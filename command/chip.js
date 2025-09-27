// command/chip.js — Chip Planner (Pro Auto-Adaptive, self-contained; no presets import)

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

const B   = (s) => `<b>${esc(s)}</b>`;
const gbp = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const kUser = (id) => `user:${id}:profile`;

export default async function chip(env, chatId) {
  // 0) Require linked team
  const pRaw   = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) { await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.`, "HTML"); return; }

  // 1) Fetch live data (per run; auto updates per GW)
  const [bootstrap, fixtures, entry, picks, history] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
    (async () => {
      const cur = getCurrentGw(await getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"));
      return cur ? getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${cur}/picks/`) : null;
    })(),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`)
  ]);
  if (!bootstrap || !fixtures || !entry || !picks) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again in a moment."); return;
  }

  const nextGW = getNextGwId(bootstrap);
  const teams  = Object.fromEntries((bootstrap?.teams||[]).map(t => [t.id, t]));
  const byId   = Object.fromEntries((bootstrap?.elements||[]).map(e => [e.id, e]));
  const elsOf  = (p) => byId[p.element];
  const squadEls = (picks?.picks||[]).map(elsOf).filter(Boolean);

  // 2) Used chips (so we don’t suggest already-spent ones)
  const usedChips = new Set((history?.chips || []).map(c => c.name)); // "bench_boost","triple_captain","freehit","wildcard"
  const canBB = !usedChips.has("bench_boost");
  const canTC = !usedChips.has("triple_captain");
  const canFH = !usedChips.has("freehit");
  // Wildcard has season split; we don’t strictly block, but we still show the window.
  // (Managers can decide if WC available.)

  // 3) Auto-Adaptive Pro settings (derived each run)
  const cfg = chooseChipAutoConfig({ bootstrap, fixtures, picks });

  // 4) Evaluate each GW in horizon
  const horizon = [];
  for (let g = nextGW; g < nextGW + cfg.H; g++) {
    const xi = bestXIForGw(squadEls, teams, fixtures, g, cfg.min, cfg.damp);
    horizon.push({
      gw: g,
      xi, // { total, benchSum, benchSafeCount, benchLine, hardInXI, riskyInXI, availStarters, captainRow }
    });
  }

  // 5) Build chip suggestions
  // Bench Boost: prefer benches with 4 safe + high benchSum
  const bbList = canBB
    ? horizon
        .filter(r => r.xi.benchSafeCount >= cfg.bbSafeFloor)
        .sort((a,b)=> b.xi.benchSum - a.xi.benchSum)
        .slice(0, 2)
    : [];

  // Triple Captain: top captainRow score, prefer DGW captain
  const tcList = canTC
    ? horizon
        .map(r => ({
          gw: r.gw,
          cap: r.xi.captainRow,
          score: r.xi.captainRow?.score || 0,
          isDGW: (r.xi.captainRow?.double || 0) > 1
        }))
        .filter(x => x.score >= cfg.tcFloor)
        .sort((a,b)=> (b.isDGW - a.isDGW) || (b.score - a.score))
        .slice(0, 2)
    : [];

  // Free Hit: pain weeks (not enough starters OR too many hard fixtures)
  const fhCand = canFH
    ? horizon
        .map(r => {
          const pain = (r.xi.availStarters < cfg.fhMinStarters) || (r.xi.hardInXI >= cfg.fhHardFloor) || (r.xi.riskyInXI >= cfg.fhRiskyFloor);
          return { gw: r.gw, pain, why: { starters:r.xi.availStarters, hard:r.xi.hardInXI, risky:r.xi.riskyInXI } };
        })
        .filter(x => x.pain)
        .sort((a,b)=> {
          // earlier + more severe first
          const sa = sevScore(a.why, cfg), sb = sevScore(b.why, cfg);
          return sa===sb ? (a.gw-b.gw) : (sb-sa);
        })[0]
    : null;

  // Wildcard: rolling weakness + fragility
  const wcCand = (() => {
    const roll = rollingStress(horizon, cfg);
    return roll.sort((a,b)=> (b.stress - a.stress) || (a.gw - b.gw))[0] || null;
  })();

  // 6) Render
  const head = [
    `${B("Chip Planner")} — Pro Auto (Adaptive)`,
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("Target from GW")}: ${nextGW}`,
    `${B("Horizon")}: ${cfg.H} | ${B("Minutes floor")}: ${cfg.min}% | ${B("DGW damp")}: ${cfg.damp}`
  ].join("\n");

  const lines = [head, ""];

  // BB
  lines.push(B("Bench Boost"));
  if (!canBB) {
    lines.push("• Already used.");
  } else if (!bbList.length) {
    lines.push(`• No strong week (need ${cfg.bbSafeFloor} safe bench players).`);
  } else {
    bbList.forEach(r => {
      lines.push(`• GW${r.gw} — Bench sum ≈ ${r.xi.benchSum.toFixed(1)} | Bench: ${esc(r.xi.benchLine || "—")}`);
    });
  }
  lines.push("");

  // TC
  lines.push(B("Triple Captain"));
  if (!canTC) {
    lines.push("• Already used.");
  } else if (!tcList.length) {
    lines.push(`• No standout week (need captain ≥ ${cfg.tcFloor.toFixed(1)}).`);
  } else {
    tcList.forEach(r => {
      const tag = r.isDGW ? " (DGW)" : "";
      lines.push(`• GW${r.gw}${tag} — ${esc(r.cap.name)} (${esc(r.cap.team)}) | Captain score ≈ ${r.score.toFixed(1)}`);
    });
  }
  lines.push("");

  // FH
  lines.push(B("Free Hit"));
  if (!canFH) {
    lines.push("• Already used.");
  } else if (!fhCand) {
    lines.push("• No obvious pain week detected.");
  } else {
    lines.push(`• Consider GW${fhCand.gw} — starters ${fhCand.why.starters}/11, hard in XI ${fhCand.why.hard}, risky ${fhCand.why.risky}`);
  }
  lines.push("");

  // WC
  lines.push(B("Wildcard (window)"));
  if (!wcCand) {
    lines.push("• No clear stress window in this horizon.");
  } else {
    lines.push(`• Around GW${wcCand.gw} — XI ≈ ${wcCand.xi.toFixed(1)} | stress ${wcCand.stress.toFixed(1)} (hard:${wcCand.hard}, risky:${wcCand.risky}, starters:${wcCand.starters})`);
  }
  lines.push("");

  lines.push("Tip: Run /transfer and /plan to act on this.");

  await send(env, chatId, lines.join("\n"), "HTML");
}

