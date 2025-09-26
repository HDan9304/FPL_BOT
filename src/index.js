// src/index.js — entry if you keep the src/ layout

import startCmd    from "../command/start.js";
import linkCmd     from "../command/link.js";
import unlinkCmd   from "../command/unlink.js";
import transferCmd from "../command/transfer.js";
import planCmd     from "../command/plan.js";
import chipCmd     from "../command/chip.js";
import { send }    from "../utils/telegram.js";

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

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
      return text(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return text("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }

      const msg = update?.message;
      if (!msg?.chat?.id) return text("ok");
      const chatId = msg.chat.id;
      const raw = (msg.text || "").trim();

      let cmd = "", arg = "";
      if (raw.startsWith("/")) {
        const sp = raw.indexOf(" ");
        cmd = (sp === -1 ? raw : raw.slice(0, sp)).replace(/@\S+$/,"").toLowerCase();
        arg = sp === -1 ? "" : raw.slice(sp + 1).trim();
      }

      try {
        if (!cmd || cmd === "/start")     { await startCmd(env, chatId, msg.from); return text("ok"); }
        if (cmd === "/link")              { await linkCmd(env, chatId, arg);        return text("ok"); }
        if (cmd === "/unlink")            { await unlinkCmd(env, chatId);           return text("ok"); }
        if (cmd === "/transfer")          { await transferCmd(env, chatId, arg);    return text("ok"); }
        if (cmd === "/plan")              { await planCmd(env, chatId, arg);        return text("ok"); }
        if (cmd === "/chip")              { await chipCmd(env, chatId, arg);        return text("ok"); }
        await send(env, chatId, "Unknown command. Try /start", "HTML");
        return text("ok");
      } catch (e) {
        await send(env, chatId, "Something went wrong. Try again in a bit.", "HTML");
        return text("ok");
      }
    }

    return text("Not Found", 404);
  }
};