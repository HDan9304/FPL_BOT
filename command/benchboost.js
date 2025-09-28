// command/benchboost.js — Simple Bench Boost advisor over Plans A–D
// Reads live squad, rebuilds the same transfer plans, then shows BB value per plan
// Output stays simple: Bench EV, Total EV (15), Hits, Net, and a plain “Play BB?” nudge.
// Now also picks a single top recommendation using the same conservative logic as /transfer.

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

import { PRO_CONF } from "../config/transfer.js";        // same settings as /transfer
import { gbp, clamp } from "../lib/util.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts } from "../lib/fixtures.js";
import { annotateSquad, shortName, teamShort } from "../lib/squad.js";
import { reason } from "../lib/reasons.js";
import { mkPlanA, mkPlanB, bestCombo, badgeLine } from "../lib/plan.js";

/* ---------- KV key ---------- */
const kUser = (id) => `user:${id}:profile`;

// fallbacks if your PRO_CONF doesn’t yet define these (keeps old configs working)
const EXTRA_MOVE_STEP     = Number.isFinite(PRO_CONF?.EXTRA_MOVE_STEP) ? PRO_CONF.EXTRA_MOVE_STEP : 1.5;
const RECO_SOFT_PENALTY   = Number.isFinite(PRO_CONF?.RECO_SOFT_PENALTY) ? PRO_CONF.RECO_SOFT_PENALTY : 0.5;

