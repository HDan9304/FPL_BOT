// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // health
    if (req.method === "GET" && (path === "" || path === "/"))
      return new Response("OK", { headers: { "content-type": "text/plain; charset=utf-8" } });

    // quick helper to set webhook to this Worker URL
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
      const ok = j && j.ok;
      return new Response(ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, {
        status: ok ? 200 : 500,
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    // telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return new Response("Forbidden", { status: 403 });

      let update;
      try { update = await req.json(); } catch { return new Response("Bad Request", { status: 400 }); }

      const msg = update?.message;
      const chatId = msg?.chat?.id;
      const text = (msg?.text || "").trim();

      if (chatId && text.startsWith("/start")) {
        await send(env, chatId,
          "Welcome! This bot is alive.\n\nUse /start to see this message again."
        );
      }

      return new Response("ok");
    }

    return new Response("Not Found", { status: 404 });
  }
};

async function send(env, chat_id, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text, disable_web_page_preview: true })
  }).catch(() => {});
}