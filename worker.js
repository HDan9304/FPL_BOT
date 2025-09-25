// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV: FPL_BOT_KV (chat:<id>:last_seen, user:<chatId>:profile)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

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

    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return text("Bad Request", 400); }
      const msg = update?.message;
      const chatId = msg?.chat?.id;
      const t = (msg?.text || "").trim();
      if (!chatId) return text("ok");

      await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now()));

      const cmd = parseCommand(t);
      switch (cmd.name) {
        case "start":    await handleStart(env, msg); break;
        case "linkteam": await handleLinkTeam(env, msg, cmd.args); break;
        default: /* minimal fallback */ break;
      }
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------- commands ---------- */

async function handleStart(env, msg) {
  const chatId = msg.chat.id;
  const first = sanitizeAscii((msg.from?.first_name || "there").trim());

  const message = [
    `*${escAll(`Hey ${first}`)}!*`,
    "",
    escAll("I'm your FPL helper. I can show deadlines, fixtures, price changes, and summarize your team."),
    "",
    escAll("- Link your team: /linkteam <YourTeamID>"),
    escAll("- Current gameweek: /gw"),
    escAll("- Help: /help")
  ].join("\n");

  await safeSend(env, chatId, message);
}

async function handleLinkTeam(env, msg, args) {
  const chatId = msg.chat.id;
  const idRaw = (args[0] || "").trim();

  if (!idRaw) {
    const linesTop = [
      `*${escAll("Link your FPL team")}*`,
      "",
      escAll("Where to find your Team ID:"),
      escAll("1) Open fantasy.premierleague.com and go to My Team"),
      escAll("2) Look at the URL: it shows /entry/1234567/ — that's your ID"),
      escAll("3) Send the command like this:")
    ].join("\n");

    // raw fenced code block (do NOT escape)
    const usageBlock = "```\n/linkteam 1234567\n```";

    await safeSend(env, chatId, `${linesTop}\n${usageBlock}`);
    return;
  }

  const teamId = Number(idRaw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await safeSend(env, chatId, escAll("Please provide a valid numeric team ID, e.g. /linkteam 1234567"));
    return;
  }

  const entry = await fplEntry(teamId);
  if (!entry) {
    await safeSend(env, chatId, escAll("I couldn't find that team. Double-check the ID and try again."));
    return;
  }

  const now = Date.now();
  await env.FPL_BOT_KV.put(kUserProfile(chatId), JSON.stringify({ teamId, createdAt: now, updatedAt: now }));

  const teamName = sanitizeAscii(`${entry.name || "Team"}`);
  const manager  = sanitizeAscii(`${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim());

  const message = [
    `*${escAll("Team linked")}* `,
    `${escAll("Team:")} ${b(teamName)}`,
    manager ? `${escAll("Manager:")} ${escAll(manager)}` : "",
    `${escAll("Team ID:")} ${escAll(String(teamId))}`,
    "",
    escAll("Next:"),
    escAll("- /gw   (current gameweek)"),
    escAll("- /team (your team summary)")
  ].filter(Boolean).join("\n");

  await safeSend(env, chatId, message);
}

/* ---------- HTTP ---------- */
const text = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/* ---------- Telegram ---------- */

async function safeSend(env, chat_id, message) {
  const r1 = await tg(env, "sendMessage", { chat_id, text: message, parse_mode: "MarkdownV2", disable_web_page_preview: true });
  if (r1?.ok) return;
  await tg(env, "sendMessage", { chat_id, text: stripMd(message), disable_web_page_preview: true });
}

async function tg(env, method, payload) {
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(payload)
    });
    return await r.json();
  } catch { return { ok: false }; }
}

/* ---------- FPL ---------- */

async function fplEntry(teamId) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || (j.id !== teamId && typeof j.id !== "number")) return null;
    return j;
  } catch { return null; }
}

/* ---------- utils ---------- */

function parseCommand(text) {
  if (!text.startsWith("/")) return { name: "", args: [] };
  const [cmd, ...args] = text.split(/\s+/);
  return { name: cmd.slice(1).toLowerCase(), args };
}

function sanitizeAscii(s) {
  return String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/•/g, "-").replace(/\u00A0/g, " ");
}

function escAll(s) { return String(s).replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&"); }
function b(s) { return `*${escAll(s)}*`; }
function stripMd(s) { return s.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1"); }

/* ---------- KV keys ---------- */
const kLastSeen = id => `chat:${id}:last_seen`;
const kUserProfile = chatId => `user:${chatId}:profile`;