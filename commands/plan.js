// src/commands/plan.js — Formation planner that mirrors /transfer logic exactly
// Commands: /plan (A=0), /planb (B=1), /planc (C=2), /pland (D=3)

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";
import { chooseAutoConfig } from "../presets.js";

const kUser = (id) => `user:${id}:profile`;
const B = (s) => `<b>${esc(s)}</b>`;
const gbp = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";
const teamShort = (teams, id) => teams[id]?.short_name || "?";
const playerShort = (el) => {
  const first = (el?.first_name || "").trim();
  const last  = (el?.second_name || "").trim();
  const web   = (el?.web_name || "").trim();
  if (first && last) {
    const initLast = `${first[0]}. ${last}`;
    return (web && web.length <= initLast.length) ? web : initLast;
  }
  return web || last || first || "—";
};

/* ===== Constants (match /transfer) ===== */
const MIN_DELTA_SINGLE = 0.5;
const MIN_DELTA_COMBO  = 1.5;
const MAX_POOL_PER_POS = 500;
const MAX_SINGLE_SCAN  = 500;

/* ===== Public entry ===== */
export default async function plan(env, chatId, variant = "a") {
  // Resolve team
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

  // Fetch data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }
  const nextGW = getNextGwId(bootstrap);
  const curGW  = getCurrentGw(bootstrap);

  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // Same Auto-Pro config as /transfer
  const cfg = chooseAutoConfig({ bootstrap, picks });

  // Budget (same as /transfer)
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  // Precompute maps
  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const allPicks = (picks?.picks || []);
  const startersP   = allPicks.filter(p => (p.position || 16) <= 11);
  const startersEls = startersP.map(p => els[p.element]).filter(Boolean);
  const ownedIds    = new Set(allPicks.map(p => p.element));

  // Team counts (≤3) and selling prices — identical to /transfer rules
  const teamCounts = {};
  const sell = {};
  for (const p of allPicks) {
    const el = els[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
    const raw = (p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0);
    sell[p.element] = (raw / 10.0) || 0;
  }

  // Horizon rows (reuse /transfer scoring)
  const rowCache = {};
  for (const el of (bootstrap?.elements || [])) {
    rowCache[el.id] = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
  }

  // OUT candidates = weakest current starters
  const outCands = startersEls.map(el => ({
    id: el.id,
    name: playerShort(el),
    posT: el.element_type,
    teamId: el.team,
    team: teamShort(teams, el.team),
    sell: sell[el.id] || ((el.now_cost || 0)/10),
    listPrice: (el.now_cost || 0)/10,
    score: rowCache[el.id]?.score ?? 0
  }))
  .sort((a,b)=>a.score-b.score)
  .slice(0, 11);

  // Market pool (minutes filter)
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements || [])) {
    if (chance(el) < cfg.min) continue;
    const r = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
    poolByPos[el.element_type].push({
      id: el.id,
      name: playerShort(el),
      team: teamShort(teams, el.team),
      teamId: el.team,
      pos: posName(el.element_type),
      price: (el.now_cost || 0) / 10,
      score: r.score
    });
  }
  Object.keys(poolByPos).forEach(k => {
    poolByPos[k].sort((a,b)=>b.score-a.score);
    poolByPos[k] = poolByPos[k].slice(0, MAX_POOL_PER_POS);
  });

  // Build singles exactly as /transfer
  const singles = [];
  const rejections = [];
  const MAX_PER_TEAM = 3;

  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT] || [];
    for (let i=0; i<list.length && singles.length<MAX_SINGLE_SCAN; i++) {
      const IN = list[i];

      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell; // SELL for OUT, LIST for IN
      if (priceDiff > bank + 1e-9) { rejections.push(reason("bank", out, IN, { need: priceDiff - bank })); continue; }

      const newCountIn = (teamCounts[IN.teamId] || 0) + (IN.teamId === out.teamId ? 0 : 1);
      if (newCountIn > MAX_PER_TEAM) { rejections.push(reason("team-limit", out, IN, { count: newCountIn })); continue; }

      const delta = IN.score - out.score;
      if (delta < MIN_DELTA_SINGLE) { rejections.push(reason("min-delta", out, IN, { delta })); continue; }

      singles.push({
        outId: out.id, inId: IN.id,
        outName: out.name, inName: IN.name,
        outTeamId: out.teamId, inTeamId: IN.teamId,
        outTeam: out.team, inTeam: IN.team,
        pos: out.posT,
        outSell: out.sell,
        outList: out.listPrice,
        inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff,
        delta,
        why: ["passed: legal, bank ok, Δ≥0.5, minutes ok"]
      });
      if (singles.length >= MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // Compose A/B/C/D (use same hit/FT logic)
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, cfg.ft);
  const planC = bestCombo(singles.slice(0, 120), 2, teamCounts, MAX_PER_TEAM, bank, cfg.ft);
  const planD = bestCombo(singles.slice(0, 160), 3, teamCounts, MAX_PER_TEAM, bank, cfg.ft);

  const plans = { a:planA, b:planB, c:planC, d:planD };
  const chosenKey = String(variant||"a").toLowerCase()[0];
  const chosen = plans[chosenKey] || planA;

  // Simulate chosen moves on your squad
  const picksSim = applyMovesToPicks(picks, chosen.moves);

  // Build XI for the simulated squad
  const formRes = bestXIForSquad(picksSim, bootstrap, fixtures, teams, nextGW, cfg);
  // C/VC — pick top two projections within XI
  const cvc = suggestCaptainVC(formRes.xi);

  // Header (same style as /transfer)
  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Formation Plan (Next)`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (assumed)")}: ${cfg.ft} | ${B("Hits")}: -4 per extra move`,
    `${B("Model")}: ${esc(cfg.presetName || "Pro Auto")} — h=${cfg.h}, min=${cfg.min}%, damp=${cfg.damp} | ${B("Hit OK if Net ≥")} ${cfg.hit}`
  ].join("\n");

  // Moves block
  const moveLines = [];
  if (!chosen.moves.length) {
    moveLines.push(`${B("Plan")}: A — Save FT (0 moves)`);
  } else {
    const label = chosenKey==="b"?"B":chosenKey==="c"?"C":chosenKey==="d"?"D":"?";
    moveLines.push(`${B("Plan")}: ${label} — ${chosen.moves.length} move(s)`);
    chosen.moves.forEach((m,i)=>{
      moveLines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
      moveLines.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
      moveLines.push(`   Prices: OUT sell ${gbp(m.outSell)} | IN list ${gbp(m.inPrice)}`);
    });
    moveLines.push(`Net (after hits): ${(chosen.net>=0?"+":"")}${chosen.net.toFixed(2)}  |  Raw Δ: +${chosen.delta.toFixed(2)}  |  Hits: -${chosen.hit}`);
  }
  if (Array.isArray(chosen.why) && chosen.why.length) {
    moveLines.push("Why:");
    chosen.why.slice(0,6).forEach(w => moveLines.push(`   • ${esc(w)}`));
  }

  // XI block
  const xiLines = [];
  xiLines.push(`${B("Best XI")}: Projected ${formRes.total.toFixed(1)} (shape ${formRes.shape})`);
  xiLines.push("");
  xiLines.push(`${B("GK:")}`);
  formRes.gk.forEach(l => xiLines.push(`• ${l}`));
  xiLines.push("");
  xiLines.push(`${B("DEF:")}`);
  formRes.def.forEach(l => xiLines.push(`• ${l}`));
  xiLines.push("");
  xiLines.push(`${B("MID:")}`);
  formRes.mid.forEach(l => xiLines.push(`• ${l}`));
  xiLines.push("");
  xiLines.push(`${B("FWD:")}`);
  formRes.fwd.forEach(l => xiLines.push(`• ${l}`));
  xiLines.push("");
  xiLines.push(`${B("Bench:")} ${formRes.benchLine || "—"}`);
  xiLines.push(`${B("Risky starters (<min%)")}: ${formRes.riskyList || "none"}`);
  xiLines.push(`${B("Captain")}: ${cvc.cName}  |  ${B("Vice")}: ${cvc.vName}`);

  const tail = [
    "",
    `${B("Try more")}: /planb /planc /pland`
  ].join("\n");

  const html = [head, "", ...moveLines, "", ...xiLines, tail].join("\n");
  await send(env, chatId, html, "HTML");
}

