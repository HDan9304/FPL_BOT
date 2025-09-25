// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname.replace(/\/$/, "");
    if (req.method === "GET" && (!p || p === "/")) return txt("OK");
    if (req.method === "GET" && p === "/init-webhook") return initWebhook(u.origin, env);
    if (p === "/webhook/telegram") {
      if (req.method !== "POST") return txt("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return txt("Forbidden", 403);
      let update; try { update = await req.json(); } catch { return txt("Bad Request", 400); }
      ctx.waitUntil(handleUpdate(update, env));
      return txt("ok");
    }
    return txt("Not Found", 404);
  }
};

/* ---------- tiny HTTP helper ---------- */
const txt = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/* ---------- Telegram send with per-chat symbol mode ---------- */
// modes: "fancy" (real symbols), "mono" (monospace MarkdownV2), "ascii" (safe fallback)
const api = t => `https://api.telegram.org/bot${t}`;
const modeKey = chat => `chat:${chat}:symbols`;  // stores "fancy" | "mono" | "ascii"
async function send(env, chat, text, extra = {}) {
  const mode = (await env.FPL_BOT_KV.get(modeKey(chat))) || "ascii";
  if (mode === "fancy") {
    return fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true, ...extra })
    }).catch(() => {});
  }
  if (mode === "mono") {
    const inner = mdv2(text); // escape content only
    const wrapped = "```" + "\n" + inner + "\n" + "```";
    return fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id: chat, text: wrapped, parse_mode: "MarkdownV2", disable_web_page_preview: true, ...extra })
    }).catch(() => {});
  }
  // ASCII fallback
  const safe = text
    .replaceAll("£", "GBP").replaceAll("€", "EUR").replaceAll("¥", "YEN")
    .replaceAll("•", "-")
    .replaceAll("", "<-").replaceAll("", "->").replaceAll("", "^").replaceAll("", "v");
  return fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id: chat, text: safe, disable_web_page_preview: true, ...extra })
  }).catch(() => {});
}
// Escape for MarkdownV2 (Telegram spec)
function mdv2(s) {
  return (s || "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/* ---------- KV helpers ---------- */
const teamKey = id => `chat:${id}:team`;
const indexKey = `chats:index`;
async function linkTeam(env, chat, teamId) {
  await env.FPL_BOT_KV.put(teamKey(chat), String(teamId), { expirationTtl: 31536000 }); // 1 year
  let arr = []; try { const raw = await env.FPL_BOT_KV.get(indexKey); if (raw) arr = JSON.parse(raw); } catch {}
  if (!arr.includes(chat)) { arr.push(chat); await env.FPL_BOT_KV.put(indexKey, JSON.stringify(arr)); }
}

/* ---------- Webhook aux ---------- */
async function initWebhook(origin, env) {
  const res = await fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/setWebhook`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      url: `${origin}/webhook/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: true
    })
  });
  const j = await res.json().catch(() => ({}));
  return txt(j.ok ? `Webhook set to ${origin}/webhook/telegram` : `Failed: ${j.description || JSON.stringify(j)}`, j.ok ? 200 : 500);
}

/* ---------- Router ---------- */
async function handleUpdate(up, env) {
  const m = up?.message; if (!m) return;
  const chat = m.chat?.id, t = (m.text || "").trim();

  if (t.startsWith("/start"))
    return send(env, chat,
      "Welcome to the FPL bot\n\n" +
      "Link your team:\n" +
      "/linkteam <FPL_TEAM_ID>\n\n" +
      "See /help for commands."
    );

  if (t.startsWith("/help"))
    return send(env, chat,
      "Commands:\n" +
      "• /linkteam <FPL_TEAM_ID>\n" +
      "• /unlink\n" +
      "• /ping\n" +
      "• /symbols          (sample)\n" +
      "• /symbols_on       (fancy symbols)\n" +
      "• /symbols_mono     (monospace symbols)\n" +
      "• /symbols_off      (ASCII)"
    );

  if (t.startsWith("/ping")) return send(env, chat, "pong");

  if (t.startsWith("/symbols_on"))  { await env.FPL_BOT_KV.put(modeKey(chat), "fancy"); return send(env, chat, "Symbols mode: fancy"); }
  if (t.startsWith("/symbols_mono")){ await env.FPL_BOT_KV.put(modeKey(chat), "mono");  return send(env, chat, "Symbols mode: monospace"); }
  if (t.startsWith("/symbols_off")) { await env.FPL_BOT_KV.put(modeKey(chat), "ascii"); return send(env, chat, "Symbols mode: ascii"); }

  if (t.startsWith("/symbols")) {
    const mode = (await env.FPL_BOT_KV.get(modeKey(chat))) || "ascii";
    const demo =
      "Currency: £ $ € ¥\n" +
      "Arrows:      \n" +
      "Bullet:   •\n" +
      "Example:  Bank £1.5m | Team value £100.2m\n" +
      "Mode:     " + mode;
    return send(env, chat, demo);
  }

  if (t.startsWith("/unlink")) {
    await env.FPL_BOT_KV.delete(teamKey(chat));
    return send(env, chat, "Unlinked. Link again with:\n/linkteam <FPL_TEAM_ID>");
  }

  if (t.startsWith("/linkteam")) {
    const id = (t.split(/\s+/)[1] || "").trim();
    if (!id)  return send(env, chat, "Usage:\n/linkteam 1234567\nFind your FPL team ID in the URL when viewing your team.");
    if (!/^\d{1,10}$/.test(id)) return send(env, chat, "That doesn't look like a valid numeric FPL team ID.");
    await linkTeam(env, chat, id);
    return send(env, chat, `Linked\n\n• Chat ${chat}  FPL Team ${id}\n• /help for commands\n• /unlink to remove`);
  }

  const linked = await env.FPL_BOT_KV.get(teamKey(chat));
  if (linked) return send(env, chat, `You are linked to FPL Team ${linked}\n• /unlink\n• /help`);
  return send(env, chat, "I didn't catch that.\nStart with:\n/linkteam <FPL_TEAM_ID>");
}