export default async function benchboost(env, chatId, arg = "") {
  // 1) Guard: linked?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `<b>${esc("Not linked")}</b> Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) Core data (bootstrap, fixtures, entry, history, picks)
  const [bootstrap, fixtures, entry, history] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`)
  ]);
  if (!bootstrap || !fixtures || !entry || !history) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGwId(bootstrap);

  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks || !Array.isArray(picks.picks)) {
    await send(env, chatId, "Couldn't fetch your picks (team private or endpoint down).");
    return;
  }

  // 3) Chip availability (simple): BB available if not used in history.chips
  const bbUsed = Array.isArray(history?.chips) && history.chips.some(c => {
    const n = String(c?.name || "").toLowerCase();
    return n === "bboost" || n === "bench boost" || n === "benchboost";
  });
  const bbAvailable = !bbUsed;

  // 4) Bank & FT assumption (same rule as /transfer)
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const usedThis = (typeof picks?.entry_history?.event_transfers === "number")
    ? picks.entry_history.event_transfers : 0;
  const assumedFT = usedThis === 0 ? 2 : 1;

  // 5) Index & counts
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const ownedIds = new Set(picks.picks.map(p => p.element));
  const countsNext = gwFixtureCounts(fixtures, nextGW);

  // 6) EV table
  const evById = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF); // { ev }
  }

  // 7) Squad rows + OUT candidates
  const squad = annotateSquad(picks.picks, elements, teams, evById);
  const outCands = squad
    .map(r => ({ id:r.id, posT:r.posT, name:r.name, teamId:r.teamId, team:r.team,
                 isStarter:r.isStarter, sell:r.sell, listPrice:r.listPrice, ev:r.ev }))
    .sort((a,b) => a.ev - b.ev)
    .slice(0, 15);

  // 8) Market pools by position (minutes cut)
  const poolByPos = { 1:[], 2:[], 3:[], 4:[] };
  for (const el of (bootstrap.elements || [])) {
    const mp = minutesProb(el);
    if (mp < PRO_CONF.MIN_PCT) continue;
    const posT = el.element_type;
    const ev   = evById[el.id]?.ev || 0;
    poolByPos[posT].push({
      id: el.id, name: shortName(el), teamId: el.team, team: teamShort(teams, el.team),
      posT, price: (el.now_cost || 0) / 10, ev
    });
  }
  Object.keys(poolByPos).forEach(k => {
    poolByPos[k].sort((a,b)=> b.ev - a.ev);
    poolByPos[k] = poolByPos[k].slice(0, PRO_CONF.MAX_POOL_PER_POS);
  });

  // 9) Team counts (<=3)
  const teamCounts = {};
  for (const p of picks.picks) {
    const el = elements[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // 10) Singles (legal + noise guard)
  const singles = [];
  const rejections = [];
  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT] || [];
    for (let i=0; i<list.length && singles.length<PRO_CONF.MAX_SINGLE_SCAN; i++){
      const IN = list[i];
      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank + 1e-9) { rejections.push(reason("bank", out, IN, { need: priceDiff - bank })); continue; }

      const newCounts = { ...teamCounts };
      if (IN.teamId !== out.teamId) {
        newCounts[out.teamId] = (newCounts[out.teamId] || 0) - 1;
        newCounts[IN.teamId]  = (newCounts[IN.teamId]  || 0) + 1;
      }
      if (Object.values(newCounts).some(c => c > 3)) { rejections.push(reason("team-limit", out, IN)); continue; }

      const delta = IN.ev - out.ev;
      if (delta < PRO_CONF.MIN_DELTA_SINGLE) { rejections.push(reason("min-delta", out, IN, { delta })); continue; }

      singles.push({
        outId: out.id, outName: out.name, outTeamId: out.teamId, outTeam: out.team,
        inId: IN.id,   inName: IN.name,   inTeamId: IN.teamId,   inTeam: IN.team,
        posT: out.posT,
        outSell: out.sell, outList: out.listPrice, inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff, delta
      });

      if (singles.length >= PRO_CONF.MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=> b.delta - a.delta);

  // 11) Build Plans A–D (same as /transfer)
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, assumedFT, PRO_CONF);
  const planC = bestCombo(singles.slice(0,150), 2, teamCounts, bank, assumedFT, PRO_CONF);
  const planD = bestCombo(singles.slice(0,180), 3, teamCounts, bank, assumedFT, PRO_CONF);

  const plans = [
    { key:"A", title:`Plan A — 0 transfers ${badgeLine(countsNext, teams)}`, ...planA },
    { key:"B", title:`Plan B — 1 transfer ${badgeLine(countsNext, teams)}`,  ...planB },
    { key:"C", title:`Plan C — 2 transfers ${badgeLine(countsNext, teams)}`, ...planC },
    { key:"D", title:`Plan D — 3 transfers ${badgeLine(countsNext, teams)}`, ...planD }
  ];

  // 12) Evaluate Bench Boost value per plan
  // We keep it SIMPLE: Bench = players in positions 12..15 of your current picks ordering.
  // After transfers, if an OUT was on the bench, the IN replaces in that same bench slot.
  const benchIdx = new Set((picks.picks || []).filter(p => (p.position||16) > 11).map(p => p.position));
  function planBenchReport(plan) {
    const mapOutToIn = new Map(plan.moves?.map(m => [m.outId, m.inId]) || []);
    let totalEV = 0;
    let benchEV = 0;

    for (const p of picks.picks) {
      const elId = mapOutToIn.has(p.element) ? mapOutToIn.get(p.element) : p.element;
      const ev = evById[elId]?.ev || 0;
      totalEV += ev;
      if (benchIdx.has(p.position)) benchEV += ev;
    }
    const hit = plan.hit || 0;
    const net = (plan.net ?? (plan.delta || 0) - hit);

    // Simple BB gate: bench must be decent and we don’t want heavy-hit only scenarios
    const playNow =
      bbAvailable &&
      benchEV >= 12 &&
      (plan.moves.length <= 1 || net >= PRO_CONF.HIT_OK);

    return {
      benchEV: round1(benchEV),
      totalEV: round1(totalEV),
      hit,
      net: round1(net),
      playNow,
      moves: plan.moves || []
    };
  }

  const reports = plans.map(p => ({ key: p.key, title: p.title, ...planBenchReport(p) }));

  // 13) Pick ONE recommendation, mirroring /transfer’s conservative style
  const needed = (movesLen) =>
    (movesLen <= 1) ? -Infinity : PRO_CONF.HIT_OK + EXTRA_MOVE_STEP * (movesLen - 1);

  const eligible = reports
    .map((r, i) => ({ ...r, movesLen: (plans[i].moves || []).length }))
    .filter(r => !r.playNow ? false : (r.net >= needed(r.movesLen)));

  const rankNet = (r) => r.net - RECO_SOFT_PENALTY * Math.max(0, r.movesLen - 1);
  const pool = eligible.length ? eligible : []; // if empty, we’ll fall back to “Not this week”
  pool.sort((a,b) => rankNet(b) - rankNet(a));
  const best = pool[0];

  // 14) Header + blocks (super simple text)
  const bbLabel = bbAvailable ? "Available ✅" : "Used ❌";
  const head = [
    `<b>${esc("Team")}:</b> ${esc(entry?.name || "—")} | <b>${esc("GW")}:</b> ${nextGW} — Bench Boost Check`,
    `<b>${esc("Bench Boost")}:</b> ${bbLabel}`,
    `<b>${esc("Bank")}:</b> ${gbp(bank)} | <b>${esc("FT (assumed)")}:</b> ${assumedFT} | <b>${esc("Hits")}:</b> -4 each`,
    `<b>${esc("Model")}:</b> Pro (H=${PRO_CONF.H}, min=${PRO_CONF.MIN_PCT}%, damp=${PRO_CONF.DGW_DAMP}, hitOK≥${PRO_CONF.HIT_OK})`
  ].join("\n");

  const reco = best
    ? `Recommendation: <b>Play Bench Boost</b> with ${esc(best.key)} (Bench EV ${best.benchEV}, Plan Net ${best.net >= 0 ? "+" : ""}${best.net})`
    : `Recommendation: <b>Not this week</b> — bench isn’t strong enough or plans require too many moves/hits`;

  const blocks = [reco, ""];
  for (let i=0; i<reports.length; i++) {
    const r = reports[i];
    const plan = plans[i];
    const line1 = `<b>${esc(r.title)}</b>`;
    const line2 = `• Bench EV: ${r.benchEV} | Total EV (15): ${r.totalEV} | Hits: -${r.hit} | Plan Net: ${r.net >= 0 ? "+" : ""}${r.net}`;
    const line3 = r.playNow
      ? "• Suggestion: <b>Play Bench Boost</b> with this plan."
      : "• Suggestion: Save the chip for a stronger bench or a DGW.";
    const firstMove = (plan.moves && plan.moves[0])
      ? `• Example move: OUT ${esc(plan.moves[0].outName)} → IN ${esc(plan.moves[0].inName)}`
      : "• Example move: (none)";

    blocks.push([line1, line2, line3, firstMove].join("\n"));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------- small helpers ---------- */
function round1(n){ return Number.isFinite(n) ? Number(n.toFixed(1)) : 0; }

function getCurrentGw(bootstrap){
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next);    if (nxt) return nxt.id;
  const up  = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}
function getNextGwId(bootstrap){
  const ev = bootstrap?.events || [];
  const nxt = ev.find(e => e.is_next);
  if (nxt) return nxt.id;
  const cur = ev.find(e => e.is_current);
  if (cur) {
    const i = ev.findIndex(x => x.id === cur.id);
    return ev[i+1]?.id || cur.id;
  }
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}
async function getJSON(url){
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}
