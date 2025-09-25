// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET | KV: FPL_BOT_KV
export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url), p = u.pathname.replace(/\/$/, "");
    if (req.method==="GET" && (!p||p==="/"))
      return txt("OK  UTF-8 ready");                             // UTF-8 header
    if (req.method==="GET" && p==="/init-webhook") return initWebhook(u.origin, env);
    if (p==="/webhook/telegram") {
      if (req.method!=="POST") return txt("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return txt("Forbidden",403);
      let up; try{up=await req.json()}catch{ return txt("Bad Request",400) }
      ctx.waitUntil(handle(up, env)); return txt("ok");
    }
    return txt("Not Found",404);
  }
};

const txt = (s, status=200)=>new Response(s, {status, headers:{ "content-type":"text/plain; charset=utf-8" }});
const api = t=>`https://api.telegram.org/bot${t}`;
const norm = s => (s||"").toString().normalize("NFC");            // normalize Unicode
const send = (e,chat_id,text,opts={})=>fetch(`${api(e.TELEGRAM_BOT_TOKEN)}/sendMessage`,{
  method:"POST",headers:{'content-type':'application/json; charset=utf-8'},
  body:JSON.stringify({chat_id,text:norm(text),disable_web_page_preview:true,...opts})
}).catch(()=>{});
const kvKey = id=>`chat:${id}:team`, idxKey = `chats:index`;

async function initWebhook(origin, env){
  const r = await fetch(`${api(env.TELEGRAM_BOT_TOKEN)}/setWebhook`,{
    method:"POST",headers:{'content-type':'application/json; charset=utf-8'},
    body:JSON.stringify({url:`${origin}/webhook/telegram`,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message"],drop_pending_updates:true})
  }); const j = await r.json().catch(()=>({}));
  return txt(j.ok?`Webhook set to ${origin}/webhook/telegram`:`Failed: ${j.description||JSON.stringify(j)}`, j.ok?200:500);
}

async function handle(up, env){
  const m = up?.message; if(!m) return;
  const chat = m.chat?.id, t = norm(m.text).trim();

  if (t.startsWith("/start")) return send(env,chat,"*Welcome to the FPL bot!* \n\nLink your team:\n`/linkteam <FPL_TEAM_ID>`\n\nUse `/help` to see commands.",{parse_mode:"Markdown"});
  if (t.startsWith("/help"))  return send(env,chat,"*Commands:*\n• `/linkteam <FPL_TEAM_ID>` – link this chat to your FPL team\n• `/unlink` – remove your link\n• `/ping` – liveness check\n• `/symbols` – test Unicode symbols\n\nTip: if a symbol shows as ?, your Telegram font doesn't support it.",{parse_mode:"Markdown"});
  if (t.startsWith("/ping"))  return send(env,chat,"pong");
  if (t.startsWith("/symbols")){
    // Use explicit escapes to avoid source-file encoding issues
    const demo =
      "Currency: $ € £ ¥     \n" +
      "Arrows: \u2190 \u2192 \u2191 \u2193 \u2194 \u21A9 \u21AA \u27A1 \u2B05 \u2B06 \u2B07\n" +
      "Math: ± × ÷           \n" +
      "Units:   ™ ® © µ      \n" +
      "Bullets: •       \n" +
      "Emoji:    ";
    return send(env,chat,demo);
  }

  if (t.startsWith("/unlink")){ await env.FPL_BOT_KV.delete(kvKey(chat)); return send(env,chat,"Unlinked. You can link again with:\n`/linkteam <FPL_TEAM_ID>`",{parse_mode:"Markdown"}); }
  if (t.startsWith("/linkteam")){
    const id = (t.split(/\s+/)[1]||"").trim();
    if(!id)  return send(env,chat,"Usage:\n`/linkteam 1234567`\nFind your FPL team ID in the URL when viewing your team.",{parse_mode:"Markdown"});
    if(!/^\d{1,10}$/.test(id)) return send(env,chat,"That doesn't look like a valid numeric FPL team ID.");
    await env.FPL_BOT_KV.put(kvKey(chat), String(id), {expirationTtl:31536000});
    let raw = await env.FPL_BOT_KV.get(idxKey), arr=[]; try{ if(raw) arr=JSON.parse(raw)}catch{}
    if(!arr.includes(chat)){ arr.push(chat); await env.FPL_BOT_KV.put(idxKey, JSON.stringify(arr)); }
    return send(env,chat,` Linked!\n\n• Chat ${chat}  FPL Team ${id}\n\nNext steps:\n• Try \`/help\`\n• Use \`/unlink\` to remove the link`);
  }

  const linked = await env.FPL_BOT_KV.get(kvKey(chat));
  if (linked) return send(env,chat,`You're linked to FPL Team *${linked}*.\nCommands:\n• \`/unlink\`\n• \`/help\``,{parse_mode:"Markdown"});
  return send(env,chat,"I didn't catch that. Start with:\n`/linkteam <FPL_TEAM_ID>`",{parse_mode:"Markdown"});
}