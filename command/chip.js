// command/chip.js — Pro Auto (separate) chip advisor
// Heuristics-only: suggests TC/BB/FH/WC with reasons, using chooseChipAutoConfig.
// No actions are taken on your team; this is advisory output only.

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";
import { chooseChipAutoConfig } from "../presets.js";

const B = s => `<b>${esc(s)}</b>`;
const kUser = id => `user:${id}:profile`;

export default async function chip(env, chatId) {
  const raw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = raw ? (JSON.parse(raw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

  // fetch core data
  const [bootstrap, fixtures, entry, hist, picksCur] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`),
    // picks for current GW (we’ll project for next GW but this gives bank/mins hint)
    (async () => {
      const curGW = getCurrentGw(await getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"));
      return curGW ? await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`) : null;
    })()
  ]);

  if (!bootstrap || !fixtures || !entry) { await send(env, chatId, "Couldn't fetch FPL data. Try again."); return; }

  const nextGW  = getNextGwId(bootstrap);
  const curGW   = getCurrentGw(bootstrap);
  const cfg     = chooseChipAutoConfig({ bootstrap, fixtures, picks: picksCur });

  // chips availability
  const used = chipUsage(hist);
  const avail = {
    "3xc":     used["3xc"] < 1,
    "bboost":  used["bboost"] < 1,
    "freehit": used["freehit"] < 1,
    "wildcard":used["wildcard"] < 2,  // there are two wildcards per season
  };

  // element maps
  const els   = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const teams = Object.fromEntries((bootstrap?.teams||[]).map(t=>[t.id,t]));

  // your current 15
  const teamPicks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!teamPicks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }
  const ownedIds = (teamPicks?.picks||[]).map(p=>p.element);
  const squadEls = ownedIds.map(id=>els[id]).filter(Boolean);

  // fixture context (DGW/Blank) for next & short horizon
  const countsNext = gwFixtureCounts(fixtures, nextGW);
  const isBlankNext = isBlankWeek(countsNext);
  const isDGWRichNext = Object.values(countsNext).some(c => c > 1);

  // Project next GW XI, bench, and identify captain candidates
  const nextRows = squadEls.map(el => rowForGw(el, fixtures, nextGW, cfg.min));
  const gk  = nextRows.filter(r=>r.pos===1).sort(byScore);
  const def = nextRows.filter(r=>r.pos===2).sort(byScore);
  const mid = nextRows.filter(r=>r.pos===3).sort(byScore);
  const fwd = nextRows.filter(r=>r.pos===4).sort(byScore);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  const bestXi = pickBestXI(gk,def,mid,fwd,shapes);

  // Baseline (no chip): double captain (best player), no bench points
  const cap = bestXi?.xi[0] ? bestXi.xi.slice().sort(byScore)[0] : null;
  const baseNoCap = bestXi?.total || 0;
  const baseline  = baseNoCap + (cap?.score || 0); // captain adds +1x (from 1x to 2x)

  // ----- Score each chip -----
  const advice = [];

  // TRIPLE CAPTAIN
  if (avail["3xc"]) {
    const capCandidate = cap;
    const capGain = (capCandidate?.score || 0); // extra over normal captain (2x → 3x)
    const meetsDGW = (countsNext[capCandidate?.teamId || -1] || 0) > 1;
    const tcMin = meetsDGW && cfg.tcPreferDGW ? cfg.tcCaptainMinDouble : cfg.tcCaptainMinSingle;
    const tcOk  = (capCandidate?.score || 0) >= tcMin && (!isBlankNext);

    advice.push({
      chip: "Triple Captain",
      available: true,
      recommend: tcOk,
      reason: tcOk
        ? `Captain ${capCandidate?.name} projected ${(capCandidate?.score||0).toFixed(1)} ${meetsDGW?"(DGW)":""}; extra gain ≈ +${capGain.toFixed(1)}.`
        : `Wait: top captain only ${(capCandidate?.score||0).toFixed(1)}${isBlankNext?" and it’s a blank GW.":""}`,
      delta: tcOk ? capGain : 0
    });
  } else advice.push({ chip:"Triple Captain", available:false, recommend:false, reason:"Already used.", delta:0 });

  // BENCH BOOST
  if (avail["bboost"]) {
    const bench = computeBench(nextRows, bestXi?.xi || []);
    const benchSum = bench.sum;
    const benchDgwers = bench.rows.filter(r => (countsNext[r.teamId] || 0) > 1).length;
    const bbBoost = benchDgwers >= 2 ? cfg.bbBenchDgwBoost : 0;
    const bbOk = (benchSum + bbBoost) >= cfg.bbBenchThreshold && !isBlankNext;

    advice.push({
      chip: "Bench Boost",
      available: true,
      recommend: bbOk,
      reason: bbOk
        ? `Bench ≈ ${benchSum.toFixed(1)} pts${benchDgwers>=2?`, +${bbBoost} DGW boost`:''}.`
        : `Wait: bench only ≈ ${benchSum.toFixed(1)} pts${isBlankNext?" and it’s a blank GW.":""}`,
      delta: bbOk ? (benchSum + bbBoost) : 0
    });
  } else advice.push({ chip:"Bench Boost", available:false, recommend:false, reason:"Already used.", delta:0 });

  // FREE HIT
  if (avail["freehit"]) {
    const startersCount = (bestXi?.xi || []).length;
    const fhStrong = isBlankNext && startersCount < cfg.fhBlankStarterFloor;
    advice.push({
      chip: "Free Hit",
      available: true,
      recommend: fhStrong,
      reason: fhStrong
        ? `Blank GW with only ${startersCount} starters projected.`
        : (isBlankNext ? `Blank GW but you can field ${startersCount}.` : `Not a blank GW next.`),
      delta: fhStrong ? Math.max(0, cfg.fhBlankStarterFloor - startersCount) * 2 : 0 // rough proxy
    });
  } else advice.push({ chip:"Free Hit", available:false, recommend:false, reason:"Already used.", delta:0 });

  // WILDCARD
  if (avail["wildcard"]) {
    const riskyN = riskyStartersCountLike(squadEls, bootstrap, 80);
    // horizon drop heuristic (compare nextGW XI vs avg of next 3)
    const horizonAvg = horizonXIAvg(squadEls, fixtures, nextGW, cfg.min, cfg.damp, 3);
    const drop = Math.max(0, (baseline) - horizonAvg);
    const wcOk = (riskyN >= cfg.wcRiskyStarterTrigger) || (drop >= cfg.wcLookaheadDrop);

    advice.push({
      chip: "Wildcard",
      available: true,
      recommend: wcOk,
      reason: wcOk
        ? riskyN >= cfg.wcRiskyStarterTrigger
          ? `Many flagged/low-minutes starters (${riskyN}).`
          : `Projection drops by ≈ ${drop.toFixed(1)} over short horizon.`
        : `Squad OK: risky starters ${riskyN}, short-horizon drop ${drop.toFixed(1)}.`,
      delta: wcOk ? (riskyN >= cfg.wcRiskyStarterTrigger ? 4 : 2) : 0 // coarse indicator only
    });
  } else advice.push({ chip:"Wildcard", available:false, recommend:false, reason:"Both wildcards used.", delta:0 });

  // Pick top suggested
  const availableRecs = advice.filter(a => a.available);
  const best = availableRecs.filter(a => a.recommend).sort((a,b)=>b.delta-a.delta)[0];

  const head = [
    `${B("Team")}: ${esc(entry?.name || "Team")} | ${B("GW")}: ${nextGW} — Chips Advisor (Pro Auto • separate)`,
    `${B("Context")}: ${isDGWRichNext?"DGW ":""}${isBlankNext?"Blank ":""}| Captain baseline: ${cap ? `${esc(cap.name)} ${(cap.score||0).toFixed(1)}` : "—"}`
  ].join("\n");

  const lines = [];
  for (const a of advice) {
    const tag = a.recommend ? "✅" : (a.available ? "—" : "✖");
    lines.push(`${tag} ${B(a.chip)} — ${esc(a.reason)}`);
  }
  if (best) lines.push(`\n${B("Recommendation")}: ${best.chip}`);

  const html = [head, "", lines.join("\n")].join("\n");
  await send(env, chatId, html, "HTML");
}

