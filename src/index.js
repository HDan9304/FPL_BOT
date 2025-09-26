// src/index.js
import startCmd     from "./commands/start.js";
import linkCmd      from "./commands/link.js";
import unlinkCmd    from "./commands/unlink.js";
import transferCmd  from "./commands/transfer.js";
import planCmd      from "./commands/plan.js";

import { send } from "./utils/telegram.js";

const parseCmd = (t) => {
  if (!t?.startsWith?.("/")) return { name: "", args: [] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
};

export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/")) return new Response("OK");
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
      return new Response(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, { status: j?.ok ? 200 : 500 });
    }

    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return new Response("Forbidden", { status: 403 });

      let update; try { update = await req.json(); } catch { return new Response("ok"); }
      const msg = update?.message;
      if (!msg?.chat?.id) return new Response("ok");
      const chatId = msg.chat.id;
      const t = (msg.text || "").trim();
      const { name } = parseCmd(t);

      // routes
      if (!name || name === "start") { await startCmd(env, chatId, msg.from); return new Response("ok"); }
      if (name === "link")    { await linkCmd(env, chatId, t.split(/\s+/).slice(1)); return new Response("ok"); }
      if (name === "unlink")  { await unlinkCmd(env, chatId); return new Response("ok"); }
      if (name === "transfer"){ await transferCmd(env, chatId); return new Response("ok"); }

      if (name === "plan")   { await planCmd(env, chatId, "A"); return new Response("ok"); }
      if (name === "planb")  { await planCmd(env, chatId, "B"); return new Response("ok"); }
      if (name === "planc")  { await planCmd(env, chatId, "C"); return new Response("ok"); }
      if (name === "pland")  { await planCmd(env, chatId, "D"); return new Response("ok"); }

      await send(env, chatId, "Unknown command. Try /start", "HTML");
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  }
};