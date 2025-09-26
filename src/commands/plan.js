// src/commands/plan.js
// Suggest best formation for the NEXT GW and annotate Captain (C) & Vice-Captain (VC)

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

// KV key where /link stored the teamId
const kUser = (chatId) => `user:${chatId}:profile`;

// ---- Public entry ----
export default async function plan(env, chatId) {
  // 1) Resolve linked team
  const profRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = safeParse(profRaw)?.teamId;
  if (!teamId) {
    await send(env, chatId, `${B("No team linked")} — use /link <team_id> first.`, "HTML");
    return;
  }

  // 2) Fetch FPL data
  const [bootstrap, fixtures] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/")
  ]);
  const curGW  = currentGw(bootstrap);
  const nextGW = nextGwId(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) {
    await send(env, chatId, `${B("Couldn’t fetch your team")} — is it private?`, "HTML");
    return;
  }

  // 3) Build best XI for NEXT GW
  const xiRes = bestXIForNextGW(picks, bootstrap, fixtures, nextGW);
  if (!xiRes) {
    await send(env, chatId, `${B("No valid XI")} — not enough available players for GW${nextGW}.`, "HTML");
    return;
  }

  // 4) Captaincy: pick top-2 by score from chosen XI (C then VC)
  const rankedXI = xiRes.xi.slice().sort((a,b)=>b.score-a.score);
  const C  = rankedXI[0];
  const VC = rankedXI.find(p => p.id !== C.id) || rankedXI[1] || C;

  // decorate names in the printed XI
  const tag = (r) => r.id === C.id ? `${r.name} (C)` : (r.id === VC.id ? `${r.name} (VC)` : r.name);

  // 5) Render
  const lines = [];
  lines.push(`${B(`GW ${nextGW} — Best Formation`)}`);
  lines.push(`${B("Shape")} ${esc(xiRes.shape)}  |  ${B("Projected XI")} ${esc(xiRes.total.toFixed(1))}`);
  if (xiRes.relaxed) lines.push(`(Minutes threshold was relaxed to fill 11)`);
  lines.push("");
  lines.push(B("Captaincy"));
  lines.push(`• ${esc(C.name)} — ${esc(`${C.pos} ${C.team}`)}  (${fmtScore(C.score)})`);
  lines.push(`• ${esc(VC.name)} — ${esc(`${VC.pos} ${VC.team}`)}  (${fmtScore(VC.score)})`);
  lines.push("");
  lines.push(B("Starters"));
  lines.push(section("GK", xiRes.xi.filter(x=>x.type===1).map(r=>`• ${esc(tag(r))} — ${esc(`${r.team}`)}`)));
  lines.push(section("DEF", xiRes.xi.filter(x=>x.type===2).map(r=>`• ${esc(tag(r))} — ${esc(`${r.team}`)}`)));
  lines.push(section("MID", xiRes.xi.filter(x=>x.type===3).map(r=>`• ${esc(tag(r))} — ${esc(`${r.team}`)}`)));
  lines.push(section("FWD", xiRes.xi.filter(x=>x.type===4).map(r=>`• ${esc(tag(r))} — ${esc(`${r.team}`)}`)));
  lines.push("");
  lines.push(`${B("Bench order")} ${esc(xiRes.benchLine || "—")}`);

  await send(env, chatId, lines.join("\n"), "HTML");
}

/* ---------------- helpers ---------------- */

function section(label, arr) {
  return [`${B(label)}:`, arr.length ? arr.join("\n") : "• —"].join("\n");
}

function fmtScore(x){ return `${x.toFixed(2)}`; }

function safeParse(s){ try { return JSON.parse(s||""); } catch { return null; } }

