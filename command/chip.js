// ./command/chip.js
// Pro Auto Chip Advisor (TC, BB, FH) for the NEXT gameweek.
// - Uses same horizon scoring as /transfer
// - Recommends a chip ONLY if projected gain clears thresholds
// - If nothing clears → "Hold"
// - Keeps output minimal, reasons included

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";
// Optional: presets; if missing chooseChipConfig, we’ll fall back to defaults at runtime
import * as presets from "../presets.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

// Shared with transfer/plan
const FORMATIONS = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[5,3,2],[5,4,1],[4,5,1]];
const MIN_AVAIL = 78;    // minutes/availability floor if presets not present
const H_DEFAULT = 2;     // horizon if presets not present
const DAMP_DEF  = 0.94;  // DGW damping for second game

export default async function chip(env, chatId, arg = "") {
  // 1) Ensure linked
  const pRaw   = await env.FPL_BOT_KV.get(kUser(chatId)).catch(()=>null);
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link &lt;TeamID&gt; first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) Fetch core data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));

  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGwId(bootstrap);

  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // 3) Pro chip config (from presets if available)
  const chooseChipConfig = (typeof presets.chooseChipConfig === "function") ? presets.chooseChipConfig : null;
  let cfg = chooseChipConfig ? chooseChipConfig({ bootstrap, fixtures, picks }) : null;
  // Safe defaults if presets missing
  cfg = {
    h: H_DEFAULT,           // look-ahead horizon for next GW scoring
    min: MIN_AVAIL,         // availability/playing chance
    damp: DAMP_DEF,
    ft: 1,
    // Chip thresholds (approximate gains required to fire)
    tc_min: 8.0,            // need a captain ceiling ≥ 8 pts for TC
    bb_min: 10.0,           // sum of bench expected ≥ 10
    fh_min: 10.0,           // gain vs your best XI ≥ 10
    ...cfg
  };

  // 4) Build per-player projected score for next GW window
  const byRow = {};
  for (const el of (bootstrap?.elements || [])) {
    byRow[el.id] = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
  }

  // 5) Your roster → best XI, bench, captain/vice (same philosophy as /plan)
  const allPicks = (picks?.picks || []);
  const ownedIds = allPicks.map(p => p.element);
  const rosterEls = ownedIds.map(id => els[id]).filter(Boolean);

  const xiPack = chooseBestXI(rosterEls, byRow);
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.keys(counts).filter(tid => counts[tid] > 1);
  const blankTeams = Object.keys(teams).filter(tid => (counts[tid] || 0) === 0);
  const badge = badgeLine(dgwTeams.length, blankTeams.length);

  // 6) Baseline numbers
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  // 7) Chip gains
  const gains = [];

  // 7a) Triple Captain (extra = +1 * captain's projected GW score)
  const cap = xiPack.candidates[0] || null;
  const tcGain = cap ? cap.score : 0;
  gains.push({
    code: "TC",
    label: "Triple Captain",
    gain: tcGain,
    pass: tcGain >= cfg.tc_min,
    why: cap ? [
      `Captain candidate: ${playerDisp(cap, teams, counts)} (proj ${cap.score.toFixed(2)})`,
      counts[cap.teamId] > 1 ? "Has DGW this GW." : "Single GW but strong ceiling."
    ] : ["No clear captain."]
  });

  // 7b) Bench Boost (sum of bench XI we wouldn’t normally get)
  const bbGain = (xiPack.benchGK ? xiPack.benchGK.score : 0)
               + xiPack.benchOutfield.reduce((s,p)=>s+p.score,0);
  gains.push({
    code: "BB",
    label: "Bench Boost",
    gain: bbGain,
    pass: bbGain >= cfg.bb_min,
    why: [
      `Bench value: ${bbGain.toFixed(2)} (${benchLine(xiPack, teams, counts)})`,
      xiPack.benchOutfield.some(p => counts[p.teamId] > 1) || (xiPack.benchGK && counts[xiPack.benchGK.teamId] > 1)
        ? "Bench includes DGW fixture(s)."
        : "Bench fixtures look OK."
    ]
  });

  // 7c) Free Hit (approximate): build market XI by raw score with team ≤3, ignore budget strictly, apply soft over-budget penalty
  const budgetApprox = xiPack.xiCost + bank;
  const market = buildMarketXI(bootstrap, byRow, budgetApprox);
  const fhGainRaw = market.score - xiPack.score;
  const fhGain = fhGainRaw;
  gains.push({
    code: "FH",
    label: "Free Hit",
    gain: fhGain,
    pass: fhGain >= cfg.fh_min,
    why: [
      `Market XI proj: ${market.score.toFixed(2)} vs your XI ${xiPack.score.toFixed(2)} (Δ ${fhGainRaw>=0?"+":""}${fhGainRaw.toFixed(2)})`,
      market.overBudget > 0 ? `Note: soft penalty for ~£${market.overBudget.toFixed(1)} over a rough XI budget.` : "Budget approximated OK."
    ]
  });

  // 8) Choose recommendation
  gains.sort((a,b)=>b.gain-a.gain);
  const top = gains[0] || null;
  const recommend = (top && top.pass) ? top : null;

  // 9) Render
  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Chip Advisor`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (assumed)")}: 1 | ${B("Model")}: Pro Chip Auto — h=${cfg.h}, min=${cfg.min}%` +
      (badge ? `  ${badge}` : "")
  ].join("\n");

  const lines = [];
  if (recommend) {
    lines.push(`${B("Recommendation")}: ${recommend.label}  —  projected gain ${(recommend.gain>=0?"+":"")}${recommend.gain.toFixed(2)}`);
  } else {
    lines.push(`${B("Recommendation")}: Hold (no chip clears thresholds)`);
  }

  lines.push("");
  lines.push(`${B("Estimates (this GW)")}:`);
  for (const g of gains) {
    lines.push(`• ${g.label}: ${(g.gain>=0?"+":"")}${g.gain.toFixed(2)} ${g.pass ? "✅" : "—"}`);
    g.why.slice(0,2).forEach(w => lines.push(`   • ${esc(w)}`));
  }

  // Show baseline XI quickly (with C/VC)
  lines.push("");
  lines.push(`${B("Your XI (baseline)")}: ${xiPack.formation.join("-")}  |  ${B("Proj")}: ${xiPack.score.toFixed(2)}`);
  renderGroup(lines, "GK",  xiPack.GK, teams, counts);
  renderGroup(lines, "DEF", xiPack.DEF, teams, counts);
  renderGroup(lines, "MID", xiPack.MID, teams, counts);
  renderGroup(lines, "FWD", xiPack.FWD, teams, counts);
  lines.push("");
  lines.push(`${B("Bench")}: ${benchLine(xiPack, teams, counts)}`);

  // Helper hint
  lines.push("");
  lines.push(`${B("Tip")}: Use /plan to optimize XI & captain; /transfer to improve squad.`);

  const html = [head, "", ...lines].join("\n");
  await send(env, chatId, html, "HTML");
}

