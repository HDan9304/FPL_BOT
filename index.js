// index.js — Telegram bot router (adds /benchboost)
import startCmd       from "./command/start.js";
import linkCmd        from "./command/link.js";
import unlinkCmd      from "./command/unlink.js";
import transferCmd    from "./command/transfer.js";
import planCmd        from "./command/plan.js";
import chipCmd        from "./command/chip.js";
import wildcardCmd    from "./command/wildcard.js";
import benchboostCmd  from "./command/benchboost.js"; // <— NEW
import { send }       from "./utils/telegram.js";

// KV key helpers
const kLastSeen = (id) => `chat:${id}:last_seen`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) {
      return new Response("OK", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    // Register Telegram webhook
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

    // Telegram webhook
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

      // ping KV
      try { await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now())); } catch {}

      // parse command
      const { name, args } = parseCmd(t);

      // routes
      if (name === "start" || name === "")              { await startCmd(env, chatId, msg.from); return new Response("ok"); }
      if (name === "link")                               { await linkCmd(env, chatId, args);      return new Response("ok"); }
      if (name === "unlink")                             { await unlinkCmd(env, chatId);          return new Response("ok"); }
      if (name === "transfer")                           { await transferCmd(env, chatId, args.join(" ")); return new Response("ok"); }
      if (name === "plan")                               { await planCmd(env, chatId, args.join(" "));     return new Response("ok"); }
      if (name === "chip")                               { await chipCmd(env, chatId, args.join(" "));     return new Response("ok"); }
      if (name === "wildcard" || name === "wc")          { await wildcardCmd(env, chatId);                return new Response("ok"); }
      if (name === "benchboost" || name === "bb")        { await benchboostCmd(env, chatId);              return new Response("ok"); } // <— NEW

      // default -> /start
      await startCmd(env, chatId, msg.from);
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

function parseCmd(t) {
  if (!t.startsWith("/")) return { name: "", args: [] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
}