// src/commands/transfer.js
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;
const kUser = (id) => `user:${id}:profile`;
const kPlan = (id) => `plan:${id}:transfers`;

export default async function transfer(env, chatId) {
  // resolve team
  const prof = safeParse(await env.FPL_BOT_KV.get(kUser(chatId)));
  const teamId = prof?.teamId;
  if (!teamId) { await send(env, chatId, `${B("No team linked")} — use /link <team_id>.`, "HTML"); return; }

  // fetch data
  const [bootstrap, fixtures] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/")
  ]);
  const curGW  = currentGw(bootstrap);
  const nextGW = nextGwId(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  const entry  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`);
  if (!picks || !entry) { await send(env, chatId, `${B("Couldn’t fetch your team")} — is it private?`, "HTML"); return; }

  // compute base bank
  const bank = deriveBank(entry, picks);

  // build singles ranked (light heuristic)
  const scored = rankSingles(picks, bootstrap, fixtures, nextGW);

  const best1 = scored[0] || null;
  const best2 = bestCombo(scored, picks, bootstrap, fixtures, nextGW, bank, 2);
  const best3 = bestCombo(scored, picks, bootstrap, fixtures, nextGW, bank, 3);

  // prepare output
  const lines = [];
  lines.push(`${B(`GW ${nextGW} — Transfer Planner`)}`);
  lines.push(`${B("Plan A")} Save (0 FT)`);
  lines.push("");

  if (best1) {
    lines.push(`${B("Plan B")} 1 move`);
    lines.push(`• ${esc(best1.outName)} → ${esc(best1.inName)}  (Δ ${fmt(best1.delta)})`);
    lines.push("");
  } else {
    lines.push(`${B("Plan B")} 1 move`);
    lines.push("• —");
    lines.push("");
  }

  if (best2) {
    const [a,b]=best2.moves;
    lines.push(`${B("Plan C")} 2 moves`);
    lines.push(`• ${esc(a.outName)} → ${esc(a.inName)}  (Δ ${fmt(a.delta)})`);
    lines.push(`• ${esc(b.outName)} → ${esc(b.inName)}  (Δ ${fmt(b.delta)})`);
    lines.push("");
  } else {
    lines.push(`${B("Plan C")} 2 moves`);
    lines.push("• —");
    lines.push("");
  }

  if (best3) {
    const [a,b,c]=best3.moves;
    lines.push(`${B("Plan D")} 3 moves`);
    lines.push(`• ${esc(a.outName)} → ${esc(a.inName)}  (Δ ${fmt(a.delta)})`);
    lines.push(`• ${esc(b.outName)} → ${esc(b.inName)}  (Δ ${fmt(b.delta)})`);
    lines.push(`• ${esc(c.outName)} → ${esc(c.inName)}  (Δ ${fmt(c.delta)})`);
  } else {
    lines.push(`${B("Plan D")} 3 moves`);
    lines.push("• —");
  }

  await send(env, chatId, lines.join("\n"), "HTML");

  // --- persist for /plan ---
  const payload = {
    gw: nextGW,
    savedAt: Date.now(),
    plans: {
      B: best1 ? [{ outId: best1.outId, inId: best1.inId }] : [],
      C: best2 ? best2.moves.map(m=>({ outId:m.outId, inId:m.inId })) : [],
      D: best3 ? best3.moves.map(m=>({ outId:m.outId, inId:m.inId })) : []
    }
  };
  const ttlSec = secondsUntilDeadline(bootstrap, nextGW) || (48*3600);
  if (env.FPL_BOT_KV) await env.FPL_BOT_KV.put(kPlan(chatId), JSON.stringify(payload), { expirationTtl: ttlSec });
}

/* ------- helpers (same lightweight model you saw before) ------- */
function safeParse(s){ try { return JSON.parse(s||""); } catch { return null; } }
async function getJSON(u){ try{ const r=await fetch(u,{cf:{cacheTtl:30,cacheEverything:true}}); if(!r.ok) return null; return r.json(); }catch{return null;} }
const fmt = (x)=> (x>=0?"+":"") + x.toFixed(2);

function currentGw(bootstrap){ const ev=bootstrap?.events||[]; return ev.find(e=>e.is_current)?.id ?? ev.find(e=>e.is_next)?.id ?? ev.find(e=>!e.finished)?.id ?? ev.at(-1)?.id ?? 1; }
function nextGwId(bootstrap){ const ev=bootstrap?.events||[]; const nxt=ev.find(e=>e.is_next); if(nxt) return nxt.id; const cur=ev.find(e=>e.is_current); if(!cur) return ev.find(e=>!e.finished)?.id ?? ev.at(-1)?.id ?? 1; const i=ev.findIndex(e=>e.id===cur.id); return ev[i+1]?.id ?? cur.id; }
function secondsUntilDeadline(bootstrap, gw){ const ev=(bootstrap?.events||[]).find(e=>e.id===gw); if(!ev?.deadline_time) return null; const ms=new Date(ev.deadline_time)-new Date(); return Math.max(0, Math.floor(ms/1000)); }

function teamShort(bootstrap,id){ return bootstrap?.teams?.find(t=>t.id===id)?.short_name||"?"; }
function posName(t){ return ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t]||"?"; }
function minutesPct(el){ return Number(el.chance_of_playing_next_round ?? 100); }
function ppg(el){ return parseFloat(el.points_per_game||"0")||0; }
function fdrFor(f, teamId){ const home=f.team_h===teamId; return home?(f.team_h_difficulty??f.difficulty??3):(f.team_a_difficulty??f.difficulty??3); }
function scoreElNext(el, fixtures, gw){
  const games = fixtures.filter(f=>f.event===gw && (f.team_h===el.team||f.team_a===el.team));
  if (!games.length) return 0;
  const min = Math.max(0, Math.min(1, minutesPct(el)/100));
  const form = Math.min(parseFloat(el.form||"0")||0, 10);
  const damp=[1.0,0.9,0.8];
  let s=0;
  for (let i=0;i<games.length;i++){
    const mult = 1.30 - 0.10 * Math.max(2, Math.min(5, fdrFor(games[i], el.team)));
    s += (ppg(el)*mult*min)*(1+0.02*form)*(damp[i]||0.75);
  }
  return s;
}
function deriveBank(entry, picks){
  if (picks?.entry_history?.bank!=null) return picks.entry_history.bank/10;
  if (entry?.last_deadline_bank!=null) return entry.last_deadline_bank/10;
  return 0;
}
function rankSingles(picks, bootstrap, fixtures, nextGW){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const my = (picks?.picks||[]).map(p=>byId[p.element]).filter(Boolean);
  const myIds = new Set(my.map(x=>x.id));

  const sell = {}; (picks?.picks||[]).forEach(p=>{ const el=byId[p.element]; const raw=p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0; sell[p.element] = raw/10; });

  // candidates pool: best-scored players not already owned, same-pos swaps
  const pool = (bootstrap?.elements||[]).filter(el => !myIds.has(el.id) && minutesPct(el)>=70)
                .map(el => ({ el, sc: scoreElNext(el, fixtures, nextGW) }))
                .sort((a,b)=>b.sc-a.sc).slice(0,400);

  const outScored = my.map(el => ({ el, sc: scoreElNext(el, fixtures, nextGW) }))
                      .sort((a,b)=>a.sc-b.sc)  // worst first as OUT candidates
                      .slice(0, 11);

  const best = [];
  for (const o of outScored) {
    for (const c of pool) {
      if (c.el.element_type !== o.el.element_type) continue;
      const priceDiff = (c.el.now_cost||0)/10 - (sell[o.el.id]||0);
      const delta = c.sc - o.sc;
      if (delta <= 0) continue;
      best.push({
        outId:o.el.id, inId:c.el.id,
        outName:o.el.web_name, inName:c.el.web_name,
        delta, priceDiff
      });
      if (best.length>=120) break;
    }
  }
  best.sort((a,b)=>b.delta-a.delta);
  return best;
}
function bestCombo(singles, picks, bootstrap, fixtures, nextGW, bank, K){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  if (singles.length < K) return null;

  // team counts
  const counts0 = {};
  for (const p of (picks?.picks||[])) { const el=byId[p.element]; if(!el) continue; counts0[el.team] = (counts0[el.team]||0)+1; }

  let best=null;
  function* choose(arr,k,start=0,acc=[]){ if(k===0){ yield acc; return; } for(let i=start;i<=arr.length-k;i++) yield* choose(arr,k-1,i+1,[...acc,arr[i]]); }

  for (const combo of choose(singles, K)) {
    const outIds=new Set(combo.map(m=>m.outId));
    const inIds =new Set(combo.map(m=>m.inId));
    if (outIds.size!==combo.length || inIds.size!==combo.length) continue;

    // team limits and bank
    const counts = {...counts0};
    let price=0, ok=true;
    for (const m of combo) {
      const out = byId[m.outId], _in = byId[m.inId];
      if (!_in || !out) { ok=false; break; }
      if (_in.team !== out.team) { counts[out.team]--; counts[_in.team]=(counts[_in.team]||0)+1; }
      price += m.priceDiff;
    }
    if (!ok) continue;
    if (Object.values(counts).some(v=>v>3)) continue;
    if (price > bank) continue;

    const delta = combo.reduce((s,m)=>s+m.delta,0);
    if (!best || delta>best.deltaTotal) best = { moves: combo, deltaTotal: delta };
  }
  return best;
}