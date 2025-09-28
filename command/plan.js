// command/plan.js — Best XI & formation per plan (A–D) + C/VC + single-plan view
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

import { PRO_CONF } from "../config/transfer.js";
import { gbp } from "../lib/util.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts, badgeLine } from "../lib/fixtures.js";
import { annotateSquad, shortName, teamShort } from "../lib/squad.js";
import { mkPlanA, mkPlanB, bestCombo } from "../lib/plan.js";

/* ---------- KV key ---------- */
const kUser = (id) => `user:${id}:profile`;

export default async function plan(env, chatId, arg = "") {
  // 1) Guard: linked?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `<b>${esc("Not linked")}</b> Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) Fetch FPL core
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

  const picksResp  = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  if (!picksResp || !Array.isArray(picksResp.picks)) {
    await send(env, chatId, "Couldn't fetch your picks (team private or endpoint down).");
    return;
  }
  const picks = picksResp.picks.map(x => ({...x}));

  // 3) Bank & FT assumption
  const bank =
    (typeof picksResp?.entry_history?.bank === "number") ? picksResp.entry_history.bank/10 :
    (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank/10 : 0;

  const usedThis = (typeof picksResp?.entry_history?.event_transfers === "number")
    ? picksResp.entry_history.event_transfers : 0;
  const assumedFT = usedThis === 0 ? 2 : 1;

  // 4) Indexes
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const ownedIds = new Set(picks.map(p => p.element));

  // 5) Next GW fixture counts
  const countsNext = gwFixtureCounts(fixtures, nextGW);

  // 6) Pre-compute EV
  const evById = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF);
  }

  // 7) OUT candidates
  const squadRows = annotateSquad(picks, elements, teams, evById);
  const outCands = squadRows
    .map(r => ({
      id:r.id, posT:r.posT, name:r.name, teamId:r.teamId, team:r.team,
      isStarter:r.isStarter, sell:r.sell, listPrice:r.listPrice, ev:r.ev
    }))
    .sort((a,b) => a.ev - b.ev)
    .slice(0, 15);

  // 8) Market pool
  const poolByPos = { 1:[], 2:[], 3:[], 4:[] };
  for (const el of (bootstrap.elements || [])) {
    const mp = minutesProb(el);
    if (mp < PRO_CONF.MIN_PCT) continue;
    const posT = el.element_type;
    const ev   = evById[el.id]?.ev || 0;
    poolByPos[posT].push({
      id: el.id, name: shortName(el), teamId: el.team, team: teamShort(teams, el.team),
      posT, price: (el.now_cost || 0) / 10, ev
    });
  }
  Object.keys(poolByPos).forEach(k => {
    poolByPos[k].sort((a,b)=> b.ev - a.ev);
    poolByPos[k] = poolByPos[k].slice(0, PRO_CONF.MAX_POOL_PER_POS);
  });

  // 9) Team counts (≤3)
  const teamCounts = {};
  for (const p of picks) {
    const el = elements[p.element]; if (!el) continue;
    teamCounts[el.team] = (teamCounts[el.team] || 0) + 1;
  }

  // 10) Singles
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

  // 11) Plans
  const planA = mkPlanA(rejections);
  const planB = mkPlanB(singles, assumedFT, PRO_CONF);
  const planC = bestCombo(singles.slice(0,150), 2, teamCounts, bank, assumedFT, PRO_CONF);
  const planD = bestCombo(singles.slice(0,180), 3, teamCounts, bank, assumedFT, PRO_CONF);

  const plans = [
    { key:"A", title:`Plan A — 0 transfers ${badgeLine(countsNext, teams)}`, ...planA },
    { key:"B", title:`Plan B — 1 transfer ${badgeLine(countsNext, teams)}`,  ...planB },
    { key:"C", title:`Plan C — 2 transfers ${badgeLine(countsNext, teams)}`, ...planC },
    { key:"D", title:`Plan D — 3 transfers ${badgeLine(countsNext, teams)}`, ...planD }
  ];

  // 12) Recommendation (same rule as /transfer)
  const pickable = plans.map(p=>({...p})).filter(p => (p.moves.length <= 1) || (p.net >= PRO_CONF.HIT_OK));
  const best = (pickable.length ? pickable : plans).slice().sort((a,b)=> b.net - a.net)[0];
  const recommend = best ? best.key : "A";

  // 13) Apply moves per plan -> XI + C/VC
  const blocks = [];
  const wantOnly = String(arg || "").trim().toUpperCase(); // "", "B", "C", or "D"
  const showPlans = wantOnly && ["B","C","D"].includes(wantOnly)
    ? plans.filter(p => p.key === wantOnly)
    : plans;

  for (const p of showPlans) {
    const applied = applyMovesToPicks(picks, p.moves || []);
    const rows = annotateSquad(applied, elements, teams, evById);
    const xi = pickBestXI(rows);
    const { cId, vcId } = chooseCaptain(xi, countsNext);

    const lines = [];
    const title = p.key === recommend ? `✅ ${p.title} (recommended)` : p.title;
    lines.push(`<b>${esc(title)}</b>`);
    if (!p.moves || !p.moves.length) {
      lines.push("• Moves: (none)");
    } else {
      p.moves.forEach((m,i)=>{
        lines.push(`• ${i+1}) OUT: ${esc(m.outName)} (${esc(m.outTeam)}) → IN: ${esc(m.inName)} (${esc(m.inTeam)})`);
      });
    }
    lines.push(`Net: ${(p.net>=0?"+":"")}${p.net.toFixed(2)} | Hits: -${p.hit} | Bank left: ${gbp(calcBankLeft(bank, p.moves))}`);

    lines.push("");
    lines.push(`<b>${esc("Best XI")}:</b> ${xi.formation}`);
    lines.push(section("GK", xi.gk, cId, vcId));
    lines.push(section("DEF", xi.def, cId, vcId));
    lines.push(section("MID", xi.mid, cId, vcId));
    lines.push(section("FWD", xi.fwd, cId, vcId));

    lines.push("");
    lines.push(`<b>${esc("Bench")}:</b>`);
    if (xi.benchGK) lines.push(`• GK) ${esc(xi.benchGK.name)} (${esc(xi.benchGK.team)})`);
    xi.benchOut.forEach((r, idx)=> lines.push(`• ${idx+1}) ${esc(r.name)} (${esc(r.team)}) — ${posLabel(r.posT)}`));

    blocks.push(lines.join("\n"));
  }

  // 14) Header + quick links
  const head = [
    `<b>${esc("Team")}:</b> ${esc(entry?.name || "—")} | <b>${esc("GW")}:</b> ${nextGW} — Best XI by Plan`,
    `<b>${esc("Bank")}:</b> ${esc(gbp(bank))} | <b>${esc("FT (assumed)")}:</b> ${assumedFT} | <b>${esc("Hits")}:</b> -4 each`,
    `<b>${esc("Model")}:</b> Pro • H=${PRO_CONF.H} • min=${PRO_CONF.MIN_PCT}% • damp=${PRO_CONF.DGW_DAMP}`,
    `<b>${esc("Recommended")}:</b> ${recommend}`,
  ].join("\n");

  const links = `Try quick views → /planb • /planc • /pland`;

  const html = [head, "", ...blocks, "", links].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------------- helpers: apply moves & compute bank left ---------------- */
