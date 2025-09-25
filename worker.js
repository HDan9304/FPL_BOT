// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV   (stores chat -> teamId)

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/"))
      return respondText("OK");

    // One-tap helper to set the Telegram webhook to this Worker URL
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
      return respondText(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return respondText("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return respondText("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return respondText("Bad Request", 400); }

      const msg = update?.message;
      const chatId = msg?.chat?.id;
      const text = (msg?.text || "").trim();
      if (!chatId || !text) return respondText("ok");

      if (text.startsWith("/start")) {
        await sendCodeV2(env, chatId, [
          "Welcome to the FPL bot",
          "",
          "Link your team:",
          "/linkteam <FPL_TEAM_ID>",
          "",
          "After linking, I'll show a quick team summary (value, bank, rank)."
        ].join("\n"));
        return respondText("ok");
      }

      if (text.startsWith("/linkteam")) {
        const teamId = (text.split(/\s+/)[1] || "").trim();
        if (!teamId) {
          await sendCodeV2(env, chatId, "Usage:\n/linkteam 1234567\nFind your FPL team ID in the URL of your team page.");
          return respondText("ok");
        }
        if (!/^\d{1,10}$/.test(teamId)) {
          await sendCodeV2(env, chatId, "That doesn't look like a valid numeric FPL team ID.");
          return respondText("ok");
        }

        // Persist chat -> teamId
        await env.FPL_BOT_KV.put(kTeam(chatId), String(teamId), { expirationTtl: 31536000 });

        // Fetch basic info and show a neat summary
        try {
          const [bootstrap, entry] = await Promise.all([
            getBootstrap(),         // cached at edge
            getEntry(teamId)
          ]);

          const club = teamNameFromId(bootstrap, entry?.favourite_team);
          const valueM = toMillions(entry?.last_deadline_value); // tenths of a million -> £xx.xm
          const bankM  = toMillions(entry?.last_deadline_bank);
          const points = safeNumber(entry?.summary_overall_points);
          const rank   = safeNumber(entry?.summary_overall_rank);

          const manager = [entry?.player_first_name, entry?.player_last_name].filter(Boolean).join(" ").trim();
          const teamName = entry?.name || `Team ${teamId}`;

          const lines = [
            `Linked!`,
            ``,
            `Team:    ${teamName}`,
            manager ? `Manager: ${manager}` : null,
            club ?    `Club:    ${club}` : null,
            ``,
            `Value:   £${valueM}m`,
            `Bank:    £${bankM}m`,
            `Points:  ${points}`,
            `Rank:    ${formatRank(rank)}`
          ].filter(Boolean);

          await sendCodeV2(env, chatId, lines.join("\n"));
        } catch (e) {
          await sendCodeV2(env, chatId, "Linked, but couldn't fetch team info right now. Try again in a minute.");
        }
        return respondText("ok");
      }

      // Quietly ignore everything else for now
      return respondText("ok");
    }

    return respondText("Not Found", 404);
  }
};

/* -------------------- Utilities -------------------- */

const respondText = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

// MarkdownV2 code block sender (monospace → reliable £ and • on most clients)
function escapeForCodeBlock(s) {
  // Inside triple backticks for MarkdownV2, only backticks need escaping.
  return (s || "").replace(/`/g, "'");
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

// KV key
const kTeam = id => `chat:${id}:team`;

/* -------- FPL API helpers -------- */

async function getBootstrap() {
  // Cache bootstrap-static at the edge for 15 minutes
  const url = "https://fantasy.premierleague.com/api/bootstrap-static/";
  const cache = caches.default;
  const req = new Request(url, { cf: { cacheTtl: 900, cacheEverything: true } });
  let res = await cache.match(req);
  if (!res) {
    res = await fetch(req);
    // set explicit caching headers to help edge cache
    res = new Response(res.body, res);
    res.headers.set("Cache-Control", "public, max-age=900");
    await cache.put(req, res.clone());
  }
  return res.json();
}

async function getEntry(teamId) {
  const url = `https://fantasy.premierleague.com/api/entry/${teamId}/`;
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error("entry fetch failed");
  return res.json();
}

function teamNameFromId(bootstrap, id) {
  if (!id) return null;
  const t = bootstrap?.teams?.find(x => x?.id === id);
  return t?.name || null;
}

function toMillions(n) {
  // FPL stores value/bank as tenths of a million (e.g., 1002 -> £100.2m, 15 -> £1.5m)
  const v = Number(n);
  if (!isFinite(v)) return "0.0";
  return (v / 10).toFixed(1);
}

function safeNumber(n) {
  const v = Number(n);
  return isFinite(v) ? v : 0;
}

function formatRank(n) {
  if (!isFinite(Number(n)) || n <= 0) return "-";
  // Simple thousands separators
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}