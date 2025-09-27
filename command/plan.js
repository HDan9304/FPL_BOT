// ./command/plan.js
// Best XI & Formation for next GW.
// Supports /plan   → no transfer applied
//          /planb  → apply Plan B from the same auto logic as /transfer
//          /planc  → apply Plan C
//          /pland  → apply Plan D
//
// Uses the same scoring/filters as /transfer so outputs stay consistent.

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";
import { chooseAutoConfig } from "../presets.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

// thresholds/sizes (kept aligned with transfer.js)
const MIN_DELTA_SINGLE = 0.5;
const MIN_DELTA_COMBO  = 1.5;
const MAX_POOL_PER_POS = 500;
const MAX_SINGLE_SCAN  = 500;

// Allowed FPL formations [DEF, MID, FWD]
const FORMATIONS = [
  [3,4,3],[3,5,2],[4,4,2],[4,3,3],[5,3,2],[5,4,1],[4,5,1]
];

export default async function plan(env, chatId, arg = "") {
  // 0) parse which plan key to apply
  const key = parsePlanKey(arg); // "A"|"B"|"C"|"D"

  // 1) Ensure linked
  const pRaw   = await env.FPL_BOT_KV.get(kUser(chatId)).catch(()=>null);
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link &lt;TeamID&gt; first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) Fetch data
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

  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // 3) Pro AUTO config (same source as /transfer)
  let cfg = chooseAutoConfig({ bootstrap, fixtures, picks, mode: "plan" }) || {};
  cfg = {
    h: 2, min: 78, damp: 0.94, ft: 1, hit: 5,
    bench_guard: true, bench_big_delta: 2.0,
    ...cfg
  };

  // 4) pricing/bank & lookup tables
  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));

  const allPicks    = (picks?.picks || []);
  const startersP   = allPicks.filter(p => (p.position || 16) <= 11);
  const benchP      = allPicks.filter(p => (p.position || 16) >  11);
  const ownedIdsSet = new Set(allPicks.map(p => p.element));
  const ownedIds    = Array.from(ownedIdsSet);

  // bank
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  // 5) Build market scores for all players (for formation and for transfer recompute)
  const byRow = {};
  for (const el of (bootstrap?.elements || [])) {
    byRow[el.id] = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
  }

  // 6) If /planB|C|D: recompute the same transfer plans as /transfer and apply selected plan to roster
  //    (kept identical: legality, bank, minutes, team-limit, Δ thresholds)
  const plans = buildPlansLikeTransfer({
    bootstrap, fixtures, picks, entry, cfg, byRow, nextGW
  });

  const chosen = plans[key] || plans.A; // always have A
  const appliedRosterIds = applyMovesToRoster(ownedIds, chosen.moves);

  // 7) Build best XI + formation from applied roster
  const rosterEls = appliedRosterIds.map(id => els[id]).filter(Boolean);
  const best = chooseBestXI(rosterEls, byRow, cfg, nextGW);

  // 8) Minor meta for DGW/Blank badges (header info)
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.keys(counts).filter(tid => counts[tid] > 1);
  const blankTeams = Object.keys(teams).filter(tid => (counts[tid] || 0) === 0);
  const badge = badgeLine(dgwTeams.length, blankTeams.length);

  // 9) Render — header aligned with /transfer
  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Best XI & Formation`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (assumed)")}: ${cfg.ft} | ${B("Hits")}: -4 per extra move`,
    `${B("Model")}: Pro Auto — h=${cfg.h}, min=${cfg.min}%, damp=${cfg.damp} ${badge}` +
    (chosen && chosen.moves?.length ? `\n${B("Applied")}: Plan ${key} (${chosen.moves.length} move${chosen.moves.length>1?"s":""}, net ${(chosen.net>=0?"+":"")}${chosen.net.toFixed(2)})` : "")
  ].join("\n");

  // 10) Lines for XI + Bench + Captain/Vice
  const lines = [];
  lines.push(`${B("Formation")}: ${best.formation.join("-")}  |  ${B("Projected XI Score")}: ${best.score.toFixed(2)}`);

  const group = (arr, label) => {
    if (!arr.length) return;
    lines.push("");
    lines.push(`${B(label)}:`);
    arr.forEach(p => {
      const tag = p.cap ? " (C)" : (p.vc ? " (VC)" : "");
      lines.push(`• ${esc(p.disp)}${tag}`);
    });
  };

  group(best.GK,  "GK");
  group(best.DEF, "DEF");
  group(best.MID, "MID");
  group(best.FWD, "FWD");

  // Bench (1,2,3; GK)
  lines.push("");
  lines.push(`${B("Bench")}:`);
  best.benchOutfield.forEach((p, idx) => {
    lines.push(`• ${idx+1}) ${esc(p.disp)} — ${posName(p.posT)}`);
  });
  if (best.benchGK) {
    lines.push(`• GK) ${esc(best.benchGK.disp)}`);
  }

  // Helper links
  lines.push("");
  lines.push(`${B("Try other plans")} — /planb  /planc  /pland`);

  const html = [head, "", ...lines].join("\n");
  await send(env, chatId, html, "HTML");
}

