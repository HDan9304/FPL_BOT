// src/commands/plan.js
// /plan  -> best XI for current squad (no changes)
// /planb -> apply Plan B from /transfer then best XI
// /planc -> apply Plan C from /transfer then best XI
// /pland -> apply Plan D from /transfer then best XI

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;
const kUser = (id) => `user:${id}:profile`;
const kPlan = (id) => `plan:${id}:transfers`;

export default async function plan(env, chatId, variant = "A") {
  // 1) Ensure linked team
  const prof = safeParse(await env.FPL_BOT_KV.get(kUser(chatId)));
  const teamId = prof?.teamId;
  if (!teamId) {
    await send(env, chatId, `${B("No team linked")} — use /link <team_id> first.`, "HTML");
    return;
  }

  // 2) Fetch core data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, `${B("Couldn’t fetch data")} — FPL might be rate-limiting. Try again.`, "HTML");
    return;
  }
  const curGW  = currentGw(bootstrap);
  const nextGW = nextGwId(bootstrap);

  // Picks for current GW (used as the "base" squad)
  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) {
    await send(env, chatId, `${B("Couldn’t fetch your team")} — is it private?`, "HTML");
    return;
  }

  // 3) Prepare "hypothetical" squad id list, applying transfer plan if variant=B/C/D
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const baseIds = (picks?.picks || []).map(p => p.element);

  let appliedMoves = [];
  if (variant !== "A") {
    const saved = safeParse(await env.FPL_BOT_KV.get(kPlan(chatId)));
    const key = variantKey(variant); // "B" | "C" | "D"
    appliedMoves = resolveMoves(saved, nextGW, key); // array of {outId,inId}
  }
  const hypoIds = applyMoves(baseIds, appliedMoves);

  // 4) Best XI for NEXT GW on that hypothetical squad
  const xi = bestXIForNextGW(hypoIds, bootstrap, fixtures, nextGW);
  if (!xi) {
    await send(env, chatId, `${B("No valid XI")} — not enough available players for GW${nextGW}.`, "HTML");
    return;
  }

  // 5) Captaincy from XI (C then VC)
  const rankedXI = xi.xi.slice().sort((a,b)=>b.score-a.score);
  const C  = rankedXI[0];
  const VC = rankedXI.find(p => p.id !== C.id) || rankedXI[1] || C;
  const tag = (r) => r.id === C.id ? `${r.name} (C)` : (r.id === VC.id ? `${r.name} (VC)` : r.name);

  // 6) Header (same style as /transfer)
  const bank = deriveBank(entry, picks);
  // We keep FT/hit simple here — your transfer command handles cost logic; plan is a view.
  const header = [
    `${B(`${entry.name || "Team"}`)} ${esc("|")} ${B(`GW ${nextGW} — Plan${variant === "A" ? "" : " " + variant}`)}`,
    `${B("Bank")} ${esc(fmtGBP(bank))} ${esc("|")} ${B("Free Transfer")} ${esc("1 (assumed)")} ${esc("|")} ${B("Hit")} ${esc("0 (view only)")}`
  ].join("\n");

  // 7) Body
  const lines = [];
  lines.push(header);
  lines.push("");
  lines.push(`${B("Captaincy")}`);
  lines.push(`• ${esc(C.name)} — ${esc(`${C.pos} ${C.team}`)} (${esc(fmtScore(C.score))})`);
  lines.push(`• ${esc(VC.name)} — ${esc(`${VC.pos} ${VC.team}`)} (${esc(fmtScore(VC.score))})`);
  lines.push("");
  lines.push(`${B("Best Formation")} ${esc(xi.shape)}  ${esc("|")}  ${B("Projected XI")} ${esc(xi.total.toFixed(1))}`);
  if (xi.relaxed) lines.push(esc("(Minutes threshold was relaxed to fill 11)"));
  lines.push("");
  lines.push(B("Starters"));
  lines.push(section("GK",  xi.xi.filter(x=>x.type===1).map(r=>`• ${esc(tag(r))} — ${esc(r.team)}`)));
  lines.push(section("DEF", xi.xi.filter(x=>x.type===2).map(r=>`• ${esc(tag(r))} — ${esc(r.team)}`)));
  lines.push(section("MID", xi.xi.filter(x=>x.type===3).map(r=>`• ${esc(tag(r))} — ${esc(r.team)}`)));
  lines.push(section("FWD", xi.xi.filter(x=>x.type===4).map(r=>`• ${esc(tag(r))} — ${esc(r.team)}`)));
  lines.push("");
  lines.push(`${B("Bench order")} ${esc(xi.benchLine || "—")}`);
  lines.push("");
  // Quick links to toggle variants
  lines.push(`${B("Variants")}`);
  lines.push(`/plan  ·  /planb  ·  /planc  ·  /pland`);

  await send(env, chatId, lines.join("\n"), "HTML");
}

/* ---------------- helpers ---------------- */

function section(label, arr){ return [`${B(label)}:`, arr.length?arr.join("\n"):"• —"].join("\n"); }
function fmtScore(x){ return x.toFixed(2); }
function fmtGBP(n){ return `£${Number(n).toFixed(1)}m`; }
function safeParse(s){ try { return JSON.parse(s||""); } catch { return null; } }
async function getJSON(u){ try{ const r=await fetch(u,{cf:{cacheTtl:30,cacheEverything:true}}); if(!r.ok) return null; return r.json(); }catch{return null;} }

