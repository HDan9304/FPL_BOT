// worker.js — v2 start + reminders (simple, durable)
// Env:
//   TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
//   FPL_BOT_KV (KV binding) — stores chat:<id>:last_seen and reminders
//   SYMBOL_MODE = "unicode" | "ascii"  (optional; defaults "unicode")

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");
    if (req.method==="GET" && (path===""||path==="/")) return text("OK");

    // Manual sweep trigger (useful before you wire Cloudflare Cron)
    if (req.method==="GET" && path==="/cron") { await runReminderSweep(env); return text("cron ok"); }

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

      const { name, args } = parseCmd(t);

      if (name==="" || name==="start" || name==="help") { await handleStart(env, chatId, msg.from); return text("ok"); }
      if (name==="remind") { await handleRemind(env, chatId, args); return text("ok"); }
      if (name==="reminders") { await handleRemindersList(env, chatId); return text("ok"); }
      if (name==="cancel") { await handleCancel(env, chatId, args); return text("ok"); }

      await handleStart(env, chatId, msg.from); return text("ok");
    }

    return text("Not Found",404);
  },

  // Optional: add a Cron Trigger to run every minute or five
  async scheduled(_event, env) { await runReminderSweep(env); }
};

/* ---------------- Handlers ---------------- */
async function handleStart(env, chatId, from) {
  const SYM = symbols(env), first = ascii((from?.first_name||"there").trim());
  const html = [
    `<b>${esc(`Hey ${first}!`)}</b>`,
    "",
    esc("Bot is alive. Reminders are enabled."),
    "",
    `<b>${esc("Quick usage")}</b>`,
    esc(`${SYM.bullet} /remind in 10m Stretch`),
    esc(`${SYM.bullet} /remind in 2h Call mum`),
    esc(`${SYM.bullet} /reminders  (list)`),
    esc(`${SYM.bullet} /cancel <id>  (from list)`),
    "",
    esc("Tip: supports s/m/h/d units: 30s, 10m, 2h, 1d")
  ].join("\n");
  await sendHTML(env, chatId, html);
}

async function handleRemind(env, chatId, args) {
  const SYM = symbols(env);
  if (!args.length) { await sendHTML(env, chatId, esc("Usage: /remind in 10m Take a break")); return; }

  // Expected: "in <delta> <message...>"
  if (args[0]!=="in" || !/^\d+(s|m|h|d)$/i.test(args[1]||"")) {
    await sendHTML(env, chatId, esc("Try: /remind in 30m Drink water  (supports s/m/h/d)"));
    return;
  }
  const ms = parseDelta(args[1]);
  const textMsg = args.slice(2).join(" ").trim();
  if (!ms || !textMsg) { await sendHTML(env, chatId, esc("Provide both duration and message, e.g. /remind in 2h Meeting")); return; }

  const due = Date.now() + ms;
  const id = await saveReminder(env, chatId, due, textMsg);
  const whenStr = fmtDue(due);
  const bell = "\u23F0"; // ⏰
  await sendHTML(env, chatId, esc(`${bell} Reminder set #${id} — fires ${whenStr}\n${SYM.sep.trim()} ${textMsg}`));
}

async function handleRemindersList(env, chatId) {
  const SYM = symbols(env);
  const list = await listReminders(env, chatId);
  if (!list.length) { await sendHTML(env, chatId, esc("No pending reminders.")); return; }
  const lines = [];
  lines.push(esc("Pending reminders:"));
  for (const r of list.sort((a,b)=>a.due-b.due)) {
    lines.push(esc(`${SYM.bullet} #${r.id} — ${fmtDue(r.due)} ${SYM.sep} ${r.text}`));
  }
  await sendHTML(env, chatId, lines.join("\n"));
}

async function handleCancel(env, chatId, args) {
  const id = (args[0]||"").trim();
  if (!/^\d{6}$/.test(id)) { await sendHTML(env, chatId, esc("Usage: /cancel <id>  (see /reminders)")); return; }
  const ok = await cancelReminder(env, chatId, id);
  await sendHTML(env, chatId, esc(ok ? `Canceled reminder #${id}.` : `Could not find reminder #${id}.`));
}

/* ---------------- Reminders core ---------------- */
const REM_PREFIX = "rem:";                      // value: JSON {chatId, due, text}
const REM_INDEX  = (chatId)=>`rem_index:${chatId}`; // value: JSON array of ids (strings)
const remKey = (chatId, id) => `${REM_PREFIX}${chatId}:${id}`;

