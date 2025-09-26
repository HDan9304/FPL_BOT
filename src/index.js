// src/index.js — Cloudflare Worker entry (static imports)
import startCmd     from "./commands/start.js";
import planCmd      from "./commands/plan.js";
import transferCmd  from "./commands/transfer.js";
import linkCmd      from "./commands/link.js";
import unlinkCmd    from "./commands/unlink.js";

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/"))
      return text("OK");

    // One-click webhook init
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

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return text("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }
      const msg = update?.message;
      if (!msg) return text("ok");

      const chatId = msg?.chat?.id;
      const txt    = (msg?.text || "").trim();
      if (!chatId || !txt) return text("ok");

      const [raw] = txt.split(/\s+/);
      const cmd = raw.toLowerCase();

      if (cmd === "/start")    { await startCmd(env, chatId, msg.from); return text("ok"); }
      if (cmd === "/plan")     { await planCmd(env, chatId);            return text("ok"); }
      if (cmd === "/transfer") { await transferCmd(env, chatId);        return text("ok"); }
      if (cmd === "/link")     { await linkCmd(env, chatId, msg);       return text("ok"); }
      if (cmd === "/unlink")   { await unlinkCmd(env, chatId);          return text("ok"); }

      // Fallback
      await startCmd(env, chatId, msg.from);
      return text("ok");
    }

    return text("Not Found", 404);
  }
};