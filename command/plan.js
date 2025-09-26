// command/plan.js — Formation planner tied to Transfer Plans (A/B/C/D)
// It recomputes the same market/singles/combos as /transfer, applies the chosen plan’s moves,
// and renders the best XI for NEXT GW. Also shows quick links to /planb /planc /pland.

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";
import { chooseAutoConfig } from "../presets.js"; // shared auto settings

const B = (s)=>`<b>${esc(s)}</b>`;
const gbp = (n)=> (n==null?"—":`£${Number(n).toFixed(1)}`);
const posName = (t)=>({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t]||"?";
const kUser = (id)=>`user:${id}:profile`;

// thresholds (mirror /transfer)
const MIN_DELTA_SINGLE = 0.5;
const MIN_DELTA_COMBO  = 1.5;
const MAX_POOL_PER_POS = 500;
const MAX_SINGLE_SCAN  = 500;

export default async function plan(env, chatId, opt={mode:"A"}) {
  const mode = (opt?.mode||"A").toUpperCase();

  // load profile
  const raw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = raw ? (JSON.parse(raw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

  // fetch data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) { await send(env, chatId, "Couldn't fetch FPL data. Try again."); return; }

  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGwId(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // config (shared with /transfer)
  const cfg = await chooseAutoConfig({ bootstrap, fixtures, picks });

  // bank
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  // prepare element maps
  const els   = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const teams = Object.fromEntries((bootstrap?.teams||[]).map(t=>[t.id,t]));
  const allPicks = (picks?.picks||[]);
  const ownedIds = new Set(allPicks.map(p=>p.element));
  const startersEls = allPicks.filter(p=>(p.position||16)<=11).map(p=>els[p.element]).filter(Boolean);

  // team counts
  const teamCounts = {};
  for (const p of allPicks){ const el=els[p.element]; if(!el) continue; teamCounts[el.team]=(teamCounts[el.team]||0)+1; }

  // selling prices
  const sell = {};
  for (const p of allPicks){
    const el = els[p.element];
    const rawP = (p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0);
    sell[p.element] = (rawP/10)||0;
  }

  // precompute horizon scores
  const byRow = {};
  for (const el of (bootstrap?.elements||[])) byRow[el.id] = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);

  // weakest starters as OUT candidates
  const outCands = startersEls.map(el=>({
    id: el.id,
    name: playerShort(el),
    posT: el.element_type,
    teamId: el.team,
    team: teamShort(teams, el.team),
    sell: sell[el.id] || ((el.now_cost||0)/10),
    listPrice: (el.now_cost||0)/10,
    score: byRow[el.id]?.score ?? 0
  })).sort((a,b)=>a.score-b.score).slice(0,11);

  // market pool by position
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements||[])) {
    if (chance(el) < cfg.min) continue;
    const r = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
    poolByPos[el.element_type].push({
      id: el.id,
      name: playerShort(el),
      team: teamShort(teams, el.team),
      teamId: el.team,
      pos: posName(el.element_type),
      price: (el.now_cost||0)/10,
      score: r.score
    });
  }
  Object.keys(poolByPos).forEach(k=>{
    poolByPos[k].sort((a,b)=>b.score-a.score);
    poolByPos[k] = poolByPos[k].slice(0, MAX_POOL_PER_POS);
  });

  // build singles identical to /transfer rules
  const singles = [];
  outer:
  for (const OUT of outCands){
    const list = poolByPos[OUT.posT]||[];
    for (let i=0;i<list.length && singles.length<MAX_SINGLE_SCAN;i++){
      const IN = list[i];
      if (IN.id === OUT.id) continue;
      if (ownedIds.has(IN.id)) continue;

      const priceDiff = IN.price - OUT.sell;
      if (priceDiff > bank + 1e-9) continue;

      const newCountIn = (teamCounts[IN.teamId]||0) + (IN.teamId===OUT.teamId?0:1);
      if (newCountIn > 3) continue;

      const delta = IN.score - OUT.score;
      if (delta < MIN_DELTA_SINGLE) continue;

      singles.push({
        outId: OUT.id, inId: IN.id,
        outName: OUT.name, inName: IN.name,
        outTeamId: OUT.teamId, inTeamId: IN.teamId,
        outTeam: OUT.team, inTeam: IN.team,
        pos: OUT.posT,
        outSell: OUT.sell,
        outList: OUT.listPrice,
        inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff,
        delta
      });
      if (singles.length >= MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // combos
  const planA = { moves:[], delta:0, hit:0, net:0 };
  const planB = mkPlanB(singles, cfg.ft);
  const planC = bestCombo(singles.slice(0,120), 2, teamCounts, bank, cfg.ft);
  const planD = bestCombo(singles.slice(0,160), 3, teamCounts, bank, cfg.ft);

  const plans = { A: planA, B: planB, C: planC, D: planD };
  const chosen = plans[mode] || planA;

  // apply chosen moves to squad (in-memory)
  const newIds = new Set(allPicks.map(p=>p.element));
  for (const m of (chosen.moves||[])) {
    newIds.delete(m.outId);
    newIds.add(m.inId);
  }
  const squadEls = [...newIds].map(id=>els[id]).filter(Boolean);

  // build best XI for NEXT GW from updated squad
  const xi = bestXIForGw(squadEls, bootstrap, fixtures, cfg, nextGW);
  const teamName = entry?.name || "Team";
  const head = [
    `${B("Team")}: ${esc(teamName)} | ${B("GW")}: ${nextGW} — Plan ${mode}`,
    `${B("Bank")}: ${gbp(bank)} | ${B("FT (assumed)")}: ${cfg.ft} | ${B("Hits")}: -4 per extra move`,
    `${B("Model")}: Pro Auto — h=${cfg.h}, min=${cfg.min}%`
  ].join("\n");

  const blocks = [];
  // summary of moves
  if (!chosen.moves?.length) {
    blocks.push(`${B("Transfers")}: Save FT (no change)`);
  } else {
    blocks.push(`${B("Transfers")}:`);
    chosen.moves.forEach((m,i)=>{
      blocks.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
      blocks.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
    });
    blocks.push(`Net (after hits): ${(chosen.net>=0?"+":"")}${chosen.net.toFixed(2)} | Raw Δ: +${chosen.delta.toFixed(2)} | Hits: -${chosen.hit}`);
  }

  // XI render + C/VC from projected per-GW scores
  if (!xi) {
    blocks.push("");
    blocks.push("Couldn’t form a legal XI (injuries/blanks?).");
  } else {
    const captainPick = xi.xi.slice().sort((a,b)=>b.score-a.score)[0];
    const vicePick    = xi.xi.slice().sort((a,b)=>b.score-a.score)[1];

    blocks.push("");
    blocks.push(`${B("Best Formation")}: ${xi.gwShape}  |  ${B("Projected XI")}: ${xi.total.toFixed(1)}`);
    blocks.push(`${B("Captain")}: ${esc(captainPick?.name||"—")} (${esc(captainPick?.team||"")})`);
    blocks.push(`${B("Vice")}: ${esc(vicePick?.name||"—")} (${esc(vicePick?.team||"")})`);
    blocks.push("");
    blocks.push(`${B("GKP")}: ${lineGroup(xi.xi,1)}`);
    blocks.push(`${B("DEF")}: ${lineGroup(xi.xi,2)}`);
    blocks.push(`${B("MID")}: ${lineGroup(xi.xi,3)}`);
    blocks.push(`${B("FWD")}: ${lineGroup(xi.xi,4)}`);
    blocks.push(`${B("Bench")}: ${xi.benchLine || "—"}`);
  }

  // quick links
  blocks.push("");
  blocks.push(`${B("Switch plan")}: /planb  /planc  /pland`);

  const html = [head, "", blocks.join("\n")].join("\n");
  await send(env, chatId, html, "HTML");
}

/* ---------- helpers (mirror /transfer where needed) ---------- */
function mkPlanB(singles, ft){
  if (!singles.length) return { moves:[], delta:0, hit:0, net:0 };
  const s = singles[0];
  const hit = Math.max(0, 1 - ft) * 4;
  return { moves:[s], delta:s.delta, hit, net: s.delta - hit };
}
function bestCombo(singles, K, teamCounts, bank, ft){
  if (singles.length < K) return { moves:[], delta:0, hit:0, net:0 };
  const S = Math.min(80, singles.length);
  const base = singles.slice(0,S);

  function valid(combo){
    const outIds=new Set(), inIds=new Set();
    const counts = { ...teamCounts };
    let spend=0, delta=0;
    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return null;
      outIds.add(m.outId); inIds.add(m.inId);
      if (m.inTeamId !== m.outTeamId){ counts[m.outTeamId]=(counts[m.outTeamId]||0)-1; counts[m.inTeamId]=(counts[m.inTeamId]||0)+1; }
      spend += m.priceDiff; delta += m.delta;
    }
    for (const c of Object.values(counts)) if (c>3) return null;
    if (spend > bank + 1e-9) return null;
    if (delta < MIN_DELTA_COMBO) return null;
    const hit = Math.max(0, combo.length - ft) * 4;
    return { delta, hit, net: delta - hit, spend };
  }

  let best=null;
  function* kComb(k, start=0, acc=[]){
    if (k===0){ yield acc; return; }
    for (let i=start;i<=S-k;i++) yield* kComb(k-1, i+1, [...acc, i]);
  }
  for (const idxs of kComb(K)){
    const combo = idxs.map(i=>base[i]);
    const chk = valid(combo); if (!chk) continue;
    const cand = { moves:combo, delta:chk.delta, hit:chk.hit, net:chk.net, spend:chk.spend };
    if (!best || cand.net > best.net) best = cand;
  }
  return best || { moves:[], delta:0, hit:0, net:0 };
}

function playerShort(el){
  const first=(el?.first_name||"").trim(), last=(el?.second_name||"").trim(), web=(el?.web_name||"").trim();
  if (first && last){
    const initLast = `${first[0]}. ${last}`;
    return (web && web.length<=initLast.length) ? web : initLast;
  }
  return web || last || first || "—";
}
function teamShort(teams, id){ return teams[id]?.short_name || "?"; }
function chance(el){ const v=parseInt(el?.chance_of_playing_next_round ?? "100",10); return Number.isFinite(v)?Math.max(0,Math.min(100,v)):100; }
function fdrMult(fdr){ const x=Math.max(2,Math.min(5,Number(fdr)||3)); return 1.30 - 0.10*x; }

function rowForHorizon(el, fixtures, teams, startGw, H=2, damp=0.94, minCut=80){
  const minProb = chance(el); if (minProb < minCut) return { score:0 };
  const ppg = parseFloat(el.points_per_game || "0") || 0;
  let score = 0;
  for (let g=startGw; g<startGw+H; g++){
    const fs = fixtures.filter(f=>f.event===g && (f.team_h===el.team || f.team_a===el.team)).sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);
    if (!fs.length) continue;
    fs.forEach((f, idx)=>{
      const home = f.team_h===el.team;
      const fdr = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
      const mult = fdrMult(fdr);
      const dampK = idx===0 ? 1.0 : damp;
      score += ppg * (minProb/100) * mult * dampK;
    });
  }
  return { score };
}

// best XI strictly for one GW (used after applying plan)
function rowForGw(el, fixtures, gw, minCut=80){
  const mp = chance(el); if (mp < minCut) return { id:el.id, score:0, name:el.web_name, pos:el.element_type, team:el.team, hasFixture:false };
  const ppg = parseFloat(el.points_per_game || "0") || 0;
  const fs = fixtures.filter(f=>f.event===gw && (f.team_h===el.team || f.team_a===el.team)).sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);
  if (!fs.length) return { id:el.id, score:0, name:el.web_name, pos:el.element_type, team:el.team, hasFixture:false };
  let s=0;
  fs.forEach((f,idx)=>{
    const home = f.team_h===el.team;
    const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
    const mult = fdrMult(fdr);
    const damp = idx===0 ? 1.0 : 0.94;
    s += ppg * (mp/100) * mult * damp;
  });
  return { id:el.id, score:s, name:el.web_name, pos:el.element_type, team:el.team, hasFixture:true };
}

function bestXIForGw(squadEls, bootstrap, fixtures, cfg, gw){
  const rows = squadEls.map(el=>rowForGw(el, fixtures, gw, cfg.min));
  const gks  = rows.filter(r=>r.pos===1).sort((a,b)=>b.score-a.score);
  const defs = rows.filter(r=>r.pos===2).sort((a,b)=>b.score-a.score);
  const mids = rows.filter(r=>r.pos===3).sort((a,b)=>b.score-a.score);
  const fwds = rows.filter(r=>r.pos===4).sort((a,b)=>b.score-a.score);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  const take = (arr,n)=>arr.slice(0,Math.min(n,arr.length));

  let best=null;
  for (const [D,M,F] of shapes){
    if (!gks.length) continue;
    const gk = gks[0];
    const dl = take(defs,D), ml=take(mids,M), fl=take(fwds,F);
    if (dl.length<D || ml.length<M || fl.length<F) continue;
    const xi = [gk, ...dl, ...ml, ...fl];
    const total = xi.reduce((s,r)=>s+r.score,0);
    // bench
    const pool = rows.filter(r=>!xi.find(x=>x.id===r.id)).sort((a,b)=>b.score-a.score);
    const benchOut = pool.filter(r=>r.pos!==1).slice(0,3);
    const benchGk  = pool.find(r=>r.pos===1);
    const benchLine = [
      benchOut[0] ? `1) ${benchOut[0].name} (${posName(benchOut[0].pos)})` : null,
      benchOut[1] ? `2) ${benchOut[1].name} (${posName(benchOut[1].pos)})` : null,
      benchOut[2] ? `3) ${benchOut[2].name} (${posName(benchOut[2].pos)})` : null,
      benchGk     ? `GK: ${benchGk.name}` : null
    ].filter(Boolean).join(", ");

    const cand = { xi, total, gwShape:`${D}-${M}-${F}`, benchLine };
    if (!best || total>best.total) best=cand;
  }
  return best;
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
async function getJSON(url){ try{ const r=await fetch(url,{signal:AbortSignal.timeout(10000)}); if(!r.ok) return null; return await r.json().catch(()=>null);} catch{ return null; } }
function lineGroup(arr, posT){
  return arr.filter(x=>x.pos===posT).map(x=>`${esc(x.name)}`).join(", ") || "—";
}