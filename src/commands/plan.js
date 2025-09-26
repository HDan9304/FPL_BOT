// src/commands/plan.js — Best XI for next GW using the recommended transfer plan (A–D)
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const pos   = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

export default async function plan(env, chatId) {
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) { await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.`, "HTML"); return; }

  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) { await send(env, chatId, "Couldn't fetch FPL data. Try again."); return; }

  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGwId(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (team private?)."); return; }

  const cfg  = autoTune({ bootstrap, picks });                          // Pro auto
  const plan = computeRecommendedPlan({ bootstrap, fixtures, entry, picks, nextGW, cfg });

  const { xiElsAfter, shape, benchLine } =
    bestXIAfterPlan({ bootstrap, fixtures, picks, nextGW, cfg, plan });

  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Best Formation`,
    `${B("Chosen Plan")}: ${plan.title} ${plan.key === "A" ? "(save)" : ""}`,
    `${B("Net")} (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)}  |  ${B("Raw Δ")}: +${plan.delta.toFixed(2)}  |  ${B("Hits")}: -${plan.hit}`
  ].join("\n");

  const lines = [];
  lines.push(head, "");

  if (plan.moves.length) {
    lines.push(B("Applied Moves"));
    plan.moves.forEach((m,i)=>{
      lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
      lines.push(`   ΔScore +${m.delta.toFixed(2)} | Price ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left ${gbp(m.bankLeft)}`);
    });
    lines.push("");
  }

  lines.push(`${B("Best XI")} — ${shape}`);
  const group = (t) => xiElsAfter.filter(e=>e.element_type===t);
  const fmt   = (e) => `${shortName(e)} (${teamShort(bootstrap, e.team)})`;

  const gks  = group(1), defs = group(2), mids = group(3), fwds = group(4);
  if (gks.length)  { lines.push(`${B("GK")}:`);  gks.forEach(e => lines.push(`• ${fmt(e)}`)); lines.push(""); }
  if (defs.length) { lines.push(`${B("DEF")}:`); defs.forEach(e => lines.push(`• ${fmt(e)}`)); lines.push(""); }
  if (mids.length) { lines.push(`${B("MID")}:`); mids.forEach(e => lines.push(`• ${fmt(e)}`)); lines.push(""); }
  if (fwds.length) { lines.push(`${B("FWD")}:`); fwds.forEach(e => lines.push(`• ${fmt(e)}`)); lines.push(""); }

  lines.push(`${B("Bench")}: ${benchLine || "—"}`);

  await send(env, chatId, lines.join("\n"), "HTML");
}

/* ============================= helpers ============================= */
function computeRecommendedPlan({ bootstrap, fixtures, entry, picks, nextGW, cfg }) {
  const els      = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const allPicks = (picks?.picks || []);
  const starters = allPicks.filter(p => (p.position||16) <= 11);
  const ownedIds = new Set(allPicks.map(p => p.element));

  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const teamCounts = {};
  for (const p of allPicks) { const el = els[p.element]; if (!el) continue; teamCounts[el.team] = (teamCounts[el.team]||0)+1; }

  const sell = {};
  for (const p of allPicks) {
    const el=els[p.element]; const raw=(p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0);
    sell[p.element] = raw/10.0;
  }

  const row = {};
  for (const el of (bootstrap?.elements||[])) row[el.id] = rowH(el, fixtures, nextGW, cfg.h, cfg.damp, cfg.min);

  const outs = starters.map(p=>els[p.element]).filter(Boolean).map(el=>({
    id: el.id, posT: el.element_type, teamId: el.team, team: teamShort(bootstrap, el.team),
    name: shortName(el), sell: sell[el.id] || (el.now_cost||0)/10, score: row[el.id]?.score || 0
  })).sort((a,b)=>a.score-b.score);

  const pool = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements||[])) {
    if (mins(el) < cfg.min) continue;
    const r = rowH(el, fixtures, nextGW, cfg.h, cfg.damp, cfg.min);
    pool[el.element_type].push({
      id: el.id, posT: el.element_type, name: shortName(el),
      teamId: el.team, team: teamShort(bootstrap, el.team),
      price: (el.now_cost||0)/10, score: r.score
    });
  }
  Object.keys(pool).forEach(k => pool[k].sort((a,b)=>b.score-a.score).splice(500));

  const singles=[], MAX_PER_TEAM=3, MIN_DELTA=0.5;
  for (const out of outs) {
    const cand = pool[out.posT];
    for (let i=0;i<cand.length;i++){
      const IN = cand[i];
      if (IN.id===out.id || ownedIds.has(IN.id)) continue;
      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank + 1e-9) continue;
      const newCount = (teamCounts[IN.teamId]||0) + (IN.teamId===out.teamId?0:1);
      if (newCount>MAX_PER_TEAM) continue;

      const delta = IN.score - out.score;
      if (delta < MIN_DELTA) continue;

      singles.push({
        outId: out.id, inId: IN.id,
        outName: out.name, inName: IN.name,
        outTeamId: out.teamId, inTeamId: IN.teamId,
        outTeam: out.team, inTeam: IN.team,
        priceDiff, bankLeft: bank - priceDiff,
        delta
      });
      if (singles.length >= 500) break;
    }
    if (singles.length >= 500) break;
  }
  singles.sort((a,b)=>b.delta-a.delta);

  const planA = { key:"A", title:"Plan A — 0 transfers", moves:[], delta:0, hit:0, net:0 };
  const planB = mkPlanB(singles, cfg.ft);
  const planC = combo(singles.slice(0,120), 2, teamCounts, MAX_PER_TEAM, bank, cfg.ft);
  const planD = combo(singles.slice(0,160), 3, teamCounts, MAX_PER_TEAM, bank, cfg.ft);

  const plans = [planA, planB, planC, planD];
  const viable = plans.filter(p => (p.moves.length <= 1) || (p.net >= cfg.hit));
  const best = (viable.length?viable:plans).slice().sort((a,b)=>b.net-a.net)[0];
  return best;
}

