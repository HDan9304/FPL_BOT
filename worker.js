// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname.replace(/\/$/, "");
    if (req.method==="GET" && (!p||p==="/")) return txt("OK");
    if (req.method==="GET" && p==="/init-webhook") return initWebhook(u.origin, env);
    if (p==="/webhook/telegram") {
      if (req.method!=="POST") return txt("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return txt("Forbidden",403);
      let up; try{ up = await req.json(); } catch { return txt("Bad Request",400); }
      ctx.waitUntil(handleUpdate(up, env));
      return txt("ok");
    }
    return txt("Not Found",404);
  }
};

/* ---------- HTTP helpers ---------- */
const txt = (s, status=200)=>new Response(s,{status,headers:{"content-type":"text/plain; charset=utf-8"}});

/* ---------- Telegram helpers (ASCII-safe) ---------- */
const api = t=>`https://api.telegram.org/bot${t}`;
async function tg(env, method, payload) {
  sanitize(payload);
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
  if (obj.text) obj.text = asciiSafe(obj.text);
  if (obj.caption) obj.caption = asciiSafe(obj.caption);
  const kb = obj.reply_markup?.inline_keyboard;
  if (kb) for (const row of kb) for (const b of row) b.text = asciiSafe(b.text);
}
function asciiSafe(s){
  const map = [
    [/[€]/g,"EUR"],[/[£]/g,"GBP"],[/[¥]/g,"JPY"],[/[]/g,"RUB"],[/[]/g,"TRY"],[/[]/g,"KRW"],[/[]/g,"INR"],[/[]/g,"BTC"],
    [/[]/g,"<-"],[/[]/g,"->"],[/[]/g,"^"],[/[]/g,"v"],[/[]/g,"[back]"],[/[]/g,"[fwd]"],[/[]/g,"[refresh]"],[/[]/g,"[loop]"],
    [/[]/g,"=>"],[/[]/g,"<="],[/[±]/g,"+/-"],[/[×]/g,"x"],[/[÷]/g,"/"],[/[]/g,"~="],[/[]/g,"!="],[/[]/g,"<="],[/[]/g,">="],[/[]/g,"infinity"],
    [/[]/g,"degC"],[/[]/g,"degF"],[/[™]/g,"tm"],[/[®]/g,"(R)"],[/[©]/g,"(C)"],[/[µ]/g,"u"],[/[]/g,"Ohm"],
    [/[]/g,"alpha"],[/[]/g,"beta"],[/[]/g,"gamma"],[/[]/g,"Delta"],[/[]/g,"pi"],
    [/[•]/g,"-"],[/[]/g,"o"],[/[]/g,">"],[/[]/g,"#"],[/[]/g,"[]"],[/[]/g,"*"],
    [/[\uFE0F\uFE0E]/g,""]
  ];
  let out = (s||"").toString().normalize("NFKC");
  for (const [re, rep] of map) out = out.replace(re, rep);
  return out;
}

/* ---------- KV helpers ---------- */
const kvKey = id=>`chat:${id}:team`;
const idxKey = `chats:index`;
async function link(env, chatId, teamId){
  await env.FPL_BOT_KV.put(kvKey(chatId), String(teamId), { expirationTtl: 31536000 });
  let raw = await env.FPL_BOT_KV.get(idxKey), arr=[]; try{ if(raw) arr=JSON.parse(raw);}catch{}
  if (!arr.includes(chatId)) { arr.push(chatId); await env.FPL_BOT_KV.put(idxKey, JSON.stringify(arr)); }
}

/* ---------- Webhook handlers ---------- */
async function initWebhook(origin, env){
  const r = await fetch(`${api(env.TELEGRAM_BOT_KEN)}/setWebhook`,{}).catch(()=>{}); // noop to warm DNS
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
  return txt(j.ok ? `Webhook set to ${origin}/webhook/telegram` : `Failed: ${j.description||JSON.stringify(j)}`, j.ok?200:500);
}

async function handleUpdate(up, env){
  const m = up?.message; if (!m) return;
  const chat = m.chat?.id, t = (m.text||"").trim();

  if (t.startsWith("/start"))
    return send(env, chat, "Welcome to the FPL bot!\n\nLink your team:\n/linkteam <FPL_TEAM_ID>\n\nUse /help to see commands.");
  if (t.startsWith("/help"))
    return send(env, chat, "Commands:\n• /linkteam <FPL_TEAM_ID>\n• /unlink\n• /ping\n• /symbols (ASCII-safe demo)");
  if (t.startsWith("/ping"))
    return send(env, chat, "pong");
  if (t.startsWith("/symbols")) {
    const demo =
      "Currency: $ EUR GBP JPY BTC\n"+
      "Arrows: <- -> ^ v [back] [fwd] [loop] [refresh]\n"+
      "Math: +/- x / ~= != <= >= -> <- => <= infinity\n"+
      "Units: degC degF tm (R) (C) u Ohm alpha beta gamma Delta pi\n"+
      "Bullets: - o > # [] *";
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
    return send(env, chat, `Linked!\n\n• Chat ${chat} -> FPL Team ${id}\n\nNext:\n• /help\n• /unlink`);
  }

  const linked = await env.FPL_BOT_KV.get(kvKey(chat));
  if (linked) return send(env, chat, `You're linked to FPL Team ${linked}.\nCommands:\n• /unlink\n• /help`);
  return send(env, chat, "I didn't catch that. Start with:\n/linkteam <FPL_TEAM_ID>");
}