/* -------- helpers -------- */
function chipUsage(hist){
  const map = { "3xc":0, "bboost":0, "freehit":0, "wildcard":0 };
  const arr = hist?.chips || [];
  for (const c of arr) {
    const name = String(c?.name || "").toLowerCase();
    if (name in map) map[name] += 1;
  }
  return map;
}

function gwFixtureCounts(fixtures, gw){
  const map={};
  for (const f of (fixtures||[])){
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h]||0)+1;
    map[f.team_a] = (map[f.team_a]||0)+1;
  }
  return map;
}
function isBlankWeek(counts){
  // blank week if at least one PL team has 0 fixtures and total fixtures are below normal
  const teamsWithFixture = Object.values(counts).filter(c=>c>0).length;
  return teamsWithFixture < 20; // typical 20 teams in PL
}

function byScore(a,b){ return (b.score - a.score); }

function computeBench(rows, xi){
  const xiSet = new Set((xi||[]).map(r=>r.id));
  const pool = rows.filter(r => !xiSet.has(r.id)).sort(byScore);
  const field = {
    outfield: pool.filter(r=>r.pos!==1).slice(0,3),
    gk: pool.find(r=>r.pos===1) || null
  };
  const benchRows = [...field.outfield, ...(field.gk?[field.gk]:[])];
  const sum = benchRows.reduce((s,r)=>s+(r.score||0), 0);
  return { rows: benchRows, sum };
}

