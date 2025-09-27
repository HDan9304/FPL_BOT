// command/transfer.js — Pro-grade EV planner (Plans A–D, full-squad aware)
// Dependencies: utils/telegram.js (send), utils/fmt.js (esc)

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

/* -------------------- Config (Pro default) -------------------- */
// You can tune these if you like. They’re conservative “Pro” defaults.
const PRO_CONF = Object.freeze({
  H: 2,            // horizon in GWs to look ahead (next GW and the one after)
  MIN_PCT: 80,     // minutes probability cut-off
  DGW_DAMP: 0.94,  // decay for 2nd+ fixture in a DGW
  HOME_BUMP: 1.05, // home multiplier
  AWAY_BUMP: 0.95, // away multiplier
  HIT_OK: 5,       // only take hits if net ≥ this
  MIN_DELTA_SINGLE: 0.5, // ignore micro “upgrades” for singles
  MIN_DELTA_COMBO: 1.5,  // require at least this raw Δ before hits for 2–3 moves
  MAX_POOL_PER_POS: 500, // cap pool size per position
  MAX_SINGLE_SCAN: 600   // how many valid singles to scan at most
});

/* -------------------- KV keys -------------------- */
const kUser = (id) => `user:${id}:profile`;

/* -------------------- Public entry -------------------- */
export default async function transfer(env, chatId, arg = "") {
  // 1) Guard: linked team?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `<b>${esc("Not linked")}</b> Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) Fetch core FPL data
  const [bootstrap, fixtures, entry] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`)
  ]);
  if (!bootstrap || !fixtures || !entry) {
    await send(env, chatId, "Couldn't fetch FPL data. Try again shortly.");
    return;
  }

  const curGW  = getCurrentGw(bootstrap);
  const nextGW = getNextGwId(bootstrap);
  const picks  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picks || !Array.isArray(picks.picks)) {
    await send(env, chatId, "Couldn't fetch your picks (team private or endpoint down).");
    return;
  }

  // 3) Bank & FT assumption
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const usedThis = (typeof picks?.entry_history?.event_transfers === "number")
    ? picks.entry_history.event_transfers : 0;
  const assumedFT = usedThis === 0 ? 2 : 1; // conservative: if you didn’t use one, we assume 2 next

  // 4) Index helpers
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const ownedIds = new Set(picks.picks.map(p => p.element));

  // 5) EV model inputs (counts for DGW/Blank in next GW)
  const countsNext = gwFixtureCounts(fixtures, nextGW);

  // 6) Pre-compute EV over horizon for *all* elements
  const evById = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF, teams);
  }

  // 7) Build OUT candidates from your full 15 (XI + bench)
  //    We include bench; weaker EV naturally appears at the top.
  const squad = annotateSquad(picks.picks, elements, teams, evById);
  const outCands = squad
    .map(r => ({
      id: r.id,
      posT: r.posT,
      name: r.name,
      teamId: r.teamId,
      team: r.team,
      isStarter: r.isStarter,
      sell: r.sell,
      listPrice: r.listPrice,
      ev: r.ev
    }))
    .sort((a,b) => a.ev - b.ev) // lowest EV first (candidates to remove)
    .slice(0, 15);

  // 8) Build market pools by position (apply minutes cut)
  const poolByPos = { 1:[], 2:[], 3:[], 4:[] };
  for (const el of (bootstrap.elements || [])) {
    const mp = minutesProb(el);
    if (mp < PRO_CONF.MIN_PCT) continue;
    const posT = el.element_type;
    const ev   = evById[el.id]?.ev || 0;
    poolByPos[posT].push({
      id: el.id,
      name: shortName(el),
      teamId: el.team,
      team: teamShort(teams, el.team),
      posT,
      price: (el.now_cost || 0) / 10,
      ev
    });
  }
  for (const k of Object.keys(poolByPos)) {
    poolByPos[k].sort((a,b) => b.ev - a.ev);
    poolByPos[k] = poolByPos[k].slice(0, PRO_CONF.MAX_POOL_PER_POS);
  }

  // 9) Team counts for per-team ≤3 constraint
  const teamCounts = {};
  for (const p of picks.picks) {
    const el = elements[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // 10) Generate valid singles with legality checks + noise guard
  const singles = [];
  const rejections = [];
  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT] || [];
    for (let i = 0; i < list.length && singles.length < PRO_CONF.MAX_SINGLE_SCAN; i++) {
      const IN = list[i];

      // reject if same or already owned
      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      // bank check: pay IN list using OUT sell
      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank + 1e-9) {
        rejections.push(reason("bank", out, IN, { need: priceDiff - bank }));
        continue;
      }

      // per-team ≤3 after swap
      const newCounts = { ...teamCounts };
      if (IN.teamId !== out.teamId) {
        newCounts[out.teamId] = (newCounts[out.teamId] || 0) - 1;
        newCounts[IN.teamId]  = (newCounts[IN.teamId]  || 0) + 1;
      }
      if (Object.values(newCounts).some(c => c > 3)) {
        rejections.push(reason("team-limit", out, IN));
        continue;
      }

      // EV delta and noise guard
      const delta = (IN.ev - out.ev);
      if (delta < PRO_CONF.MIN_DELTA_SINGLE) {
        rejections.push(reason("min-delta", out, IN, { delta }));
        continue;
      }

      singles.push({
        outId: out.id, outName: out.name, outTeamId: out.teamId, outTeam: out.team,
        inId:  IN.id,  inName:  IN.name,  inTeamId:  IN.teamId,  inTeam:  IN.team,
        posT: out.posT,
        outSell: out.sell,
        outList: out.listPrice,
        inPrice: IN.price,
        priceDiff,
        bankLeft: bank - priceDiff,
        delta
      });

      if (singles.length >= PRO_CONF.MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=> b.delta - a.delta);

  // 11) Plans A–D
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, assumedFT, PRO_CONF);
  const planC = bestCombo(singles.slice(0, 150), 2, teamCounts, bank, assumedFT, PRO_CONF);
  const planD = bestCombo(singles.slice(0, 180), 3, teamCounts, bank, assumedFT, PRO_CONF);

  const plans = [
    { key:"A", title:`Plan A — 0 transfers ${badgeLine(countsNext, teams)}`, ...planA },
    { key:"B", title:`Plan B — 1 transfer ${badgeLine(countsNext, teams)}`,  ...planB },
    { key:"C", title:`Plan C — 2 transfers ${badgeLine(countsNext, teams)}`, ...planC },
    { key:"D", title:`Plan D — 3 transfers ${badgeLine(countsNext, teams)}`, ...planD }
  ];

  // 12) Recommendation: only exceed 1 move if net ≥ HIT_OK
  const pickable = plans.map(p => ({...p}))
    .filter(p => (p.moves.length <= 1) || (p.net >= PRO_CONF.HIT_OK));
  const best = (pickable.length ? pickable : plans).slice().sort((a,b)=> b.net - a.net)[0];
  const recommend = best ? best.key : "A";

  // 13) Header + blocks
  const head = [
    `<b>${esc("Team")}:</b> ${esc(entry?.name || "—")} | <b>${esc("GW")}:</b> ${nextGW} — Transfer Plan (Next)`,
    `<b>${esc("Bank")}:</b> ${esc(gbp(bank))} | <b>${esc("FT (assumed)")}:</b> ${assumedFT} | <b>${esc("Hits")}:</b> -4 each`,
    `<b>${esc("Model")}:</b> Pro • H=${PRO_CONF.H} • min=${PRO_CONF.MIN_PCT}% • damp=${PRO_CONF.DGW_DAMP} • hitOK≥${PRO_CONF.HIT_OK}`
  ].join("\n");

  const blocks = [];
  for (const p of plans) {
    const title = p.key === recommend ? `✅ ${p.title} (recommended)` : p.title;
    blocks.push(renderPlan(title, p, nextGW, countsNext));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* -------------------- Planning helpers -------------------- */
function mkPlanA(rejections) {
  const why = [];
  if (Array.isArray(rejections) && rejections.length) {
    const counts = {};
    for (const r of rejections) counts[r.code] = (counts[r.code] || 0) + 1;
    const top = Object.entries(counts).sort((a,b)=> b[1]-a[1]).slice(0,3)
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

function mkPlanB(singles, ft, CFG){
  if (!singles.length) return mkPlanA();
  const s = singles[0];
  const hit = Math.max(0, 1 - ft) * 4;
  const raw = s.delta;
  if (raw < CFG.MIN_DELTA_SINGLE) {
    return { ...mkPlanA(), why: ["Best single was below +0.5."] };
  }
  const why = [];
  if (hit > 0) why.push(`-4 applied (only ${ft} FT assumed)`);
  return { moves:[s], delta: raw, hit, net: raw - hit, why };
}

function bestCombo(singles, K, teamCounts, bank, ft, CFG){
  if (!singles.length || K < 2) return mkPlanA();

  // prune aggressively by the top EV deltas helps speed/quality
  const base = singles;

  function validCombo(ms){
    const outIds = new Set(), inIds = new Set();
    const counts = { ...teamCounts };
    let spend = 0, deltaSum = 0;

    for (const m of ms){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return { invalid:true, why:["Duplicate player in combo"] };
      outIds.add(m.outId); inIds.add(m.inId);

      if (m.inTeamId !== m.outTeamId) {
        counts[m.outTeamId] = (counts[m.outTeamId] || 0) - 1;
        counts[m.inTeamId]  = (counts[m.inTeamId]  || 0) + 1;
      }
      spend += m.priceDiff;
      deltaSum += m.delta;
    }
    if (Object.values(counts).some(c => c > 3)) return { invalid:true, why:["Team limit >3"] };
    if (spend > bank + 1e-9) return { invalid:true, why:[`Insufficient bank (need ${gbp(spend - bank)})`] };
    if (deltaSum < CFG.MIN_DELTA_COMBO) return { invalid:true, why:["Total Δ below +1.5 before hits"] };

    const hit = Math.max(0, ms.length - ft) * 4;
    return { invalid:false, delta: deltaSum, hit, net: deltaSum - hit, spend };
  }

  // Enumerate K-combinations of first S singles
  const S = Math.min(90, base.length);
  const idxs = [...Array(S).keys()];
  let best = null;

  function* kComb(k, start=0, acc=[]){
    if (k === 0) { yield acc; return; }
    for (let i=start; i<=S-k; i++) yield* kComb(k-1, i+1, [...acc, i]);
  }

  for (const ids of kComb(K)) {
    const ms = ids.map(i => base[i]);
    const chk = validCombo(ms);
    if (chk.invalid) continue;
    const cand = { moves: ms, delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend, why: [] };
    if (!best || cand.net > best.net) best = cand;
  }

  if (!best) return mkPlanA(["No affordable/legal combo found."]);
  if (best.hit > 0) best.why.push(`Includes -${best.hit} hit; net ${best.net>=0?"+":""}${best.net.toFixed(2)}`);
  return best;
}

function renderPlan(title, plan, nextGW, countsNext){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!plan || !plan.moves || !plan.moves.length) {
    lines.push("• Save FT. Projected Δ: +0.00");
  } else {
    plan.moves.forEach((m, i) => {
      const inTag  = fixtureBadgeForTeam(m.inTeamId, countsNext);
      const outTag = fixtureBadgeForTeam(m.outTeamId, countsNext);
      lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) ${outTag} → IN: ${esc(m.inName)} (${esc(m.inTeam)}) ${inTag}`);
      lines.push(`   Δ: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
      lines.push(`   Prices: OUT sell ${gbp(m.outSell)} | IN list ${gbp(m.inPrice)}`);
    });
    lines.push(`Net (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)} | Raw Δ: +${plan.delta.toFixed(2)} | Hits: -${plan.hit}`);
  }
  if (Array.isArray(plan.why) && plan.why.length){
    lines.push("Why:");
    plan.why.slice(0,6).forEach(w => lines.push(`   • ${esc(w)}`));
  }
  return lines.join("\n");
}

/* -------------------- EV model -------------------- */
function playerEV(el, fixtures, startGw, CFG, teams){
  const mp = minutesProb(el);
  if (mp < CFG.MIN_PCT) return { ev: 0 };

  const ppg = num(el.points_per_game);
  if (ppg <= 0) return { ev: 0 };

  let ev = 0;
  let endGw = startGw + Math.max(1, CFG.H) - 1;

  for (let g = startGw; g <= endGw; g++) {
    const fs = fixturesForTeam(fixtures, g, el.team);
    if (!fs.length) continue; // blank: contributes 0
    fs.forEach((f, idx) => {
      const home = f.team_h === el.team;
      const fdr  = getFDR(f, home);
      const fdrMultVal   = fdrMult(fdr);         // 2..5 → 1.10..0.80
      const haMultVal    = home ? CFG.HOME_BUMP : CFG.AWAY_BUMP;
      const dgwDampValue = idx === 0 ? 1.0 : CFG.DGW_DAMP;

      ev += ppg * (mp/100) * fdrMultVal * haMultVal * dgwDampValue;
    });
  }
  return { ev };
}

function fixturesForTeam(fixtures, gw, teamId){
  const fs = (fixtures || []).filter(f => f.event === gw && (f.team_h === teamId || f.team_a === teamId));
  // sort by kickoff for stable order -> lets DGW damp apply to 2nd game
  fs.sort((a,b)=> (a.kickoff_time || "") < (b.kickoff_time || "") ? -1 : 1);
  return fs;
}

function getFDR(f, home){
  // prefer new keys, fall back to legacy
  const key = home ? "team_h_difficulty" : "team_a_difficulty";
  const v = f?.[key];
  return Number.isFinite(v) ? v : (f?.difficulty ?? 3);
}

function fdrMult(fdr){
  const x = clamp(Number(fdr)||3, 2, 5);
  // simple, monotonic mapping (2 easy → 1.10, 5 hard → 0.80)
  return 1.30 - 0.10 * x;
}

/* -------------------- Squad annotation -------------------- */
function annotateSquad(picks, elements, teams, evById){
  // picks: [{ position:1..15, element, selling_price, purchase_price }]
  const rows = [];
  for (const p of picks || []) {
    const el = elements[p.element]; if (!el) continue;
    const pos = (p.position || 16);
    const isStarter = pos <= 11;
    const sell = (p?.selling_price ?? p?.purchase_price ?? el?.now_cost ?? 0) / 10;
    const listPrice = (el?.now_cost ?? 0)/10;

    rows.push({
      id: el.id,
      name: shortName(el),
      teamId: el.team,
      team: teamShort(teams, el.team),
      posT: el.element_type,
      isStarter,
      sell,
      listPrice,
      ev: evById[el.id]?.ev || 0
    });
  }
  return rows;
}

/* -------------------- Badges & fixtures counts -------------------- */
function gwFixtureCounts(fixtures, gw){
  const map = {};
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h] || 0) + 1;
    map[f.team_a] = (map[f.team_a] || 0) + 1;
  }
  return map;
}

function fixtureBadgeForTeam(teamId, countsNext){
  const c = countsNext?.[teamId] || 0;
  if (c > 1)  return "(DGW)";
  if (c === 0) return "(Blank)";
  return "";
}

function badgeLine(countsNext, teams){
  const dgw = Object.keys(countsNext || {}).filter(tid => (countsNext[tid] || 0) > 1).length;
  const blanks = Object.keys(teams || {}).filter(tid => (countsNext?.[tid] || 0) === 0).length;
  const bits = [];
  if (dgw > 0)   bits.push(`[DGW:${dgw}]`);
  if (blanks > 0) bits.push(`[BLANK:${blanks}]`);
  return bits.length ? `• ${bits.join(" ")}` : "";
}

/* -------------------- Rejections / explanations -------------------- */
function reason(code, OUT, IN, extra = {}){
  const msg = {
    "same-player":   "Candidate equals OUT player",
    "already-owned": "Already in your team",
    "bank":          `Insufficient bank (need ${gbp(extra.need || 0)})`,
    "team-limit":    "Would break per-team limit (max 3)",
    "min-delta":     `Upgrade below +0.5 (Δ=${fmt(extra.delta)})`,
  }[code] || "Filtered";
  return { code, text: `${OUT.name} → ${IN.name}: ${msg}` };
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

/* -------------------- Utilities -------------------- */
function minutesProb(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? clamp(v, 0, 100) : 100;
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
function teamShort(teams, id){ return teams?.[id]?.short_name || "?"; }
function num(x){ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; }
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
function fmt(x){ return Number.isFinite(x) ? x.toFixed(2) : "0.00"; }
function gbp(n){ return n == null ? "—" : `£${Number(n).toFixed(1)}`; }

function getCurrentGw(bootstrap){
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next);    if (nxt) return nxt.id;
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
  } catch {
    return null;
  }
}