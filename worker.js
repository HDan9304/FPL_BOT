// worker.js — ultra-minimal bot (start-only, no KV)
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

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
      return text(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return text("Bad Request", 400); }
      const msg = update?.message; if (!msg) return text("ok");
      const chatId = msg?.chat?.id; const raw = (msg?.text || "").trim(); if (!chatId) return text("ok");

      const { name } = parseCmd(raw);
      if (name === "start" || name === "") {
        await send(env, chatId,
`hey — totally fine to pause. 
you can come back anytime.

/start — shows this note again

(when you’re ready: we can add /linkteam, /myteam, etc.)`);
        return text("ok");
      }

      // everything else → same gentle note
      await send(env, chatId,
`got it. i’ve kept things simple.
type /start to see the note again when you’re back.`);
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ------- helpers ------- */
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const parseCmd = (t) => {
  if (!t.startsWith("/")) return { name: "", args: [] };
  const parts = t.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
};

async function send(env, chat_id, message) {
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id, text: message, disable_web_page_preview: true })
    });
  } catch {}
}