/* ----------------- helpers ----------------- */

// Parse which plan key from arg
function parsePlanKey(arg){
  const a = String(arg||"").trim().toUpperCase();
  if (a === "B") return "B";
  if (a === "C") return "C";
  if (a === "D") return "D";
  // allow "/planb" passed as arg too
  if (/PLANB$/i.test(a)) return "B";
  if (/PLANC$/i.test(a)) return "C";
  if (/PLAND$/i.test(a)) return "D";
  return "A";
}

/* Build A–D like transfer.js, then return {A,B,C,D} */
function buildPlansLikeTransfer({ bootstrap, fixtures, picks, entry, cfg, byRow, nextGW }) {
  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const allPicks  = (picks?.picks || []);
  const startersP = allPicks.filter(p => (p.position || 16) <= 11);
  const benchP    = allPicks.filter(p => (p.position || 16) >  11);
  const startersEls = startersP.map(p => els[p.element]).filter(Boolean);
  const benchEls    = benchP.map(p => els[p.element]).filter(Boolean);
  const ownedIdsSet = new Set(allPicks.map(p => p.element));

  // bank
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  // team counts (≤3)
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

  // OUT candidates (starters + bench, bench needs big Δ)
  const outs = [];
  for (const el of startersEls) outs.push({
    id: el.id, bench:false,
    name: playerShort(el), posT: el.element_type,
    teamId: el.team, team: teamShort(teams, el.team),
    sell: sell[el.id] || ((el.now_cost || 0)/10),
    listPrice: (el.now_cost || 0)/10,
    score: byRow[el.id]?.score ?? 0
  });
  for (const el of benchEls) outs.push({
    id: el.id, bench:true,
    name: playerShort(el), posT: el.element_type,
    teamId: el.team, team: teamShort(teams, el.team),
    sell: sell[el.id] || ((el.now_cost || 0)/10),
    listPrice: (el.now_cost || 0)/10,
    score: byRow[el.id]?.score ?? 0
  });
  outs.sort((a,b)=>a.score-b.score);

  // Market pool by position (minutes/availability filter)
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements || [])) {
    if (chance(el) < cfg.min) continue;
    const r = byRow[el.id] || { score: 0 };
    poolByPos[el.element_type].push({
      id: el.id,
      name: playerShort(el),
      team: teamShort(teams, el.team),
      teamId: el.team,
      pos: posName(el.element_type),
      price: (el.now_cost || 0)/10,
      score: r.score
    });
  }
  Object.keys(poolByPos).forEach(k => { poolByPos[k].sort((a,b)=>b.score-a.score); poolByPos[k] = poolByPos[k].slice(0, MAX_POOL_PER_POS); });

  const ownedIds = new Set(ownedIdsSet);
  const singles = [];
  const rejections = [];

  outer:
  for (const out of outs) {
    const candidates = poolByPos[out.posT] || [];
    for (let i=0; i<candidates.length && singles.length<MAX_SINGLE_SCAN; i++) {
      const IN = candidates[i];
      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank + 1e-9) { rejections.push(reason("bank", out, IN, { need: priceDiff - bank })); continue; }

      const newCountIn = (teamCounts[IN.teamId] || 0) + (IN.teamId === out.teamId ? 0 : 1);
      if (newCountIn > 3) { rejections.push(reason("team-limit", out, IN)); continue; }

      const delta = IN.score - out.score;
      if (delta < MIN_DELTA_SINGLE) { rejections.push(reason("min-delta", out, IN, { delta })); continue; }
      if (cfg.bench_guard && out.bench && delta < (cfg.bench_big_delta || 2.0)) {
        rejections.push(reason("bench-small", out, IN, { delta }));
        continue;
      }

      singles.push({
        outId: out.id, inId: IN.id,
        outName: out.name, inName: IN.name,
        outTeamId: out.teamId, inTeamId: IN.teamId,
        outTeam: out.team, inTeam: IN.team,
        pos: out.posT, benchOut: !!out.bench,
        outSell: out.sell, inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff,
        delta, why: ["passed: legal, minutes ok, Δ≥0.5", ...(out.bench?[`bench-out: Δ≥${(cfg.bench_big_delta||2.0).toFixed(1)}`]:[])]
      });
      if (singles.length >= MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // A-D plans
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, cfg.ft);
  const planC = bestCombo(singles.slice(0, 120), 2, teamCounts, 3, bank, cfg.ft);
  const planD = bestCombo(singles.slice(0, 160), 3, teamCounts, 3, bank, cfg.ft);

  // recommend (kept same rule as /transfer)
  const all = { A: planA, B: planB, C: planC, D: planD };
  return all;
}

