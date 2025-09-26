// src/commands/chip.js — Chip Planner (Pro Auto preset)
// Usage: /chip [h=6]  (h optional; default from preset)
// Output: BB / TC / FH / WC short recommendations + "why"

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";
import { chooseAutoConfig } from "../presets.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n==null ? "—" : `£${Number(n).toFixed(1)}`);
const posOf = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

/* -------------------- entry -------------------- */
export default async function chip(env, chatId, arg="") {
  // 1) Resolve team
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

  // 2) Pull FPL data
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
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  const hist   = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // 3) Config: Pro Auto + optional horizon override
  let cfg = chooseAutoConfig({ bootstrap, fixtures, picks });
  const hArg = parseInt((String(arg||"").match(/\bh=(\d+)\b/i)?.[1] || ""), 10);
  if (Number.isFinite(hArg) && hArg>=3 && hArg<=10) cfg = { ...cfg, chip: { ...cfg.chip }, h: Math.min(cfg.chip.wcHorizon, hArg) };

  // 4) Build weekly projections over horizon
  const H = cfg.h || cfg.chip.wcHorizon || 6;
  const weeks = [];
  for (let gw = nextGW; gw < nextGW + H; gw++) {
    const wk = projectWeek({ gw, bootstrap, fixtures, picks, minCut: cfg.min, damp: cfg.damp });
    weeks.push(wk);
  }

  // 5) Evaluate chip windows
  const dgwInfo = dgwBlankSummary(fixtures, nextGW, nextGW + H - 1);
  const bb = adviseBB(weeks, cfg);
  const tc = adviseTC(weeks, cfg);
  const fh = adviseFH(weeks, cfg);
  const wc = adviseWC(weeks, cfg);

  // 6) Header
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;
  const usedThis = (picks?.entry_history?.event_transfers || 0);
  const nextFT   = usedThis === 0 ? 2 : 1;

  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW Horizon")}: ${H} — Chip Planner (Auto Pro)`,
    `${B("Bank")}: ${gbp(bank)} | ${B("FT (assumed next)")}: ${nextFT} | ${B("Model")}: h=${H}, min=${cfg.min}%, damp=${cfg.damp}`,
    dgwInfo ? `${B("DGW/Blank")}: ${esc(dgwInfo)}` : ""
  ].filter(Boolean).join("\n");

  // 7) Blocks
  const lines = [head, ""];
  lines.push(renderBB(bb));
  lines.push("");
  lines.push(renderTC(tc));
  lines.push("");
  lines.push(renderFH(fh));
  lines.push("");
  lines.push(renderWC(wc));
  lines.push("");
  lines.push("Tips: Use /plan to set XI shape per week, and /transfer for targeted upgrades. Add `h=8` to scan further.");

  await send(env, chatId, lines.join("\n"), "HTML");
}

/* -------------------- advisors -------------------- */
function adviseBB(weeks, cfg){
  const ok = weeks
    .map(w => ({
      gw: w.gw,
      benchSafe: w.benchSafe,
      benchEv: Number(w.benchEv.toFixed(1)),
      benchLine: w.benchLine,
      why: [
        `benchSafe=${w.benchSafe}`,
        `benchEv=${w.benchEv.toFixed(1)}`
      ]
    }))
    .filter(w => w.benchSafe >= cfg.chip.bbBenchSafeMin && w.benchEv >= cfg.chip.bbBenchEvMin)
    .sort((a,b)=>b.benchEv - a.benchEv)
    .slice(0,2);
  return { top: ok, rule: `Need benchSafe ≥ ${cfg.chip.bbBenchSafeMin} & benchEV ≥ ${cfg.chip.bbBenchEvMin}` };
}

function adviseTC(weeks, cfg){
  const capEvs = weeks.map(w => w.capEv).filter(x=>Number.isFinite(x) && x>0);
  const median = capEvs.length ? quantile(capEvs.slice().sort((a,b)=>a-b), 0.5) : 0;
  const ok = weeks
    .map(w => ({
      gw: w.gw,
      cap: w.capName,
      capEv: Number(w.capEv.toFixed(1)),
      spike: Number((w.capEv - median).toFixed(1)),
      dgw: w.capDGW
    }))
    .filter(x => (x.capEv - median) >= cfg.chip.tcSpikeMin || x.capEv >= cfg.chip.tcCapEvMin)
    .sort((a,b)=> (b.capEv - a.capEv))
    .slice(0,2);
  return { top: ok, baseline: median.toFixed(1), rule: `Spike ≥ ${cfg.chip.tcSpikeMin} or CapEV ≥ ${cfg.chip.tcCapEvMin}` };
}