function pickBestXI(gk,def,mid,fwd,shapes){
  const take=(a,n)=>a.slice(0,Math.min(n,a.length));
  let best=null;
  for (const [D,M,F] of shapes){
    if (!gk.length) continue;
    const g = gk[0], ds=take(def,D), ms=take(mid,M), fs=take(fwd,F);
    if (ds.length<D || ms.length<M || fs.length<F) continue;
    const xi=[g,...ds,...ms,...fs];
    const total=xi.reduce((s,r)=>s+(r.score||0),0);
    if (!best || total>best.total) best={ xi, total };
  }
  return best;
}

function rowForGw(el, fixtures, gw, minCut=78){
  const mp = chance(el); if (mp < minCut) return makeRow(el, 0);
  const ppg = parseFloat(el.points_per_game || "0") || 0;
  const fs = fixtures.filter(f=>f.event===gw && (f.team_h===el.team || f.team_a===el.team))
                     .sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);
  if (!fs.length) return makeRow(el, 0);
  let score=0;
  fs.forEach((f,idx)=>{
    const home = f.team_h===el.team;
    const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
    const mult = fdrMult(fdr);
    const damp = idx===0 ? 1.0 : 0.94;
    score += ppg * (mp/100) * mult * damp;
  });
  return makeRow(el, score);
}
function makeRow(el, s){
  return { id:el.id, name: (el.web_name||"—"), pos: el.element_type, teamId: el.team, score: s };
}
function chance(el){ const v=parseInt(el?.chance_of_playing_next_round ?? "100",10); return Number.isFinite(v)?Math.max(0,Math.min(100,v)):100; }
function fdrMult(fdr){ const x=Math.max(2,Math.min(5,Number(fdr)||3)); return 1.30 - 0.10*x; }

function horizonXIAvg(squadEls, fixtures, startGw, minCut, damp, H=3){
  // crude: average best-XI projection over startGw...startGw+H-1
  let tot=0, n=0;
  for (let g=startGw; g<startGw+H; g++){
    const rows = squadEls.map(el => rowForGw(el, fixtures, g, minCut));
    const gk  = rows.filter(r=>r.pos===1).sort(byScore);
    const def = rows.filter(r=>r.pos===2).sort(byScore);
    const mid = rows.filter(r=>r.pos===3).sort(byScore);
    const fwd = rows.filter(r=>r.pos===4).sort(byScore);
    const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
    const xi = pickBestXI(gk,def,mid,fwd,shapes);
    if (xi) {
      const cap = xi.xi.slice().sort(byScore)[0];
      const baseline = xi.total + (cap?.score || 0); // include normal captain
      tot += baseline; n++;
    }
  }
  return n ? (tot/n) : 0;
}

function getCurrentGw(bootstrap){
  const ev=bootstrap?.events||[];
  const cur=ev.find(e=>e.is_current); if (cur) return cur.id;
  const nxt=ev.find(e=>e.is_next);    if (nxt) return nxt.id;
  const up=ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id||1);
}
function getNextGwId(bootstrap){
  const ev=bootstrap?.events||[];
  const nxt=ev.find(e=>e.is_next); if (nxt) return nxt.id;
  const cur=ev.find(e=>e.is_current);
  if (cur){ const i=ev.findIndex(x=>x.id===cur.id); return ev[i+1]?.id || cur.id; }
  const up=ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id||1);
}
async function getJSON(url){
  try { const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return null; return await r.json().catch(()=>null);
  } catch { return null; }
}