function applyMovesToRoster(ownedIds, moves){
  if (!moves || !moves.length) return ownedIds.slice();
  const set = new Set(ownedIds);
  for (const m of moves) {
    set.delete(m.outId);
    set.add(m.inId);
  }
  return Array.from(set);
}

/* ---------- formation & XI ---------- */
function chooseBestXI(rosterEls, byRow, cfg, nextGW){
  const withScore = rosterEls.map(el => ({
    id: el.id,
    posT: el.element_type,
    teamId: el.team,
    score: (byRow[el.id]?.score || 0),
    disp: `${playerShort(el)} (${teamIdToShort(el.team)})`
  }));

  // Split by position
  const GKs  = withScore.filter(p => p.posT === 1).sort((a,b)=>b.score-a.score);
  const DEFs = withScore.filter(p => p.posT === 2).sort((a,b)=>b.score-a.score);
  const MIDs = withScore.filter(p => p.posT === 3).sort((a,b)=>b.score-a.score);
  const FWDs = withScore.filter(p => p.posT === 4).sort((a,b)=>b.score-a.score);

  const bestGK = GKs[0] || null;
  let best = { score:-1e9, formation:[3,4,3], GK:[], DEF:[], MID:[], FWD:[], benchOutfield:[], benchGK:null };

  for (const [d,m,f] of FORMATIONS){
    if (!bestGK) continue;
    if (DEFs.length < d || MIDs.length < m || FWDs.length < f) continue;

    const pickDEF = DEFs.slice(0, d);
    const pickMID = MIDs.slice(0, m);
    const pickFWD = FWDs.slice(0, f);
    const xi = [bestGK, ...pickDEF, ...pickMID, ...pickFWD];
    const total = xi.reduce((s,p)=>s+p.score, 0);

    if (total > best.score) {
      // bench: remaining outfield by score desc
      const used = new Set(xi.map(p=>p.id));
      const restOutfield = withScore.filter(p => p.posT !== 1 && !used.has(p.id)).sort((a,b)=>b.score-a.score);
      const benchGK = GKs[1] || null;
      best = {
        score: total,
        formation: [d,m,f],
        GK:  [ cloneMark(bestGK) ],
        DEF: pickDEF.map(cloneMark),
        MID: pickMID.map(cloneMark),
        FWD: pickFWD.map(cloneMark),
        benchOutfield: restOutfield.slice(0,3).map(cloneMark),
        benchGK: benchGK ? cloneMark(benchGK) : null
      };
    }
  }

  // Captain/Vice as top two scores from XI
  const xiFlat = [...best.GK, ...best.DEF, ...best.MID, ...best.FWD].slice().sort((a,b)=>b.score-a.score);
  if (xiFlat[0]) xiFlat[0].cap = true;
  if (xiFlat[1]) xiFlat[1].vc  = true;

  // write marks back
  const mark = (p) => {
    const f = xiFlat.find(x => x.id === p.id);
    p.cap = !!f?.cap; p.vc = !!f?.vc;
    return p;
  };
  best.GK  = best.GK.map(mark);
  best.DEF = best.DEF.map(mark);
  best.MID = best.MID.map(mark);
  best.FWD = best.FWD.map(mark);

  return best;
}

