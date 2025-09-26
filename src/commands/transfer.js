// src/commands/transfer.js — AUTO MODE ONLY
// Usage: /transfer   (no arguments)
// Requires: utils/telegram.send, utils/fmt.esc, KV key user:<chatId>:profile

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

export default async function transfer(env, chatId /* arg is ignored in auto mode */) {
  // resolve linked team
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

  // fetch core data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const nextGW = getNextGwId(bootstrap);
  const curGW  = getCurrentGw(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) {
    await send(env, chatId, "Couldn't fetch your picks (is your team private?).");
    return;
  }

  // auto settings from team state
  const cfg = autoTuneSettings({ bootstrap, fixtures, picks });

  // bank & roster
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const allPicks = (picks?.picks || []);
  const startersP = allPicks.filter(p => (p.position || 16) <= 11);
  const startersEls = startersP.map(p => els[p.element]).filter(Boolean);
  const ownedIds = new Set(allPicks.map(p => p.element));

  // team counts (per club for ≤3 rule)
  const teamCounts = {};
  for (const p of allPicks) {
    const el = els[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // selling prices
  const sell = {};
  for (const p of allPicks) {
    const el = els[p.element];
    const raw = (p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0);
    sell[p.element] = (raw / 10.0) || 0;
  }

  // pre-compute horizon score for every element
  const byRow = {}; // id -> {score}
  for (const el of (bootstrap?.elements || [])) {
    byRow[el.id] = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
  }

  // OUT candidates = weakest starters across horizon
  const outCands = startersEls
    .map(el => ({
      id: el.id,
      name: playerShort(el),
      posT: el.element_type,
      teamId: el.team,
      team: teamShort(teams, el.team),
      sell: sell[el.id] || ((el.now_cost || 0)/10),
      score: byRow[el.id]?.score ?? 0
    }))
    .sort((a,b)=>a.score-b.score)
    .slice(0, 11);

  // Market pool by position (minutes filter)
  const MAX_PER_TEAM = 3;
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements || [])) {
    if (chance(el) < cfg.min) continue;
    const r = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
    poolByPos[el.element_type].push({
      id: el.id,
      name: playerShort(el),
      team: teamShort(teams, el.team),
      teamId: el.team,
      pos: posName(el.element_type),
      price: (el.now_cost || 0) / 10,
      score: r.score
    });
  }
  Object.values(poolByPos).forEach(arr => arr.sort((a,b)=>b.score-a.score));

  // Single-move upgrades
  const singles = [];
  for (const out of outCands) {
    const list = poolByPos[out.posT];
    for (let i=0; i<list.length && singles.length<400; i++) {
      const IN = list[i];
      if (IN.id === out.id) continue;
      if (ownedIds.has(IN.id)) continue; // don't suggest someone you already own

      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank + 1e-9) continue;

      const newCountIn = (teamCounts[IN.teamId] || 0) + (IN.teamId === out.teamId ? 0 : 1);
      if (newCountIn > MAX_PER_TEAM) continue;

      const delta = IN.score - out.score;
      if (delta <= 0) continue;

      singles.push({
        outId: out.id, inId: IN.id,
        outName: out.name, inName: IN.name,
        outTeamId: out.teamId, inTeamId: IN.teamId,
        outTeam: out.team, inTeam: IN.team,
        pos: out.posT,
        outSell: out.sell, inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff,
        delta
      });
      if (singles.length >= 400) break;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // Plans A–D
  const planA = mkPlanA();
  const planB = mkPlanB(singles, cfg.ft);
  const planC = bestCombo(singles.slice(0, 100), 2, teamCounts, MAX_PER_TEAM, bank, cfg.ft);
  const planD = bestCombo(singles.slice(0, 120), 3, teamCounts, MAX_PER_TEAM, bank, cfg.ft);

  const plans = [
    { key:"A", title:"Plan A — 0 transfers", ...planA },
    { key:"B", title:"Plan B — 1 transfer",  ...planB },
    { key:"C", title:"Plan C — 2 transfers", ...planC },
    { key:"D", title:"Plan D — 3 transfers", ...planD }
  ];
  const best = plans.slice().sort((a,b)=> (b.net - a.net) )[0];
  const recommend = best && best.net >= (best.moves.length > 1 ? cfg.hit : 0) ? best.key : "A";

  // render
  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Transfer Plan (Next)`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (assumed)")}: ${cfg.ft} | ${B("Hits")}: -4 per extra move`,
    `${B("Model")}: Auto — h=${cfg.h}, min=${cfg.min}%, damp=${cfg.damp} | ${B("Hit OK if Net ≥")} ${cfg.hit}`
  ].join("\n");

  const blocks = [];
  for (const p of plans) {
    const title = p.key === recommend ? `✅ ${p.title} (recommended)` : p.title;
    blocks.push(renderPlan(title, p));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------- auto tuner ---------- */
function autoTuneSettings({ bootstrap, fixtures, picks }, base = { h:1, min:80, damp:0.9, ft:1, hit:5 }){
  const nextGW = getNextGwId(bootstrap);
  const riskyN = riskyStartersCount(picks, bootstrap, 80);
  const dgwTeams = countDGWWindow(fixtures, nextGW, 3);
  const swing = fixtureSwingScore(fixtures, bootstrap, nextGW, 3);
  const usedThis = usedTransfersThisGw(picks);
  const cfg = { ...base };

  // FT assumption for next GW (rollover if none used this GW)
  cfg.ft = (usedThis === 0) ? 2 : 1;

  // Horizon
  if (riskyN >= 2 || dgwTeams >= 4 || Math.abs(swing) >= 0.3) cfg.h = 2;
  else cfg.h = 1;

  // Minutes floor
  cfg.min = riskyN >= 2 ? 85 : 80;

  // DGW damp
  cfg.damp = dgwTeams >= 4 ? 0.92 : 0.90;

  // Hit threshold
  cfg.hit = riskyN >= 2 ? 6 : 5;

  return cfg;
}

/* ---------- planning helpers ---------- */
function mkPlanA(){ return { moves: [], delta: 0, hit: 0, net: 0 }; }
function mkPlanB(singles, ft){
  if (!singles.length) return mkPlanA();
  const s = singles[0];
  const hit = Math.max(0, 1 - ft) * 4;
  return { moves:[s], delta: s.delta, hit, net: s.delta - hit };
}
function bestCombo(singles, K, teamCounts, MAX_PER_TEAM, bank, ft){
  if (!singles.length || K < 2) return mkPlanA();

  function validCombo(combo){
    const outIds = new Set(), inIds = new Set();
    const counts = { ...teamCounts };
    let spend = 0, deltaSum = 0;
    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return null;
      outIds.add(m.outId); inIds.add(m.inId);
      if (m.inTeamId !== m.outTeamId) {
        counts[m.outTeamId] = (counts[m.outTeamId]||0) - 1;
        counts[m.inTeamId]  = (counts[m.inTeamId] ||0) + 1;
      }
      spend += m.priceDiff;
      deltaSum += m.delta;
    }
    for (const c of Object.values(counts)) if (c > MAX_PER_TEAM) return null;
    if (spend > bank + 1e-9) return null;
    const hit = Math.max(0, combo.length - ft) * 4;
    return { delta: deltaSum, hit, net: deltaSum - hit, spend };
  }

  const S = Math.min(60, singles.length);
  const base = singles.slice(0, S);
  let best = null;

  const idxs = [...Array(S).keys()];
  function* kComb(k, start=0, acc=[]){
    if (k===0) { yield acc; return; }
    for (let i=start;i<=S-k;i++) yield* kComb(k-1, i+1, [...acc, i]);
  }
  for (const ids of kComb(K)) {
    const combo = ids.map(i => base[i]);
    const chk = validCombo(combo);
    if (!chk) continue;
    const cand = { moves: combo, delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend };
    if (!best || cand.net > best.net) best = cand;
  }
  return best || mkPlanA();
}

function renderPlan(title, plan){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!plan || !plan.moves || !plan.moves.length) {
    lines.push("• Save FT. Projected ΔScore: +0.00");
  } else {
    plan.moves.forEach((m,i)=>{
      lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
      lines.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
    });
    lines.push(`Net (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)}  |  Raw Δ: +${plan.delta.toFixed(2)}  |  Hits: -${plan.hit}`);
  }
  return lines.join("\n");
}

