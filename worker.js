// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname.replace(/\/$/, "");
    if (req.method==="GET" && (!p||p==="/")) return text("OK");
    if (req.method==="GET" && p==="/init-webhook") return initWebhook(u.origin, env);
    if (p==="/webhook/telegram") {
      if (req.method!=="POST") return text("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden",403);
      let up; try { up = await req.json(); } catch { return text("Bad Request",400); }
      ctx.waitUntil(handleUpdate(up, env));
      return text("ok");
    }
    return text("Not Found",404);
  }
};

/* ---------- HTTP ---------- */
const text = (s, status=200)=>new Response(s,{status,headers:{"content-type":"text/plain; charset=utf-8"}});

/* ---------- Telegram (ASCII-safe) ---------- */
const api = t=>`https://api.telegram.org/bot${t}`;
async function tg(env, method, payload) {
  sanitize(payload); // only minimal FPL-relevant replacements
  return fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/${method}`, {
    method:"POST",
    headers:{ "content-type":"application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  }).catch(()=>{});
}
const send = (env, chat_id, text, opts={}) =>
  tg(env, "sendMessage", { chat_id, text, disable_web_page_preview:true, ...opts });

function sanitize(obj){
  if (!obj) return;
  if (obj.text) obj.text = asciiFpl(obj.text);
  if (obj.caption) obj.caption = asciiFpl(obj.caption);
  const kb = obj.reply_markup?.inline_keyboard;
  if (kb) for (const row of kb) for (const b of row) b.text = asciiFpl(b.text);
}

// Only what we actually need for FPL displays.
function asciiFpl(s){
  let out = (s||"").toString();
  // Currency: FPL shows £; replace with ASCII-safe token.
  out = out.replace(/£/g, "GBP");
  // Optional euro support if you ever show EUR values.
  out = out.replace(/€/g, "EUR");
  // Basic arrows (in case you type them)
  out = out.replace(/[]/g, "<-").replace(/[]/g, "->");
  return out;
}

/* ---------- KV ---------- */
const kvKey = id=>`chat:${id}:team`;
const idxKey = `chats:index`;
async function link(env, chatId, teamId){
  await env.FPL_BOT_KV.put(kvKey(chatId), String(teamId), { expirationTtl: 31536000 }); // 1 year
  let raw = await env.FPL_BOT_KV.get(idxKey), arr=[]; try{ if(raw) arr=JSON.parse(raw);}catch{}
  if (!arr.includes(chatId)) { arr.push(chatId); await env.FPL_BOT_KV.put(idxKey, JSON.stringify(arr)); }
}

/* ---------- Routes ---------- */
async function initWebhook(origin, env){
  const res = await fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/setWebhook`, {
    method:"POST",
    headers:{ "content-type":"application/json; charset=utf-8" },
    body: JSON.stringify({
      url: `${origin}/webhook/telegram`,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
      drop_pending_updates: true
    })
  });
  const j = await res.json().catch(()=>({}));
  return text(j.ok ? `Webhook set to ${origin}/webhook/telegram` : `Failed: ${j.description||JSON.stringify(j)}`, j.ok?200:500);
}

async function handleUpdate(up, env){
  const m = up?.message; if (!m) return;
  const chat = m.chat?.id, t = (m.text||"").trim();

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
      "- /linkteam <FPL_TEAM_ID>\n" +
      "- /unlink\n" +
      "- /ping\n" +
      "- /symbols  (sanity check)"
    );

  if (t.startsWith("/ping"))
    return send(env, chat, "pong");

  if (t.startsWith("/symbols")) {
    // Only ASCII + minimal currency tokens
    const demo =
      "Currency: $ GBP EUR\n" +
      "Arrows: <- -> ^ v\n" +
      "Example price line: Bank: GBP 1.5m  |  Team value: GBP 100.2m";
    return send(env, chat, demo);
  }

  if (t.startsWith("/unlink")) {
    await env.FPL_BOT_KV.delete(kvKey(chat));
    return send(env, chat, "Unlinked. Link again with:\n/linkteam <FPL_TEAM_ID>");
  }

  if (t.startsWith("/linkteam")) {
    const id = (t.split(/\s+/)[1]||"").trim();
    if (!id)  return send(env, chat, "Usage:\n/linkteam 1234567\nFind your FPL team ID in the URL when viewing your team.");
    if (!/^\d{1,10}$/.test(id)) return send(env, chat, "That doesn't look like a valid numeric FPL team ID.");
    await link(env, chat, id);
    return send(env, chat, `Linked\n\n- Chat ${chat} -> FPL Team ${id}\n- Use /help for commands\n- Use /unlink to remove`);
  }

  const linked = await env.FPL_BOT_KV.get(kvKey(chat));
  if (linked) return send(env, chat, `You are linked to FPL Team ${linked}\n- /unlink\n- /help`);
  return send(env, chat, "I didn't catch that.\nStart with:\n/linkteam <FPL_TEAM_ID>");
}