function cloneMark(p){ return { ...p, cap:false, vc:false }; }

/* ---------- mini-transfer builders (identical logic) ---------- */
function mkPlanA(rejections){
  const why = [];
  if (Array.isArray(rejections) && rejections.length) {
    const counts = {};
    for (const r of rejections) counts[r.code] = (counts[r.code]||0) + 1;
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,4)
      .map(([code,n]) => humanReasonSummary(code, n));
    if (top.length) {
      why.push("No legal upgrades cleared the bar.");
      top.forEach(t => why.push(`• ${t}`));
    } else {
      why.push("No clear upgrades; better to roll FT.");
    }
  } else {
    why.push("No clear upgrades; better to roll FT.");
  }
  return { moves: [], delta: 0, hit: 0, net: 0, why };
}

function mkPlanB(singles, ft){
  if (!singles.length) return mkPlanA();
  const s = singles[0];
  const hit = Math.max(0, 1 - (ft||0)) * 4;
  const raw = s.delta;
  if (raw < MIN_DELTA_SINGLE) {
    return { ...mkPlanA(), why: ["Best single was below +0.5."] };
  }
  const why = [...(s.why||[])];
  if (hit>0) why.push(`-4 applied (1 FT used already)`);
  return { moves:[s], delta: raw, hit, net: raw - hit, why };
}

function bestCombo(singles, K, teamCounts, MAX_PER_TEAM, bank, ft){
  if (!singles.length || K < 2) return mkPlanA();

  function validCombo(combo){
    const outIds = new Set(), inIds = new Set();
    const counts = { ...teamCounts };
    let spend = 0, deltaSum = 0;
    const why = [];

    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return { invalid:true, why:["Duplicate player in combo"] };
      outIds.add(m.outId); inIds.add(m.inId);

      if (m.inTeamId !== m.outTeamId) {
        counts[m.outTeamId] = (counts[m.outTeamId]||0) - 1;
        counts[m.inTeamId]  = (counts[m.inTeamId] ||0) + 1;
      }
      spend += m.priceDiff;
      deltaSum += m.delta;
      if (m.why) why.push(...m.why);
    }
    for (const c of Object.values(counts)) if (c > MAX_PER_TEAM) return { invalid:true, why:["Team limit >3"] };
    if (spend > bank + 1e-9) return { invalid:true, why:[`Insufficient bank (need ${gbp(spend - bank)})`] };
    if (deltaSum < MIN_DELTA_COMBO) return { invalid:true, why:["Total Δ below +1.5 before hits"] };

    const hit = Math.max(0, combo.length - (ft||0)) * 4;
    return { invalid:false, delta: deltaSum, hit, net: deltaSum - hit, spend, why };
  }

  const S = Math.min(80, singles.length);
  const base = singles.slice(0, S);
  let best = null;

  function* kComb(k, start=0, acc=[]){
    if (k===0) { yield acc; return; }
    for (let i=start;i<=S-k;i++) yield* kComb(k-1, i+1, [...acc, i]);
  }
  for (const ids of kComb(K)) {
    const combo = ids.map(i => base[i]);
    const chk = validCombo(combo);
    if (chk.invalid) continue;
    const cand = { moves: combo, delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend, why: uniq(chk.why) };
    if (!best || cand.net > best.net) best = cand;
  }
  if (!best) return mkPlanA(["No affordable/legal combo found."]);
  if (best.hit>0) best.why = [...(best.why||[]), `Includes -${best.hit} hit; net ${best.net>=0?"+":""}${best.net.toFixed(2)}`];
  return best;
}

/* ---------- DGW/Blank helpers ---------- */
function gwFixtureCounts(fixtures, gw){
  const map = {};
  for (const f of (fixtures||[])) {
    if (typeof f.event !== "number" || f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h]||0) + 1;
    map[f.team_a] = (map[f.team_a]||0) + 1;
  }
  return map;
}
function badgeLine(dgwCount, blankCount){
  const parts = [];
  if (dgwCount>0) parts.push(`[DGW:${dgwCount}]`);
  if (blankCount>0) parts.push(`[BLANK:${blankCount}]`);
  return parts.length ? `• ${parts.join(" ")}` : "";
}