function mkPlanB(singles, ft){
  if (!singles.length) return { key:"B", title:"Plan B — 1 transfer", moves:[], delta:0, hit:0, net:0 };
  const s = singles[0];
  const hit = Math.max(0, 1 - (ft||1)) * 4;
  const raw = s.delta;
  return { key:"B", title:"Plan B — 1 transfer", moves:[s], delta: raw, hit, net: raw - hit };
}
function combo(singles, K, teamCounts, MAX_PER_TEAM, bank, ft){
  if (!singles.length || K<2) return { key: K===2?"C":"D", title: `Plan ${K===2?"C":"D"} — ${K} transfers`, moves:[], delta:0, hit:0, net:0 };
  let best=null;
  const S = Math.min(singles.length, 80);
  const arr = singles.slice(0,S);
  function ok(combo){
    const outIds=new Set(), inIds=new Set(); const counts={...teamCounts};
    let spend=0, delta=0;
    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return null;
      outIds.add(m.outId); inIds.add(m.inId);
      if (m.inTeamId !== m.outTeamId){ counts[m.outTeamId]=(counts[m.outTeamId]||0)-1; counts[m.inTeamId]=(counts[m.inTeamId]||0)+1; }
      spend += m.priceDiff; delta += m.delta;
    }
    if (Object.values(counts).some(c=>c>MAX_PER_TEAM)) return null;
    if (spend > bank + 1e-9) return null;
    if (delta < 1.5) return null;
    const hit = Math.max(0, combo.length - (ft||1)) * 4;
    return { delta, hit, net: delta - hit };
  }
  function* choose(k,start=0, acc=[]){
    if (k===0){ yield acc; return; }
    for (let i=start;i<=arr.length-k;i++) yield* choose(k-1, i+1, [...acc, arr[i]]);
  }
  for (const comboMoves of choose(K,0,[])) {
    const e = ok(comboMoves); if (!e) continue;
    const cand = { key: K===2?"C":"D", title: `Plan ${K===2?"C":"D"} — ${K} transfers`, moves: comboMoves, delta:e.delta, hit:e.hit, net:e.net };
    if (!best || cand.net>best.net) best=cand;
  }
  return best || { key: K===2?"C":"D", title: `Plan ${K===2?"C":"D"} — ${K} transfers`, moves:[], delta:0, hit:0, net:0 };
}

