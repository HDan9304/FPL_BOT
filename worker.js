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
          // We only need messages for now (reply keyboard will send text messages)
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
      const tRaw = (msg?.text || "");
      const t = tRaw.trim();
      if (!chatId) return text("ok");

      // record in KV to confirm binding works
      await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now()));

      // --- Minimal router (we only handle /start for now) ---
      const cmd = parseCommand(t);
      if (cmd.name === "start") {
        await handleStart(env, msg);
        return text("ok");
      }

      // Unknown / fallback: stay silent or send a tiny nudge
      // (Optional) uncomment to gently point users to /start
      // await sendMd(env, chatId, "Type /start to see what I can do.");
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------- command handlers ---------- */

async function handleStart(env, msg) {
  const chatId = msg.chat.id;
  const firstName = (msg.from?.first_name && msg.from.first_name.trim()) || "there";

  // Compose MarkdownV2 message. Escape dynamic bits to avoid formatting errors.
  const title = b(`Hey ${esc(firstName)}!`) + " 👋";
  const body = [
    "I’m your FPL helper bot. I can show gameweek deadlines, fixtures, price changes, and summarize your team.",
    "",
    "• Use /link <YourTeamID> to connect your FPL team",
    "• Try /gw for the current gameweek overview",
    "• Need commands? /help",
    "",
    i("Tip: you can set your timezone with") + " /tz Asia/Kuala_Lumpur"
  ].join("\n");

  const message = [title, "", body].join("\n");

  // Reply keyboard (buttons: on). This sends actual messages when tapped—no callback handling needed.
  const reply_keyboard = {
    keyboard: [
      [{ text: "/help" }, { text: "/gw" }],
      [{ text: "/link" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };

  await sendMd(env, chatId, message, reply_keyboard);
}

/* ---------- helpers ---------- */

// Plain text response helper (HTTP)
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// Telegram send (plain)
async function send(env, chat_id, message) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text: message, disable_web_page_preview: true })
  }).catch(() => {});
}

// Telegram send (MarkdownV2 + optional reply keyboard)
async function sendMd(env, chat_id, message, replyKeyboard /* object or undefined */) {
  const payload = {
    chat_id,
    text: message,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true
  };
  if (replyKeyboard) payload.reply_markup = replyKeyboard;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  }).catch(() => {});
}

// Command parser for "/command arg1 arg2"
function parseCommand(text) {
  if (!text.startsWith("/")) return { name: "", args: [] };
  const parts = text.split(/\s+/);
  const name = parts[0].slice(1).toLowerCase(); // "/Start" → "start"
  const args = parts.slice(1);
  return { name, args };
}

// MarkdownV2 escaping (per Telegram docs) for dynamic content
function esc(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
function b(s) { return `*${esc(s)}*`; }  // bold
function i(s) { return `_${esc(s)}_`; }  // italic

const kLastSeen = id => `chat:${id}:last_seen`;