function applyMovesToPicks(picks, moves){
  if (!moves || !moves.length) return picks.map(x => ({...x}));
  const outSet = new Set(moves.map(m => m.outId));
  const inQueue = moves.map(m => m.inId);
  const newPicks = picks.map(x => ({...x}));

  for (let i=0;i<newPicks.length;i++){
    const id = newPicks[i].element;
    if (outSet.has(id)) {
      const nextIn = inQueue.shift();
      if (nextIn != null) newPicks[i].element = nextIn;
    }
  }
  return newPicks;
}

function calcBankLeft(startBank, moves){
  if (!moves || !moves.length) return startBank;
  let bank = startBank;
  for (const m of moves) bank -= m.priceDiff;
  return Math.max(-999, Math.round(bank*10)/10);
}

/* ---------------- helpers: XI selection ---------------- */
function pickBestXI(rows){
  const gk  = rows.filter(r => r.posT === 1).sort((a,b)=> b.ev - a.ev);
  const def = rows.filter(r => r.posT === 2).sort((a,b)=> b.ev - a.ev);
  const mid = rows.filter(r => r.posT === 3).sort((a,b)=> b.ev - a.ev);
  const fwd = rows.filter(r => r.posT === 4).sort((a,b)=> b.ev - a.ev);

  const formations = [
    [3,4,3], [3,5,2],
    [4,4,2], [4,3,3],
    [4,5,1], [5,2,3]
    [5,4,1], [5,3,2]
  ];

  let best = null;
  for (const [D,M,F] of formations){
    if (def.length < D || mid.length < M || fwd.length < F || gk.length < 1) continue;
    const cand = {
      gk: [gk[0]],
      def: def.slice(0, D),
      mid: mid.slice(0, M),
      fwd: fwd.slice(0, F)
    };
    const sum = sumEV(cand.gk) + sumEV(cand.def) + sumEV(cand.mid) + sumEV(cand.fwd);
    if (!best || sum > best.sum) best = { ...cand, sum, formation: `${D}-${M}-${F}` };
  }
  if (!best) {
    const any = rows.slice().sort((a,b)=> b.ev - a.ev);
    const gkPick = any.find(r=>r.posT===1);
    const outfield = any.filter(r=>r.posT!==1).slice(0,10);
    const defNum = Math.min(5, Math.max(3, outfield.filter(r=>r.posT===2).length));
    const midNum = Math.min(5, Math.max(2, outfield.filter(r=>r.posT===3).length));
    const fwdNum = 10 - defNum - midNum;
    return {
      formation: `${defNum}-${midNum}-${fwdNum}`,
      gk: gkPick ? [gkPick] : [],
      def: outfield.filter(r=>r.posT===2).slice(0,defNum),
      mid: outfield.filter(r=>r.posT===3).slice(0,midNum),
      fwd: outfield.filter(r=>r.posT===4).slice(0,fwdNum),
      benchGK: null,
      benchOut: []
    };
  }

  const usedIds = new Set([...best.gk, ...best.def, ...best.mid, ...best.fwd].map(r=>r.id));
  const benchGK = gk[1] || null;
  const benchOut = rows
    .filter(r => r.posT !== 1 && !usedIds.has(r.id))
    .sort((a,b)=> a.ev - b.ev)
    .slice(0,3);

  return { ...best, benchGK, benchOut };
}

