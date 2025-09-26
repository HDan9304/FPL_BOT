// src/commands/transfer.js — AUTO MODE (Pro preset) with EXPLANATIONS
// Usage: /transfer
// Requires: utils/telegram.send, utils/fmt.esc, KV key user:<chatId>:profile

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kUser   = (id) => `user:${id}:profile`;
const B       = (s) => `<b>${esc(s)}</b>`;
const gbp     = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

/* =======================
   Pro preset (recommended)
   ======================= */
// Noise guards
const MIN_DELTA_SINGLE = 0.5;  // ignore micro “upgrades”
const MIN_DELTA_COMBO  = 1.5;  // total raw gain required before hits
// Scan sizes
const MAX_POOL_PER_POS = 500;
const MAX_SINGLE_SCAN  = 500;

export default async function transfer(env, chatId) {
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

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
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // Pro auto-tune
  const cfg = autoTuneSettings({ bootstrap, fixtures, picks });

  // bank & roster
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const allPicks = (picks?.picks || []);
  const startersP   = allPicks.filter(p => (p.position || 16) <= 11);
  const startersEls = startersP.map(p => els[p.element]).filter(Boolean);
  const ownedIds    = new Set(allPicks.map(p => p.element));

  // team counts (≤3)
  const teamCounts = {};
  for (const p of allPicks) {
    const el = els[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // selling prices
  const sell = {};
  for (const p of allPicks) {
    const el = els[p.element];
    const raw = (p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0);
    sell[p.element] = (raw / 10.0) || 0;
  }

  // pre-compute horizon score
  const byRow = {};
  for (const el of (bootstrap?.elements || [])) {
    byRow[el.id] = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
  }

  // OUT candidates (weakest starters)
  const outCands = startersEls
    .map(el => ({
      id: el.id,
      name: playerShort(el),
      posT: el.element_type,
      teamId: el.team,
      team: teamShort(teams, el.team),
      sell: sell[el.id] || ((el.now_cost || 0)/10),
      score: byRow[el.id]?.score ?? 0
    }))
    .sort((a,b)=>a.score-b.score)
    .slice(0, 11);

  // Market pool by position (minutes filter)
  const MAX_PER_TEAM = 3;
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
  Object.keys(poolByPos).forEach(k => { poolByPos[k].sort((a,b)=>b.score-a.score); poolByPos[k] = poolByPos[k].slice(0, MAX_POOL_PER_POS); });

  // Singles with EXPLANATIONS
  const singles = [];
  const rejections = []; // record why we skipped candidates
  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT];
    for (let i=0; i<list.length && singles.length<MAX_SINGLE_SCAN; i++) {
      const IN = list[i];

      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell;
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
        outSell: out.sell, inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff,
        delta,
        why: ["passed: legal, bank ok, Δ≥0.5, minutes ok"]
      });
      if (singles.length >= MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // Plans A–D (with inline WHY)
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, cfg.ft);
  const planC = bestCombo(singles.slice(0, 120), 2, teamCounts, MAX_PER_TEAM, bank, cfg.ft);
  const planD = bestCombo(singles.slice(0, 160), 3, teamCounts, MAX_PER_TEAM, bank, cfg.ft);

  const plans = [
    { key:"A", title:"Plan A — 0 transfers", ...planA },
    { key:"B", title:"Plan B — 1 transfer",  ...planB },
    { key:"C", title:"Plan C — 2 transfers", ...planC },
    { key:"D", title:"Plan D — 3 transfers", ...planD }
  ];

  // choose recommendation
  const filtered = plans.map(p => ({...p})).filter(p => (p.moves.length <= 1) || (p.net >= cfg.hit));
  const best = (filtered.length ? filtered : plans).slice().sort((a,b)=> (b.net - a.net) )[0];
  const recommend = best ? best.key : "A";

  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Transfer Plan (Next)`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (assumed)")}: ${cfg.ft} | ${B("Hits")}: -4 per extra move`,
    `${B("Model")}: Pro Auto — h=${cfg.h}, min=${cfg.min}%, damp=${cfg.damp} | ${B("Hit OK if Net ≥")} ${cfg.hit}`
  ].join("\n");

  const blocks = [];
  for (const p of plans) {
    const title = p.key === recommend ? `✅ ${p.title} (recommended)` : p.title;
    blocks.push(renderPlan(title, p));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------- auto tuner (Pro) ---------- */
function autoTuneSettings({ bootstrap, fixtures, picks }, base = { h:2, min:78, damp:0.94, ft:1, hit:5 }){
  const riskyN = riskyStartersCount(picks, bootstrap, 80);
  const usedThis = usedTransfersThisGw(picks);
  const cfg = { ...base };

  // FT assumption for next GW (roll if unused this GW)
  cfg.ft = (usedThis === 0) ? 2 : 1;

  // Minutes floor — tighten only if fragile
  cfg.min = (riskyN >= 2) ? 85 : 78;

  // DGW damp stays 0.94 (mild discount on 2nd leg)
  cfg.damp = 0.94;

  // Hit threshold — tougher if fragile
  cfg.hit = (riskyN >= 3) ? 6 : 5;

  return cfg;
}

/* ---------- planning helpers ---------- */
function mkPlanA(rejections){
  const why = [];
  if (Array.isArray(rejections) && rejections.length) {
    // Summarize top reasons
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
  if (raw < MIN_DELTA_SINGLE) {
    return { ...mkPlanA(), why: ["Best single was below +0.5."] };
  }
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
  // Explain hit acceptance
  if (best.hit>0) best.why = [...(best.why||[]), `Includes -${best.hit} hit; net ${best.net>=0?"+":""}${best.net.toFixed(2)}`];
  return best;
}

function renderPlan(title, plan){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!plan || !plan.moves || !plan.moves.length) {
    lines.push("• Save FT. Projected ΔScore: +0.00");
  } else {
    plan.moves.forEach((m,i)=>{
      lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
      lines.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
    });
    lines.push(`Net (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)}  |  Raw Δ: +${plan.delta.toFixed(2)}  |  Hits: -${plan.hit}`);
  }
  // WHY block
  if (Array.isArray(plan.why) && plan.why.length){
    lines.push("Why:");
    plan.why.slice(0,6).forEach(w => lines.push(`   • ${esc(w)}`));
  }
  return lines.join("\n");
}

/* ---------- reasons helpers ---------- */
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

/* ---------- scoring over horizon ---------- */
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
  return 1.30 - 0.10 * x; // easy → ~1.10, hard → ~0.80
}

/* ---------- team state signals ---------- */
function riskyStartersCount(picks, bootstrap, minCut=80){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  let n=0;
  for (const p of xi){
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}
function usedTransfersThisGw(picks){
  const eh = picks?.entry_history;
  return (typeof eh?.event_transfers === "number") ? eh.event_transfers : null;
}

/* ---------- misc utils ---------- */
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function teamShort(teams, id){ return teams[id]?.short_name || "?"; }
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