/* ---------- reasons helpers ---------- */
function reason(code, OUT, IN, extra={}){
  const m = {
    "same-player":   `Candidate equals OUT player`,
    "already-owned": `Already in your team`,
    "bank":          `Insufficient bank (need ${gbp(extra.need || 0)})`,
    "team-limit":    `Would break per-team limit (max 3)`,
    "min-delta":     `Upgrade below +0.5 (Δ=${(extra.delta??0).toFixed(2)})`,
    "bench-small":   `Bench sale blocked (Δ below big-upgrade guard)`
  }[code] || "Filtered";
  return { code, text: `${OUT.name} → ${IN.name}: ${m}` };
}
function humanReasonSummary(code, n){
  const label = {
    "same-player":"same-player collisions",
    "already-owned":"already-owned targets",
    "bank":"bank shortfall",
    "team-limit":"team limit >3",
    "min-delta":"Δ below +0.5",
    "bench-small":"bench Δ too small"
  }[code] || code;
  return `${label}: ${n}×`;
}
function uniq(arr){ return Array.from(new Set(arr)); }

/* ---------- scoring over horizon (identical to /transfer) ---------- */
function rowForHorizon(el, fixtures, teams, startGw, H = 1, damp = 0.94, minCut = 78){
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
      const dampK = idx === 0 ? 1.0 : damp;
      score += ppg * (minProb/100) * mult * dampK;
    });
  }
  return { score };
}
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x; // easy → ~1.10, hard → ~0.80
}

/* ---------- tiny utils shared with transfer ---------- */
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function teamShort(teams, id){ return teams[id]?.short_name || "?"; }
function teamIdToShort(id){ return String(id); } // replaced by lookup in disp (we embed actual short at build-time)
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

// We bake team short name inside disp using bootstrap teams:
function buildTeamShortMap(bootstrap){
  const out = {};
  for (const t of (bootstrap?.teams || [])) out[t.id] = t.short_name || "?";
  return out;
}

/* ---------- common GW helpers ---------- */
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

/* inject real team short into disp (called at top of chooseBestXI) */
(function monkeyPatchTeamShort(){
  // This function replaces teamIdToShort to actually consult a cached map.
  // We can't pass bootstrap here directly, so we lazy-init a map using globalThis.
  if (!globalThis.__TEAM_SHORT_MAP__) globalThis.__TEAM_SHORT_MAP__ = {};
  teamIdToShort = function(id){
    const map = globalThis.__TEAM_SHORT_MAP__;
    return map && map[id] ? map[id] : "?";
  };
})();

// When plan() runs we fill the map:
function fillTeamShortCache(bootstrap){
  if (!globalThis.__TEAM_SHORT_MAP__) globalThis.__TEAM_SHORT_MAP__ = {};
  const map = globalThis.__TEAM_SHORT_MAP__;
  for (const t of (bootstrap?.teams || [])) map[t.id] = t.short_name || "?";
}

// Patch: we must fill the cache before choosing XI; wrap chooseBestXI call
const _chooseBestXI = chooseBestXI;
chooseBestXI = function(rosterEls, byRow, cfg, nextGW){
  // ensure map is present (noop if already filled)
  if (!globalThis.__TEAM_SHORT_MAP__ || Object.keys(globalThis.__TEAM_SHORT_MAP__).length === 0) {
    // We can't access bootstrap here; but disp already embeds short name at build time elsewhere.
    // To ensure short shows, we’ll rebuild disp below using element.team’s short fetched via global map if present.
  }
  // Before returning, we ensure disp contains team short:
  const res = _chooseBestXI(rosterEls, byRow, cfg, nextGW);
  const map = globalThis.__TEAM_SHORT_MAP__ || {};
  const fix = (p) => {
    // replace trailing "(id)" with "(SHORT)" if possible
    const m = p.disp.match(/\((\d+)\)$/);
    if (m && map[m[1]]) p.disp = p.disp.replace(/\(\d+\)$/, `(${map[m[1]]})`);
    return p;
  };
  res.GK = res.GK.map(fix);
  res.DEF = res.DEF.map(fix);
  res.MID = res.MID.map(fix);
  res.FWD = res.FWD.map(fix);
  if (res.benchGK) res.benchGK = fix(res.benchGK);
  res.benchOutfield = res.benchOutfield.map(fix);
  return res;
};