async function saveReminder(env, chatId, due, textMsg) {
  const id = String(Math.floor(100000 + Math.random()*900000)); // 6-digit
  const rec = { chatId: String(chatId), due, text: textMsg };
  await env.FPL_BOT_KV.put(remKey(chatId, id), JSON.stringify(rec), { expirationTtl: 60*60*24*7 }); // 7d TTL
  const idxRaw = await env.FPL_BOT_KV.get(REM_INDEX(chatId));
  const idx = safeJSON(idxRaw, []) ; idx.push(id);
  await env.FPL_BOT_KV.put(REM_INDEX(chatId), JSON.stringify(idx), { expirationTtl: 60*60*24*7 });
  return id;
}

async function listReminders(env, chatId) {
  const idx = safeJSON(await env.FPL_BOT_KV.get(REM_INDEX(chatId)), []);
  const out = [];
  for (const id of idx) {
    const rec = safeJSON(await env.FPL_BOT_KV.get(remKey(chatId, id)), null);
    if (rec) out.push({ id, ...rec });
  }
  return out;
}

async function cancelReminder(env, chatId, id) {
  const k = remKey(chatId, id);
  const rec = await env.FPL_BOT_KV.get(k);
  if (!rec) return false;
  await env.FPL_BOT_KV.delete(k);
  const idx = safeJSON(await env.FPL_BOT_KV.get(REM_INDEX(chatId)), []);
  const next = idx.filter(x=>x!==id);
  await env.FPL_BOT_KV.put(REM_INDEX(chatId), JSON.stringify(next), { expirationTtl: 60*60*24*7 });
  return true;
}

async function runReminderSweep(env) {
  const now = Date.now();
  let cursor = undefined;
  do {
    const page = await env.FPL_BOT_KV.list({ prefix: REM_PREFIX, cursor });
    cursor = page.cursor;
    for (const { name } of page.keys) {
      const rec = safeJSON(await env.FPL_BOT_KV.get(name), null);
      if (!rec) { await env.FPL_BOT_KV.delete(name); continue; }
      if (now >= Number(rec.due||0)) {
        const bell = "\u23F0"; // ⏰
        const txt = `${bell} Reminder\n${rec.text}`;
        await sendHTML(env, Number(rec.chatId), esc(txt));
        await env.FPL_BOT_KV.delete(name);
        // also remove from that chat's index
        const [_, chatId, id] = name.match(/^rem:(\-?\d+):(\d{6})$/) || [];
        if (chatId && id) {
          const idx = safeJSON(await env.FPL_BOT_KV.get(REM_INDEX(chatId)), []);
          const next = idx.filter(x=>x!==id);
          await env.FPL_BOT_KV.put(REM_INDEX(chatId), JSON.stringify(next), { expirationTtl: 60*60*24*7 });
        }
      }
    }
  } while (cursor);
}

/* ---------------- Telegram helpers ---------------- */
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

/* ---------------- Utils ---------------- */
const text = (s, status=200) => new Response(s, { status, headers:{ "content-type":"text/plain; charset=utf-8" } });
const parseCmd = (t)=>{ if(!t.startsWith("/")) return {name:"",args:[]}; const parts=t.split(/\s+/); return {name:parts[0].slice(1).toLowerCase(), args:parts.slice(1)}; };
const ascii = (s)=>String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\u2014|\u2013/g,"-").replace(/\u00A0/g," ");
const esc = (s)=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const strip = (s)=>s.replace(/<[^>]+>/g,"");
const kLastSeen = (id)=>`chat:${id}:last_seen`;
const safeJSON = (raw, fallback)=>{ try{ return raw?JSON.parse(raw):fallback; }catch{ return fallback; } };

function symbols(env){
  const isAscii = String(env.SYMBOL_MODE||"unicode").toLowerCase()==="ascii";
  const U = { bullet:"\u2022", sep:" \u2022 " };
  const A = { bullet:"-", sep:" | " };
  return isAscii ? A : U;
}
function parseDelta(tok){ const m=String(tok).match(/^(\d+)([smhd])$/i); if(!m) return 0;
  const n=+m[1], u=m[2].toLowerCase(); return n*(u==="s"?1e3:u==="m"?6e4:u==="h"?36e5:864e5); }
function fmtDue(ts){ const d=new Date(ts);
  const pad=(x)=>String(x).padStart(2,"0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}