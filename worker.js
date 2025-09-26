// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV: FPL_BOT_KV (chat:<id>:last_seen, user:<chatId>:profile)

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // One-click webhook init
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
      const msg = update?.message;
      const chatId = msg?.chat?.id;
      const t = (msg?.text || "").trim();
      if (!chatId) return text("ok");

      // heartbeat
      await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now()));

      const cmd = parseCommand(t);
      switch (cmd.name) {
        case "start":    await handleStart(env, msg); break;
        case "linkteam": await handleLinkTeam(env, msg, cmd.args); break;
        case "myteam":   await handleMyTeam(env, msg); break;
        default: /* silent for now */ break;
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

  const html = [
    `<b>${htmlEsc(`Hey ${first}!`)}</b>`,
    ``,
    htmlEsc(`I'm your FPL helper. I can show your current gameweek stats and summarize your linked team.`),
    ``,
    `${htmlEsc(`Link your team:`)}  <code>/linkteam &lt;YourTeamID&gt;</code>`,
    ``,
    `${htmlEsc(`Your team (this GW):`)}  <code>/myteam</code>`
  ].join("\n");

  await sendHTML(env, chatId, html);
}

async function handleLinkTeam(env, msg, args) {
  const chatId = msg.chat.id;
  const idRaw = (args[0] || "").trim();

  if (!idRaw) {
    const guide = [
      `<b>${htmlEsc("Link your FPL team")}</b>`,
      ``,
      htmlEsc("Where to find your Team ID:"),
      htmlEsc("1) Open fantasy.premierleague.com and go to My Team"),
      htmlEsc("2) Look at the URL: it shows /entry/1234567/ - that's your ID"),
      ``,
      htmlEsc("Send the command like this:"),
      `<pre><code>/linkteam 1234567</code></pre>`
    ].join("\n");
    await sendHTML(env, chatId, guide);
    return;
  }

  const teamId = Number(idRaw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await sendHTML(env, chatId, htmlEsc("Please provide a valid numeric team ID, e.g. /linkteam 1234567"));
    return;
  }

  const entry = await fplEntry(teamId);
  if (!entry) {
    await sendHTML(env, chatId, htmlEsc("I couldn't find that team. Double-check the ID and try again."));
    return;
  }

  const now = Date.now();
  await env.FPL_BOT_KV.put(kUserProfile(chatId), JSON.stringify({ teamId, createdAt: now, updatedAt: now }));

  const teamName = sanitizeAscii(`${entry.name || "Team"}`);
  const manager  = sanitizeAscii(`${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim());

  const html = [
    `<b>${htmlEsc("Team linked")}</b> ✅`,
    ``,
    `${htmlEsc("Team:")}  <b>${htmlEsc(teamName)}</b>`,
    manager ? `${htmlEsc("Manager:")}  ${htmlEsc(manager)}` : "",
    `${htmlEsc("Team ID:")}  ${htmlEsc(String(teamId))}`,
    ``,
    htmlEsc("Next:"),
    `<code>/myteam</code>  ${htmlEsc("(your team this GW)")}`
  ].filter(Boolean).join("\n");

  await sendHTML(env, chatId, html);
}

async function handleMyTeam(env, msg) {
  const chatId = msg.chat.id;
  const prof = await env.FPL_BOT_KV.get(kUserProfile(chatId)).then(j => j && JSON.parse(j)).catch(() => null);
  const teamId = prof?.teamId;
  if (!teamId) {
    const html = [
      htmlEsc("You haven't linked a team yet."),
      ``,
      `${htmlEsc("Use:")}  <code>/linkteam &lt;YourTeamID&gt;</code>`
    ].join("\n");
    await sendHTML(env, chatId, html);
    return;
  }

  // Bootstrap for current event + player names
  const boot = await fplBootstrap();
  if (!boot) { await sendHTML(env, chatId, htmlEsc("FPL is busy. Try again shortly.")); return; }

  const currentEvent = (boot.events || []).find(e => e.is_current)
                    || (boot.events || []).filter(e => e.finished).sort((a,b)=>b.id-a.id)[0]
                    || null;
  if (!currentEvent) { await sendHTML(env, chatId, htmlEsc("Couldn't determine the current gameweek.")); return; }
  const gw = currentEvent.id;

  // Entry + history + picks (for captain)
  const [entry, history, picks] = await Promise.all([
    fplEntry(teamId),
    fplEntryHistory(teamId),
    fplEntryPicks(teamId, gw)
  ]);
  if (!entry || !history) { await sendHTML(env, chatId, htmlEsc("Couldn't load your team right now.")); return; }

  const thisGw = (history.current || []).find(r => r.event === gw);
  const points = thisGw?.points ?? null;
  const rank   = thisGw?.overall_rank ?? thisGw?.rank ?? null;
  const value  = thisGw?.value ?? history?.current?.slice(-1)?.[0]?.value ?? entry?.value ?? null; // tenths
  const bank   = thisGw?.bank ?? history?.current?.slice(-1)?.[0]?.bank ?? entry?.bank ?? null;

  // Captain name
  let captainName = null;
  if (picks?.picks?.length) {
    const capEl = picks.picks.find(p => p.is_captain)?.element;
    if (capEl) {
      const el = (boot.elements || []).find(e => e.id === capEl);
      if (el) captainName = `${el.web_name}`;
    }
  }

  const teamName = sanitizeAscii(`${entry.name || "Team"}`);
  const fmtMoney = (v) => (typeof v === "number" ? (v/10).toFixed(1) : "-");
  const fmtNum   = (n) => (typeof n === "number" ? n.toLocaleString("en-GB") : "-");

  // Clear section spacing via blank lines
  const html = [
    `<b>${htmlEsc(teamName)}</b>`,
    htmlEsc(`Gameweek ${gw} (current)`),
    ``,
    points != null ? `${htmlEsc("Points:")}  <b>${htmlEsc(String(points))}</b>` : "",
    rank   != null ? `${htmlEsc("Overall rank:")}  ${htmlEsc(fmtNum(rank))}` : "",
    value  != null ? `${htmlEsc("Team value:")}  ${htmlEsc(fmtMoney(value))}` : "",
    bank   != null ? `${htmlEsc("Bank:")}  ${htmlEsc(fmtMoney(bank))}` : "",
    captainName ? `${htmlEsc("Captain:")}  ${htmlEsc(captainName)}` : ""
  ].filter(Boolean).join("\n");

  await sendHTML(env, chatId, html);
}

/* ---------- HTTP ---------- */
const text = (s, status = 200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/* ---------- Telegram (HTML) ---------- */

async function sendHTML(env, chat_id, html) {
  const r1 = await tg(env, "sendMessage", { chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true });
  if (r1?.ok) return;
  await tg(env, "sendMessage", { chat_id, text: stripHtml(html), disable_web_page_preview: true });
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

async function fplBootstrap() {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/bootstrap-static/`, { cf: { cacheTtl: 60 } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

async function fplEntry(teamId) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    if (!j || (j.id !== teamId && typeof j.id !== "number")) return null;
    return j;
  } catch { return null; }
}

async function fplEntryHistory(teamId) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

async function fplEntryPicks(teamId, gw) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

/* ---------- utils ---------- */

function parseCommand(text) {
  if (!text.startsWith("/")) return { name: "", args: [] };
  const [cmd, ...args] = text.split(/\s+/);
  return { name: cmd.slice(1).toLowerCase(), args };
}

// Normalize smart punctuation -> ASCII
function sanitizeAscii(s) {
  return String(s)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\u2014|\u2013/g, "-")
    .replace(/•/g, "-")
    .replace(/\u00A0/g, " ");
}

// Escape for HTML parse_mode
function htmlEsc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// Plain text fallback
function stripHtml(s) { return s.replace(/<[^>]+>/g, ""); }

/* ---------- KV keys ---------- */
const kLastSeen     = id => `chat:${id}:last_seen`;
const kUserProfile  = chatId => `user:${chatId}:profile`;