/* ======= EXACTLY matching helper logic from /transfer ======= */
function reason(code, OUT, IN, extra={}){
  const m = {
    "same-player":   `Candidate equals OUT player`,
    "already-owned": `Already in your team`,
    "bank":          `Insufficient bank (need ${gbp(extra.need || 0)})`,
    "team-limit":    `Would break per-team limit (max 3)`,
    "min-delta":     `Upgrade below +0.5 (Δ=${(extra.delta??0).toFixed(2)})`,
  }[code] || "Filtered";
  return { code, text: `${OUT.name} → ${IN.name}: ${m}` };
}
function mkPlanA(rejections){
  const why = [];
  if (Array.isArray(rejections) && rejections.length) {
    const counts = {};
    for (const r of rejections) counts[r.code] = (counts[r.code]||0) + 1;
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3)
      .map(([code,n]) => humanReasonSummary(code, n));
    if (top.length) {
      why.push("No legal upgrades cleared the bar.");
      top.forEach(t => why.push(`• ${t}`));
    } else {
      why.push("No clear upgrades; better to roll FT.");
    }
  } else {
    why.push("No clear upgrades; better to roll FT.");
  }
  return { moves: [], delta: 0, hit: 0, net: 0, why };
}
function mkPlanB(singles, ft){
  if (!singles.length) return mkPlanA();
  const s = singles[0];
  const hit = Math.max(0, 1 - ft) * 4;
  const raw = s.delta;
  if (raw < MIN_DELTA_SINGLE) return { ...mkPlanA(), why: ["Best single was below +0.5."] };
  const why = [...(s.why||[])];
  if (hit>0) why.push(`-4 applied (1 FT used already)`);
  return { moves:[s], delta: raw, hit, net: raw - hit, why };
}
function bestCombo(singles, K, teamCounts, MAX_PER_TEAM, bank, ft){
  if (!singles.length || K < 2) return mkPlanA();
  function validCombo(combo){
    const outIds = new Set(), inIds = new Set();
    const counts = { ...teamCounts };
    let spend = 0, deltaSum = 0;
    const why = [];
    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return { invalid:true, why:["Duplicate player in combo"] };
      outIds.add(m.outId); inIds.add(m.inId);
      if (m.inTeamId !== m.outTeamId) {
        counts[m.outTeamId] = (counts[m.outTeamId]||0) - 1;
        counts[m.inTeamId]  = (counts[m.inTeamId] ||0) + 1;
      }
      spend += m.priceDiff;
      deltaSum += m.delta;
      if (m.why) why.push(...m.why);
    }
    for (const c of Object.values(counts)) if (c > MAX_PER_TEAM) return { invalid:true, why:["Team limit >3"] };
    if (spend > bank + 1e-9) return { invalid:true, why:[`Insufficient bank (need ${gbp(spend - bank)})`] };
    if (deltaSum < MIN_DELTA_COMBO) return { invalid:true, why:["Total Δ below +1.5 before hits"] };
    const hit = Math.max(0, combo.length - ft) * 4;
    return { invalid:false, delta: deltaSum, hit, net: deltaSum - hit, spend, why };
  }
  const S = Math.min(80, singles.length);
  const base = singles.slice(0, S);
  let best = null;
  const idxs = [...Array(S).keys()];
  function* kComb(k, start=0, acc=[]){
    if (k===0) { yield acc; return; }
    for (let i=start;i<=S-k;i++) yield* kComb(k-1, i+1, [...acc, i]);
  }
  for (const ids of kComb(K)) {
    const combo = ids.map(i => base[i]);
    const chk = validCombo(combo);
    if (chk.invalid) continue;
    const cand = { moves: combo, delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend, why: uniq(chk.why) };
    if (!best || cand.net > best.net) best = cand;
  }
  if (!best) return mkPlanA(["No affordable/legal combo found."]);
  if (best.hit>0) best.why = [...(best.why||[]), `Includes -${best.hit} hit; net ${best.net>=0?"+":""}${best.net.toFixed(2)}`];
  return best;
}
function humanReasonSummary(code, n){
  const label = {
    "same-player":"same-player collisions",
    "already-owned":"already-owned targets",
    "bank":"bank shortfall",
    "team-limit":"team limit >3",
    "min-delta":"Δ below +0.5"
  }[code] || code;
  return `${label}: ${n}×`;
}
function uniq(arr){ return Array.from(new Set(arr)); }

