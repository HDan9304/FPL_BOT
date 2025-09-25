// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV   (stores chat:<id>:last_seen, user:<chatId>:profile)

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

      // --- Minimal router ---
      const cmd = parseCommand(t);
      switch (cmd.name) {
        case "start":
          await handleStart(env, msg);
          break;
        case "linkteam":
          await handleLinkTeam(env, msg, cmd.args);
          break;
        default:
          // (Optional) nudge unknowns
          // await safeSend(env, chatId, escAll("Type /start to see what I can do."));
          break;
      }

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
    escAll("- Use /linkteam <YourTeamID> to connect your FPL team"),
    escAll("- Try /gw for the current gameweek overview"),
    escAll("- Need commands? /help"),
    "",
    `${i("Tip: you can set your timezone with")} ${escAll("/tz Asia/Kuala_Lumpur")}`
  ];

  const message = [title, "", ...lines].join("\n");

  const reply_keyboard = {
    keyboard: [
      [{ text: "/help" }, { text: "/gw" }],
      [{ text: "/linkteam" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };

  await safeSend(env, chatId, message, reply_keyboard);
}

async function handleLinkTeam(env, msg, args) {
  const chatId = msg.chat.id;

  // 1) Parse & validate argument
  const idRaw = (args[0] || "").trim();
  if (!idRaw) {
    const usage = [
      `*${escAll("Link your FPL team")}*`,
      "",
      escAll("Usage:"),
      escAll("/linkteam <YourTeamID>"),
      "",
      escAll("Example:"),
      escAll("/linkteam 1234567")
    ].join("\n");
    await safeSend(env, chatId, usage);
    return;
  }
  const teamId = Number(idRaw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await safeSend(env, chatId, escAll("Please provide a valid numeric team ID, e.g. /linkteam 1234567"));
    return;
  }

  // 2) Validate with FPL API
  const entry = await fplEntry(env, teamId);
  if (!entry) {
    await safeSend(env, chatId, escAll("I couldn't find that team. Double-check the ID and try again."));
    return;
  }

  // 3) Save to KV profile
  const now = Date.now();
  const profile = {
    teamId,
    createdAt: now,
    updatedAt: now
    // tz will be added later by /tz
  };
  await env.FPL_BOT_KV.put(kUserProfile(chatId), JSON.stringify(profile));

  // 4) Confirm to user
  const teamName = sanitizeAscii(`${entry.name || "Team"}`);
  const playerName = sanitizeAscii(`${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim());

  const title = `*${escAll("Team linked successfully")}* `;
  const lines = [
    `${escAll("Team:")} ${b(teamName)}`,
    playerName ? `${escAll("Manager:")} ${escAll(playerName)}` : "",
    `${escAll("Team ID:")} ${escAll(String(teamId))}`,
    "",
    escAll("You're all set! Try these:"),
    escAll("- /gw  (current gameweek overview)"),
    escAll("- /team  (your team summary)")
  ].filter(Boolean);

  const message = [title, "", ...lines].join("\n");

  const reply_keyboard = {
    keyboard: [
      [{ text: "/gw" }, { text: "/team" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: true
  };

  await safeSend(env, chatId, message, reply_keyboard);
}

/* ---------- HTTP helper ---------- */

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/* ---------- Telegram send helpers ---------- */

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

/* ---------- FPL API helpers ---------- */

async function fplEntry(env, teamId) {
  const url = `https://fantasy.premierleague.com/api/entry/${teamId}/`;
  try {
    const r = await fetch(url, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    // Defensive: some 200s can still be HTML; try/catch JSON
    const j = await r.json().catch(() => null);
    if (!j || typeof j !== "object") return null;
    // Basic shape check
    if (j.id !== teamId && typeof j.id !== "number") return null;
    return j;
  } catch {
    return null;
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
function sanitizeAscii(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/•/g, "-")
    .replace(/\u00A0/g, " "); // non-breaking space  normal space
}

// MarkdownV2 escaping
function escAll(s) {
  return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}
function b(s) { return `*${escAll(s)}*`; }
function i(s) { return `_${escAll(s)}_`; }

// For fallback: remove backslashes that were for MarkdownV2 so plain text reads fine
function stripMd(s) {
  return s.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
}

/* ---------- KV keys ---------- */
const kLastSeen = id => `chat:${id}:last_seen`;
const kUserProfile = chatId => `user:${chatId}:profile`;