/* ==========================
   Pro Auto-Adaptive config
   ========================== */
function chooseChipAutoConfig({ bootstrap, fixtures, picks }) {
  // Baseline
  let H   = 6;    // look-ahead GWs
  let min = 82;   // minutes floor (adaptive)
  let damp= 0.93; // DGW 2nd game damp factor

  // Signals
  const riskyN = riskyStartersCount(picks, bootstrap, 80);
  const dgwSoon= hasDGWWithin(fixtures, getNextGwId(bootstrap), 3);

  // Adapt minutes: fragile squads tighten the bar
  if (riskyN >= 3) min = 86;
  else if (riskyN === 2) min = 84;
  else min = 82;

  // Horizon: extend when DGW near to capture swings
  if (dgwSoon) H = 8;

  // Free Hit pain thresholds (stricter if fragile)
  const fhMinStarters = riskyN >= 2 ? 10 : 9;  // need at least this many
  const fhHardFloor   = riskyN >= 2 ? 8  : 9;  // “hard in XI” to flag pain
  const fhRiskyFloor  = riskyN >= 2 ? 3  : 4;  // risky XI count

  // Bench Boost: need 4 safe bench players
  const bbSafeFloor = 4;

  // Triple Captain: minimum projected captain score
  const tcFloor = dgwSoon ? 11.0 : 10.0;

  return { H, min, damp, fhMinStarters, fhHardFloor, fhRiskyFloor, bbSafeFloor, tcFloor };
}

