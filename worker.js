// worker.js
// Secrets required: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/"))
      return text("OK");

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
      return text(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return text("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }

      const chat = update?.message?.chat?.id;
      const t = (update?.message?.text || "").trim();

      if (!chat) return text("ok");

      if (t.startsWith("/start")) {
        await sendCodeV2(env, chat, symbolsDemo());
        return text("ok");
      }

      if (t.startsWith("/symbols")) {
        await sendCodeV2(env, chat, symbolsDemo());
        return text("ok");
      }

      // ignore other messages quietly
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------------- helpers ---------------- */
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// MarkdownV2 code block sender (monospace font, best glyph coverage)
function escapeForCodeBlock(s) {
  // Inside MarkdownV2 triple backticks, you only need to avoid literal backticks.
  return (s || "").replace(/`/g, "'"); // swap backticks with apostrophes
}

async function sendCodeV2(env, chat_id, body) {
  const payload = {
    chat_id,
    text: "```\n" + escapeForCodeBlock(body) + "\n```",
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true
  };
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

// Minimal, useful symbol set for FPL
function symbolsDemo() {
  return [
    "Symbols check",
    "",
    "Currency: £  $  €  ¥",
    "Arrows:   ←  →  ↑  ↓",
    "Bullet:   •",
    "",
    "Example:",
    "Bank: £1.5m",
    "Team value: £100.2m",
  ].join("\n");
}