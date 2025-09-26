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
        default: /* silent */ break;
      }
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------- HTTP helper (single definition) ---------- */
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/* ---------- commands ---------- */

async function handleStart(env, msg) {
  const chatId = msg.chat.id;
  const first = sanitizeAscii((msg.from?.first_name || "there").trim());

  const html = [
    `<b>${htmlEsc(`Hey ${first}!`)}</b>`,
    ``,
    htmlEsc(`I show a clean, current-GW overview of your FPL squad.`),
    ``,
    `${boldLabel("Link Team")} <code>/linkteam &lt;YourTeamID&gt;</code>`,
    ``,
    `${boldLabel("My Team (Current GW)")} <code>/myteam</code>`
  ].join("\n");

  await sendHTML(env, chatId, html, keyboardMain());
}

async function handleLinkTeam(env, msg, args) {
  const chatId = msg.chat.id;
  const idRaw = (args[0] || "").trim();

  if (!idRaw) {
    const guide = [
      `<b>${htmlEsc("Link Your FPL Team")}</b>`,
      ``,
      `${boldLabel("Where To Find Team ID")} ${htmlEsc("Open fantasy.premierleague.com -> My Team")}`,
      `${htmlEsc("Look at the URL:")} <code>/entry/1234567/</code> ${htmlEsc("- that's your ID")}`,
      ``,
      `${boldLabel("How To Link")}`,
      `<pre><code>/linkteam 1234567</code></pre>`
    ].join("\n");
    await sendHTML(env, chatId, guide, keyboardMain());
    return;
  }

  const teamId = Number(idRaw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await sendHTML(env, chatId, `${boldLabel("Tip")} ${htmlEsc("Use a numeric ID, e.g.")} <code>/linkteam 1234567</code>`, keyboardMain());
    return;
  }

  const entry = await fplEntry(teamId);
  if (!entry) {
    await sendHTML(env, chatId, `${boldLabel("Not Found")} ${htmlEsc("That team ID didn’t resolve. Double-check and try again.")}`, keyboardMain());
    return;
  }

  const now = Date.now();
  await env.FPL_BOT_KV.put(kUserProfile(chatId), JSON.stringify({ teamId, createdAt: now, updatedAt: now }));

  const teamName = sanitizeAscii(`${entry.name || "Team"}`);
  const manager  = sanitizeAscii(`${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim());

  const html = [
    `<b>${htmlEsc("Team Linked")}</b> ✅`,
    ``,
    `${boldLabel("Team")} <b>${htmlEsc(teamName)}</b>`,
    manager ? `${boldLabel("Manager")} ${htmlEsc(manager)}` : "",
    `${boldLabel("Team ID")} ${htmlEsc(String(teamId))}`,
    ``,
    `${boldLabel("Next")} <code>/myteam</code> ${htmlEsc("(current GW)")}`
  ].filter(Boolean).join("\n");

  await sendHTML(env, chatId, html, keyboardMain());
}

async function handleMyTeam(env, msg) {
  const chatId = msg.chat.id;
  const prof = await env.FPL_BOT_KV.get(kUserProfile(chatId)).then(j => j && JSON.parse(j)).catch(() => null);
  const teamId = prof?.teamId;
  if (!teamId) {
    const html = [
      `${boldLabel("No Team Linked")} ${htmlEsc("Add your team first:")}`,
      ``,
      `<code>/linkteam &lt;YourTeamID&gt;</code>`
    ].join("\n");
    await sendHTML(env, chatId, html, keyboardMain());
    return;
  }

  // Bootstrap (current event + elements & teams)
  const boot = await fplBootstrap();
  if (!boot) { await sendHTML(env, chatId, `${boldLabel("Busy")} ${htmlEsc("FPL is busy. Try again shortly.")}`, keyboardMain()); return; }

  const events = boot.events || [];
  const elements = boot.elements || [];
  const teams = boot.teams || [];
  const elById = new Map(elements.map(e => [e.id, e]));
  const teamShort = (tid) => {
    const t = teams.find(x => x.id === tid);
    return t ? t.short_name : "";
  };

  const currentEvent = events.find(e => e.is_current)
                    || events.filter(e => e.finished).sort((a,b)=>b.id-a.id)[0]
                    || null;
  if (!currentEvent) { await sendHTML(env, chatId, `${boldLabel("Oops")} ${htmlEsc("Couldn't determine the current gameweek.")}`, keyboardMain()); return; }
  const gw = currentEvent.id;

  // Entry + history + picks + live (for per-player points/bonus) 
  const [entry, history, picks, live] = await Promise.all([
    fplEntry(teamId),
    fplEntryHistory(teamId),
    fplEntryPicks(teamId, gw),
    fplEventLive(gw)
  ]);
  if (!entry || !history || !picks || !live) {
    await sendHTML(env, chatId, `${boldLabel("Error")} ${htmlEsc("Couldn't load your team right now.")}`, keyboardMain());
    return;
  }

  const thisGw = (history.current || []).find(r => r.event === gw);
  const points = thisGw?.points ?? null;
  const rank   = thisGw?.overall_rank ?? thisGw?.rank ?? null;
  const value  = thisGw?.value ?? history?.current?.slice(-1)?.[0]?.value ?? entry?.value ?? null; // tenths
  const bank   = thisGw?.bank ?? history?.current?.slice(-1)?.[0]?.bank ?? entry?.bank ?? null;

  // Chips: active chip + available chips (based on history.chips played)
  const activeChip = picks.active_chip || null;
  const played = (history.chips || []).map(c => c.name);
  const remaining = remainingChips(played);

  // Live points map & bonus extraction
  const liveById = new Map();
  (live.elements || []).forEach(e => {
    const id = e.id;
    const total = e.stats?.total_points ?? 0;
    let bonus = 0;
    if (Array.isArray(e.explain)) {
      for (const ex of e.explain) {
        for (const st of (ex.stats || [])) if (st.identifier === "bonus") bonus += (st.points || 0);
      }
    } else if (typeof e.stats?.bonus === "number") {
      bonus = e.stats.bonus;
    }
    liveById.set(id, { total, bonus });
  });

  // Build squad: starters (positions 1–11) then bench (12–15)
  const picksArr = (picks.picks || []).slice().sort((a,b) => a.position - b.position);
  const starters = picksArr.filter(p => p.position <= 11);
  const bench    = picksArr.filter(p => p.position >= 12);

  const fmtMoney = (v) => (typeof v === "number" ? (v/10).toFixed(1) : "-");
  const fmtNum   = (n) => (typeof n === "number" ? n.toLocaleString("en-GB") : "-");

  const capEl = starters.find(p => p.is_captain)?.element;
  const vcEl  = picksArr.find(p => p.is_vice_captain)?.element;

  const lineForPick = (p) => {
    const el = elById.get(p.element);
    if (!el) return null;
    const liveStats = liveById.get(p.element) || { total: 0, bonus: 0 };
    const name = `${el.web_name}`;
    const club = teamShort(el.team);
    const posMap = {1:"GKP",2:"DEF",3:"MID",4:"FWD"};
    const pos = posMap[el.element_type] || "";
    const isCap = p.element === capEl;
    const isVC  = p.element === vcEl;
    const mult  = p.multiplier || 0;

    const rawPts = liveStats.total;
    const effPts = rawPts * mult;
    const bonusSuffix = liveStats.bonus > 0 ? ` ${htmlEsc("(+" + liveStats.bonus + " bonus)")}` : "";
    const multNote = mult === 0 ? " (bench)" : (mult === 1 ? "" : " (x" + mult + "=" + effPts + ")");

    const tag = isCap ? " (C)" : (isVC ? " (VC)" : "");

    return `${htmlEsc(name + tag)} ${htmlEsc("(" + pos + " - " + club + ")")}\n${boldLabel("Points")} ${htmlEsc(String(rawPts))}${bonusSuffix}${htmlEsc(multNote)}`;
  };

  const startersLines = starters.map(lineForPick).filter(Boolean);
  const benchLines    = bench.map(lineForPick).filter(Boolean);

  const teamName = sanitizeAscii(`${entry.name || "Team"}`);

  const header = [
    `<b>${htmlEsc(teamName)}</b>`,
    htmlEsc("Gameweek " + gw + " (current)")
  ].join("\n");

  const overview = [
    points != null ? `${boldLabel("Points")} <b>${htmlEsc(String(points))}</b>` : "",
    rank   != null ? `${boldLabel("Overall Rank")} ${htmlEsc(fmtNum(rank))}` : "",
    value  != null ? `${boldLabel("Team Value")} ${htmlEsc(fmtMoney(value))}` : "",
    bank   != null ? `${boldLabel("Bank")} ${htmlEsc(fmtMoney(bank))}` : "",
    capEl  ? `${boldLabel("Captain")} ${htmlEsc(elById.get(capEl)?.web_name || "")}` : "",
    vcEl   ? `${boldLabel("Vice-Captain")} ${htmlEsc(elById.get(vcEl)?.web_name || "")}` : ""
  ].filter(Boolean).join("\n");

  const chipsBlock = [
    activeChip ? `${boldLabel("Active Chip")} ${htmlEsc(prettyChip(activeChip))}` : `${boldLabel("Active Chip")} ${htmlEsc("None")}`,
    `${boldLabel("Available Chips")} ${htmlEsc(remaining.join(", ") || "None")}`
  ].join("\n");

  const html = [
    header,
    ``,
    overview,
    ``,
    `${boldLabel("Starting XI")}`,
    startersLines.length ? startersLines.map(s => `- ${s}`).join("\n\n") : htmlEsc("No starters found."),
    ``,
    `${boldLabel("Bench")}`,
    benchLines.length ? benchLines.map(s => `- ${s}`).join("\n\n") : htmlEsc("No bench found."),
    ``,
    chipsBlock
  ].join("\n");

  await sendHTML(env, chatId, html, keyboardMain());
}

/* ---------- Telegram (HTML) ---------- */

// Reply keyboard (clean & minimal)
function keyboardMain() {
  return {
    keyboard: [
      [{ text: "/myteam" }, { text: "/linkteam" }]
    ],
    resize_keyboard: true,
    one_time_keyboard: false
  };
}

async function sendHTML(env, chat_id, html, replyKeyboard) {
  const payload = { chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true };
  if (replyKeyboard) payload.reply_markup = replyKeyboard;

  const r1 = await tg(env, "sendMessage", payload);
  if (r1?.ok) return;

  // fallback: plain text
  const plain = stripHtml(html);
  const payload2 = { chat_id, text: plain, disable_web_page_preview: true };
  if (replyKeyboard) payload2.reply_markup = replyKeyboard;
  await tg(env, "sendMessage", payload2);
}

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

async function fplEventLive(gw) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/event/${gw}/live/`, { cf: { cacheTtl: 30 } });
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

// Chips remaining calculation
function remainingChips(playedNames) {
  const counts = { wildcard: 0, freehit: 0, bench_boost: 0, triple_captain: 0 };
  for (const n of playedNames) if (n in counts) counts[n]++;
  const rem = [];
  // Wildcards: up to 2 per season
  const wcLeft = Math.max(0, 2 - counts.wildcard);
  if (wcLeft > 0) rem.push(wcLeft === 2 ? "Wildcard x2" : "Wildcard");
  if (counts.freehit === 0) rem.push("Free Hit");
  if (counts.bench_boost === 0) rem.push("Bench Boost");
  if (counts.triple_captain === 0) rem.push("Triple Captain");
  return rem;
}
function prettyChip(name) {
  const map = { freehit: "Free Hit", bench_boost: "Bench Boost", triple_captain: "Triple Captain", wildcard: "Wildcard" };
  return map[name] || name;
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
function stripHtml(s) { return s.replace(/<[^>]+>/g, ""); }

// Label helper: **Bold first word**
function boldLabel(label) { return `<b>${htmlEsc(label)}:</b>`; }

/* ---------- KV keys ---------- */
const kLastSeen     = id => `chat:${id}:last_seen`;
const kUserProfile  = chatId => `user:${chatId}:profile`;