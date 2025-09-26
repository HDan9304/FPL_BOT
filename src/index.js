import startCmd from "./commands/start.js";
import transferCmd from "./commands/transfer.js";
import { parseCmd } from "./utils/fmt.js";

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/"))
      return new Response("OK", { headers: { "content-type": "text/plain; charset=utf-8" } });

    // Set Telegram webhook
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
      return new Response(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, {
        status: j?.ok ? 200 : 500,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return new Response("Forbidden", { status: 403 });

      let update;
      try { update = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

      const msg = update?.message;
      const chatId = msg?.chat?.id;
      const raw = (msg?.text || "").trim();
      if (!chatId) return new Response("ok");

      const { name } = parseCmd(raw);

      if (name === "transfer") { await transferCmd(env, chatId); return new Response("ok"); }

      await startCmd(env, chatId, msg); // default to /start
      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  }
};
