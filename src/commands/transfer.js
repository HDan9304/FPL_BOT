// src/commands/transfer.js — AUTO MODE via presets + DGW/Blank badges + chase/pos + list vs sell
// Usage: /transfer [chase] [pos=DEF]

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";
import { chooseAutoConfig } from "../presets.js";

const kUser   = (id) => `user:${id}:profile`;
const B       = (s) => `<b>${esc(s)}</b>`;
const gbp     = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";
const posCodeToType = (s) => ({GK:1,GKP:1,DEF:2,DEFENDER:2,MID:3,MIDF:3,MF:3,FWD:4,FW:4,FORWARD:4}[String(s||"").toUpperCase()]||null);

// Noise guards
const MIN_DELTA_SINGLE = 0.5;  // ignore micro “upgrades”
const MIN_DELTA_COMBO  = 1.5;  // total raw gain required before hits
// Scan sizes
const MAX_POOL_PER_POS = 500;
const MAX_SINGLE_SCAN  = 500;

export default async function transfer(env, chatId, arg = "") {
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

  // Parse optional args: "chase" & "pos=DEF|MID|FWD|GK"
  const opts = parseArgs(arg);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks) { await send(env, chatId, "Couldn't fetch your picks (is your team private?)."); return; }

  // ---- AUTO CONFIG via presets (keeps your Pro Auto behavior; now centralized) ----
  const cfg = chooseAutoConfig({ bootstrap, fixtures, picks, entry, mode: "pro", chase: opts.chase });

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

  // OUT candidates (weakest starters), optionally focus a position
  const outCands = startersEls
    .filter(el => !opts.posType || el.element_type === opts.posType)
    .map(el => ({
      id: el.id,
      name: playerShort(el),
      posT: el.element_type,
      teamId: el.team,
      team: teamShort(teams, el.team),
      sell: sell[el.id] || ((el.now_cost || 0)/10),
      listPrice: (el.now_cost || 0)/10,
      score: byRow[el.id]?.score ?? 0
    }))
    .sort((a,b)=>a.score-b.score)
    .slice(0, 11);

  // Market pool by position (minutes filter), optionally focus
  const MAX_PER_TEAM = 3;
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements || [])) {
    if (chance(el) < cfg.min) continue;
    if (opts.posType && el.element_type !== opts.posType) continue;
    const r = rowForHorizon(el, fixtures, teams, nextGW, cfg.h, cfg.damp, cfg.min);
    poolByPos[el.element_type].push({
      id: el.id,
      name: playerShort(el),
      team: teamShort(teams, el.team),
      teamId: el.team,
      pos: posName(el.element_type),
      price: (el.now_cost || 0) / 10,     // LIST price (what you pay)
      score: r.score
    });
  }
  Object.keys(poolByPos).forEach(k => { poolByPos[k].sort((a,b)=>b.score-a.score); poolByPos[k] = poolByPos[k].slice(0, MAX_POOL_PER_POS); });

  // Singles with EXPLANATIONS
  const singles = [];
  const rejections = [];
  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT] || [];
    for (let i=0; i<list.length && singles.length<MAX_SINGLE_SCAN; i++) {
      const IN = list[i];

      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell;     // use SELL for OUT, LIST for IN
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
        outSell: out.sell,           // SELL price for OUT
        outList: out.listPrice,      // current list for OUT (info)
        inPrice: IN.price,           // LIST price for IN
        priceDiff, bankLeft: bank - priceDiff,
        delta,
        why: ["passed: legal, bank ok, Δ≥0.5, minutes ok"]
      });
      if (singles.length >= MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // DGW/Blank detector (for the next GW)
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.keys(counts).filter(tid => counts[tid] > 1);
  const blankTeams = Object.keys(teams).filter(tid => (counts[tid] || 0) === 0);
  const badge = badgeLine(dgwTeams.length, blankTeams.length);

  // Plans A–D (with inline WHY)
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, cfg.ft);
  const planC = bestCombo(singles.slice(0, 120), 2, teamCounts, MAX_PER_TEAM, bank, cfg.ft);
  const planD = bestCombo(singles.slice(0, 160), 3, teamCounts, MAX_PER_TEAM, bank, cfg.ft);

  const plans = [
    { key:"A", title:`Plan A — 0 transfers ${badge}`, ...planA },
    { key:"B", title:`Plan B — 1 transfer ${badge}`,  ...planB },
    { key:"C", title:`Plan C — 2 transfers ${badge}`, ...planC },
    { key:"D", title:`Plan D — 3 transfers ${badge}`, ...planD }
  ];

  // choose recommendation
  const filtered = plans.map(p => ({...p})).filter(p => (p.moves.length <= 1) || (p.net >= cfg.hit));
  const best = (filtered.length ? filtered : plans).slice().sort((a,b)=> (b.net - a.net) )[0];
  const recommend = best ? best.key : "A";

  const head = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Transfer Plan (Next)`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (assumed)")}: ${cfg.ft} | ${B("Hits")}: -4 per extra move`,
    `${B("Preset")}: ${cfg.presetName}${opts.chase ? " (Chasing)" : ""} — h=${cfg.h}, min=${cfg.min}%, damp=${cfg.damp} | ${B("Hit OK if Net ≥")} ${cfg.hit}` +
    (opts.posType ? ` | ${B("Focus")}: ${posName(opts.posType)}` : "")
  ].join("\n");

  const blocks = [];
  for (const p of plans) {
    const title = p.key === recommend ? `✅ ${p.title} (recommended)` : p.title;
    blocks.push(renderPlan(title, p, teams, nextGW, counts));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------- parse args ---------- */
function parseArgs(arg){
  const a = String(arg||"").trim();
  const out = { chase:false, posType:null };
  if (!a) return out;
  const toks = a.split(/\s+/).filter(Boolean);
  for (const t of toks){
    if (/^chase$/i.test(t)) { out.chase = true; continue; }
    const m = t.match(/^pos=(.+)$/i);
    if (m) {
      const pt = posCodeToType(m[1]);
      if (pt) out.posType = pt;
      continue;
    }
  }
  return out;
}

/* ---------- planning helpers ---------- */
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
  if (best.hit>0) best.why = [...(best.why||[]), `Includes -${best.hit} hit; net ${best.net>=0?"+":""}${best.net.toFixed(2)}`];
  return best;
}

