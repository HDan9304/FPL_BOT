// worker.js — v0 minimal, fresh start
// Env bindings:
//   Secrets: BOT_TOKEN, WEBHOOK_SECRET
//   KV: TEAM_KV

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // health
    if (req.method === "GET" && (path === "" || path === "/")) return txt("OK");

    // set Telegram webhook (messages only)
    if (req.method === "GET" && path === "/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          url: `${url.origin}/webhook`,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true
        })
      });
      const j = await r.json().catch(()=>({}));
      return txt(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // Telegram webhook
    if (path === "/webhook") {
      if (req.method !== "POST") return txt("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.WEBHOOK_SECRET) return txt("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return txt("OK"); }
      const msg = update?.message;
      if (!msg?.chat?.id) return txt("OK");

      const chatId = msg.chat.id;
      const { cmd, arg } = parseCmd(msg);

      // /start or anything unknown -> help
      if (!cmd || cmd === "/start" || cmd === "/help") {
        await handleStart(env, chatId, msg.from);
        return txt("OK");
      }

      if (cmd === "/linkteam") {
        await handleLinkTeam(env, chatId, arg);
        return txt("OK");
      }

      // fallback: show help
      await handleStart(env, chatId, msg.from);
      return txt("OK");
    }

    return txt("Not Found", 404);
  }
};

/* ---------- handlers ---------- */
async function handleStart(env, chatId, from) {
  const name = ascii((from?.first_name || "there").trim());
  const html = [
    `<b>${esc(`Hey ${name}!`)}</b>`,
    "",
    `<b>What I can do now:</b>`,
    `• <code>/linkteam &lt;YourTeamID&gt;</code> — save your FPL team ID`,
    "",
    `<b>Where to find Team ID:</b>`,
    `Open fantasy.premierleague.com → My Team, URL looks like <code>/entry/1234567/</code>`,
    "",
    `<b>Example:</b>`,
    `<code>/linkteam 1234567</code>`
  ].join("\n");
  await sendHTML(env, chatId, html);
}

async function handleLinkTeam(env, chatId, arg) {
  const raw = (arg || "").trim();
  if (!/^\d+$/.test(raw)) {
    const html = [
      `<b>Link Your FPL Team</b>`,
      "",
      `<b>Find Team ID:</b> fantasy.premierleague.com → My Team (URL contains <code>/entry/1234567/</code>)`,
      "",
      `<b>How To Link:</b>`,
      `<code>/linkteam 1234567</code>`
    ].join("\n");
    await sendHTML(env, chatId, html);
    return;
  }

  const teamId = parseInt(raw, 10);
  const entry = await fplEntry(teamId);
  if (!entry) {
    await sendHTML(env, chatId, `<b>Not Found:</b> that Team ID didn’t resolve. Double-check and try again.`);
    return;
  }

  const teamName = ascii(entry.name || "Team");
  const manager = ascii(`${entry.player_first_name || ""} ${entry.player_last_name || ""}`.trim());

  if (env.TEAM_KV) {
    await env.TEAM_KV.put(kTeam(chatId), String(teamId), { expirationTtl: 60 * 60 * 24 * 365 });
  }

  const html = [
    `<b>Team Linked</b> ✅`,
    "",
    `<b>Team:</b> <b>${esc(teamName)}</b>`,
    manager ? `<b>Manager:</b> ${esc(manager)}` : "",
    `<b>Team ID:</b> ${esc(String(teamId))}`,
    "",
    `All set. Next we’ll add <code>/myteam</code> when you’re ready.`
  ].filter(Boolean).join("\n");
  await sendHTML(env, chatId, html);
}

/* ---------- Telegram helpers ---------- */
async function sendHTML(env, chat_id, html) {
  const payload = { chat_id, text: html, parse_mode: "HTML", disable_web_page_preview: true };
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload)
    });
    const j = await r.json().catch(()=>null);
    if (!j?.ok) {
      // fallback without formatting
      await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ chat_id, text: strip(html) })
      });
    }
  } catch {
    // last resort
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ chat_id, text: strip(html) })
    });
  }
}

/* ---------- FPL API ---------- */
async function fplEntry(id) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${id}/`, { cf: { cacheTtl: 0 } });
    if (!r.ok) return null;
    const j = await r.json().catch(()=>null);
    return (j && typeof j.id === "number") ? j : null;
  } catch { return null; }
}

/* ---------- utils ---------- */
const txt = (s, status=200) => new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function parseCmd(msg) {
  const raw = (msg.text || msg.caption || "").trim();
  if (!raw) return { cmd: null, arg: "" };
  const ent = (msg.entities || msg.caption_entities || []).find(e => e.type === "bot_command" && e.offset === 0);
  let cmd = null, arg = "";
  if (ent) { cmd = raw.slice(0, ent.length); arg = raw.slice(ent.length).trim(); }
  else if (raw.startsWith("/")) { const sp = raw.indexOf(" "); cmd = sp === -1 ? raw : raw.slice(0, sp); arg = sp === -1 ? "" : raw.slice(sp+1).trim(); }
  if (!cmd) return { cmd: null, arg: "" };
  cmd = cmd.replace(/@\S+$/, "").toLowerCase();
  return { cmd, arg };
}

const ascii = s => String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\u2014|\u2013/g,"-").replace(/\u00A0/g," ");
const esc   = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const strip = s => s.replace(/<[^>]+>/g, "");
const kTeam = chatId => `team:${chatId}`;