/* ---------------- Captain / Vice-Captain heuristic ---------------- */
function chooseCaptain(xi, countsNext){
  const starters = [...(xi.gk||[]), ...(xi.def||[]), ...(xi.mid||[]), ...(xi.fwd||[])];

  function capScore(r){
    const dgw = (countsNext?.[r.teamId] || 0) > 1 ? 0.10 : 0.0;  // +10% for DGW team
    const posBias = (r.posT === 3 || r.posT === 4) ? 0.02 : 0.00; // tiny MID/FWD bias
    return (r.ev || 0) * (1 + dgw + posBias);
  }

  const ordered = starters.slice().sort((a,b)=> capScore(b) - capScore(a));
  const C = ordered[0] || null;
  if (!C) return { cId:null, vcId:null };

  let VC = ordered.find(x => x.id !== C.id && x.teamId !== C.teamId) || ordered.find(x => x.id !== C.id) || null;
  return { cId: C.id, vcId: VC ? VC.id : null };
}

/* ---------------- rendering helpers ---------------- */
function sumEV(list){ return list.reduce((s,r)=> s + (r.ev||0), 0); }
function posLabel(t){ return ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?"; }
function section(label, rows, cId, vcId){
  if (!rows || !rows.length) return `<b>${esc(label)}:</b>\n• —`;
  const lines = rows.map(r => {
    const tag = r.id === cId ? " (C)" : (r.id === vcId ? " (VC)" : "");
    return `• ${esc(r.name)} (${esc(r.team)})${tag}`;
  });
  return `<b>${esc(label)}:</b>\n${lines.join("\n")}`;
}

/* ---------- local utils ---------- */
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

/* ---------- reasons (inline) ---------- */
function reason(code, OUT, IN){
  const msg = {
    "same-player":   "Candidate equals OUT player",
    "already-owned": "Already in your team",
    "bank":          `Insufficient bank`,
    "team-limit":    "Would break per-team limit (max 3)",
    "min-delta":     `Upgrade below threshold`,
  }[code] || "Filtered";
  return { code, text: `${OUT.name} → ${IN.name}: ${msg}` };
}