function renderPlan(title, plan, teams, nextGW, counts){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!plan || !plan.moves || !plan.moves.length) {
    lines.push("• Save FT. Projected ΔScore: +0.00");
  } else {
    plan.moves.forEach((m,i)=>{
      const inTag  = fixtureBadgeForTeam(m.inTeamId, nextGW, counts);
      const outTag = fixtureBadgeForTeam(m.outTeamId, nextGW, counts);
      lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) ${outTag} → IN: ${esc(m.inName)} (${esc(m.inTeam)}) ${inTag}`);
      lines.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
      // list vs sell price
      lines.push(`   Prices: OUT sell ${gbp(m.outSell)} | IN list ${gbp(m.inPrice)}`);
    });
    lines.push(`Net (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)}  |  Raw Δ: +${plan.delta.toFixed(2)}  |  Hits: -${plan.hit}`);
  }
  if (Array.isArray(plan.why) && plan.why.length){
    lines.push("Why:");
    plan.why.slice(0,6).forEach(w => lines.push(`   • ${esc(w)}`));
  }
  return lines.join("\n");
}

/* ---------- DGW/Blank helpers ---------- */
function gwFixtureCounts(fixtures, gw){
  const map = {};
  for (const f of (fixtures||[])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h]||0) + 1;
    map[f.team_a] = (map[f.team_a]||0) + 1;
  }
  return map;
}
function badgeLine(dgwCount, blankCount){
  const parts = [];
  if (dgwCount>0) parts.push(`[DGW:${dgwCount}]`);
  if (blankCount>0) parts.push(`[BLANK:${blankCount}]`);
  return parts.length ? `• ${parts.join(" ")}` : "";
}
function fixtureBadgeForTeam(teamId, gw, counts){
  const c = counts?.[teamId] || 0;
  if (c > 1)  return "(DGW)";
  if (c === 0) return "(Blank)";
  return "";
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