/* ----------------- scoring & XI ----------------- */

function chooseBestXI(rosterEls, byRow){
  const withScore = rosterEls.map(el => ({
    id: el.id,
    posT: el.element_type,
    teamId: el.team,
    price: (el.now_cost || 0)/10,
    score: (byRow[el.id]?.score || 0),
    disp: playerShort(el)
  }));

  const GKs  = withScore.filter(p => p.posT === 1).sort((a,b)=>b.score-a.score);
  const DEFs = withScore.filter(p => p.posT === 2).sort((a,b)=>b.score-a.score);
  const MIDs = withScore.filter(p => p.posT === 3).sort((a,b)=>b.score-a.score);
  const FWDs = withScore.filter(p => p.posT === 4).sort((a,b)=>b.score-a.score);

  const bestGK = GKs[0] || null;
  let best = { score:-1e9, formation:[3,4,3], GK:[], DEF:[], MID:[], FWD:[], benchOutfield:[], benchGK:null, xiCost:0, candidates:[] };

  for (const [d,m,f] of FORMATIONS){
    if (!bestGK) continue;
    if (DEFs.length < d || MIDs.length < m || FWDs.length < f) continue;

    const pickDEF = DEFs.slice(0, d);
    const pickMID = MIDs.slice(0, m);
    const pickFWD = FWDs.slice(0, f);
    const xi = [bestGK, ...pickDEF, ...pickMID, ...pickFWD];
    const total = xi.reduce((s,p)=>s+p.score, 0);
    const cost  = xi.reduce((s,p)=>s+p.price, 0);

    if (total > best.score) {
      const used = new Set(xi.map(p=>p.id));
      const restOutfield = withScore.filter(p => p.posT !== 1 && !used.has(p.id)).sort((a,b)=>b.score-a.score);
      const benchGK = GKs[1] || null;
      best = {
        score: total,
        formation: [d,m,f],
        GK:  [ mark(xi[0]) ],
        DEF: pickDEF.map(mark),
        MID: pickMID.map(mark),
        FWD: pickFWD.map(mark),
        benchOutfield: restOutfield.slice(0,3).map(mark),
        benchGK: benchGK ? mark(benchGK) : null,
        xiCost: cost,
        candidates: xi.slice().sort((a,b)=>b.score-a.score) // for C/VC
      };
    }
  }

  // C/VC
  if (best.candidates[0]) best.candidates[0].cap = true;
  if (best.candidates[1]) best.candidates[1].vc  = true;
  best.GK  = best.GK.map(inherit(best.candidates));
  best.DEF = best.DEF.map(inherit(best.candidates));
  best.MID = best.MID.map(inherit(best.candidates));
  best.FWD = best.FWD.map(inherit(best.candidates));
  return best;

  function mark(p){ return { ...p, cap:false, vc:false }; }
  function inherit(pool){ return (p) => {
    const f = pool.find(x => x.id === p.id);
    return { ...p, cap: !!f?.cap, vc: !!f?.vc };
  }; }
}

