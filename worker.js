// worker.js — minimal bot with /start and /deadline
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method==="GET" && (path===""||path==="/")) return text("OK");

    // Register webhook
    if (req.method==="GET" && path==="/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method:"POST",
        headers:{ "content-type":"application/json; charset=utf-8" },
        body: JSON.stringify({
          url:`${url.origin}/webhook/telegram`,
          secret_token:env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates:["message"],
          drop_pending_updates:true
        })
      });
      const j = await r.json().catch(()=>({}));
      return text(j?.ok?"webhook set":`failed: ${j?.description||"unknown"}`, j?.ok?200:500);
    }

    // Webhook
    if (path==="/webhook/telegram") {
      if (req.method!=="POST") return text("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden",403);

      let update; try { update = await req.json(); } catch { return text("Bad Request",400); }
      const msg = update?.message; if (!msg) return text("ok");
      const chatId = msg?.chat?.id, raw = (msg?.text||"").trim(); if (!chatId) return text("ok");

      const { name } = parseCmd(raw);
      if (name==="start" || name==="") { await handleStart(env, chatId, msg.from); return text("ok"); }
      if (name==="deadline") { await handleDeadline(env, chatId); return text("ok"); }

      await handleStart(env, chatId, msg.from);
      return text("ok");
    }

    return text("Not Found",404);
  }
};

/* ---------- handlers ---------- */
async function handleStart(env, chatId, from) {
  const first = ascii((from?.first_name || "there").trim());
  const msg = `Hey ${first}!\n\nAvailable commands:\n/start — show this message\n/deadline — show next GW deadline`;
  await send(env, chatId, msg);
}

async function handleDeadline(env, chatId) {
  try {
    const data = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/").then(r=>r.json());
    const ev = (data?.events||[]).find(e=>e.is_next);
    if (!ev?.deadline_time) { await send(env, chatId, "Couldn’t find next deadline."); return; }
    const dl = new Date(ev.deadline_time);
    const now = Date.now();
    const ms = dl - now;
    const d = Math.floor(ms/86400000);
    const h = Math.floor((ms%86400000)/3600000);
    const m = Math.floor((ms%3600000)/60000);

    const line = [
      `GW${ev.id} Deadline`,
      `UTC: ${dl.getUTCFullYear()}-${pad(dl.getUTCMonth()+1)}-${pad(dl.getUTCDate())} ${pad(dl.getUTCHours())}:${pad(dl.getUTCMinutes())}`,
      `Countdown: ${d}d ${h}h ${m}m`
    ].join("\n");

    await send(env, chatId, line);
  } catch {
    await send(env, chatId, "Error fetching deadline.");
  }
}

/* ---------- helpers ---------- */
const text = (s, status=200) => new Response(s, { status, headers:{ "content-type":"text/plain; charset=utf-8" } });
const parseCmd = (t)=>{ if(!t.startsWith("/")) return {name:"",args:[]}; const parts=t.split(/\s+/); return {name:parts[0].slice(1).toLowerCase(), args:parts.slice(1)}; };
const pad = (n)=>String(n).padStart(2,"0");
const ascii = (s)=>String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\u2014|\u2013/g,"-").replace(/\u00A0/g," ");
async function send(env, chat_id, message) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:"POST", headers:{ "content-type":"application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text: message, disable_web_page_preview:true })
  }).catch(()=>{});
}