function currentGw(bootstrap){
  const ev=bootstrap?.events||[];
  return ev.find(e=>e.is_current)?.id ?? ev.find(e=>e.is_next)?.id ?? ev.find(e=>!e.finished)?.id ?? ev.at(-1)?.id ?? 1;
}
function nextGwId(bootstrap){
  const ev=bootstrap?.events||[];
  const nxt=ev.find(e=>e.is_next); if(nxt) return nxt.id;
  const cur=ev.find(e=>e.is_current);
  if(!cur) return ev.find(e=>!e.finished)?.id ?? ev.at(-1)?.id ?? 1;
  const i=ev.findIndex(e=>e.id===cur.id);
  return ev[i+1]?.id ?? cur.id;
}

function variantKey(v){
  const u = String(v||"A").toUpperCase();
  return u==="B"?"B":u==="C"?"C":u==="D"?"D":"A";
}
function resolveMoves(saved, nextGW, key){
  if (!saved || saved.gw !== nextGW || !saved.plans) return [];
  if (key==="B") return saved.plans.B || [];
  if (key==="C") return saved.plans.C || [];
  if (key==="D") return saved.plans.D || [];
  return [];
}
function applyMoves(idList, moves){
  const ids = idList.slice();
  for (const m of moves) {
    const i = ids.indexOf(m.outId);
    if (i !== -1) ids.splice(i,1);
    ids.push(m.inId);
  }
  return ids;
}

function deriveBank(entry, picks){
  if (picks?.entry_history?.bank != null) return picks.entry_history.bank/10;
  if (entry?.last_deadline_bank != null)   return entry.last_deadline_bank/10;
  return 0;
}

function teamShort(bootstrap, id){ return bootstrap?.teams?.find(t=>t.id===id)?.short_name || "?"; }
function posName(t){ return ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t]||"?"; }
function fdrFor(f, teamId){ const home=f.team_h===teamId; return home?(f.team_h_difficulty??f.difficulty??3):(f.team_a_difficulty??f.difficulty??3); }

function scoreElNext(el, fixtures, gw){
  const games = fixtures.filter(f=>f.event===gw && (f.team_h===el.team||f.team_a===el.team));
  if (!games.length) return 0;
  const min = Math.max(0, Math.min(1, Number(el.chance_of_playing_next_round ?? 100)/100));
  const form = Math.min(parseFloat(el.form||"0")||0, 10);
  const damp=[1.0,0.9,0.8];
  let s=0;
  for (let i=0;i<games.length;i++){
    const mult = 1.30 - 0.10 * Math.max(2, Math.min(5, fdrFor(games[i], el.team)));
    const ppg = parseFloat(el.points_per_game||"0")||0;
    s += (ppg * mult * min) * (1 + 0.02*form) * (damp[i]||0.75);
  }
  return s;
}

function bestXIForNextGW(hypoIds, bootstrap, fixtures, gw){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const rows = hypoIds.map(id => byId[id]).filter(Boolean).map(el => ({
    id: el.id,
    type: el.element_type,
    pos: posName(el.element_type),
    team: teamShort(bootstrap, el.team),
    name: el.web_name,      // short display name
    score: scoreElNext(el, fixtures, gw),
    minPct: Number(el.chance_of_playing_next_round ?? 100)
  }));

  const gks  = rows.filter(r=>r.type===1).sort((a,b)=>b.score-a.score);
  const defs = rows.filter(r=>r.type===2).sort((a,b)=>b.score-a.score);
  const mids = rows.filter(r=>r.type===3).sort((a,b)=>b.score-a.score);
  const fwds = rows.filter(r=>r.type===4).sort((a,b)=>b.score-a.score);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  const MIN = 80; // minutes threshold

  let best=null;
  for (const [d,m,f] of shapes){
    const pickGK = () => gks.find(r=>r.minPct>=MIN) || gks[0] || null;
    const pickN = (arr,n)=>{
      const safe=arr.filter(r=>r.minPct>=MIN).slice(0,n);
      if(safe.length===n) return {chosen:safe,relaxed:false};
      const need=n-safe.length;
      const fill=arr.filter(x=>!safe.includes(x)).slice(0,need);
      return {chosen:[...safe,...fill],relaxed:need>0};
    };

    const GK = pickGK(); if (!GK) continue;
    const {chosen:D,relaxed:rD}=pickN(defs,d);
    const {chosen:M,relaxed:rM}=pickN(mids,m);
    const {chosen:F,relaxed:rF}=pickN(fwds,f);
    if (D.length<d || M.length<m || F.length<f) continue;

    const xi = [GK, ...D, ...M, ...F];
    const total = xi.reduce((s,r)=>s+r.score,0);

    // Bench line
    const rest = rows.filter(r=>!xi.find(x=>x.id===r.id));
    const outfield = rest.filter(r=>r.type!==1).sort((a,b)=>b.score-a.score);
    const gk2 = rest.find(r=>r.type===1) || null;
    const benchLine = [
      outfield[0] ? `1) ${outfield[0].name} (${outfield[0].pos})` : null,
      outfield[1] ? `2) ${outfield[1].name} (${outfield[1].pos})` : null,
      outfield[2] ? `3) ${outfield[2].name} (${outfield[2].pos})` : null,
      gk2 ? `GK) ${gk2.name}` : null
    ].filter(Boolean).join(", ");

    const relaxed = rD || rM || rF;
    const cand = { d,m,f, xi, total, benchLine, relaxed, shape: `${d}-${m}-${f}` };
    if (!best || total>best.total) best=cand;
  }
  return best;
}