/* ----------------- Chip helpers ----------------- */

function buildMarketXI(bootstrap, byRow, budgetApprox){
  const teams = bootstrap?.teams || [];
  const elements = bootstrap?.elements || [];

  const pool = elements
    .filter(el => chance(el) >= MIN_AVAIL)
    .map(el => ({
      id: el.id, posT: el.element_type, teamId: el.team,
      price: (el.now_cost || 0)/10,
      score: (byRow[el.id]?.score || 0),
      disp: playerShort(el)
    }));

  const byPos = {
    1: pool.filter(p=>p.posT===1).sort((a,b)=>b.score-a.score),
    2: pool.filter(p=>p.posT===2).sort((a,b)=>b.score-a.score),
    3: pool.filter(p=>p.posT===3).sort((a,b)=>b.score-a.score),
    4: pool.filter(p=>p.posT===4).sort((a,b)=>b.score-a.score),
  };

  let best = { score:-1e9, formation:[3,4,3], overBudget:0 };
  for (const [d,m,f] of FORMATIONS){
    if (byPos[1].length < 1 || byPos[2].length < d || byPos[3].length < m || byPos[4].length < f) continue;

    // Team cap ≤3 (greedy)
    const teamCount = {};
    const take = (list, k, acc=[]) => {
      for (const p of list) {
        const c = (teamCount[p.teamId]||0);
        if (c >= 3) continue;
        teamCount[p.teamId] = c+1;
        acc.push(p);
        if (acc.length === k) return acc;
      }
      return acc;
    };

    const xi = [];
    xi.push(byPos[1][0]); teamCount[byPos[1][0].teamId] = (teamCount[byPos[1][0].teamId]||0)+1;
    take(byPos[2], d, xi);
    take(byPos[3], m, xi);
    take(byPos[4], f, xi);
    if (xi.length !== (1+d+m+f)) continue;

    const cost = xi.reduce((s,p)=>s+p.price, 0);
    const score= xi.reduce((s,p)=>s+p.score, 0);

    // Soft budget penalty if we exceed a rough XI budget
    const over = Math.max(0, cost - (budgetApprox || 0));
    const penalty = over * 0.25; // each extra £1.0 costs ~0.25 expected points (tunable)
    const adjScore = score - penalty;

    if (adjScore > best.score) best = { score: adjScore, formation:[d,m,f], overBudget: over };
  }
  return best;
}

function benchLine(xiPack, teams, counts){
  const arr = [];
  xiPack.benchOutfield.forEach((p, i) => arr.push(`${i+1}) ${playerDisp(p, teams, counts)}`));
  if (xiPack.benchGK) arr.push(`GK) ${playerDisp(xiPack.benchGK, teams, counts)}`);
  return arr.join("  •  ");
}

function playerDisp(p, teams, counts){
  const short = teams?.[p.teamId]?.short_name || "?";
  const tag = counts?.[p.teamId] > 1 ? " (DGW)" : (counts?.[p.teamId] === 0 ? " (Blank)" : "");
  const cap = p.cap ? " (C)" : (p.vc ? " (VC)" : "");
  return `${p.disp} (${short})${tag}${cap}`;
}

/* ----------------- GW & scoring ----------------- */

function gwFixtureCounts(fixtures, gw){
  const map = {};
  for (const f of (fixtures||[])) {
    if (f.event !== gw) continue;
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
  return 1.30 - 0.10 * x; // 2→1.10, 3→1.00, 4→0.90, 5→0.80 approx
}

/* ----------------- small utils ----------------- */

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
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
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

function renderGroup(lines, label, arr, teams, counts){
  lines.push(`${B(label)}:`);
  arr.forEach(p => lines.push(`• ${esc(playerDisp(p, teams, counts))}`));
}