function adviseFH(weeks, cfg){
  // Rough “best-of-market” XI vs my XI this week (ignores budget, ok for signal)
  const ok = [];
  for (const w of weeks){
    const gain = Math.max(0, w.marketXiEv - w.xiEv);
    const pain = (w.starters < 10) || (w.hardInXi >= 7) || (w.riskyXi >= 3);
    if (gain >= cfg.chip.fhGainMin || pain || w.xiEv < cfg.chip.fhMyEvMin) {
      ok.push({
        gw: w.gw,
        myXi: Number(w.xiEv.toFixed(1)),
        marketXi: Number(w.marketXiEv.toFixed(1)),
        gain: Number(gain.toFixed(1)),
        flags: pain ? flagsForWeek(w) : ""
      });
    }
  }
  ok.sort((a,b)=> (b.gain - a.gain) || (b.marketXi - a.marketXi));
  return { top: ok.slice(0,1), rule: `Gain ≥ ${cfg.chip.fhGainMin} or starters<10 / hard fixtures / risky XI` };
}

function adviseWC(weeks, cfg){
  // Average next 3 weeks if available
  const take = weeks.slice(0, Math.min(3, weeks.length));
  const avgMy   = take.reduce((s,w)=>s+w.xiEv,0) / Math.max(1,take.length);
  const avgMkt  = take.reduce((s,w)=>s+w.marketXiEv,0) / Math.max(1,take.length);
  const stress  = weeks.length ? Math.max(...weeks.map(w=>w.stress)) : 0;
  const gain    = avgMkt - avgMy;
  const suggest = (gain >= cfg.chip.wcGainMin) && (stress >= cfg.chip.wcStressMin);

  // pick the week with highest stress as the window
  const worst = weeks.slice().sort((a,b)=>b.stress - a.stress)[0];

  return {
    suggest,
    window: worst ? { gw: worst.gw, stress: worst.stress } : null,
    gain: Number(gain.toFixed(1)),
    rule: `Avg gain ≥ ${cfg.chip.wcGainMin} & stress ≥ ${cfg.chip.wcStressMin}`
  };
}

/* -------------------- renderers -------------------- */
function renderBB(bb){
  const lines = [];
  lines.push(`${B("Bench Boost")}`);
  if (!bb.top.length) {
    lines.push(`• No strong window. (${esc(bb.rule)})`);
    return lines.join("\n");
  }
  bb.top.forEach(w=>{
    lines.push(`• GW${w.gw} — BenchEV ${w.benchEv} | ${w.benchLine}`);
  });
  lines.push(`Why: ${esc(bb.rule)}`);
  return lines.join("\n");
}
function renderTC(tc){
  const lines = [];
  lines.push(`${B("Triple Captain")}`);
  if (!tc.top.length) {
    lines.push(`• No standout spike. (baseline CapEV ${tc.baseline})`);
    return lines.join("\n");
  }
  tc.top.forEach(w=>{
    const tag = w.dgw ? " (DGW)" : "";
    lines.push(`• GW${w.gw} — ${esc(w.cap)}${tag} | CapEV ${w.capEv} | Spike +${w.spike}`);
  });
  lines.push(`Why: baseline ${tc.baseline}, rule: ${esc(tc.rule)}`);
  return lines.join("\n");
}
function renderFH(fh){
  const lines = [];
  lines.push(`${B("Free Hit")}`);
  if (!fh.top.length) {
    lines.push("• Hold FH for now.");
    return lines.join("\n");
  }
  const w = fh.top[0];
  lines.push(`• GW${w.gw} — EV gain +${w.gain} (my ${w.myXi} → market ${w.marketXi})${w.flags?` | ${w.flags}`:""}`);
  lines.push(`Why: ${esc(fh.rule)}`);
  return lines.join("\n");
}
function renderWC(wc){
  const lines = [];
  lines.push(`${B("Wildcard")}`);
  if (!wc.suggest || !wc.window) {
    lines.push(`• No urgent WC signal. (Avg gain +${wc.gain}, rule: ${esc(wc.rule)})`);
    return lines.join("\n");
  }
  lines.push(`• Consider GW${wc.window.gw} — stress ${wc.window.stress} | projected avg gain +${wc.gain}`);
  lines.push(`Why: ${esc(wc.rule)}`);
  return lines.join("\n");
}

