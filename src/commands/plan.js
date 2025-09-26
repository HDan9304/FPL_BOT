// src/commands/plan.js — formation planner with parity to /transfer
// Usage:
//   /plan      -> Plan A (no moves; base 15 saved by /transfer)
//   /planb     -> Plan B (apply 1-move from /transfer snapshot)
//   /planc     -> Plan C (apply 2-move from /transfer snapshot)
//   /pland     -> Plan D (apply 3-move from /transfer snapshot)
//
// This relies on KV state written by src/commands/transfer.js at key: plan:${chatId}:transfers

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kPlan = (id) => `plan:${id}:transfers`;
const kUser = (id) => `user:${id}:profile`;

const B = (s) => `<b>${esc(s)}</b>`;
const gbp = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}m`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

/* ================================================================
   Entry
================================================================ */
export default async function plan(env, chatId, rawArg = "") {
  // Detect which plan: A|B|C|D
  const mode = detectMode(rawArg); // "A" | "B" | "C" | "D"

  // Ensure team linked (for nicer error)
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  if (!pRaw) {
    await send(env, chatId, `${B("Not linked")} Use /link &lt;TeamID&gt; first.`, "HTML");
    return;
  }
  const { teamId } = JSON.parse(pRaw) || {};
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link &lt;TeamID&gt; first.`, "HTML");
    return;
  }

  // Must have a recent /transfer run to seed parity state
  const saved = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kPlan(chatId)) : null;
  if (!saved) {
    await send(env, chatId, `${B("No plan saved")} Run /transfer first to generate Plans A–D.`, "HTML");
    return;
  }
  let state;
  try { state = JSON.parse(saved); } catch { state = null; }
  if (!state || !Array.isArray(state.base)) {
    await send(env, chatId, `${B("No plan saved")} Run /transfer first.`, "HTML");
    return;
  }

  // Fetch FPL data we need to render
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again.", "HTML");
    return;
  }
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const elsById = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));

  const nextGW = getNextGwId(bootstrap);

  // Determine squad of 15 for selected plan (A base, B/C/D snapshots from /transfer)
  let squadIds = null;
  if (mode === "A") squadIds = state.base.slice(0, 15);
  else {
    // Prefer snapshots if present; else, apply moves recorded
    const snap = state.squads?.[mode];
    if (Array.isArray(snap) && snap.length) {
      squadIds = snap.slice(0, 15);
    } else {
      const moves = (state.plans?.[mode] || []);
      squadIds = applyMoves(state.base, moves).slice(0, 15);
    }
  }

  // Build XI recommendation for THIS squad (no transfers here)
  const cfg = state.model || { h:3, min:78, damp:0.94 };
  const best = bestXIForGw(
    squadIds.map(id => elsById[id]).filter(Boolean),
    bootstrap, fixtures, cfg, nextGW
  );
  if (!best) {
    await send(env, chatId, "Couldn't form a valid XI from this plan.", "HTML");
    return;
  }

  // Captain / Vice suggestions (within this XI)
  const ranked = best.xi.slice().sort((a,b)=>b.score-a.score);
  const C  = ranked[0];
  const VC = ranked[1] || null;

  // Header — mirror /transfer header style
  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — ${mode==="A"?"Plan A (no moves)":"Plan "+mode} — Formation`,
    `${B("Model")}: ${cfg.chase ? "Chasing" : "Pro Auto"} — h=${cfg.h}, min=${cfg.min}% , damp=${cfg.damp}${cfg.ft!=null?` | ${B("FT (assumed)")}: ${cfg.ft}`:""}`
  ].join("\n");

  // Body
  const lines = [];
  lines.push(`${B("Recommended XI")}: ${best.gwShape}  |  ${B("Projected")} ${best.total.toFixed(2)}`);
  lines.push("");
  lines.push(B("GKP"));
  lines.push(`• ${playerLine(best.xi.find(r=>r.type===1), teams, true, C, VC)}`);
  lines.push("");
  lines.push(B("DEF"));
  best.xi.filter(r=>r.type===2).forEach(r => lines.push(`• ${playerLine(r, teams, false, C, VC)}`));
  lines.push("");
  lines.push(B("MID"));
  best.xi.filter(r=>r.type===3).forEach(r => lines.push(`• ${playerLine(r, teams, false, C, VC)}`));
  lines.push("");
  lines.push(B("FWD"));
  best.xi.filter(r=>r.type===4).forEach(r => lines.push(`• ${playerLine(r, teams, false, C, VC)}`));
  lines.push("");

  lines.push(`${B("Bench order")}: ${best.benchLine || "—"}`);
  lines.push(`${B("Minutes threshold")}: ${cfg.min}%`);
  if (best.riskyXI?.length) lines.push(`${B("Risk in XI")}: ${best.riskyXI.join(", ")}`);
  if (best.relaxed) lines.push(`(Minutes filter relaxed to fill positions.)`);

  // Footer quick nav (parity)
  lines.push("");
  lines.push(esc("View other plans: /planb · /planc · /pland  |  Rebuild: /transfer"));

  const html = [head, "", ...lines].join("\n");
  await send(env, chatId, html, "HTML");
}

/* ================================================================
   Mode detection
================================================================ */
function detectMode(arg){
  const a = String(arg||"").trim().toLowerCase();
  if (a.includes("planb") || a==="b") return "B";
  if (a.includes("planc") || a==="c") return "C";
  if (a.includes("pland") || a==="d") return "D";
  // Some routers call plan(env,id,"B") directly; accept that:
  if (/^[abcd]$/i.test(a)) return a.toUpperCase();
  return "A";
}

/* ================================================================
   XI builder (same spirit as /transfer scoring)
================================================================ */
function bestXIForGw(squadEls, bootstrap, fixtures, cfg, gw){
  const minPct = cfg.min || 78;

  const rows = squadEls.map(el => rowForGw(el, fixtures, gw, cfg, bootstrap));
  const gks  = rows.filter(r=>r.type===1).sort((a,b)=>b.score-a.score);
  const defs = rows.filter(r=>r.type===2).sort((a,b)=>b.score-a.score);
  const mids = rows.filter(r=>r.type===3).sort((a,b)=>b.score-a.score);
  const fwds = rows.filter(r=>r.type===4).sort((a,b)=>b.score-a.score);

  // allowed shapes
  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];

  const pickGK = () => {
    const safe = gks.filter(r=>r.mp>=minPct && r.hasFixture);
    if (safe.length) return safe[0];
    return gks.find(r=>r.hasFixture) || null;
  };
  const pickN = (arr,n) => {
    const safe = arr.filter(r=>r.mp>=minPct && r.hasFixture).slice(0,n);
    if (safe.length===n) return { chosen:safe, relaxed:false };
    const need = n - safe.length;
    const fill = arr.filter(r=>r.hasFixture && !safe.find(x=>x.id===r.id)).slice(0,need);
    return { chosen:[...safe,...fill], relaxed: need>0 };
  };

  let best=null;
  for (const [d,m,f] of shapes){
    const gk = pickGK(); if (!gk) continue;
    const {chosen: D, relaxed:rD} = pickN(defs, d);
    const {chosen: M, relaxed:rM} = pickN(mids, m);
    const {chosen: F, relaxed:rF} = pickN(fwds, f);
    if (D.length<d || M.length<m || F.length<f) continue;
    const xi=[gk, ...D, ...M, ...F];
    const total = xi.reduce((s,r)=>s+r.score,0);

    const benchPool = rows.filter(r=>!xi.find(x=>x.id===r.id));
    const benchOut  = benchPool.sort((a,b)=>b.score-a.score).slice(0,3);
    const benchGK   = gks.find(r=>r.id!==gk.id);

    const benchLine = [
      benchOut[0] ? `1) ${benchOut[0].name} (${benchOut[0].pos})` : null,
      benchOut[1] ? `2) ${benchOut[1].name} (${benchOut[1].pos})` : null,
      benchOut[2] ? `3) ${benchOut[2].name} (${benchOut[2].pos})` : null,
      benchGK     ? `GK: ${benchGK.name}` : null
    ].filter(Boolean).join(", ");

    const riskyXI = xi.filter(r => r.mp < minPct || !r.hasFixture).map(r=>r.name);
    const cand = {
      d, m, f, xi, total,
      benchLine,
      gwShape:`${d}-${m}-${f}`,
      riskyXI,
      relaxed:(rD||rM||rF)
    };
    if (!best || total>best.total) best=cand;
  }
  return best;
}

function rowForGw(el, fixtures, gw, cfg, bootstrap){
  const minProb = chance(el);
  const teamId = el.team;
  const teamShort = (bootstrap?.teams?.find(t=>t.id===teamId)?.short_name) || "?";

  const fs = fixtures
    .filter(f => f.event === gw && (f.team_h===teamId || f.team_a===teamId))
    .sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);

  if (!fs.length) {
    return {
      id: el.id, type: el.element_type, pos: posName(el.element_type),
      team: teamShort, name: playerShort(el), mp: minProb, score: 0, hasFixture: false, double: 0
    };
  }

  const ppg = parseFloat(el.points_per_game || "0") || 0;
  let score = 0;
  fs.forEach((f, idx) => {
    const home = f.team_h === teamId;
    const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
    const mult = fdrMult(fdr);
    const dampK = idx === 0 ? 1.0 : (cfg.damp ?? 0.94);
    score += ppg * (minProb/100) * mult * dampK;
  });

  return {
    id: el.id,
    type: el.element_type,
    pos: posName(el.element_type),
    team: teamShort,
    name: playerShort(el),
    mp: minProb,
    score,
    hasFixture: true,
    double: fs.length
  };
}

/* ================================================================
   Captain rendering helper
================================================================ */
function playerLine(r, teams, isGK=false, C=null, VC=null){
  if (!r) return "—";
  const tag = (C && r.id===C.id) ? " (C)" : (VC && r.id===VC.id) ? " (VC)" : "";
  const dgw = r.double>1 ? " x2" : "";
  return `${esc(r.name)} (${r.team})${tag}${dgw}`;
}

/* ================================================================
   Shared small utils
================================================================ */
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
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x;
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
function applyMoves(idList, moves){
  const ids = idList.slice();
  for (const m of (moves||[])){
    const idx = ids.indexOf(m.outId);
    if (idx !== -1) ids.splice(idx, 1);
    if (!ids.includes(m.inId)) ids.push(m.inId);
  }
  return ids;
}