// index.js — Telegram router (HTML-safe replies)

import startCmd     from "./command/start.js";
import linkCmd      from "./command/link.js";
import unlinkCmd    from "./command/unlink.js";
import transferCmd  from "./command/transfer.js";
import planCmd      from "./command/plan.js";
import chipCmd      from "./command/chip.js";
import benchboostCmd from "./command/benchboost.js";
import wildcardCmd  from "./command/wildcard.js";
import wcsquadCmd   from "./command/wcsquad.js";   // <— NEW

import { send } from "./utils/telegram.js";

const kLastSeen = (id) => `chat:${id}:last_seen`;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/")) {
      return new Response("OK", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

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
      const ok = j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`;
      return new Response(ok, { status: j?.ok ? 200 : 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

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

      await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now()));

      const { name, args } = parseCmd(t);

      try {
        if (name === "start" || name === "") { await startCmd(env, chatId, msg.from); return new Response("ok"); }
        if (name === "link")                  { await linkCmd(env, chatId, args);     return new Response("ok"); }
        if (name === "unlink")                { await unlinkCmd(env, chatId);         return new Response("ok"); }
        if (name === "transfer")              { await transferCmd(env, chatId, args.join(" ")); return new Response("ok"); }
        if (name === "plan")                  { await planCmd(env, chatId, args.join(" "));     return new Response("ok"); }
        if (name === "chip")                  { await chipCmd(env, chatId);           return new Response("ok"); }
        if (name === "benchboost")            { await benchboostCmd(env, chatId);     return new Response("ok"); }
        if (name === "wildcard")              { await wildcardCmd(env, chatId);       return new Response("ok"); }
        if (name === "wcsquad")               { await wcsquadCmd(env, chatId);        return new Response("ok"); } // NEW

        // fallback
        await startCmd(env, chatId, msg.from);
      } catch (e) {
        await send(env, chatId, "Something went wrong. Please try again.");
      }
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  }
};

function parseCmd(t) {
  if (!t.startsWith("/")) return { name: "", args: [] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
}