/* -------------------- projections -------------------- */
function projectWeek({ gw, bootstrap, fixtures, picks, minCut=85, damp=0.94 }){
  const els = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const teams = Object.fromEntries((bootstrap?.teams||[]).map(t=>[t.id,t]));
  const all = (picks?.picks||[]).map(p=>els[p.element]).filter(Boolean);

  // score every squad player for this GW
  const rows = all.map(el => rowForGw(el, fixtures, gw, minCut, damp));

  // Best XI (legal shapes)
  const best = bestXI(rows);

  // Bench EV (top 3 outfield + backup GK)
  const pool = rows.slice().sort((a,b)=>b.ev-a.ev);
  const byType = (t) => pool.filter(r=>r.type===t);
  const gks    = byType(1);
  const outs   = pool.filter(r=>r.type!==1);
  const bench3 = outs.filter(r=>!best.xi.find(x=>x.id===r.id)).slice(0,3);
  const bGk    = gks.find(r=>!best.xi.find(x=>x.id===r.id));
  const benchEv = bench3.reduce((s,r)=>s+r.ev,0) + (bGk?.ev || 0);
  const benchSafe = bench3.filter(r=>r.hasFixture && r.min>=minCut).length + ((bGk && bGk.hasFixture && bGk.min>=minCut)?1:0);
  const benchLine = [
    bench3[0] ? `1) ${bench3[0].name} (${bench3[0].pos})` : null,
    bench3[1] ? `2) ${bench3[1].name} (${bench3[1].pos})` : null,
    bench3[2] ? `3) ${bench3[2].name} (${bench3[2].pos})` : null,
    bGk       ? `GK) ${bGk.name}` : null
  ].filter(Boolean).join(", ");

  // Captain EV & DGW tag
  const cap = best.xi.slice().sort((a,b)=>b.ev-a.ev)[0];
  const capName = cap ? cap.name : "—";
  const capEv   = cap ? cap.ev : 0;
  const capDGW  = cap ? cap.double>1 : false;

  // Hard fixtures count & risky XI count
  const hardInXi = best.xi.filter(r => (r.avgFdr ?? 3) >= 4.5).length;
  const riskyXi  = best.xi.filter(r => (!r.hasFixture || r.min < minCut)).length;

  // Market (rough best XI this week, from all players)
  const marketPool = (bootstrap?.elements||[])
    .map(el => rowForGw(el, fixtures, gw, minCut, damp))
    .filter(r => r.hasFixture && r.min>=minCut);
  const marketBest = bestXI(marketPool);
  const starters = best.xi.filter(r=>r.hasFixture && r.min>=minCut).length;

  // Stress
  const stress = (riskyXi*3) + Math.max(0, 8 - hardInXi) + Math.max(0, 4 - benchSafe);

  return {
    gw,
    xiEv: sumEv(best.xi),
    marketXiEv: sumEv(marketBest.xi),
    starters,
    hardInXi,
    riskyXi,
    benchEv,
    benchSafe,
    benchLine,
    capName, capEv, capDGW,
    stress
  };
}

function bestXI(rows){
  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  const type = (t)=>rows.filter(r=>r.type===t).slice().sort((a,b)=>b.ev-a.ev);
  const G=type(1), D=type(2), M=type(3), F=type(4);
  let best=null;

  const pickGK = ()=> G.length ? G[0] : null;
  function pickN(arr, n){
    const ok = arr.filter(r=>r.hasFixture).slice(0,n);
    if (ok.length===n) return ok;
    // if not enough with fixture, allow next best (rare)
    const more = arr.filter(r=>!ok.find(x=>x.id===r.id)).slice(0, n-ok.length);
    return [...ok, ...more];
  }

  for (const [d,m,f] of shapes){
    const gk = pickGK(); if(!gk) continue;
    const ds = pickN(D, d); if (ds.length<d) continue;
    const ms = pickN(M, m); if (ms.length<m) continue;
    const fs = pickN(F, f); if (fs.length<f) continue;
    const xi = [gk, ...ds, ...ms, ...fs];
    const ev = sumEv(xi);
    if (!best || ev>best.ev) best = { xi, ev };
  }
  return best || { xi: [], ev: 0 };
}