/* ==========================
   Core evaluators
   ========================== */
function bestXIForGw(squadEls, teams, fixtures, gw, minCut, damp) {
  const rows = squadEls.map(el => rowForGw(el, teams, fixtures, gw, minCut, damp));

  const gks  = rows.filter(r => r.type===1);
  const defs = rows.filter(r => r.type===2).sort((a,b)=>b.score-a.score);
  const mids = rows.filter(r => r.type===3).sort((a,b)=>b.score-a.score);
  const fwds = rows.filter(r => r.type===4).sort((a,b)=>b.score-a.score);

  // Valid shapes
  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];

  // Pick GK (safe if possible)
  const pickGK = () => {
    const safe = gks.filter(r=>r.mp>=minCut && r.hasFixture).sort((a,b)=>b.score-a.score);
    if (safe.length) return safe[0];
    return gks.filter(r=>r.hasFixture).sort((a,b)=>b.score-a.score)[0] || null;
  };

  // Pick N by line with relax
  const pickN = (arr, n) => {
    const safe = arr.filter(r=>r.mp>=minCut && r.hasFixture).slice(0,n);
    if (safe.length===n) return { chosen:safe, relaxed:false };
    const need = n-safe.length;
    const fill = arr.filter(r=>r.hasFixture && !safe.find(x=>x.id===r.id)).slice(0,need);
    return { chosen:[...safe, ...fill], relaxed: need>0 };
  };

  let best=null;
  for (const [d,m,f] of shapes) {
    const gk = pickGK(); if (!gk) continue;
    const { chosen:D, relaxed:rD } = pickN(defs, d);
    const { chosen:M, relaxed:rM } = pickN(mids, m);
    const { chosen:F, relaxed:rF } = pickN(fwds, f);
    if (D.length<d || M.length<m || F.length<f) continue;

    const xi = [gk, ...D, ...M, ...F];
    const total = xi.reduce((s,r)=>s+r.score,0);

    const benchPool = rows.filter(r => r.hasFixture && !xi.find(x=>x.id===r.id));
    const benchOut  = benchPool.sort((a,b)=>b.score-a.score).slice(0,3);
    const benchGK   = gks.find(r => r.hasFixture && r.id!==gk.id);

    const benchLine = [
      benchOut[0] ? `1) ${benchOut[0].name} (${benchOut[0].pos})` : null,
      benchOut[1] ? `2) ${benchOut[1].name} (${benchOut[1].pos})` : null,
      benchOut[2] ? `3) ${benchOut[2].name} (${benchOut[2].pos})` : null,
      benchGK     ? `GK: ${benchGK.name}` : null
    ].filter(Boolean).join(", ");

    const benchSum = (benchOut.reduce((s,r)=>s+r.score,0) + (benchGK?.score || 0));
    const benchSafeCount =
      benchOut.filter(r=>r.mp>=minCut).length + ((benchGK && benchGK.mp>=minCut) ? 1 : 0);

    const hardInXI  = xi.filter(r => (r.avgFdr ?? 3) >= 4.5).length;
    const riskyInXI = xi.filter(r => r.mp < minCut || !r.hasFixture).length;

    // Captain row = best scorer
    const captainRow = xi.slice().sort((a,b)=>b.score-a.score)[0] || null;

    const availStarters = xi.filter(r => r.hasFixture && r.mp>=minCut).length;

    const cand = {
      total, benchSum, benchSafeCount, benchLine,
      hardInXI, riskyInXI, availStarters, captainRow,
      relaxed: (rD || rM || rF)
    };
    if (!best || cand.total > best.total) best = cand;
  }
  // Fallback if something went very wrong
  if (!best) {
    const zero = { total:0, benchSum:0, benchSafeCount:0, benchLine:"—", hardInXI:0, riskyInXI:11, availStarters:0, captainRow:null, relaxed:true };
    return zero;
  }
  return best;
}

