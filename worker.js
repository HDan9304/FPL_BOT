// worker.js — minimal FPL deadline bot
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, DEFAULT_CHAT_ID
// KV binding: FPL_BOT_KV (stores reminder flags)

const REMINDER_WINDOWS = [24, 2];     // hours before deadline
const TOLERANCE_HOURS = 0.2;          // ~12 min tolerance

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");

    if (req.method==="GET" && (path===""||path==="/")) return text("OK");

    // Register Telegram webhook
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

    // Telegram webhook
    if (path==="/webhook/telegram") {
      if (req.method!=="POST") return text("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden",403);

      let update; try { update = await req.json(); } catch { return text("Bad Request",400); }
      const msg = update?.message; if (!msg) return text("ok");
      const chatId = msg?.chat?.id, raw = (msg?.text||"").trim(); if (!chatId) return text("ok");

      const { name } = parseCmd(raw);
      if (name==="start" || name==="") { await handleStart(env, chatId, msg.from); return text("ok"); }
      if (name==="deadline") { await handleDeadline(env, chatId); return text("ok"); }
      if (name==="dltest") { await runDeadlineSweep(env, true, chatId); return text("ok"); }

      await handleStart(env, chatId, msg.from);
      return text("ok");
    }

    return text("Not Found",404);
  },

  // Cron trigger
  async scheduled(_event, env, _ctx) {
    await runDeadlineSweep(env);
  }
};

/* -------- Handlers -------- */
async function handleStart(env, chatId, from) {
  const first = ascii((from?.first_name || "there").trim());
  const msg = `Hey ${first}!\n\nCommands:\n/start — show this message\n/deadline — show next GW deadline\n/dltest — simulate reminder\n\nBot will also remind you 24h & 2h before each deadline.`;
  await send(env, chatId, msg);
}

async function handleDeadline(env, chatId) {
  const ev = await nextEvent();
  if (!ev) { await send(env, chatId, "Couldn’t fetch next deadline."); return; }

  const dl = new Date(ev.deadline_time);
  const ms = dl - Date.now();
  const d = Math.floor(ms/86400000);
  const h = Math.floor((ms%86400000)/3600000);
  const m = Math.floor((ms%3600000)/60000);

  const msg = [
    `GW${ev.id} Deadline`,
    `UTC: ${dl.getUTCFullYear()}-${pad(dl.getUTCMonth()+1)}-${pad(dl.getUTCDate())} ${pad(dl.getUTCHours())}:${pad(dl.getUTCMinutes())}`,
    `Countdown: ${d}d ${h}h ${m}m`
  ].join("\n");

  await send(env, chatId, msg);
}

/* -------- Deadline reminders -------- */
async function runDeadlineSweep(env, isTest=false, forceChat=null) {
  const ev = await nextEvent();
  if (!ev) return;
  const deadline = new Date(ev.deadline_time);
  const hoursTo = (deadline - Date.now()) / 36e5;

  // For now: one chat only (set as secret DEFAULT_CHAT_ID)
  const chatId = forceChat || env.DEFAULT_CHAT_ID;

  for (const T of REMINDER_WINDOWS) {
    if (isTest || Math.abs(hoursTo - T) <= TOLERANCE_HOURS) {
      const flag = `alerted:${chatId}:gw${ev.id}:${T}`;
      if (!(await env.FPL_BOT_KV.get(flag))) {
        await sendReminder(env, chatId, ev, deadline, T, isTest);
        await env.FPL_BOT_KV.put(flag, "1", { expirationTtl: 60*60*48 });
      }
    }
  }
}

async function sendReminder(env, chatId, ev, deadline, T, isTest) {
  const ms = deadline - Date.now();
  const h = Math.max(0, Math.floor(ms/36e5));
  const m = Math.max(0, Math.floor((ms%36e5)/6e4));

  const msg = [
    `⏰ ${isTest?"[TEST] ":""}GW${ev.id} deadline reminder`,
    `UTC: ${deadline.toISOString().slice(0,16).replace("T"," ")}`,
    "",
    `Countdown: ${h}h ${m}m`,
    "Advice: Make transfers ~2–6h before deadline (team news, price moves)."
  ].join("\n");

  await send(env, chatId, msg);
}

/* -------- Helpers -------- */
async function nextEvent() {
  try {
    const r = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/");
    const j = await r.json();
    return (j.events||[]).find(e=>e.is_next);
  } catch { return null; }
}

const text = (s, status=200)=>new Response(s,{status,headers:{"content-type":"text/plain; charset=utf-8"}});
const parseCmd = (t)=>{ if(!t.startsWith("/")) return {name:"",args:[]}; const parts=t.split(/\s+/); return {name:parts[0].slice(1).toLowerCase(), args:parts.slice(1)}; };
const pad = (n)=>String(n).padStart(2,"0");
const ascii = (s)=>String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"');
async function send(env, chat_id, message) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:"POST",
    headers:{ "content-type":"application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text: message, disable_web_page_preview:true })
  }).catch(()=>{});
}