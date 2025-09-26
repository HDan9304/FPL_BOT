// index.js — Telegram webhook router (flat layout)
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, FPL_BOT_KV

import startCmd    from "./command/start.js";
import linkCmd     from "./command/link.js";
import unlinkCmd   from "./command/unlink.js";
import transferCmd from "./command/transfer.js";
import planCmd     from "./command/plan.js";
import chipCmd     from "./command/chip.js"; // ok if file missing; just not routed

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // set webhook
    if (req.method === "GET" && path === "/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: `${url.origin}/webhook/telegram`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true
        })
      });
      const j = await r.json().catch(()=>({}));
      return text(j?.ok ? "webhook set" : `failed: ${j?.description||"unknown"}`, j?.ok?200:500);
    }

    // webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return text("Bad Request", 400); }
      const msg = update?.message;
      if (!msg) return text("ok");
      const chatId = msg?.chat?.id; if (!chatId) return text("ok");
      const t = String(msg?.text || "").trim();

      // keep-alive KV
      if (env.FPL_BOT_KV) await env.FPL_BOT_KV.put(`chat:${chatId}:last_seen`, String(Date.now()));

      const { name, args } = parseCmd(t);

      // routes
      if (name === "" || name === "start")  { await startCmd(env, chatId, msg.from); return text("ok"); }
      if (name === "link")                  { await linkCmd(env, chatId, args);      return text("ok"); }
      if (name === "unlink")                { await unlinkCmd(env, chatId);          return text("ok"); }

      if (name === "transfer")              { await transferCmd(env, chatId, args.join(" ")); return text("ok"); }

      // planner variants
      if (name === "plan")                  { await planCmd(env, chatId, { mode:"A" }); return text("ok"); }
      if (name === "planb" || name === "b") { await planCmd(env, chatId, { mode:"B" }); return text("ok"); }
      if (name === "planc" || name === "c") { await planCmd(env, chatId, { mode:"C" }); return text("ok"); }
      if (name === "pland" || name === "d") { await planCmd(env, chatId, { mode:"D" }); return text("ok"); }

      // chips (optional)
      if (name === "chip" || name === "chips") { if (chipCmd) await chipCmd(env, chatId); return text("ok"); }

      // fallback
      await startCmd(env, chatId, msg.from);
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* utils */
const text = (s, status=200)=> new Response(s, {status, headers:{ "content-type":"text/plain; charset=utf-8" }});
function parseCmd(t){
  if (!t || t[0] !== "/") return { name:"", args:[] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase().replace(/@\S+$/,""), args: parts.slice(1) };
}