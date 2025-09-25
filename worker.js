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

      // (Optional) nudge unknowns
      // await safeSend(env, chatId, escAll("Type /start to see what I can do."));

      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------- command handlers ---------- */

async function handleStart(env, msg) {
  const chatId = msg.chat.id;
  const firstName = sanitizeAscii((msg.from?.first_name && msg.from.first_name.trim()) || "there");

  // Compose MarkdownV2 message using ASCII-friendly copy
  const title = `*${escAll(`Hey ${firstName}!`)}* `;

  const lines = [
    escAll("I'm your FPL helper bot. I can show gameweek deadlines, fixtures, price changes, and summarize your team."),
    "",
    escAll("- Use /link <YourTeamID> to connect your FPL team"),
    escAll("- Try /gw for the current gameweek overview"),
    escAll("- Need commands? /help"),
    "",
    `${i("Tip: you can set your timezone with")} ${escAll("/tz Asia/Kuala_Lumpur")}`
  ];

  const message = [title, "", ...lines].join("\n");

  // Reply keyboard (buttons: on) — sends real text messages
  const reply_keyboard = {
    keyboard: [
      [{ text: "/help" }, { text: "/gw" }],
      [{ text: "/link" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };

  await safeSend(env, chatId, message, reply_keyboard);
}

/* ---------- HTTP helper ---------- */

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/* ---------- robust Telegram send helpers ---------- */

// Sends with MarkdownV2; if Telegram rejects (parse error), falls back to plain text.
async function safeSend(env, chat_id, message, replyKeyboard) {
  const mdPayload = {
    chat_id,
    text: message,
    parse_mode: "MarkdownV2",
    disable_web_page_preview: true
  };
  if (replyKeyboard) mdPayload.reply_markup = replyKeyboard;

  const r1 = await tg(env, "sendMessage", mdPayload);
  if (r1?.ok) return;

  // If MarkdownV2 failed (commonly "can't parse entities"), try plain text
  const plainPayload = {
    chat_id,
    text: stripMd(message),
    disable_web_page_preview: true
  };
  if (replyKeyboard) plainPayload.reply_markup = replyKeyboard;

  await tg(env, "sendMessage", plainPayload);
}

// Low-level Telegram call that returns the JSON (no silent catch)
async function tg(env, method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

/* ---------- parsing & formatting utils ---------- */

// Command parser for "/command arg1 arg2"
function parseCommand(text) {
  if (!text.startsWith("/")) return { name: "", args: [] };
  const parts = text.split(/\s+/);
  const name = parts[0].slice(1).toLowerCase(); // "/Start"  "start"
  const args = parts.slice(1);
  return { name, args };
}

// Normalize smart punctuation to ASCII so clients never show 
// Apply to any user-provided names/inputs you show back to users.
function sanitizeAscii(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•/g, "-")
    .replace(/\u00A0/g, " "); // non-breaking space  normal space
}

// Escape EVERYTHING Telegram cares about in MarkdownV2
function escAll(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
function i(s) { return `_${escAll(s)}_`; }

// For fallback: remove backslashes that were for MarkdownV2 so plain text reads fine
function stripMd(s) {
  return s.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
}

/* ---------- KV keys ---------- */
const kLastSeen = id => `chat:${id}:last_seen`;