function rowForGw(el, teams, fixtures, gw, minCut, damp) {
  const mp = chance(el);
  const safe = mp >= minCut;
  const fs = fixturesForTeam(fixtures, el.team, gw);
  if (!fs.length) {
    return baseRow(el, teams, mp, false, 0, null, 0);
  }
  const ppg = parseFloat(el.points_per_game || "0") || 0;

  let score = 0, fdrAvg=0;
  fs.forEach((f, idx) => {
    const home = f.team_h === el.team;
    const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3)
                      : (f.team_a_difficulty ?? f.difficulty ?? 3);
    fdrAvg += fdr;
    const mult = fdrMult(fdr);
    const dampK = idx === 0 ? 1.0 : damp;
    score += ppg * (mp/100) * mult * dampK;
  });
  fdrAvg /= fs.length;

  const r = baseRow(el, teams, mp, true, score, fdrAvg, fs.length);
  r.safe = safe;
  return r;
}

function baseRow(el, teams, mp, hasFixture, score, avgFdr, double) {
  return {
    id: el.id,
    name: playerShort(el),
    team: teamShort(teams, el.team),
    type: el.element_type,
    pos: posName(el.element_type),
    mp, hasFixture, score, avgFdr, double
  };
}

/* ==========================
   Helpers & signals
   ========================== */
function sevScore(why, cfg){
  // crude severity for FH
  const lack = Math.max(0, cfg.fhMinStarters - (why.starters || 0));
  return (lack*2) + (why.hard || 0) + (why.risky || 0);
}
function rollingStress(horizon, cfg){
  // stress = low XI + many hard fixtures + risky XI + short starters
  return horizon.map(r => ({
    gw: r.gw,
    xi: r.xi.total,
    hard: r.xi.hardInXI,
    risky: r.xi.riskyInXI,
    starters: r.xi.availStarters,
    stress: (Math.max(0, 55 - r.xi.total)/5) + r.xi.hardInXI + (r.xi.riskyInXI*1.5) + Math.max(0, 11 - r.xi.availStarters)
  }));
}
function riskyStartersCount(picks, bootstrap, minCut=80){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  let n=0;
  for (const p of xi){
    const el = byId[p.element]; if (!el) continue;
    const mp = chance(el);
    if (mp < minCut) n++;
  }
  return n;
}
function hasDGWWithin(fixtures, startGw, within=3){
  const map = {};
  for (const f of (fixtures||[])) {
    if (f.event == null) continue;
    if (f.event < startGw || f.event >= startGw + within) continue;
    map[f.team_h] = (map[f.team_h]||0) + 1;
    map[f.team_a] = (map[f.team_a]||0) + 1;
  }
  for (const tid in map) if (map[tid] > 1) return true;
  return false;
}
function fixturesForTeam(fixtures, teamId, gw){
  return (fixtures||[])
    .filter(f => f.event === gw && (f.team_h === teamId || f.team_a === teamId))
    .sort((a,b)=> ((a.kickoff_time||"") < (b.kickoff_time||"")) ? -1 : 1);
}
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x; // 1.10 (easy) ... 0.80 (hard)
}
function posName(t){ return ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?"; }
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
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function getCurrentGw(bootstrap){
  const ev=bootstrap?.events||[];
  const cur = ev.find(e=>e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e=>e.is_next);    if (nxt) return nxt.id;
  const up  = ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}
function getNextGwId(bootstrap){
  const ev=bootstrap?.events||[];
  const nxt = ev.find(e=>e.is_next); if (nxt) return nxt.id;
  const cur = ev.find(e=>e.is_current);
  if (cur){
    const i = ev.findIndex(x=>x.id===cur.id);
    return ev[i+1]?.id || cur.id;
  }
  const up = ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}
async function getJSON(url){
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12000) });
    if (!r.ok) return null;
    return await r.json().catch(()=>null);
  } catch { return null; }
}