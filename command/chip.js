// command/chip.js — Pro Auto (separate) chip advisor
// Uses chooseChipAutoConfig from presets.js
import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";
import { chooseChipAutoConfig } from "../presets.js";

const B = s => `<b>${esc(s)}</b>`;
const kUser = id => `user:${id}:profile`;

export default async function chip(env, chatId) {
  try {
    const raw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
    const teamId = raw ? (JSON.parse(raw).teamId) : null;
    if (!teamId) {
      await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
      return;
    }

    const [bootstrap, fixtures, entry, hist] = await Promise.all([
      getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
      getJSON("https://fantasy.premierleague.com/api/fixtures/"),
      getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
      getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`)
    ]);
    if (!bootstrap || !fixtures || !entry) { await send(env, chatId, "Couldn't fetch FPL data. Try again."); return; }

    const curGW  = getCurrentGw(bootstrap);
    const nextGW = getNextGwId(bootstrap);

    const picksCur = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
    if (!picksCur) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

    const cfg = chooseChipAutoConfig({ bootstrap, fixtures, picks: picksCur });

    const used = chipUsage(hist);
    const avail = {
      "3xc":      used["3xc"] < 1,
      "bboost":   used["bboost"] < 1,
      "freehit":  used["freehit"] < 1,
      "wildcard": used["wildcard"] < 2
    };

    const els   = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
    const countsNext = gwFixtureCounts(fixtures, nextGW);
    const isBlankNext = isBlankWeek(countsNext);

    // your current 15 rows for next GW
    const ownedIds = (picksCur?.picks||[]).map(p=>p.element);
    const squadEls = ownedIds.map(id=>els[id]).filter(Boolean);
    const rowsNext = squadEls.map(el => rowForGw(el, fixtures, nextGW, cfg.min)).sort(byScore);

    // pick best XI over common shapes and a captain
    const gk  = rowsNext.filter(r=>r.pos===1).sort(byScore);
    const def = rowsNext.filter(r=>r.pos===2).sort(byScore);
    const mid = rowsNext.filter(r=>r.pos===3).sort(byScore);
    const fwd = rowsNext.filter(r=>r.pos===4).sort(byScore);
    const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
    const bestXi = pickBestXI(gk,def,mid,fwd,shapes);

    const cap = bestXi?.xi?.slice()?.sort(byScore)?.[0] || null;
    const baselineNoCap = bestXi?.total || 0;
    const baselineWithCap = baselineNoCap + (cap?.score || 0); // 2x cap included

    // score chips
    const advice = [];

    // Triple Captain
    if (avail["3xc"]) {
      const meetsDGW = (countsNext[cap?.teamId || -1] || 0) > 1;
      const tcMin = (meetsDGW && cfg.tcPreferDGW) ? cfg.tcCaptainMinDouble : cfg.tcCaptainMinSingle;
      const tcGain = (cap?.score || 0); // extra over normal captain (2x → 3x)
      const ok = !isBlankNext && (cap?.score || 0) >= tcMin;
      advice.push({
        chip: "Triple Captain",
        available: true,
        recommend: ok,
        reason: ok
          ? `Captain ${cap?.name} ${(cap?.score||0).toFixed(1)} ${meetsDGW?"(DGW)":""}; extra ≈ +${tcGain.toFixed(1)}.`
          : `Wait: top captain only ${(cap?.score||0).toFixed(1)}${isBlankNext?" and blank GW.":""}`,
        delta: ok ? tcGain : 0
      });
    } else advice.push({ chip:"Triple Captain", available:false, recommend:false, reason:"Already used.", delta:0 });

    // Bench Boost
    if (avail["bboost"]) {
      const bench = computeBench(rowsNext, bestXi?.xi || []);
      const benchDgwers = bench.rows.filter(r => (countsNext[r.teamId] || 0) > 1).length;
      const bbBoost = benchDgwers >= 2 ? cfg.bbBenchDgwBoost : 0;
      const ok = !isBlankNext && (bench.sum + bbBoost) >= cfg.bbBenchThreshold;
      advice.push({
        chip: "Bench Boost",
        available: true,
        recommend: ok,
        reason: ok
          ? `Bench ≈ ${bench.sum.toFixed(1)} pts${benchDgwers>=2?`, +${bbBoost} DGW boost`:''}.`
          : `Wait: bench only ≈ ${bench.sum.toFixed(1)} pts${isBlankNext?" and blank GW.":""}`,
        delta: ok ? (bench.sum + bbBoost) : 0
      });
    } else advice.push({ chip:"Bench Boost", available:false, recommend:false, reason:"Already used.", delta:0 });

    // Free Hit
    if (avail["freehit"]) {
      const starters = (bestXi?.xi || []).length;
      const ok = isBlankNext && starters < cfg.fhBlankStarterFloor;
      advice.push({
        chip: "Free Hit",
        available: true,
        recommend: ok,
        reason: ok
          ? `Blank GW with only ${starters} starters projected.`
          : (isBlankNext ? `Blank GW but you can field ${starters}.` : `Not a blank GW.`),
        delta: ok ? Math.max(0, cfg.fhBlankStarterFloor - starters) * 2 : 0
      });
    } else advice.push({ chip:"Free Hit", available:false, recommend:false, reason:"Already used.", delta:0 });

    // Wildcard
    if (avail["wildcard"]) {
      const riskyN = riskyStartersCountLike(squadEls, 80);
      const horizonAvg = horizonXIAvg(squadEls, fixtures, nextGW, cfg.min, 3);
      const drop = Math.max(0, (baselineWithCap) - horizonAvg);
      const ok = (riskyN >= cfg.wcRiskyStarterTrigger) || (drop >= cfg.wcLookaheadDrop);
      advice.push({
        chip: "Wildcard",
        available: true,
        recommend: ok,
        reason: ok
          ? (riskyN >= cfg.wcRiskyStarterTrigger
              ? `Many flagged/low-minutes starters (${riskyN}).`
              : `Short-horizon drop ≈ ${drop.toFixed(1)} pts.`)
          : `Squad stable (risky starters ${riskyN}, drop ${drop.toFixed(1)}).`,
        delta: ok ? (riskyN >= cfg.wcRiskyStarterTrigger ? 4 : 2) : 0
      });
    } else advice.push({ chip:"Wildcard", available:false, recommend:false, reason:"Both wildcards used.", delta:0 });

    const availableRecs = advice.filter(a => a.available);
    const best = availableRecs.filter(a => a.recommend).sort((a,b)=>b.delta-a.delta)[0];

    const head = [
      `${B("Team")}: ${esc(entry?.name || "Team")} | ${B("GW")}: ${nextGW} — Chips Advisor (Pro Auto • separate)`,
      `${B("Captain baseline")}: ${cap ? `${esc(cap.name)} ${(cap.score||0).toFixed(1)}` : "—"}`
    ].join("\n");

    const lines = advice.map(a => {
      const tag = a.recommend ? "✅" : (a.available ? "—" : "✖");
      return `${tag} ${B(a.chip)} — ${esc(a.reason)}`;
    });
    if (best) lines.push(`\n${B("Recommendation")}: ${best.chip}`);

    await send(env, chatId, [head, "", lines.join("\n")].join("\n"), "HTML");
  } catch (e) {
    await send(env, chatId, `Chip advisor error.\n\n<code>${(e && (e.stack || e.message)) || String(e)}</code>`, "HTML");
  }
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
  const teamsWithFixture = Object.values(counts).filter(c=>c>0).length;
  return teamsWithFixture < 20;
}
function byScore(a,b){ return (b.score - a.score); }
function computeBench(rows, xi){
  const xiSet = new Set((xi||[]).map(r=>r.id));
  const pool = rows.filter(r => !xiSet.has(r.id)).sort(byScore);
  const outfield = pool.filter(r=>r.pos!==1).slice(0,3);
  const gk = pool.find(r=>r.pos===1) || null;
  const benchRows = [...outfield, ...(gk?[gk]:[])];
  const sum = benchRows.reduce((s,r)=>s+(r.score||0), 0);
  return { rows: benchRows, sum };
}
function pickBestXI(gk,def,mid,fwd,shapes){
  const take=(a,n)=>a.slice(0,Math.min(n,a.length));
  let best=null;
  for (const [D,M,F] of shapes){
    if (!gk.length) continue;
    const g=gk[0], ds=take(def,D), ms=take(mid,M), fs=take(fwd,F);
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
function makeRow(el, s){ return { id:el.id, name:(el.web_name||"—"), pos:el.element_type, teamId:el.team, score:s }; }
function chance(el){ const v=parseInt(el?.chance_of_playing_next_round ?? "100",10); return Number.isFinite(v)?Math.max(0,Math.min(100,v)):100; }
function fdrMult(fdr){ const x=Math.max(2,Math.min(5,Number(fdr)||3)); return 1.30 - 0.10*x; }

function riskyStartersCountLike(squadEls, minCut=80){
  let n=0;
  for (const el of squadEls){
    const mp = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}
function horizonXIAvg(squadEls, fixtures, startGw, minCut, H=3){
  let tot=0, n=0;
  for (let g=startGw; g<startGw+H; g++){
    const rows = squadEls.map(el => rowForGw(el, fixtures, g, minCut));
    const gk  = rows.filter(r=>r.pos===1).sort(byScore);
    const def = rows.filter(r=>r.pos===2).sort(byScore);
    const mid = rows.filter(r=>r.pos===3).sort(byScore);
    const fwd = rows.filter(r=>r.pos===4).sort(byScore);
    const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
    const best = pickBestXI(gk,def,mid,fwd,shapes);
    if (best) {
      const cap = best.xi.slice().sort(byScore)[0];
      const base = best.total + (cap?.score || 0);
      tot += base; n++;
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