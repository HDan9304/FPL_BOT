// command/transfer.js — thin orchestrator wiring all pieces together
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

import { PRO_CONF } from "../config/transfer.js";
import { gbp } from "../lib/util.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts } from "../lib/fixtures.js";
import { annotateSquad, shortName, teamShort } from "../lib/squad.js";
import { reason } from "../lib/reasons.js";
import { mkPlanA, mkPlanB, bestCombo, renderPlan, badgeLine } from "../lib/plan.js";

/* ---------- KV key ---------- */
const kUser = (id) => `user:${id}:profile`;

export default async function transfer(env, chatId, arg = "") {
  // Guard: linked?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(
      env,
      chatId,
      `<b>${esc("Not linked")}</b> Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`,
      "HTML"
    );
    return;
  }

  // Core data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGwId(bootstrap);

  const picks  = await getJSON(
    `https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`
  );
  if (!picks || !Array.isArray(picks.picks)) {
    await send(env, chatId, "Couldn't fetch your picks (team private or endpoint down).");
    return;
  }

  // Bank & FT assumption
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const usedThis = (typeof picks?.entry_history?.event_transfers === "number")
    ? picks.entry_history.event_transfers : 0;
  const assumedFT = usedThis === 0 ? 2 : 1;

  // Indexes
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const ownedIds = new Set(picks.picks.map(p => p.element));

  // Counts for next GW
  const countsNext = gwFixtureCounts(fixtures, nextGW);

  // EV across all players
  const evById = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF);
  }

  // Squad & OUT candidates (full 15)
  const squad = annotateSquad(picks.picks, elements, teams, evById);
  const outCands = squad
    .map(r => ({
      id:r.id, posT:r.posT, name:r.name, teamId:r.teamId, team:r.team,
      isStarter:r.isStarter, sell:r.sell, listPrice:r.listPrice, ev:r.ev
    }))
    .sort((a,b) => a.ev - b.ev)
    .slice(0, 15);

  // Market pools by position (minutes cut)
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

  // Team counts (<=3)
  const teamCounts = {};
  for (const p of picks.picks) {
    const el = elements[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // Singles (legal + noise guard)
  const singles = [];
  const rejections = [];
  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT] || [];
    for (let i=0; i<list.length && singles.length<PRO_CONF.MAX_SINGLE_SCAN; i++){
      const IN = list[i];
      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell; // pay IN list using OUT sell
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

  // Plans
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

  // Recommendation rule (more conservative):
  // 1) Multi-move plans must clear a rising bar: HIT_OK + HIT_OK_PER_EXTRA*(moves-1)
  // 2) When ranking, apply a soft penalty per extra move to break close ties.

  const required = (p) =>
    (p.moves.length <= 1)
      ? -Infinity
      : PRO_CONF.HIT_OK + PRO_CONF.HIT_OK_PER_EXTRA * (p.moves.length - 1);

  const pickable = plans
    .map(p => ({ ...p }))
    .filter(p => (p.moves.length === 0) || (p.net >= required(p)));

  const rankNet = (p) =>
    p.net - PRO_CONF.SOFT_PEN_PER_EXTRA * Math.max(0, p.moves.length - 1);

  const considered = pickable.length ? pickable : plans.slice();
  considered.sort((a,b) => rankNet(b) - rankNet(a));

  // Optional final sanity: if best beats best ≤1-move by <1.0, prefer ≤1-move
  const best = considered[0];
  const bestLite = [...considered].filter(p => p.moves.length <= 1)[0];
  let recommend = best?.key || "A";
  if (best && bestLite && best.moves.length > 1) {
    if (best.net - bestLite.net < 1.0) recommend = bestLite.key;
  }

  // Header + blocks
  const head = [
    `<b>${esc("Team")}:</b> ${esc(entry?.name || "—")} | <b>${esc("GW")}:</b> ${nextGW} — Transfer Plan (Next)`,
    `<b>${esc("Bank")}:</b> ${esc(gbp(bank))} | <b>${esc("FT (assumed)")}:</b> ${assumedFT} | <b>${esc("Hits")}:</b> -4 each`,
    `<b>${esc("Model")}:</b> Pro • H=${PRO_CONF.H} • min=${PRO_CONF.MIN_PCT}% • damp=${PRO_CONF.DGW_DAMP} • hitOK≥${PRO_CONF.HIT_OK}`
  ].join("\n");

  const blocks = [];
  for (const p of plans) {
    const title = p.key === recommend ? `✅ ${p.title} (recommended${(p.moves?.length||0)>1 ? ", tougher bar applied" : ""})` : p.title;
    // SIMPLE output renderer (passes current bank)
    blocks.push(renderPlan(title, p, countsNext, bank));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------- local utils (only used here) ---------- */
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
