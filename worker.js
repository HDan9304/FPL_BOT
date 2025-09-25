// worker.js
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV (stores chat -> teamId)

export default {
  async fetch(req, env) {
    const url = new URL(req.url), path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/"))
      return txt("OK");

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
      return txt(j?.ok ? "webhook set" : `failed: ${j?.description||"unknown"}`, j?.ok?200:500);
    }

    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return txt("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return txt("Forbidden",403);

      let update; try { update = await req.json(); } catch { return txt("Bad Request",400); }
      const msg = update?.message, chat = msg?.chat?.id, t = (msg?.text||"").trim();
      if (!chat || !t) return txt("ok");

      if (t.startsWith("/start")) {
        await send(env, chat,
`Welcome to the FPL bot

Link your team:
/linkteam <FPL_TEAM_ID>

I can show you team info like value, bank, and rank.

Symbols test:
£ ¢ € ¥ • ← → ↑ ↓`);
        return txt("ok");
      }

      if (t.startsWith("/linkteam")) {
        const teamId = (t.split(/\s+/)[1]||"").trim();
        if (!/^\d{1,10}$/.test(teamId)) {
          await send(env, chat, "Usage:\n/linkteam 1234567");
          return txt("ok");
        }
        await env.FPL_BOT_KV.put(kTeam(chat), teamId, { expirationTtl: 31536000 });

        try {
          const [bootstrap, entry] = await Promise.all([getBootstrap(), getEntry(teamId)]);
          const club = teamNameFromId(bootstrap, entry?.favourite_team);
          const valueM = toMillions(entry?.last_deadline_value);
          const bankM  = toMillions(entry?.last_deadline_bank);
          const points = num(entry?.summary_overall_points);
          const rank   = num(entry?.summary_overall_rank);
          const manager = [entry?.player_first_name, entry?.player_last_name].filter(Boolean).join(" ").trim();
          const teamName = entry?.name || `Team ${teamId}`;

          await send(env, chat,
`Linked!

Team:    ${teamName}
Manager: ${manager || "-"}
Club:    ${club || "-"}

Value:   £${valueM}m
Bank:    £${bankM}m
Points:  ${points}
Rank:    ${formatRank(rank)}`);
        } catch {
          await send(env, chat, "Linked, but couldn't fetch team info right now.");
        }
        return txt("ok");
      }

      return txt("ok");
    }

    return txt("Not Found",404);
  }
};

/* ---------- helpers ---------- */
const txt = (s, status=200)=>new Response(s,{status,headers:{"content-type":"text/plain; charset=utf-8"}});
const kTeam = id => `chat:${id}:team`;

async function send(env, chat_id, text) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method:"POST",
    headers:{ "content-type":"application/json; charset=utf-8" },
    body: JSON.stringify({ chat_id, text, disable_web_page_preview:true })
  }).catch(()=>{});
}

/* ---------- FPL helpers ---------- */
async function getBootstrap() {
  const url = "https://fantasy.premierleague.com/api/bootstrap-static/";
  const cache = caches.default;
  const req = new Request(url, { cf:{cacheTtl:900,cacheEverything:true} });
  let res = await cache.match(req);
  if (!res) {
    res = await fetch(req);
    res = new Response(res.body, res);
    res.headers.set("Cache-Control","public, max-age=900");
    await cache.put(req,res.clone());
  }
  return res.json();
}

async function getEntry(teamId) {
  const res = await fetch(`https://fantasy.premierleague.com/api/entry/${teamId}/`, {
    headers:{ "accept":"application/json" }
  });
  if (!res.ok) throw new Error("entry fetch failed");
  return res.json();
}

function teamNameFromId(bootstrap, id) {
  if (!id) return null;
  const t = bootstrap?.teams?.find(x=>x?.id===id);
  return t?.name||null;
}
function toMillions(n){const v=Number(n);return isFinite(v)?(v/10).toFixed(1):"0.0";}
function num(n){const v=Number(n);return isFinite(v)?v:0;}
function formatRank(n){if(!isFinite(n)||n<=0)return "-";return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g,",");}