/* ---------- scoring over horizon ---------- */
function rowForHorizon(el, fixtures, teams, startGw, H = 1, damp = 0.9, minCut = 80){
  const minProb = chance(el); if (minProb < minCut) return { score: 0 };
  const ppg = parseFloat(el.points_per_game || "0") || 0;
  let score = 0;

  for (let g = startGw; g < startGw + H; g++){
    const fs = fixtures
      .filter(f => f.event === g && (f.team_h===el.team || f.team_a===el.team))
      .sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);
    if (!fs.length) continue;
    fs.forEach((f, idx) => {
      const home = f.team_h === el.team;
      const fdr = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
      const mult = fdrMult(fdr);
      const dampK = idx === 0 ? 1.0 : damp; // 2nd DGW slightly down-weighted
      score += ppg * (minProb/100) * mult * dampK;
    });
  }
  return { score };
}

function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x; // easy → ~1.10, hard → ~0.80
}

/* ---------- team state signals ---------- */
function riskyStartersCount(picks, bootstrap, minCut=80){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  let n=0;
  for (const p of xi){
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}
function countDGWWindow(fixtures, gw, span=3){
  const map = new Map(); // teamId -> matches in window
  for (const f of fixtures){
    if (!f.event || f.event < gw || f.event >= gw+span) continue;
    map.set(f.team_h, (map.get(f.team_h)||0)+1);
    map.set(f.team_a, (map.get(f.team_a)||0)+1);
  }
  let multi=0;
  for (const [_id, cnt] of map) if (cnt>=4) multi++; // 4+ across 3 GWs ≈ DGW exposure
  return multi;
}
function fixtureSwingScore(fixtures, bootstrap, gw, span=3){
  const teams = bootstrap?.teams||[];
  let sum=0, n=0;
  for (const t of teams){
    const id=t.id;
    const cur = fixtures.find(f=>f.event===gw   && (f.team_h===id||f.team_a===id));
    const nxt = fixtures.find(f=>f.event===gw+1 && (f.team_h===id||f.team_a===id));
    if (!cur || !nxt) continue;
    const dCur = cur.team_h===id ? (cur.team_h_difficulty??cur.difficulty??3) : (cur.team_a_difficulty??cur.difficulty??3);
    const dNxt = nxt.team_h===id ? (nxt.team_h_difficulty??nxt.difficulty??3) : (nxt.team_a_difficulty??nxt.difficulty??3);
    sum += (dCur - dNxt); n++;
  }
  return n ? sum/n : 0; // positive => trend to easier fixtures
}
function usedTransfersThisGw(picks){
  const eh = picks?.entry_history;
  return (typeof eh?.event_transfers === "number") ? eh.event_transfers : null;
}

/* ---------- misc utils ---------- */
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function teamShort(teams, id){ return teams[id]?.short_name || "?"; }
function playerShort(el){
  const first = (el?.first_name || "").trim();
  const last  = (el?.second_name || "").trim();
  const web   = (el?.web_name || "").trim();
  if (first && last) {
    const initLast = `${first[0]}. ${last}`;
    return (web && web.length <= initLast.length) ? web : initLast;
  }
  return web || last || first || "—";
}
function getCurrentGw(bootstrap){
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next); if (nxt) return nxt.id;
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