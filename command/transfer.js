// command/transfer.js — header-only /transfer (next GW) with settings layer
// Usage: /transfer [mode=auto|pro|champ]
//
// Needs: FPL_BOT_KV (KV), TELEGRAM_BOT_TOKEN (for send), utils/telegram.js & utils/fmt.js

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);

export default async function transfer(env, chatId, arg = "") {
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
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const curGW  = currentGw(bootstrap);
  const nextGW = nextGwId(bootstrap);

  // Picks from CURRENT GW to infer bank & transfer usage state
  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) {
    await send(env, chatId, "Couldn't fetch your picks (is your team private?).");
    return;
  }

  // 3) Basic header fields
  const teamName = (entry?.name || "—");
  const bank = (typeof picks?.entry_history?.bank === "number")
    ? picks.entry_history.bank / 10
    : (typeof entry?.last_deadline_bank === "number" ? entry.last_deadline_bank / 10 : null);

  // FT assumption for NEXT GW:
  // If you used 0 transfers this GW → assume 2 next (cap at 2). Else 1.
  const usedThisGw = Number(picks?.entry_history?.event_transfers || 0);
  const assumedFT  = usedThisGw === 0 ? 2 : 1;

  // 4) Build context → choose settings (auto/pro/champ)
  const mode = parseMode(arg); // "auto" | "pro" | "champ"
  const ctx  = buildContext({ bootstrap, fixtures, picks, nextGW });

  const chosen = (mode === "auto")
    ? chooseAutoMode(ctx)
    : mode;

  const cfg = (chosen === "champ")
    ? championConfig(ctx, assumedFT)
    : proConfig(ctx, assumedFT); // default “pro”

  // 5) Print header + settings
  const html = [
    `${B("Team")}: ${esc(teamName)} | ${B("GW")}: ${nextGW} — Transfer`,
    `${B("Bank")}: ${gbp(bank)} | ${B("Free Transfers (assumed)")}: ${assumedFT} | ${B("Hit")}: (-4 after ${assumedFT} FT)`,
    `${B("Model")}: ${chosen === "champ" ? "Champion (edge-chasing)" : "Pro (balanced)"} ` +
    `| ${B("Settings")}: h=${cfg.h} • min=${cfg.min}% • damp=${cfg.damp.toFixed(2)} • hit≥${cfg.hit} • bankPad=${gbp(cfg.bankPad)}`
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

/* -------------------- Settings Layer -------------------- */

// Parse /transfer args like: "mode=champ"
function parseMode(arg) {
  const a = String(arg||"").trim();
  const m = a.match(/\bmode=(auto|pro|champ)\b/i);
  return m ? m[1].toLowerCase() : "auto";
}

// Collate quick context for tuning
function buildContext({ bootstrap, fixtures, picks, nextGW }) {
  const risky = riskyStartersCount(picks, bootstrap, 80);
  const usedCost = Number(picks?.entry_history?.event_transfers_cost || 0);
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.keys(counts).filter(tid => counts[tid] > 1).length;
  const blankTeams = (bootstrap?.teams || []).filter(t => (counts[t.id] || 0) === 0).length;
  return {
    nextGW,
    riskyStarters: risky,
    tookHitThisGW: usedCost > 0,
    dgwTeams,
    blankTeams
  };
}

// Auto picks Pro unless we’re entering a big DGW or the user just took a hit
function chooseAutoMode(ctx) {
  if (ctx.dgwTeams >= 4 || ctx.tookHitThisGW) return "champ";
  return "pro";
}

// Pro (balanced, low-risk)
function proConfig(ctx, assumedFT) {
  let h = 2;
  let min = 82;          // prefer nailed picks
  let damp = 0.94;       // discount 2nd game in a DGW
  let hit = 5;           // require ≥ +5 net to justify a hit
  const bankPad = 0.1;   // keep small buffer

  if (ctx.riskyStarters >= 2) { min = Math.min(90, min + 3); hit = 6; }
  if (ctx.dgwTeams >= 4) { h = 3; damp = 0.92; }
  if (ctx.blankTeams >= 4) { h = 1; min = Math.min(90, min + 2); }

  return { h, min, damp, hit, bankPad, ft: assumedFT };
}

// Champion (edge-chasing, calculated aggression)
function championConfig(ctx, assumedFT) {
  // early/mid/late season hit bars (rough heuristic by GW)
  const gw = Number(ctx.nextGW || 1);
  let seasonHit = gw <= 12 ? 4 : gw <= 28 ? 5 : 6;

  let h = 3;
  let min = 78;          // slightly looser to allow upside
  let damp = 0.93;       // lean into doubles a bit more
  let hit = seasonHit;   // lower early, tighter later
  const bankPad = 0.2;   // more flexibility for moves

  if (ctx.dgwTeams >= 6) { h = 4; damp = 0.90; }
  if (ctx.blankTeams >= 4) { h = 1; min = Math.min(90, min + 3); }
  if (ctx.riskyStarters >= 3) { min = Math.min(90, min + 4); /* keep hit bar */ }

  return { h, min, damp, hit, bankPad, ft: assumedFT };
}

/* -------------------- Helpers -------------------- */
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

function riskyStartersCount(picks, bootstrap, minCut = 80) {
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const xi = (picks?.picks || []).filter(p => (p.position || 16) <= 11);
  let n = 0;
  for (const p of xi) {
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}

function gwFixtureCounts(fixtures, gw) {
  const map = {};
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h] || 0) + 1;
    map[f.team_a] = (map[f.team_a] || 0) + 1;
  }
  return map;
}