/* ===== Formation builder (next GW horizon scoring) ===== */
function bestXIForSquad(picksLike, bootstrap, fixtures, teams, nextGW, cfg){
  const els = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const H = cfg.h, damp = cfg.damp, minCut = cfg.min;

  const all = (picksLike?.picks || []).slice().sort((a,b)=>a.position-b.position);
  const squadEls = all.map(p => els[p.element]).filter(Boolean);

  const rows = squadEls.map(el => ({
    el,
    posT: el.element_type,
    team: teamShort(teams, el.team),
    pos: posName(el.element_type),
    mp: chance(el),
    score: rowForHorizon(el, fixtures, teams, nextGW, H, damp, minCut).score
  }));

  const gks  = rows.filter(r=>r.posT===1).sort((a,b)=>b.score-a.score);
  const defs = rows.filter(r=>r.posT===2).sort((a,b)=>b.score-a.score);
  const mids = rows.filter(r=>r.posT===3).sort((a,b)=>b.score-a.score);
  const fwds = rows.filter(r=>r.posT===4).sort((a,b)=>b.score-a.score);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];

  function pickN(arr, n){
    const safe = arr.filter(r=>r.mp>=minCut).slice(0,n);
    if (safe.length===n) return { chosen:safe, relaxed:false };
    const need = n - safe.length;
    const fill = arr.filter(r=>!safe.includes(r)).slice(0,need);
    return { chosen:[...safe, ...fill], relaxed: need>0 };
  }

  let best=null;
  for (const [d,m,f] of shapes){
    const gk = (gks.find(r=>r.mp>=minCut) || gks[0]);
    if (!gk) continue;

    const D = pickN(defs, d);
    const M = pickN(mids, m);
    const F = pickN(fwds, f);
    if (D.chosen.length<d || M.chosen.length<m || F.chosen.length<f) continue;

    const xi = [gk, ...D.chosen, ...M.chosen, ...F.chosen].map(x=>x.el ? x : {el:x.el}); // normalize
    const xiRows = [gk, ...D.chosen, ...M.chosen, ...F.chosen];

    const total = xiRows.reduce((s,r)=>s+(r.score||0),0);

    const benchPool = [...defs, ...mids, ...fwds].filter(r=>!xiRows.find(x=>x.el?.id===r.el?.id)).sort((a,b)=>b.score-a.score);
    const benchOut = benchPool.slice(0,3);
    const gkBench  = gks.find(r=>r.el?.id !== gk.el?.id);

    const benchLine = [
      benchOut[0] ? `1) ${benchOut[0].el.web_name} (${benchOut[0].pos})` : null,
      benchOut[1] ? `2) ${benchOut[1].el.web_name} (${benchOut[1].pos})` : null,
      benchOut[2] ? `3) ${benchOut[2].el.web_name} (${benchOut[2].pos})` : null,
      gkBench     ? `GK: ${gkBench.el.web_name}` : null
    ].filter(Boolean).join(", ");

    const riskyList = xiRows.filter(r=>r.mp < minCut).map(r=>`${r.el.web_name} (${r.mp}%)`).join(", ");

    const lines = grp => grp.map(r => `${r.el.web_name} (${teamShort(teams, r.el.team)})`);

    const cand = {
      total,
      shape: `${d}-${m}-${f}`,
      gk: [gk.el ? `${gk.el.web_name} (${teamShort(teams, gk.el.team)})` : ""].filter(Boolean),
      def: lines(D.chosen),
      mid: lines(M.chosen),
      fwd: lines(F.chosen),
      benchLine,
      riskyList,
      xi: xiRows
    };
    if (!best || total > best.total) best = cand;
  }
  return best || { total:0, shape:"-", gk:[], def:[], mid:[], fwd:[], benchLine:"", riskyList:"", xi:[] };
}
function suggestCaptainVC(xiRows){
  const arr = xiRows.slice().sort((a,b)=> (b.score||0) - (a.score||0));
  const c = arr[0]?.el?.web_name || "—";
  const v = arr[1]?.el?.web_name || "—";
  return { cName: c, vName: v };
}

