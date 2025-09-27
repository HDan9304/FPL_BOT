// ./command/transfer.js
// Transfer planner — Plans A(0) B(1) C(2) D(3) for NEXT GW
// Bench is considered for risk (not default OUT targets). OUTs default to current XI only.
// Switch behaviour with: /transfer [mode=pro|champ]  (default: pro)

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const gbp   = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

/* ---------------- Presets (Pro vs Champion) ---------------- */
const PRESETS = {
  pro: {
    H: 2,               // horizon (GWs)
    min: 80,            // minutes threshold
    formCap: 8,         // cap form used in bonus
    damp: 0.92,         // per-fixture damp in DGW
    minDeltaSingle: 0.5,
    minDeltaCombo: 1.5,
    scanPoolPerPos: 400,
    scanSinglesMax: 500,
    hitOkayIfNetAtLeast: 5, // will take hits if net gain >= this
  },
  champ: {
    H: 3,
    min: 78,
    formCap: 9,
    damp: 0.94,
    minDeltaSingle: 0.4,
    minDeltaCombo: 1.2,
    scanPoolPerPos: 500,
    scanSinglesMax: 700,
    hitOkayIfNetAtLeast: 4, // a bit more aggressive
  }
};

/* ---------------- Entry point ---------------- */
export default async function transfer(env, chatId, arg = "") {
  // Resolve linked team
  const profRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = profRaw ? (JSON.parse(profRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`, "HTML");
    return;
  }

  // Fetch core FPL data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  // GWs & picks
  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGw(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (team private or API error)."); return; }

  // Choose preset from arg (default pro), then auto-tune around your squad risk/FT
  const opts   = parseArgs(arg);
  const base   = PRESETS[opts.mode] || PRESETS.pro;
  const tuned  = autoTune(base, { picks, bootstrap });
  const cfg    = { ...base, ...tuned }; // final config

  // Bank (ITB) and FT assumption for next GW
  const bank = getBank(entry, picks);
  const ft   = cfg.ft; // from autoTune

  // Build fast indexes
  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const allPicks = (picks?.picks || []).slice().sort((a,b)=>a.position-b.position);
  const startersP = allPicks.filter(p => (p.position || 16) <= 11);
  const benchP    = allPicks.filter(p => (p.position || 16) > 11);
  const ownedIds  = new Set(allPicks.map(p => p.element));

  // Team counts & selling prices
  const teamCounts = {};
  const sell = {};
  for (const p of allPicks) {
    const el = els[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
    const raw = (p.selling_price ?? p.purchase_price ?? el.now_cost ?? 0);
    sell[p.element] = (raw / 10.0) || 0;
  }

  // Risk scan (uses bench only for safety signals)
  const minCut = cfg.min;
  const riskyXI = startersP
    .map(p => els[p.element])
    .filter(Boolean)
    .filter(el => chance(el) < minCut);
  const safeBench = benchP
    .map(p => els[p.element])
    .filter(Boolean)
    .filter(el => chance(el) >= minCut);
  const benchSafeCount = safeBench.length;

  // Score cache for horizon
  const scoreCache = {};
  for (const el of (bootstrap?.elements || [])) {
    scoreCache[el.id] = horizonScore(el, fixtures, teams, nextGW, cfg);
  }

  // OUT candidates = current XI only (don’t dump bench by default)
  const outCands = startersP
    .map(p => els[p.element])
    .filter(Boolean)
    .map(el => ({
      id: el.id,
      name: shortName(el),
      pos: el.element_type,
      teamId: el.team,
      team: teamShort(teams, el.team),
      sell: sell[el.id] || ((el.now_cost || 0)/10),
      list: (el.now_cost || 0)/10,
      score: scoreCache[el.id] ?? 0
    }))
    .sort((a,b)=>a.score-b.score); // weakest first

  // Market pool (by position, minutes filtered)
  const MAX_PER_TEAM = 3;
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements || [])) {
    if (chance(el) < cfg.min) continue;
    const s = scoreCache[el.id] ?? 0;
    poolByPos[el.element_type].push({
      id: el.id,
      name: shortName(el),
      teamId: el.team,
      team: teamShort(teams, el.team),
      pos: posName(el.element_type),
      price: (el.now_cost || 0)/10,
      score: s
    });
  }
  Object.keys(poolByPos).forEach(k=>{
    poolByPos[k].sort((a,b)=>b.score-a.score);
    poolByPos[k] = poolByPos[k].slice(0, cfg.scanPoolPerPos);
  });

  // Build single-move upgrades (respect bank, team limit, not already owned, delta gates)
  const singles = [];
  const rejections = [];
  const OUT_SCAN = Math.min(outCands.length, 11);
  const SINGLE_SCAN_MAX = cfg.scanSinglesMax;

  outer:
  for (let i=0; i<OUT_SCAN; i++){
    const OUT = outCands[i];
    const candPool = poolByPos[OUT.pos] || [];
    for (let j=0; j<candPool.length; j++){
      if (singles.length >= SINGLE_SCAN_MAX) break outer;
      const IN = candPool[j];

      if (IN.id === OUT.id) { rejections.push(reason("same", OUT, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("owned", OUT, IN)); continue; }

      // team limit with swap
      const newCountIn = (teamCounts[IN.teamId] || 0) + (IN.teamId === OUT.teamId ? 0 : 1);
      if (newCountIn > MAX_PER_TEAM) { rejections.push(reason("limit", OUT, IN)); continue; }

      // affordability (use OUT sell vs IN list)
      const priceDiff = IN.price - OUT.sell;
      if (priceDiff > bank + 1e-9) { rejections.push(reason("bank", OUT, IN, { need: priceDiff - bank })); continue; }

      // delta gate
      const delta = (IN.score - OUT.score);
      if (delta < cfg.minDeltaSingle) { rejections.push(reason("delta", OUT, IN, { delta })); continue; }

      singles.push({
        outId: OUT.id, inId: IN.id,
        outName: OUT.name, inName: IN.name,
        outTeamId: OUT.teamId, inTeamId: IN.teamId,
        outTeam: OUT.team, inTeam: IN.team,
        pos: OUT.pos,
        outSell: OUT.sell, outList: OUT.list,
        inPrice: IN.price,
        priceDiff,
        bankLeft: bank - priceDiff,
        delta
      });
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // Build Plans
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwN   = Object.values(counts).filter(x => x>1).length;
  const blankN = Object.keys(teams).filter(tid => (counts[tid]||0)===0).length;
  const badgeLine = badge(dgwN, blankN);

  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, ft, cfg);
  const planC = bestCombo(singles.slice(0, 140), 2, teamCounts, MAX_PER_TEAM, bank, ft, cfg);
  const planD = bestCombo(singles.slice(0, 180), 3, teamCounts, MAX_PER_TEAM, bank, ft, cfg);

  // Recommend: choose highest net; only accept hits if net >= cfg.hitOkayIfNetAtLeast
  const plans = [
    { key:"A", title:`Plan A — 0 transfers ${badgeLine}`, ...planA },
    { key:"B", title:`Plan B — 1 transfer ${badgeLine}`,  ...planB },
    { key:"C", title:`Plan C — 2 transfers ${badgeLine}`, ...planC },
    { key:"D", title:`Plan D — 3 transfers ${badgeLine}`, ...planD }
  ];

  const filtered = plans.filter(p => (p.moves.length <= 1) || (p.net >= cfg.hitOkayIfNetAtLeast));
  const best = (filtered.length ? filtered : plans).slice().sort((a,b)=>b.net-a.net)[0];
  const recommend = best ? best.key : "A";

  // Header
  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")}  |  ${B("GW")}: ${nextGW} — Transfer Plan (Next)`,
    `${B("Bank")}: ${esc(gbp(bank))}  |  ${B("FT (assumed)")}: ${ft}  |  ${B("Hits")}: -4 after FT`,
    `${B("Mode")}: ${opts.mode.toUpperCase()}  |  H=${cfg.H}, min=${cfg.min}%  |  damp=${cfg.damp}  |  Δ1≥${cfg.minDeltaSingle}, ΔK≥${cfg.minDeltaCombo}`,
    riskyXI.length
      ? `${B("Risk")}: ${riskyXI.length} risky starters (<${cfg.min}% mins)  |  Safe bench: ${benchSafeCount}`
      : `${B("Risk")}: no flagged starters (min≥${cfg.min}%)  |  Safe bench: ${benchSafeCount}`
  ].join("\n");

  // Render plans
  const blocks = [];
  for (const p of plans) {
    const ttl = p.key === recommend ? `✅ ${p.title} (recommended)` : p.title;
    blocks.push(renderPlan(ttl, p, nextGW, counts));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------------- Parsing & auto-tune ---------------- */
function parseArgs(arg){
  const a = String(arg||"").trim();
  const out = { mode: "pro" };
  if (!a) return out;
  const toks = a.split(/\s+/).filter(Boolean);
  for (const t of toks){
    const m = t.match(/^mode=(pro|champ)$/i);
    if (m) { out.mode = m[1].toLowerCase(); continue; }
    if (/^champ$/i.test(t)) out.mode="champ";
    if (/^pro$/i.test(t))   out.mode="pro";
  }
  return out;
}

function autoTune(base, { picks, bootstrap }){
  // Risk-based nudges: more risk => raise min%, raise hit threshold
  const xi = (picks?.picks || []).filter(p => (p.position||16) <= 11);
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  let risky = 0;
  for (const p of xi) {
    const el = byId[p.element]; if (!el) continue;
    const mp = chance(el);
    if (mp < Math.max(70, base.min)) risky++;
  }
  // free transfers NEXT GW heuristic: if no transfers used this GW, assume 2
  const used = (picks?.entry_history?.event_transfers ?? 0);
  const ft = used === 0 ? 2 : 1;

  const cfg = { ft };
  if (risky >= 2) {
    cfg.min = Math.max(base.min, 84);
    cfg.hitOkayIfNetAtLeast = Math.max(base.hitOkayIfNetAtLeast, 6);
  } else {
    cfg.min = base.min;
    cfg.hitOkayIfNetAtLeast = base.hitOkayIfNetAtLeast;
  }
  return cfg;
}

/* ---------------- Planning helpers ---------------- */
function mkPlanA(rejections){
  const why = [];
  if (Array.isArray(rejections) && rejections.length) {
    const counts = {};
    for (const r of rejections) counts[r.code] = (counts[r.code]||0) + 1;
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3)
      .map(([code,n]) => reasonLabel(code, n));
    if (top.length) {
      why.push("No clear upgrades exceeded the thresholds:");
      top.forEach(t => why.push(`• ${t}`));
    } else {
      why.push("Roll FT — no obvious upgrade.");
    }
  } else {
    why.push("Roll FT — no obvious upgrade.");
  }
  return { moves: [], delta: 0, hit: 0, net: 0, why };
}

function mkPlanB(singles, ft, cfg){
  if (!singles.length) return mkPlanA([]);
  const best = singles[0];
  const hit  = Math.max(0, 1 - ft) * 4;
  const raw  = best.delta;
  if (raw < cfg.minDeltaSingle) return mkPlanA([]);
  return { moves:[best], delta: raw, hit, net: raw - hit, why: [] };
}

function bestCombo(singles, K, teamCounts0, MAX_PER_TEAM, bank, ft, cfg){
  if (!singles.length || K < 2) return mkPlanA([]);

  function valid(combo){
    const outIds = new Set(), inIds = new Set();
    const teamCounts = { ...teamCounts0 };
    let spend = 0, deltaSum = 0;

    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return { bad:true };
      outIds.add(m.outId); inIds.add(m.inId);

      if (m.inTeamId !== m.outTeamId) {
        teamCounts[m.outTeamId] = (teamCounts[m.outTeamId]||0) - 1;
        teamCounts[m.inTeamId]  = (teamCounts[m.inTeamId] ||0) + 1;
      }
      spend    += m.priceDiff;
      deltaSum += m.delta;
    }
    for (const c of Object.values(teamCounts)) if (c > MAX_PER_TEAM) return { bad:true };
    if (spend > bank + 1e-9) return { bad:true };
    if (deltaSum < cfg.minDeltaCombo) return { bad:true };

    const hit = Math.max(0, combo.length - ft) * 4;
    return { bad:false, delta: deltaSum, hit, net: deltaSum - hit, spend };
  }

  // small K=2,3 comb search from trimmed list
  const S = Math.min(100, singles.length);
  let best = null;

  if (K === 2) {
    for (let i=0;i<S;i++){
      for (let j=i+1;j<S;j++){
        const chk = valid([singles[i], singles[j]]);
        if (chk.bad) continue;
        const cand = { moves:[singles[i], singles[j]], delta:chk.delta, hit:chk.hit, net:chk.net };
        if (!best || cand.net > best.net) best = cand;
      }
    }
  } else if (K === 3) {
    for (let i=0;i<S;i++){
      for (let j=i+1;j<S;j++){
        for (let k=j+1;k<S;k++){
          const chk = valid([singles[i], singles[j], singles[k]]);
          if (chk.bad) continue;
          const cand = { moves:[singles[i], singles[j], singles[k]], delta:chk.delta, hit:chk.hit, net:chk.net };
          if (!best || cand.net > best.net) best = cand;
        }
      }
    }
  }

  return best ? best : mkPlanA([]);
}

function renderPlan(title, plan, nextGW, counts){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!plan || !plan.moves || !plan.moves.length) {
    lines.push("• Save FT. Projected ΔScore: +0.00");
  } else {
    plan.moves.forEach((m,i)=>{
      const inBadge  = fixtureBadge(m.inTeamId, nextGW, counts);
      const outBadge = fixtureBadge(m.outTeamId, nextGW, counts);
      lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) ${outBadge} → IN: ${esc(m.inName)} (${esc(m.inTeam)}) ${inBadge}`);
      lines.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
      lines.push(`   Prices: OUT sell ${gbp(m.outSell)} | IN list ${gbp(m.inPrice)}`);
    });
    lines.push(`Net (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)}  |  Raw Δ: +${plan.delta.toFixed(2)}  |  Hits: -${plan.hit}`);
  }
  return lines.join("\n");
}

/* ---------------- Scoring ---------------- */
function horizonScore(el, fixtures, teams, startGw, cfg){
  const minProb = chance(el); if (minProb < cfg.min) return 0;
  const ppg  = parseFloat(el.points_per_game || "0") || 0;
  const form = Math.min(parseFloat(el.form || "0") || 0, cfg.formCap);
  let total = 0;

  for (let g = startGw; g < startGw + cfg.H; g++){
    const fs = fixtures
      .filter(f => f.event === g && (f.team_h===el.team || f.team_a===el.team))
      .sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1);
    if (!fs.length) continue;
    fs.forEach((f, idx) => {
      const home = f.team_h === el.team;
      const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3)
                        : (f.team_a_difficulty ?? f.difficulty ?? 3);
      const mult = fdrMult(fdr);             // 1.30 – 0.10×FDR
      const damp = idx === 0 ? 1.0 : cfg.damp; // soften extra fixtures
      total += ppg * (minProb/100) * mult * (1 + 0.02 * form) * damp;
    });
  }
  return total;
}
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x; // easy≈1.10, hard≈0.80
}

/* ---------------- GW / fixtures helpers ---------------- */
function getCurrentGw(bootstrap){
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next);    if (nxt) return nxt.id;
  const up  = ev.find(e => !e.finished);  if (up)  return up.id;
  return ev[ev.length-1]?.id || 1;
}
function getNextGw(bootstrap){
  const ev = bootstrap?.events || [];
  const nxt = ev.find(e => e.is_next); if (nxt) return nxt.id;
  const cur = ev.find(e => e.is_current);
  if (cur) {
    const i = ev.findIndex(x => x.id === cur.id);
    return ev[i+1]?.id || cur.id;
  }
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}

function gwFixtureCounts(fixtures, gw){
  const map = {};
  for (const f of (fixtures||[])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h]||0) + 1;
    map[f.team_a] = (map[f.team_a]||0) + 1;
  }
  return map;
}
function badge(dgwCount, blankCount){
  const parts = [];
  if (dgwCount>0) parts.push(`[DGW:${dgwCount}]`);
  if (blankCount>0) parts.push(`[BLANK:${blankCount}]`);
  return parts.length ? `• ${parts.join(" ")}` : "";
}
function fixtureBadge(teamId, gw, counts){
  const c = counts?.[teamId] || 0;
  if (c > 1)  return "(DGW)";
  if (c === 0) return "(Blank)";
  return "";
}

/* ---------------- Util ---------------- */
function getBank(entry, picks){
  if (typeof picks?.entry_history?.bank === "number") return picks.entry_history.bank/10;
  if (typeof entry?.last_deadline_bank === "number")   return entry.last_deadline_bank/10;
  return 0;
}
function shortName(el){
  const first = (el?.first_name || "").trim();
  const last  = (el?.second_name || "").trim();
  const web   = (el?.web_name || "").trim();
  if (first && last) {
    const initLast = `${first[0]}. ${last}`;
    return (web && web.length <= initLast.length) ? web : initLast;
  }
  return web || last || first || "—";
}
function teamShort(teams, id){ return teams[id]?.short_name || "?"; }
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function reason(code, OUT, IN, extra={}){
  const msg = {
    same:  "same player",
    owned: "already in squad",
    limit: "team limit > 3",
    bank:  `bank shortfall ${gbp(extra.need || 0)}`,
    delta: `Δ below gate (${(extra.delta??0).toFixed(2)})`
  }[code] || "filtered";
  return { code, text: `${OUT.name} → ${IN.name}: ${msg}` };
}
function reasonLabel(code, n){
  const label = { same:"same-player", owned:"already-owned", bank:"bank shortfall", limit:"team limit", delta:"Δ below gate" }[code] || code;
  return `${label}: ${n}×`;
}

async function getJSON(url){
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}