function rowForGw(el, fixtures, gw, minCut=85, damp=0.94){
  const min = chance(el);
  const name = shortName(el);
  const pos  = posOf(el.element_type);

  const games = fixtures
    .filter(f => f.event===gw && (f.team_h===el.team || f.team_a===el.team))
    .sort((a,b)=> ((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);

  if (min < minCut || games.length===0) {
    return { id: el.id, name, pos, type: el.element_type, min, ev: 0, hasFixture: games.length>0, avgFdr: games.length? avgFdrFor(el, games) : null, double: games.length };
  }

  let ev=0;
  games.forEach((g, idx)=>{
    const fdr = fdrFor(el, g);
    const mult = fdrMult(fdr);
    const dampK = idx===0 ? 1.0 : damp;
    const ppg = parseFloat(el.points_per_game || "0") || 0;
    ev += ppg * (min/100) * mult * dampK;
  });

  return {
    id: el.id, name, pos, type: el.element_type, min,
    ev,
    hasFixture: true,
    avgFdr: avgFdrFor(el, games),
    double: games.length
  };
}

/* -------------------- helpers -------------------- */
function getCurrentGw(bootstrap){
  const ev=bootstrap?.events??[];
  const cur=ev.find(e=>e.is_current); if(cur) return cur.id;
  const nxt=ev.find(e=>e.is_next); if(nxt) return nxt.id;
  const up=ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id||1);
}
function getNextGwId(bootstrap){
  const ev=bootstrap?.events??[];
  const nxt=ev.find(e=>e.is_next); if(nxt) return nxt.id;
  const cur=ev.find(e=>e.is_current);
  if(cur){
    const i=ev.findIndex(x=>x.id===cur.id);
    return ev[i+1]?.id || cur.id;
  }
  const up=ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id||1);
}
function fdrFor(el, f){
  const home = f.team_h===el.team;
  return home ? (f.team_h_difficulty ?? f.difficulty ?? 3)
              : (f.team_a_difficulty ?? f.difficulty ?? 3);
}
function avgFdrFor(el, games){
  let s=0; for (const g of games) s += fdrFor(el,g); return s/games.length;
}
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x; // easy → ~1.10, hard → ~0.80
}
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function shortName(el){
  const first = (el?.first_name||"").trim();
  const last  = (el?.second_name||"").trim();
  const web   = (el?.web_name||"").trim();
  if (first && last) {
    const initLast = `${first[0]}. ${last}`;
    return (web && web.length <= initLast.length) ? web : initLast;
  }
  return web || last || first || "—";
}
function sumEv(arr){ return arr.reduce((s,r)=>s+(r.ev||0),0); }
function quantile(sortedAsc, q){
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedAsc[base+1]!==undefined) return sortedAsc[base] + rest*(sortedAsc[base+1]-sortedAsc[base]);
  return sortedAsc[base];
}
function flagsForWeek(w){
  const f = [];
  if (w.starters < 10) f.push("starters<10");
  if (w.hardInXi >= 7) f.push("hard fixtures");
  if (w.riskyXi >= 3) f.push("risky XI");
  return f.join(", ");
}
function dgwBlankSummary(fixtures, fromGw, toGw){
  const map = {};
  for (const f of (fixtures||[])) {
    const g = f.event; if (!g || g<fromGw || g>toGw) continue;
    map[g] = map[g] || { dgw:0, blank:0, teams:{} };
    map[g].teams[f.team_h] = (map[g].teams[f.team_h]||0)+1;
    map[g].teams[f.team_a] = (map[g].teams[f.team_a]||0)+1;
  }
  const parts=[];
  for (const gw of Object.keys(map).map(n=>+n).sort((a,b)=>a-b)){
    const t = map[gw].teams;
    const d = Object.values(t).filter(c=>c>1).length;
    const b = Object.values(t).filter(c=>c===0).length; // always 0 in this map; kept for completeness
    if (d>0) parts.push(`GW${gw}: ${d} DGW teams`);
  }
  return parts.join(" • ");
}
async function getJSON(url){
  try{
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json().catch(()=>null);
  } catch { return null; }
}