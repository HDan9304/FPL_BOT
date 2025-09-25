// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV   (stores chat:<id>:last_seen)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/"))
      return text("OK");

    // Helper: set Telegram webhook to this Worker URL
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
      const chatId = msg?.chat?.id;
      const t = (msg?.text || "").trim();
      if (!chatId) return text("ok");

      // record in KV to confirm binding works
      await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now()));

      if (t.startsWith("/start")) {
        await send(env, chatId,
"Bot is alive.\n\nUse /start to see this message again.");
      }

      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------- helpers ---------- */
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function send(env, chat_id, message) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text: message, disable_web_page_preview: true })
  }).catch(() => {});
}

const kLastSeen = id => `chat:${id}:last_seen`;