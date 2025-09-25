// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV  (stores chat -> teamId)

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/"))
      return plain("OK");

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
      return plain(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return plain("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return plain("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return plain("Bad Request", 400); }
      const msg = update?.message, chat = msg?.chat?.id, t = (msg?.text || "").trim();
      if (!chat || !t) return plain("ok");

      // /start
      if (t.startsWith("/start")) {
        await sendMD(env, chat,
          [
            "*Welcome to the FPL bot*",
            "",
            "*Link your team*",
            "`/linkteam <FPL_TEAM_ID>`",
            "",
            "I’ll reply with value, bank, points and rank.",
            "",
            "Symbols test: £ • ← →"
          ].join("\n")
        );
        return plain("ok");
      }

      // /linkteam <id>
      if (t.startsWith("/linkteam")) {
        const teamId = (t.split(/\s+/)[1] || "").trim();
        if (!/^\d{1,10}$/.test(teamId)) {
          await sendMD(env, chat, [
            "*Usage*",
            "`/linkteam 1234567`",
            "Find your FPL team ID in your team page URL."
          ].join("\n"));
          return plain("ok");
        }

        await env.FPL_BOT_KV.put(kTeam(chat), teamId, { expirationTtl: 31536000 });

        try {
          const [bootstrap, entry] = await Promise.all([getBootstrap(), getEntry(teamId)]);

          const club     = teamNameFromId(bootstrap, entry?.favourite_team) || "-";
          const valueM   = toMillions(entry?.last_deadline_value);
          const bankM    = toMillions(entry?.last_deadline_bank);
          const points   = num(entry?.summary_overall_points);
          const rank     = num(entry?.summary_overall_rank);
          const manager  = [entry?.player_first_name, entry?.player_last_name].filter(Boolean).join(" ").trim() || "-";
          const teamName = entry?.name || `Team ${teamId}`;

          const m = (label, value) => `*${esc(label)}*: ${esc(value)}`;
          const card = [
            "*Linked!*",
            "",
            m("Team",    teamName),
            m("Manager", manager),
            m("Club",    club),
            "",
            m("Value",   `£${valueM}m`),
            m("Bank",    `£${bankM}m`),
            m("Points",  String(points)),
            m("Rank",    formatRank(rank))
          ].join("\n");

          await sendMD(env, chat, card);
        } catch {
          await sendMD(env, chat, "Linked, but I couldn't fetch your team info just now. Please try again in a minute.");
        }
        return plain("ok");
      }

      return plain("ok");
    }

    return plain("Not Found", 404);
  }
};

/* ------------ helpers ------------ */
const plain = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

const kTeam = id => `chat:${id}:team`;

/* Send MarkdownV2 (no code box). We escape dynamic content safely. */
async function sendMD(env, chat_id, mdText) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      chat_id,
      text: mdText,
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true
    })
  }).catch(() => {});
}

/* Escape dynamic text for MarkdownV2 (keeps £, •, arrows as-is) */
function esc(s) {
  return (s ?? "")
    .toString()
    .replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/* ------------ FPL helpers ------------ */
async function getBootstrap() {
  const url = "https://fantasy.premierleague.com/api/bootstrap-static/";
  const cache = caches.default;
  const req = new Request(url, { cf: { cacheTtl: 900, cacheEverything: true } });
  let res = await cache.match(req);
  if (!res) {
    res = await fetch(req);
    res = new Response(res.body, res);
    res.headers.set("Cache-Control", "public, max-age=900");
    await cache.put(req, res.clone());
  }
  return res.json();
}

async function getEntry(teamId) {
  const res = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`, {
    headers: { "accept": "application/json" }
  });
  if (!res.ok) throw new Error("entry fetch failed");
  return res.json();
}

function teamNameFromId(bootstrap, id) {
  if (!id) return null;
  const t = bootstrap?.teams?.find(x => x?.id === id);
  return t?.name || null;
}

function toMillions(n) {
  const v = Number(n);
  if (!isFinite(v)) return "0.0";
  return (v / 10).toFixed(1); // FPL stores tenths of a million
}

const num = n => {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
};

function formatRank(n) {
  if (!Number.isFinite(n) || n <= 0) return "-";
  return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}