// command/chip.js — Plan-aware Pro Auto chip advisor (simple output)
// - Rebuilds Plans A–D (same engine/guards as /transfer)
// - For each plan (A..D), simulates your squad after those moves
// - Scans next 6 GWs and suggests when to use TC, BB, FH, or Save/WC nudge
// - Explanations stay short; logic matches your Pro EV settings
// - Renders ALL transfers per plan (not just the first)

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

import { PRO_CONF } from "../config/transfer.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts, fixturesForTeam, getFDR, badgeLine } from "../lib/fixtures.js";
import { annotateSquad, shortName, teamShort } from "../lib/squad.js";
import { reason } from "../lib/reasons.js";
import { mkPlanA, mkPlanB, bestCombo } from "../lib/plan.js";
import { clamp } from "../lib/util.js";

/* ---------- KV key ---------- */
const kUser = (id) => `user:${id}:profile`;
const B = (s) => `<b>${esc(s)}</b>`;

/* ---------- Public entry ---------- */
export default async function chip(env, chatId) {
  // 1) Guard: linked?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `${B("Not linked")} Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) Core fetches
  const [bootstrap, fixtures, entry, hist] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`)
  ]);
  if (!bootstrap || !fixtures || !entry || !hist) {
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

  // 3) Available chips (show once in header)
  const avail = chipsAvailable(hist);
  const availStr = friendlyChips(avail);

  // 4) Index + EV preload (reused across plans)
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const evById   = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF); // { ev }
  }

  // 5) Counts & bank/FT assumption
  const countsNext = gwFixtureCounts(fixtures, nextGW);
  const bank =
    (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;
  const usedThis = (typeof picks?.entry_history?.event_transfers === "number")
    ? picks.entry_history.event_transfers : 0;
  const assumedFT = usedThis === 0 ? 2 : 1;

  // 6) Build Plans A–D (same legality as /transfer)
  const { plans } = buildPlansAD({
    bootstrap, fixtures, picks, elements, teams,
    countsNext, bank, assumedFT
  });

  // 7) For each plan, simulate the post-plan squad and recommend chips
  const H = 6; // window
  const windows = [];
  for (let g = nextGW; g < nextGW + H; g++) {
    const c = gwFixtureCounts(fixtures, g);
    windows.push({ gw: g, counts: c, dgwTeams: Object.values(c).filter(x=>x>1).length,
                   blanks: Object.keys(teams).filter(tid => (c[tid]||0)===0).length });
  }

  const head = [
    `${B("Chips available")}: ${esc(availStr)}`,
    `${B("Scan window")}: next ${H} GWs | ${esc(badgeLine(countsNext, teams))}`,
    `${B("Assumptions")}: FT next GW = ${assumedFT}, hits cost -4`
  ].join("\n");

  const blocks = [];
  for (const p of plans) {
    // Apply moves to current 15 → new rows
    const postRows = applyPlanToRows(picks.picks, p.moves || [], evById, elements, teams);
    // Find chip suggestions for this plan
    const chipRecs = suggestChipsForRows(postRows, windows, elements, fixtures, avail);

    const title = (p.key === bestKey(plans)) ? `✅ ${p.title} (best net)` : p.title;
    const lines = [];
    lines.push(`${B(title)}`);
    lines.push(`• Net after hits: ${(p.net>=0?"+":"")}${p.net.toFixed(1)} | Moves: ${p.moves.length}`);

    // FULL transfer list (every move)
    if (p.moves && p.moves.length) {
      lines.push("• Transfers:");
      p.moves.forEach((m, i) => {
        lines.push(`   ${i+1}) OUT ${esc(m.outName)} (${esc(m.outTeam)}) → IN ${esc(m.inName)} (${esc(m.inTeam)})`);
      });
    } else {
      lines.push("• Transfers: (none)");
    }

    // Chip recommendations (simple)
    if (chipRecs.tc) lines.push(`• Triple Captain: ${chipRecs.tc.when} — ${chipRecs.tc.why}`);
    if (chipRecs.bb) lines.push(`• Bench Boost: ${chipRecs.bb.when} — ${chipRecs.bb.why}`);
    if (chipRecs.fh) lines.push(`• Free Hit: ${chipRecs.fh.when} — ${chipRecs.fh.why}`);
    if (chipRecs.wc) lines.push(`• Wildcard: ${chipRecs.wc.when} — ${chipRecs.wc.why}`);
    if (!chipRecs.tc && !chipRecs.bb && !chipRecs.fh && !chipRecs.wc) {
      lines.push("• No chip needed soon — manage with normal transfers.");
    }

    blocks.push(lines.join("\n"));
  }

  const html = [head, "", ...blocks].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------------- plan building (mirrors /transfer) ---------------- */

function buildPlansAD({ bootstrap, fixtures, picks, elements, teams, countsNext, bank, assumedFT }) {
  const ownedIds = new Set(picks.picks.map(p => p.element));

  // team counts
  const teamCounts = {};
  for (const p of picks.picks) {
    const el = elements[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // EV quick map
  const nextGW = getNextGwId(bootstrap);
  const evCache = {};
  for (const el of (bootstrap.elements || [])) evCache[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF).ev;

  // out candidates (full 15)
  const outCands = picks.picks
    .map(p => {
      const el = elements[p.element];
      return {
        id: el.id, posT: el.element_type, name: shortName(el),
        teamId: el.team, team: teamShort(teams, el.team),
        isStarter: (p.position||16) <= 11,
        sell: (p?.selling_price ?? p?.purchase_price ?? el?.now_cost ?? 0)/10,
        listPrice: (el?.now_cost ?? 0)/10,
        ev: evCache[el.id] || 0
      };
    })
    .sort((a,b)=> a.ev - b.ev)
    .slice(0, 15);

  // market pools
  const poolByPos = { 1:[], 2:[], 3:[], 4:[] };
  for (const el of (bootstrap.elements || [])) {
    if (minutesProb(el) < PRO_CONF.MIN_PCT) continue;
    const posT = el.element_type;
    const ev   = evCache[el.id] || 0;
    poolByPos[posT].push({
      id: el.id, name: shortName(el), teamId: el.team, team: teamShort(teams, el.team),
      posT, price: (el.now_cost || 0)/10, ev
    });
  }
  Object.keys(poolByPos).forEach(k => {
    poolByPos[k].sort((a,b)=> b.ev - a.ev);
    poolByPos[k] = poolByPos[k].slice(0, PRO_CONF.MAX_POOL_PER_POS);
  });

  // singles
  const singles = [];
  const rejections = [];
  outer:
  for (const out of outCands) {
    const list = poolByPos[out.posT] || [];
    for (let i=0; i<list.length && singles.length<PRO_CONF.MAX_SINGLE_SCAN; i++){
      const IN = list[i];
      if (IN.id === out.id) { rejections.push(reason("same-player", out, IN)); continue; }
      if (ownedIds.has(IN.id)) { rejections.push(reason("already-owned", out, IN)); continue; }

      const priceDiff = IN.price - out.sell;
      if (priceDiff > bank + 1e-9) { rejections.push(reason("bank", out, IN, { need: priceDiff - bank })); continue; }

      const newCounts = { ...teamCounts };
      if (IN.teamId !== out.teamId) {
        newCounts[out.teamId] = (newCounts[out.teamId] || 0) - 1;
        newCounts[IN.teamId]  = (newCounts[IN.teamId]  || 0) + 1;
      }
      if (Object.values(newCounts).some(c => c > 3)) { rejections.push(reason("team-limit", out, IN)); continue; }

      const delta = IN.ev - out.ev;
      if (delta < PRO_CONF.MIN_DELTA_SINGLE) { rejections.push(reason("min-delta", out, IN, { delta })); continue; }

      singles.push({
        outId: out.id, outName: out.name, outTeamId: out.teamId, outTeam: out.team,
        inId: IN.id,   inName: IN.name,   inTeamId: IN.teamId,   inTeam: IN.team,
        posT: out.posT,
        outSell: out.sell, outList: out.listPrice, inPrice: IN.price,
        priceDiff, bankLeft: bank - priceDiff, delta
      });

      if (singles.length >= PRO_CONF.MAX_SINGLE_SCAN) break outer;
    }
  }
  singles.sort((a,b)=> b.delta - a.delta);

  // plans
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, assumedFT, PRO_CONF);
  const planC = bestCombo(singles.slice(0,150), 2, teamCounts, bank, assumedFT, PRO_CONF);
  const planD = bestCombo(singles.slice(0,180), 3, teamCounts, bank, assumedFT, PRO_CONF);

  const plans = [
    { key:"A", title:`Plan A — 0 transfers ${badgeLine(gwFixtureCounts(fixtures, nextGW), teams)}`, ...planA },
    { key:"B", title:`Plan B — 1 transfer ${badgeLine(gwFixtureCounts(fixtures, nextGW), teams)}`,  ...planB },
    { key:"C", title:`Plan C — 2 transfers ${badgeLine(gwFixtureCounts(fixtures, nextGW), teams)}`, ...planC },
    { key:"D", title:`Plan D — 3 transfers ${badgeLine(gwFixtureCounts(fixtures, nextGW), teams)}`, ...planD }
  ];

  return { plans };
}

/* ---------------- apply plan to current rows ---------------- */

function applyPlanToRows(picks, moves, evById, elements, teams){
  // Turn your current 15 into “rows” AFTER applying moves out->in
  const mapOutToIn = new Map(moves.map(m => [m.outId, m.inId]));
  const rows = [];
  for (const p of picks) {
    const origElId = p.element;
    const newId = mapOutToIn.get(origElId) || origElId;
    const el = elements[newId];
    if (!el) continue;
    rows.push({
      id: el.id,
      name: shortName(el),
      teamId: el.team,
      team: teamShort(teams, el.team),
      posT: el.element_type,
      isStarter: (p.position||16) <= 11,
      ev: evById[el.id]?.ev || 0
    });
  }
  return rows;
}

/* ---------------- plan-aware chip suggestions (simple words) ---------------- */

function suggestChipsForRows(rows, windows, elements, fixtures, avail){
  const out = {};

  // TC: earliest window with standout captain (prefer DGW)
  if (avail.tc) {
    const pick = pickTripleCaptainWindow(rows, windows);
    if (pick) out.tc = { when: `GW ${pick.gw}`, why: pick.dgw ? "your best captain has a DGW" : "favourable matchup for your best captain" };
  }

  // BB: good bench week (decent EV + minutes) and/or many doubles
  if (avail.bb) {
    const pick = pickBenchBoostWindow(rows, windows);
    if (pick) out.bb = { when: `GW ${pick.gw}`, why: pick.dgwTeams >= 4 ? "many doubles across teams" : "bench looks playable" };
  }

  // FH: big blank where you’d field < 9
  if (avail.fh) {
    const pick = pickFreeHitWindow(rows, windows);
    if (pick) out.fh = { when: `GW ${pick.gw}`, why: `large blank (~${pick.expectedStarters} starters without hits)` };
  }

  // WC: nudge only if many risks soon
  if (avail.wc > 0) {
    const pick = pickWildcardWindow(rows, windows);
    if (pick) out.wc = { when: `Before GW ${pick.beforeGw}`, why: "too many weak spots or bad fixture run ahead" };
  }

  return out;
}

/* ---------------- Chip logic (fast & simple) ---------------- */

function pickTripleCaptainWindow(rows, windows){
  const xi = pickXI(rows);
  if (!xi) return null;
  const starters = [...xi.gk, ...xi.def, ...xi.mid, ...xi.fwd];

  function capScore(r, counts){
    const dgw = (counts?.[r.teamId] || 0) > 1 ? 0.10 : 0.0;
    const posBias = (r.posT === 3 || r.posT === 4) ? 0.02 : 0.00;
    return (r.ev || 0) * (1 + dgw + posBias);
  }

  for (const w of windows) {
    const ordered = starters.slice().sort((a,b)=> capScore(b, w.counts) - capScore(a, w.counts));
    const top = ordered[0];
    if (!top) continue;
    const isDGW = (w.counts?.[top.teamId] || 0) > 1;
    const strong = (top.ev || 0) >= 5.0;
    if (isDGW || strong) return { gw: w.gw, dgw: isDGW };
  }
  return null;
}

function pickBenchBoostWindow(rows, windows){
  const xi = pickXI(rows); if (!xi) return null;
  const bench = benchRows(rows, xi);
  const benchLikely = bench.length >= 3;
  const benchSumEV  = bench.reduce((s,r)=> s + (r.ev || 0), 0);

  for (const w of windows) {
    const benchDGW = bench.filter(b => (w.counts?.[b.teamId] || 0) > 1).length;
    const ok = (benchLikely && benchSumEV >= 6.0) || (benchDGW >= 2) || (w.dgwTeams >= 4);
    if (ok) return { gw: w.gw, dgwTeams: w.dgwTeams };
  }
  return null;
}

function pickFreeHitWindow(rows, windows){
  for (const w of windows) {
    if (w.blanks <= 0) continue;
    const playable = rows.filter(r => (w.counts?.[r.teamId] || 0) > 0)
                         .sort((a,b)=> b.ev - a.ev);
    const expectedStarters = Math.min(11, playable.length);
    if (expectedStarters < 9) return { gw: w.gw, expectedStarters };
  }
  return null;
}

function pickWildcardWindow(rows, windows){
  const gk  = rows.filter(r => r.posT === 1).sort((a,b)=> b.ev - a.ev);
  const of  = rows.filter(r => r.posT !== 1).sort((a,b)=> a.ev - b.ev);
  const weak = of.slice(0,4).filter(r => (r.ev||0) < 2.0).length + (gk[1] && (gk[1].ev||0) < 2.0 ? 1 : 0);
  const nearBlankWave = windows.find(w => w.blanks >= 6);
  if (weak >= 3) return { beforeGw: windows[0].gw };
  if (nearBlankWave) return { beforeGw: nearBlankWave.gw };
  return null;
}

/* ---------------- XI helpers ---------------- */

function pickXI(rows){
  const gk  = rows.filter(r => r.posT === 1).sort((a,b)=> b.ev - a.ev);
  const def = rows.filter(r => r.posT === 2).sort((a,b)=> b.ev - a.ev);
  const mid = rows.filter(r => r.posT === 3).sort((a,b)=> b.ev - a.ev);
  const fwd = rows.filter(r => r.posT === 4).sort((a,b)=> b.ev - a.ev);
  if (!gk.length) return null;
  const forms = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[5,3,2],[5,4,1]];
  let best = null;
  for (const [D,M,F] of forms){
    if (def.length < D || mid.length < M || fwd.length < F) continue;
    const cand = { gk:[gk[0]], def:def.slice(0,D), mid:mid.slice(0,M), fwd:fwd.slice(0,F) };
    const sum = sumEV(cand.gk)+sumEV(cand.def)+sumEV(cand.mid)+sumEV(cand.fwd);
    if (!best || sum > best.sum) best = { ...cand, sum };
  }
  return best;
}

function benchRows(rows, xi){
  const used = new Set([...xi.gk, ...xi.def, ...xi.mid, ...xi.fwd].map(r=>r.id));
  const gk = rows.filter(r => r.posT === 1 && !used.has(r.id)).sort((a,b)=> b.ev - a.ev);
  const of = rows.filter(r => r.posT !== 1 && !used.has(r.id)).sort((a,b)=> b.ev - a.ev);
  const b = [];
  if (gk[0]) b.push(gk[0]);
  b.push(...of.slice(0,3));
  return b;
}

function sumEV(list){ return list.reduce((s,r)=> s + (r.ev||0), 0); }

/* ---------------- available chips helpers ---------------- */

function chipsAvailable(hist){
  const names = (hist?.chips || []).map(c => String(c?.name || c?.chip_name || "").toLowerCase());
  const count = (key) => names.filter(x => x === key).length;

  const wcUsed = count("wildcard");
  const fhUsed = count("freehit");
  const bbUsed = count("bboost");
  const tcUsed = count("3xc");

  return {
    wc: clamp(2 - wcUsed, 0, 2),
    fh: fhUsed ? 0 : 1,
    bb: bbUsed ? 0 : 1,
    tc: tcUsed ? 0 : 1
  };
}

function friendlyChips(av){
  const tags = [];
  if (av.wc > 0) tags.push(`WC×${av.wc}`);
  if (av.fh)     tags.push("FH");
  if (av.bb)     tags.push("BB");
  if (av.tc)     tags.push("TC");
  return tags.length ? tags.join(" • ") : "None";
}

/* ---------------- small utils ---------------- */

function bestKey(plans){
  return [...plans].sort((a,b)=> (b.net - a.net))[0]?.key || "A";
}

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
  } catch { return null; }
}
