// worker.js — minimal start-only with symbols
export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");
    if (req.method==="GET" && (path===""||path==="/")) return text("OK");
    if (req.method==="GET" && path==="/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method:"POST", headers:{ "content-type":"application/json; charset=utf-8" },
        body: JSON.stringify({ url:`${url.origin}/webhook/telegram`, secret_token:env.TELEGRAM_WEBHOOK_SECRET, allowed_updates:["message"], drop_pending_updates:true })
      });
      const j = await r.json().catch(()=>({}));
      return text(j?.ok?"webhook set":`failed: ${j?.description||"unknown"}`, j?.ok?200:500);
    }
    if (path==="/webhook/telegram") {
      if (req.method!=="POST") return text("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden",403);
      let update; try { update = await req.json(); } catch { return text("Bad Request",400); }
      const msg = update?.message; if (!msg) return text("ok");
      const chatId = msg?.chat?.id; const t = (msg?.text||"").trim(); if (!chatId) return text("ok");
      try { await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now())); } catch {}
      const { name } = parseCmd(t);
      if (name==="start" || name==="") { await handleStart(env, chatId, msg.from); return text("ok"); }
      await handleStart(env, chatId, msg.from); return text("ok");
    }
    return text("Not Found",404);
  }
};

async function handleStart(env, chatId, from) {
  const SYM = symbols(env), first = ascii((from?.first_name||"there").trim());
  const demoMoney = fmtMoney(12.3, SYM), demoArrow = SYM.arrowR+" sample flow";
  const demoList = [
    SYM.bullet+" Unicode-safe bullets",
    SYM.bullet+" Arrows "+SYM.arrowR+" left "+SYM.arrowL,
    SYM.bullet+" Currency: "+demoMoney,
    SYM.bullet+" Check: "+SYM.check+"  Warn: "+SYM.warn
  ].join("\n");
  const html = [
    `<b>${esc(`Hey ${first}!`)}</b>`, "", esc("Bot is alive and ready."), "",
    `<b>${esc("Symbols Demo")}</b>`, esc(demoArrow), esc(demoList), "",
    esc("Switch to ASCII anytime with env SYMBOL_MODE=ascii.")
  ].join("\n");
  await sendHTML(env, chatId, html);
}

async function sendHTML(env, chat_id, html) {
  const payload = { chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    const r = await tg(env, "sendMessage", payload);
    if (!r?.ok) await tg(env, "sendMessage", { chat_id, text: strip(html) });
  } catch { await tg(env, "sendMessage", { chat_id, text: strip(html) }); }
}
async function tg(env, method, body) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method:"POST", headers:{ "content-type":"application/json; charset=utf-8" }, body: JSON.stringify(body)
    });
    return await r.json();
  } catch { return { ok:false }; }
}

const text = (s, status=200) => new Response(s, { status, headers:{ "content-type":"text/plain; charset=utf-8" } });
const parseCmd = (t)=>{ if(!t.startsWith("/")) return {name:"",args:[]}; const parts=t.split(/\s+/); return {name:parts[0].slice(1).toLowerCase(), args:parts.slice(1)}; };
const ascii = (s)=>String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\u2014|\u2013/g,"-").replace(/\u00A0/g," ");
const esc = (s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const strip = (s)=>s.replace(/<[^>]+>/g,"");
const kLastSeen = (id)=>`chat:${id}:last_seen`;

function symbols(env){
  const isAscii = String(env.SYMBOL_MODE||"unicode").toLowerCase()==="ascii";
  const U = { bullet:"\u2022", dot:"\u00B7", sep:" \u2022 ", arrowR:"\u2192", arrowL:"\u2190", arrowUp:"\u2191", arrowDn:"\u2193", check:"\u2705", cross:"\u274C", warn:"\u26A0\uFE0F", pound:"\u00A3", times:"\u00D7", ndash:"\u2013", mdash:"\u2014" };
  const A = { bullet:"-", dot:".", sep:" | ", arrowR:"->", arrowL:"<-", arrowUp:"^", arrowDn:"v", check:"[ok]", cross:"[x]", warn:"[!]", pound:"GBP ", times:"x", ndash:"-", mdash:"-" };
  return isAscii ? A : U;
}
function fmtMoney(n, SYM){ const v=Number(n); if(!Number.isFinite(v)) return SYM.pound+"0.0m"; return `${SYM.pound}${v.toFixed(1)}m`; }