/* ====== Apply moves to picks ====== */
function applyMovesToPicks(picks, moves){
  if (!moves || !moves.length) return picks;
  const outToIn = new Map();
  for (const m of moves) outToIn.set(m.outId, m.inId);

  const cloned = JSON.parse(JSON.stringify(picks || {}));
  for (const p of (cloned.picks || [])) {
    if (outToIn.has(p.element)) p.element = outToIn.get(p.element);
  }
  return cloned;
}

/* ====== Scoring primitives (match /transfer) ====== */
function rowForHorizon(el, fixtures, teams, startGw, H = 1, damp = 0.94, minCut = 78){
  const minProb = chance(el); if (minProb < minCut) return { score: 0 };
  const ppg = parseFloat(el.points_per_game || "0") || 0;
  let score = 0;
  for (let g = startGw; g < startGw + H; g++){
    const fs = fixtures
      .filter(f => f.event === g && (f.team_h===el.team || f.team_a===el.team))
      .sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);
    if (!fs.length) continue;
    fs.forEach((f, idx) => {
      const home = f.team_h === el.team;
      const fdr = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
      const mult = fdrMult(fdr);
      const dampK = idx === 0 ? 1.0 : damp;
      score += ppg * (minProb/100) * mult * dampK;
    });
  }
  return { score };
}
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x;
}
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}

/* ====== GW helpers & HTTP ====== */
function getCurrentGw(bootstrap){
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next); if (nxt) return nxt.id;
  const up  = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
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