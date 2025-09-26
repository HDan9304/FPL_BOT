// worker.js — v1 minimal: /start and /linkteam only (clean slate)
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV   (stores user:<chatId>:profile)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // Register Telegram webhook (message-only)
    if (req.method === "GET" && path === "/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          url: `${url.origin}/webhook/telegram`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true
        })
      });
      const j = await r.json().catch(() => ({}));
      return text(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }

      const msg = update?.message;
      if (!msg) return text("ok");
      const chatId = msg?.chat?.id;
      const t = (msg?.text || "").trim();
      if (!chatId) return text("ok");

      // ping KV so we know it works
      await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now()));

      const { name, args } = parseCmd(t);

      if (name === "start" || name === "") {
        await handleStart(env, chatId, msg.from);
        return text("ok");
      }

      if (name === "linkteam") {
        await handleLinkTeam(env, chatId, args);
        return text("ok");
      }

      // Unknown -> show help
      await handleStart(env, chatId, msg.from);
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------- handlers ---------- */
async function handleStart(env, chatId, from) {
  const first = ascii((from?.first_name || "there").trim());
  const html = [
    `<b>${esc(`Hey ${first}!`)}</b>`,
    "",
    `${B("What I can do now")}`,
    `• <code>/linkteam &lt;YourTeamID&gt;</code> — save your FPL team ID`,
    "",
    `${B("Where to find Team ID")}`,
    `Open fantasy.premierleague.com → My Team, check the URL like <code>/entry/1234567/</code>`,
    "",
    `${B("Example")}`,
    `<code>/linkteam 1234567</code>`
  ].join("\n");
  await sendHTML(env, chatId, html);
}

async function handleLinkTeam(env, chatId, args) {
  const raw = (args[0] || "").trim();
  if (!raw) {
    const html = [
      `<b>${esc("Link Your FPL Team")}</b>`,
      "",
      `${B("Find Team ID")} fantasy.premierleague.com → My Team (URL contains <code>/entry/1234567/</code>)`,
      "",
      `${B("How To Link")}`,
      `<code>/linkteam 1234567</code>`
    ].join("\n");
    await sendHTML(env, chatId, html);
    return;
  }

  const teamId = Number(raw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await sendHTML(env, chatId, `${B("Tip")} use a numeric Team ID, e.g. <code>/linkteam 1234567</code>`);
    return;
  }

  const entry = await fplEntry(teamId);
  if (!entry) {
    await sendHTML(env, chatId, `${B("Not Found")} that Team ID didn’t resolve. Double-check and try again.`);
    return;
  }

  const now = Date.now();
  await env.FPL_BOT_KV.put(kUser(chatId), JSON.stringify({ teamId, createdAt: now, updatedAt: now }));

  const teamName = ascii(`${entry.name || "Team"}`);
  const manager = ascii(`${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim());

  const html = [
    `<b>${esc("Team Linked")}</b> ✅`,
    "",
    `${B("Team")} <b>${esc(teamName)}</b>`,
    manager ? `${B("Manager")} ${esc(manager)}` : "",
    `${B("Team ID")} ${esc(String(teamId))}`,
    "",
    esc("Nice. We’re ready to add /myteam and /transfer next.")
  ].filter(Boolean).join("\n");
  await sendHTML(env, chatId, html);
}

/* ---------- telegram helpers ---------- */
async function sendHTML(env, chat_id, html) {
  const payload = { chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    const r = await tg(env, "sendMessage", payload);
    if (!r?.ok) await tg(env, "sendMessage", { chat_id, text: strip(html) });
  } catch {
    await tg(env, "sendMessage", { chat_id, text: strip(html) });
  }
}

async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(body)
    });
    return await r.json();
  } catch { return { ok: false }; }
}

/* ---------- FPL API (only entry used for now) ---------- */
async function fplEntry(id) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${id}/`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || typeof j.id !== "number") return null;
    return j;
  } catch { return null; }
}

/* ---------- utils ---------- */
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const parseCmd = (t) => {
  if (!t.startsWith("/")) return { name: "", args: [] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
};

const ascii = (s) => String(s)
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/\u2014|\u2013/g, "-")
  .replace(/\u00A0/g, " ");

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const strip = (s) => s.replace(/<[^>]+>/g, "");
const B = (label) => `<b>${esc(label)}:</b>`;

const kLastSeen = (id) => `chat:${id}:last_seen`;
const kUser = (id) => `user:${id}:profile`;