function bestXIAfterPlan({ bootstrap, fixtures, picks, nextGW, cfg, plan }){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const squad = (picks?.picks||[]).map(p=>byId[p.element]).filter(Boolean);

  const outIds = new Set(plan.moves.map(m=>m.outId));
  let after = squad.filter(el => !outIds.has(el.id));
  for (const m of plan.moves) {
    const add = byId[m.inId]; if (add) after.push(add);
  }

  const rows = after.map(el => ({ el, r: rowH(el, fixtures, nextGW, 1, cfg.damp, cfg.min) }))
                    .filter(x => x.r && x.r.score>0);

  const gks  = rows.filter(x=>x.el.element_type===1).sort((a,b)=>b.r.score-a.r.score);
  const defs = rows.filter(x=>x.el.element_type===2).sort((a,b)=>b.r.score-a.r.score);
  const mids = rows.filter(x=>x.el.element_type===3).sort((a,b)=>b.r.score-a.r.score);
  const fwds = rows.filter(x=>x.el.element_type===4).sort((a,b)=>b.r.score-a.r.score);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  let best=null;
  for (const [D,M,F] of shapes){
    const gk = gks[0]?.el; if (!gk) continue;
    const Dp = defs.slice(0,D).map(x=>x.el); if (Dp.length<D) continue;
    const Mp = mids.slice(0,M).map(x=>x.el); if (Mp.length<M) continue;
    const Fp = fwds.slice(0,F).map(x=>x.el); if (Fp.length<F) continue;
    const total = [gks[0], ...defs.slice(0,D), ...mids.slice(0,M), ...fwds.slice(0,F)]
      .reduce((s,x)=>s+(x?.r?.score||0),0);

    const xi = [gk, ...Dp, ...Mp, ...Fp];
    const benchPool = [...defs.slice(D), ...mids.slice(M), ...fwds.slice(F)].map(x=>x.el);
    const benchOut  = benchPool.slice(0,3);
    const benchGK   = gks[1]?.el;
    const benchLine = [
      benchOut[0] ? `1) ${shortName(benchOut[0])} (${pos(benchOut[0].element_type)})` : null,
      benchOut[1] ? `2) ${shortName(benchOut[1])} (${pos(benchOut[1].element_type)})` : null,
      benchOut[2] ? `3) ${shortName(benchOut[2])} (${pos(benchOut[2].element_type)})` : null,
      benchGK     ? `GK: ${shortName(benchGK)}` : null
    ].filter(Boolean).join(", ");

    const cand = { total, xiElsAfter: xi, shape: `${D}-${M}-${F}`, benchLine };
    if (!best || cand.total>best.total) best=cand;
  }
  return best || { xiElsAfter: [], shape: "—", benchLine: "" };
}

/* tiny utils */
function autoTune({ bootstrap, picks }, base={ h:2, min:78, damp:0.94, ft:1, hit:5 }){
  const risky = riskyStarters(picks, bootstrap, 80);
  const used  = picks?.entry_history?.event_transfers || 0;
  const cfg   = { ...base };
  cfg.ft  = used===0 ? 2 : 1;
  cfg.min = risky>=2 ? 85 : 78;
  cfg.damp= 0.94; cfg.hit = risky>=3 ? 6 : 5;
  return cfg;
}
function rowH(el, fixtures, startGw, H=1, damp=0.94, minCut=78){
  const mp = mins(el); if (mp < minCut) return { score: 0 };
  const ppg = parseFloat(el.points_per_game || "0") || 0;
  let s = 0;
  for (let g=startGw; g<startGw+H; g++){
    const fs = fixtures.filter(f => f.event === g && (f.team_h===el.team || f.team_a===el.team));
    if (!fs.length) continue;
    fs.sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1)
      .forEach((f,idx)=>{
        const home = f.team_h===el.team;
        const fdr = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
        s += ppg * (mp/100) * fdrMult(fdr) * (idx===0?1.0:damp);
      });
  }
  return { score: s };
}
function fdrMult(x){ const v=Math.max(2,Math.min(5,Number(x)||3)); return 1.30 - 0.10*v; }
function mins(el){ const v=parseInt(el?.chance_of_playing_next_round ?? "100", 10); return Number.isFinite(v)?Math.max(0,Math.min(100,v)):100; }
function shortName(el){
  const f=(el?.first_name||"").trim(), l=(el?.second_name||"").trim(), w=(el?.web_name||"").trim();
  if (f && l) { const s=`${f[0]}. ${l}`; return (w && w.length<=s.length) ? w : s; }
  return w || l || f || "—";
}
function teamShort(bootstrapOrTeams, id){
  const t = Array.isArray(bootstrapOrTeams?.teams)
    ? bootstrapOrTeams.teams.find(x=>x.id===id)
    : bootstrapOrTeams[id];
  return t?.short_name || "?";
}
function riskyStarters(picks, bootstrap, minCut=80){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  return xi.reduce((n,p)=>{
    const el=byId[p.element]; if(!el) return n;
    const mp=mins(el); return n + (mp<minCut ? 1 : 0);
  },0);
}
function getCurrentGw(bootstrap){
  const ev=bootstrap?.events||[];
  const cur=ev.find(e=>e.is_current); if (cur) return cur.id;
  const nxt=ev.find(e=>e.is_next); if (nxt) return nxt.id;
  const up =ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id||1);
}
function getNextGwId(bootstrap){
  const ev=bootstrap?.events||[];
  const nxt=ev.find(e=>e.is_next); if (nxt) return nxt.id;
  const cur=ev.find(e=>e.is_current);
  if (cur){ const i=ev.findIndex(x=>x.id===cur.id); return ev[i+1]?.id || cur.id; }
  const up=ev.find(e=>!e.finished); return up ? up.id : (ev[ev.length-1]?.id||1);
}
async function getJSON(url){
  try{ const r=await fetch(url, { signal: AbortSignal.timeout(10000) }); if(!r.ok) return null; return await r.json().catch(()=>null); }
  catch { return null; }
}