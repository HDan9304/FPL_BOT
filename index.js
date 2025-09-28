// index.js — Router + Telegram webhook (flat paths: ./command/*, ./utils/*)
import startCmd     from "./command/start.js";
import linkCmd      from "./command/link.js";
import unlinkCmd    from "./command/unlink.js";
import transferCmd  from "./command/transfer.js";
import planCmd      from "./command/plan.js";
import chipCmd      from "./command/chip.js";
import benchboostCmd from "./command/benchboost.js"; // <-- NEW

import { send }     from "./utils/telegram.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // health
    if (req.method === "GET" && (path === "" || path === "/")) {
      return new Response("OK", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // register webhook (message-only)
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
      const ok = j?.ok;
      return new Response(ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, {
        status: ok ? 200 : 500,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    // telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }

      let update;
      try { update = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

      const msg = update?.message;
      if (!msg) return new Response("ok");
      const chatId = msg?.chat?.id;
      const t = (msg?.text || "").trim();
      if (!chatId) return new Response("ok");

      // KV heartbeat
      await env.FPL_BOT_KV.put(`chat:${chatId}:last_seen`, String(Date.now()));

      const { name, args } = parseCmd(t);

      try {
        if (name === "" || name === "start") { await startCmd(env, chatId, msg.from); return new Response("ok"); }
        if (name === "link")   { await linkCmd(env, chatId, args.join(" ")); return new Response("ok"); }
        if (name === "unlink") { await unlinkCmd(env, chatId); return new Response("ok"); }
        if (name === "transfer"){ await transferCmd(env, chatId, args.join(" ")); return new Response("ok"); }
        if (name === "plan")   { await planCmd(env, chatId, args.join(" ")); return new Response("ok"); }
        if (name === "chip")   { await chipCmd(env, chatId, args.join(" ")); return new Response("ok"); }
        if (name === "benchboost" || name === "bb") { // <-- NEW alias
          await benchboostCmd(env, chatId, args.join(" "));
          return new Response("ok");
        }

        // unknown -> show /start
        await startCmd(env, chatId, msg.from);
        return new Response("ok");
      } catch (e) {
        await send(env, chatId, "Something went wrong. Try again in a minute.");
        return new Response("ok");
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};

function parseCmd(t) {
  if (!t.startsWith("/")) return { name: "", args: [] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
}