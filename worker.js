// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV   (we'll just write a "last_seen" key to prove KV works)

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/"))
      return txt("OK");

    // One-tap: set Telegram webhook to this Worker URL
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
      return txt(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook (baseline: only /start)
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return txt("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return txt("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return txt("Bad Request", 400); }
      const msg = update?.message, chat = msg?.chat?.id, t = (msg?.text || "").trim();
      if (!chat) return txt("ok");

      // prove KV works (records last time this chat hit the bot)
      await env.FPL_BOT_KV.put(kLastSeen(chat), String(Date.now()));

      if (t && t.startsWith("/start")) {
        await send(env, chat,
`Bot is alive.

Use /start to see this message again.
(£ • ← → test: normal text)`);
      }

      return txt("ok");
    }

    return txt("Not Found", 404);
  }
};

/* ------------- helpers ------------- */
const txt = (s, status=200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

async function send(env, chat_id, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text, disable_web_page_preview: true })
  }).catch(()=>{});
}

// KV keys
const kLastSeen = id => `chat:${id}:last_seen`;