async function getJSON(url){
  try {
    const r = await fetch(url, { cf:{ cacheTtl: 30, cacheEverything: true }});
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function currentGw(bootstrap){
  const ev=bootstrap?.events||[];
  return ev.find(e=>e.is_current)?.id ?? ev.find(e=>e.is_next)?.id ?? ev.find(e=>!e.finished)?.id ?? ev.at(-1)?.id ?? 1;
}
function nextGwId(bootstrap){
  const ev=bootstrap?.events||[];
  return ev.find(e=>e.is_next)?.id ?? (()=>{ const cur=ev.find(e=>e.is_current); if(!cur) return ev.find(e=>!e.finished)?.id ?? ev.at(-1)?.id ?? 1;
    const i=ev.findIndex(e=>e.id===cur.id); return ev[i+1]?.id ?? cur.id; })();
}

// Core scoring (simple, fast, explainable)
function scorePlayer(el, fixtures, bootstrap, gw){
  // PPG & form
  const ppg  = parseFloat(el.points_per_game||"0") || 0;
  const form = Math.min(parseFloat(el.form||"0")||0, 10);

  // Minutes proxy (flag)
  const minPct = Number(el.chance_of_playing_next_round ?? 100);
  const minMult = Math.max(0, Math.min(1, minPct/100));

  // Fixture(s) in GW — support DGW by summing with slight diminishing returns
  const teamId = el.team;
  const games = fixtures.filter(f => f.event === gw && (f.team_h===teamId || f.team_a===teamId));
  if (!games.length) return 0;

  let sum = 0;
  const damp = [1.0, 0.9, 0.8];
  for (let i=0;i<games.length;i++){
    const f = games[i];
    const home = f.team_h===teamId;
    const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
    const fdrMult = 1.30 - 0.10 * clamp(fdr, 2, 5); // easier fixture → bigger multiplier
    sum += (ppg * fdrMult * minMult) * (1 + 0.02 * form) * (damp[i] ?? 0.75);
  }
  return sum;
}

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function posName(t){ return ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t]||"?"; }
function teamShort(bootstrap, id){ return bootstrap?.teams?.find(t=>t.id===id)?.short_name || "?"; }

// Build best XI for the next GW by checking common legal shapes
function bestXIForNextGW(picks, bootstrap, fixtures, gw){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const squad = (picks?.picks||[]).map(p=>byId[p.element]).filter(Boolean);

  // Precompute rows with scores for the next GW
  const rows = squad.map(el => ({
    id: el.id,
    type: el.element_type,
    pos: posName(el.element_type),
    team: teamShort(bootstrap, el.team),
    name: el.web_name, // short display name
    score: scorePlayer(el, fixtures, bootstrap, gw),
    minPct: Number(el.chance_of_playing_next_round ?? 100)
  }));

  const gks  = rows.filter(r=>r.type===1).sort((a,b)=>b.score-a.score);
  const defs = rows.filter(r=>r.type===2).sort((a,b)=>b.score-a.score);
  const mids = rows.filter(r=>r.type===3).sort((a,b)=>b.score-a.score);
  const fwds = rows.filter(r=>r.type===4).sort((a,b)=>b.score-a.score);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  const MIN = 0.80; // 80% minutes preferred; we can relax if needed

  let best=null;

  for (const [d,m,f] of shapes){
    const pickGK = () => {
      const safe = gks.filter(r=>r.minPct>=MIN*100);
      return (safe[0] || gks[0] || null);
    };
    const pickN = (arr, n) => {
      const safe = arr.filter(r=>r.minPct>=MIN*100).slice(0,n);
      if (safe.length === n) return { chosen: safe, relaxed: false };
      const need = n - safe.length;
      const fill = arr.filter(r=>!safe.includes(r)).slice(0,need);
      return { chosen: [...safe, ...fill], relaxed: need>0 };
    };

    const GK = pickGK(); if (!GK) continue;
    const {chosen: D, relaxed: rD} = pickN(defs, d);
    const {chosen: M, relaxed: rM} = pickN(mids, m);
    const {chosen: F, relaxed: rF} = pickN(fwds, f);
    if (D.length<d || M.length<m || F.length<f) continue;

    const xi = [GK, ...D, ...M, ...F];
    const total = xi.reduce((s,r)=>s+r.score,0);

    // Bench: top 3 remaining outfielders + spare GK label
    const rest = rows.filter(r => !xi.find(x=>x.id===r.id));
    const outfield = rest.filter(r=>r.type!==1).sort((a,b)=>b.score-a.score);
    const gk2 = rest.find(r=>r.type===1) || null;
    const benchLine = [
      outfield[0] ? `1) ${outfield[0].name} (${outfield[0].pos})` : null,
      outfield[1] ? `2) ${outfield[1].name} (${outfield[1].pos})` : null,
      outfield[2] ? `3) ${outfield[2].name} (${outfield[2].pos})` : null,
      gk2 ? `GK) ${gk2.name}` : null
    ].filter(Boolean).join(", ");

    const relaxed = rD || rM || rF;

    const cand = { d, m, f, xi, total, benchLine, relaxed };
    if (!best || total > best.total) best = cand;
  }

  if (!best) return null;
  best.shape = `${best.d}-${best.m}-${best.f}`;
  return best;
}