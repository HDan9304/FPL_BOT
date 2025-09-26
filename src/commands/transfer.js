// src/commands/transfer.js
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B = (s) => `<b>${esc(s)}</b>`;
const gbp = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);
const posName = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

/**
 * /transfer — Next-GW transfer planner with 4 plans:
 * A: 0 moves (save), B: 1 move, C: best 2-move combo, D: best 3-move combo.
 * Assumptions (v1):
 * - Horizon = next GW only.
 * - Free Transfers (next) = 1, so hits = max(0, moves-1)*4.
 * - Keep formation sane by swapping same-position only.
 */
export default async function transfer(env, chatId) {
  // 0) Resolve linked team
  const pRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = pRaw ? (JSON.parse(pRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId,
      `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`,
      "HTML"
    );
    return;
  }

  // 1) Fetch data
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
  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${getCurrentGw(bootstrap)}/picks/`);
  if (!picks) {
    await send(env, chatId, "Couldn't fetch your picks (is your team private?).");
    return;
  }

  // 2) Money / roster context
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const els = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t]));
  const startersP = (picks?.picks || []).filter(p => (p.position || 16) <= 11);
  const benchP    = (picks?.picks || []).filter(p => (p.position || 16) > 11);
  const allPicks  = (picks?.picks || []);
  const ownedIds  = new Set(allPicks.map(p => p.element)); // NEW: full-squad ownership check

  const teamCounts = {}; // current team usage
  for (const p of allPicks) {
    const el = els[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // Selling price map
  const sell = {}; // elementId -> sell price (£m)
  for (const p of allPicks) {
    const el = els[p.element];
    const raw = (p.selling_price ?? p.purchase_price ?? el?.now_cost ?? 0);
    sell[p.element] = (raw / 10.0) || 0;
  }

  // 3) Evaluate next-GW projection for each element
  const byRow = {}; // elementId -> row with scoreNext
  const startersEls = startersP.map(p => els[p.element]).filter(Boolean);
  for (const el of (bootstrap?.elements || [])) {
    byRow[el.id] = rowForNextGW(el, fixtures, teams, nextGW);
  }

  // 4) Build single-move market (same-position, minutes >= 70%)
  const MIN_MINUTES = 70;
  const MAX_PER_TEAM = 3;
  const poolByPos = {1:[],2:[],3:[],4:[]};
  for (const el of (bootstrap?.elements || [])) {
    const r = byRow[el.id];
    const minPct = chance(el);
    if (minPct < MIN_MINUTES) continue;
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
  Object.values(poolByPos).forEach(arr => arr.sort((a,b)=>b.score-a.score));

  // Identify OUT candidates: worst starters next GW by score
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
    .slice(0, 11); // at most XI

  // 5) Enumerate best single moves
  const singles = [];
  for (const out of outCands) {
    const list = poolByPos[out.posT];
    for (let i=0; i<list.length && singles.length<400; i++) {
      const IN = list[i];
      if (IN.id === out.id) continue;
      if (ownedIds.has(IN.id)) continue; // NEW: skip if already owned anywhere in squad

      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank) continue; // budget

      // team cap (handle swap in same team)
      const newCountIn = (teamCounts[IN.teamId] || 0) + (IN.teamId === out.teamId ? 0 : 1);
      if (newCountIn > MAX_PER_TEAM) continue;

      const delta = IN.score - out.score;
      if (delta <= 0) continue;

      singles.push({
        outId: out.id, inId: IN.id,
        outName: out.name, inName: IN.name,
        outTeamId: out.teamId, inTeamId: IN.teamId,
        outTeam: out.team, inTeam: IN.team,
        pos: out.posT,
        outSell: out.sell, inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff,
        delta
      });
      if (singles.length >= 400) break;
    }
  }
  singles.sort((a,b)=>b.delta-a.delta);

  // 6) Build Plans
  const FT_NEXT = 1;
  const planA = { moves: [], delta: 0, hit: 0, net: 0 };

  const planB = singles[0]
    ? { moves: [singles[0]], delta: singles[0].delta, hit: Math.max(0,1-FT_NEXT)*4, net: singles[0].delta - Math.max(0,1-FT_NEXT)*4 }
    : { moves: [], delta: 0, hit: 0, net: 0 };

  const planC = bestCombo(singles.slice(0, 100), 2, allPicks, els, MAX_PER_TEAM, bank, teamCounts, FT_NEXT);
  const planD = bestCombo(singles.slice(0, 120), 3, allPicks, els, MAX_PER_TEAM, bank, teamCounts, FT_NEXT);

  // 7) Render
  const html = [
    `${B("Team")}: ${esc(entry?.name || "—")} | ${B("GW")}: ${nextGW} — Transfer Plan (Next)`,
    `${B("Bank")}: ${esc(gbp(bank))} | ${B("FT (next)")}: ${FT_NEXT} | ${B("Hit policy")}: -4 per extra move`,
    "",
    renderPlan("Plan A — 0 transfers", planA),
    "",
    renderPlan("Plan B — 1 transfer", planB),
    "",
    renderPlan("Plan C — 2 transfers", planC),
    "",
    renderPlan("Plan D — 3 transfers", planD),
    "",
    `${B("Logic")}`,
    "• Score(next GW) ≈ PPG × (minutes%) × FDR_mult; DGW summed with 0.9 damp on 2nd game.",
    "• Minutes from chance_of_playing_next_round (fallback 100%).",
    "• FDR_mult from fixture difficulty (harder → lower).",
    "• Swaps keep same position → formation stays legal; team limit ≤3; budget respected.",
    "• Net = ΔScore − 4×(moves − 1 FT).",
    "• Dedup: IN candidates already owned are skipped."
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

/* ---------------- helpers: output ---------------- */
function renderPlan(title, plan){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);
  if (!plan || !plan.moves || !plan.moves.length) {
    lines.push("• Save FT. Projected ΔScore: +0.00");
    return lines.join("\n");
  }
  plan.moves.forEach((m,i)=>{
    lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
    lines.push(`   ΔScore: +${m.delta.toFixed(2)} | Price: ${m.priceDiff>=0?"+":""}${gbp(m.priceDiff)} | Bank left: ${gbp(m.bankLeft)}`);
  });
  lines.push(`Net (after hits): ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)}  |  Raw Δ: +${plan.delta.toFixed(2)}  |  Hits: -${plan.hit}`);
  return lines.join("\n");
}

/* ---------------- helpers: combos ---------------- */
function bestCombo(singles, K, _allPicks, _els, MAX_PER_TEAM, bank, teamCounts, FT_NEXT){
  if (!singles.length || K < 2) return { moves: [], delta: 0, hit: 0, net: 0 };

  function validCombo(combo){
    const outIds = new Set(), inIds = new Set();
    const counts = { ...teamCounts };
    let spend = 0, deltaSum = 0;
    for (const m of combo){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return null;
      outIds.add(m.outId); inIds.add(m.inId);
      if (m.inTeamId !== m.outTeamId) {
        counts[m.outTeamId] = (counts[m.outTeamId]||0) - 1;
        counts[m.inTeamId]  = (counts[m.inTeamId] ||0) + 1;
      }
      spend += m.priceDiff;
      deltaSum += m.delta;
    }
    for (const c of Object.values(counts)) if (c > MAX_PER_TEAM) return null;
    if (spend > bank + 1e-9) return null;
    const hit = Math.max(0, combo.length - FT_NEXT) * 4;
    return { delta: deltaSum, hit, net: deltaSum - hit, spend };
  }

  const S = Math.min(60, singles.length);
  const base = singles.slice(0, S);

  if (K === 2) {
    let best = null;
    for (let i=0;i<S;i++){
      for (let j=i+1;j<S;j++){
        const chk = validCombo([base[i], base[j]]);
        if (!chk) continue;
        const cand = { moves:[base[i], base[j]], delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend };
        if (!best || cand.net > best.net) best = cand;
      }
    }
    return best || { moves: [], delta: 0, hit: 0, net: 0 };
  } else {
    let best = null;
    for (let i=0;i<S;i++){
      for (let j=i+1;j<S;j++){
        for (let k=j+1;k<S;k++){
          const chk = validCombo([base[i], base[j], base[k]]);
          if (!chk) continue;
          const cand = { moves:[base[i], base[j], base[k]], delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend };
          if (!best || cand.net > best.net) best = cand;
        }
      }
    }
    return best || { moves: [], delta: 0, hit: 0, net: 0 };
  }
}

/* ---------------- helpers: scoring ---------------- */
function chance(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}
function teamShort(teams, id){ return teams[id]?.short_name || "?"; }

function rowForNextGW(el, fixtures, teams, gw){
  const fs = fixtures.filter(f => f.event === gw && (f.team_h===el.team || f.team_a===el.team));
  if (!fs.length) return { score: 0 };
  const minX = chance(el)/100;
  let total = 0;
  fs.sort((a,b)=>((a.kickoff_time||"")<(b.kickoff_time||""))?-1:1).forEach((f,idx)=>{
    const home = (f.team_h === el.team);
    const fdr  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
    const mult = fdrMult(fdr);
    const ppg  = parseFloat(el.points_per_game || "0") || 0;
    const damp = idx === 0 ? 1.0 : 0.9; // mild damp for second DGW match
    total += (ppg * mult * minX) * damp;
  });
  return { score: total };
}
function fdrMult(fdr){
  const x = Math.max(2, Math.min(5, Number(fdr)||3));
  return 1.30 - 0.10 * x;
}
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

/* ---------------- helpers: GW calc + fetch ---------------- */
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