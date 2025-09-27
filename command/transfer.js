// command/transfer.js — header-only /transfer (next GW)
// Needs: FPL_BOT_KV (KV), TELEGRAM_BOT_TOKEN (for send), utils/telegram.js & utils/fmt.js

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);

export default async function transfer(env, chatId, _arg = "") {
  // 1) Read linked team
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(
      env,
      chatId,
      `${B("Not linked")} Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`,
      "HTML"
    );
    return;
  }

  // 2) Fetch FPL data
  const [bootstrap, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
  ]);
  if (!bootstrap || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const curGW  = currentGw(bootstrap);
  const nextGW = nextGwId(bootstrap);

  // Picks are taken from current GW to infer bank and transfers used
  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) {
    await send(env, chatId, "Couldn't fetch your picks (is your team private?).");
    return;
  }

  // 3) Header fields
  const teamName = (entry?.name || "—");
  const bank = (typeof picks?.entry_history?.bank === "number")
    ? picks.entry_history.bank / 10
    : (typeof entry?.last_deadline_bank === "number" ? entry.last_deadline_bank / 10 : null);

  // FT assumption for NEXT GW:
  // If you used 0 transfers this GW → assume 2 next (cap at 2). Else 1.
  const usedThisGw = Number(picks?.entry_history?.event_transfers || 0);
  const assumedFT  = usedThisGw === 0 ? 2 : 1;

  const html = [
    `${B("Team")}: ${esc(teamName)} | ${B("GW")}: ${nextGW} — Transfer`,
    `${B("Bank")}: ${gbp(bank)} | ${B("Free Transfers (assumed)")}: ${assumedFT} | ${B("Hit")}: (-4 after ${assumedFT} FT)`,
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

/* ---------- helpers ---------- */
async function getJSON(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

function currentGw(bootstrap) {
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next);    if (nxt) return nxt.id;
  const up  = ev.find(e => !e.finished);  return up ? up.id : (ev[ev.length - 1]?.id || 1);
}

function nextGwId(bootstrap) {
  const ev = bootstrap?.events || [];
  const nxt = ev.find(e => e.is_next);
  if (nxt) return nxt.id;
  const cur = ev.find(e => e.is_current);
  if (cur) {
    const i = ev.findIndex(x => x.id === cur.id);
    return ev[i + 1]?.id || cur.id;
    }
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length - 1]?.id || 1);
}