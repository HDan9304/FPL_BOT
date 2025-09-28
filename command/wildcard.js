// command/wildcard.js — Pro/Champion-style WC advice + draft (simple view, clear reasons)

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts, fixturesForTeam, getFDR, fdrMult, fixtureBadgeForTeam } from "../lib/fixtures.js";
import { annotateSquad, shortName, teamShort } from "../lib/squad.js";
import { gbp, clamp } from "../lib/util.js";
import { PRO_CONF } from "../config/transfer.js"; // reuse same horizon/mins/damp philosophy

const kUser = (id) => `user:${id}:profile`;
const B = (s) => `<b>${esc(s)}</b>`;

// Basic thresholds — conservative Pro defaults
const THRESH = Object.freeze({
  RISKY_MIN: 75,            // starters under this minutes probability are considered risky
  WC_HIT_BAR: 8,            // if likely hits needed exceed this, WC becomes appealing
  RISKY_COUNT_FOR_WC: 4,    // many fragile/blank starters → consider WC
  H_LOOKAHEAD: Math.max(2, PRO_CONF.H) // keep aligned with transfer model
});

export default async function wildcard(env, chatId) {
  // 1) linked?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `<b>${esc("Not linked")}</b> Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`, "HTML");
    return;
  }

  // 2) fetch core
  const [bootstrap, fixtures, entry, history] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getJSON("https://fantasy.premierleague.com/api/fixtures/"),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`),
    getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`)
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

  // 3) availability: how many wildcards already used
  const wcUsed = countWildcardChips(history);
  const wcAvailable = wcUsed < 2; // simple: 2 per season
  const countsNext = gwFixtureCounts(fixtures, nextGW);

  // 4) EV & squad annotation (use same EV engine to keep alignment)
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const evById = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF);
  }
  const squad = annotateSquad(picks.picks, elements, teams, evById);

  // 5) quick diagnostics (simple & human)
  const starters = squad.filter(r => r.isStarter);
  const bench    = squad.filter(r => !r.isStarter);

  const riskyStarters = starters.filter(r => minutesProb(elements[r.id]) < THRESH.RISKY_MIN);
  const blankStarters = starters.filter(r => (countsNext?.[r.teamId] || 0) === 0);
  const dgwStarters   = starters.filter(r => (countsNext?.[r.teamId] || 0) > 1);

  // hits estimate: how many “must-fix” issues minus FT next GW (assume 1 FT if you used one this GW, else 2)
  const usedThis = (typeof picks?.entry_history?.event_transfers === "number")
    ? picks.entry_history.event_transfers : 0;
  const assumedFT = usedThis === 0 ? 2 : 1;

  const mustFix = uniqueIds([...riskyStarters, ...blankStarters]).length;
  const likelyHits = Math.max(0, mustFix - assumedFT) * 4; // rough & conservative

  // 6) simple “fixture swing” read — how friendly are next fixtures for your XI vs market?
  const swingNote = quickSwingNote(starters, fixtures, nextGW);

  // 7) decision logic (simple, conservative)
  let recommend = "Save Wildcard";
  const reasons = [];

  if (!wcAvailable) {
    recommend = "Wildcard not available";
    reasons.push("You have already used both Wildcards this season.");
  } else {
    if (mustFix >= THRESH.RISKY_COUNT_FOR_WC) {
      recommend = "Play Wildcard";
      reasons.push("Several of your starters are risks or have a blank next week.");
    }
    if (likelyHits >= THRESH.WC_HIT_BAR) {
      recommend = "Play Wildcard";
      reasons.push("You’d likely need multiple hits to fix the team without a Wildcard.");
    }
    if (recommend !== "Play Wildcard" && swingNote.bad) {
      reasons.push("Upcoming fixtures don’t suit many of your starters.");
    }
    if (recommend === "Save Wildcard" && dgwStarters.length >= 3) {
      reasons.push("You already have decent Double Gameweek coverage among starters.");
    }
  }

  // 8) header (simple words, no math spam)
  const head = [
    `${B("Wildcard")} — ${B("Availability")}: ${wcAvailable ? "Yes" : "No"} | ${B("GW")}: ${nextGW}`,
    `${B("Snapshot")}: ${riskyStarters.length} risky · ${blankStarters.length} blank · ${dgwStarters.length} DGW among starters`,
    `${B("FT assumed next GW")}: ${assumedFT}`
  ].join("\n");

  const lines = [];
  lines.push(`${B("Recommendation")}: ${esc(recommend)}`);
  if (reasons.length) {
    lines.push(`${B("Why")}:`);
    reasons.slice(0, 4).forEach(r => lines.push(`• ${esc(r)}`));
  }

  // 9) If recommending to PLAY WILDCARD — build a draft (legal 15 under budget)
  if (wcAvailable && recommend === "Play Wildcard") {
    // Budget: prefer entry.last_deadline_value + bank; fallback to picks sum; last resort 100.0
    const valTm = num(entry?.last_deadline_value); // in tenths
    const valBk = num(entry?.last_deadline_bank);  // in tenths
    let budget = (valTm + valBk) > 0 ? (valTm + valBk) / 10 : null;

    if ((budget == null || !isFinite(budget)) && picks?.picks?.length) {
      let sumList = 0;
      for (const p of picks.picks) {
        const el = elements[p.element]; if (!el) continue;
        sumList += (el.now_cost || 0);
      }
      const bankTenths =
        (typeof picks?.entry_history?.bank === "number") ? picks.entry_history.bank :
        (typeof entry?.last_deadline_bank === "number") ? entry.last_deadline_bank : 0;
      budget = (sumList + bankTenths) / 10;
    }
    if (budget == null || !isFinite(budget) || budget <= 70) budget = 100.0;

    // Build candidate pools with EV
    const pool = { GK:[], DEF:[], MID:[], FWD:[] };
    for (const el of (bootstrap.elements || [])) {
      const mp = minutesProb(el);
      if (mp < PRO_CONF.MIN_PCT) continue;
      const ev = playerEV(el, fixtures, nextGW, PRO_CONF)?.ev || 0;
      if (ev <= 0) continue;

      const posT  = el.element_type;              // 1=GK,2=DEF,3=MID,4=FWD
      const pos   = POS[posT] || "MID";
      const price = (el.now_cost || 0)/10;

      pool[pos].push({
        id: el.id, posT, pos,
        name: shortName(el),
        teamId: el.team,
        team: teamShort(teams, el.team),
        price, ev
      });
    }
    // Sort pools by EV
    for (const k of Object.keys(pool)) pool[k].sort((a,b)=> b.ev - a.ev);

    // Quotas & constraints
    const QUOTA = { GK:2, DEF:5, MID:5, FWD:3 };
    const MAX_PER_TEAM = 3;

    // Greedy draft under budget with ≤3/team
    const teamCounts = {};
    let chosen = { GK:[], DEF:[], MID:[], FWD:[] };
    let spend  = 0;

    pickGreedy(pool.GK, QUOTA.GK, chosen.GK, teamCounts, MAX_PER_TEAM, budget, () => spend, p => { spend += p.price; });
    pickGreedy(pool.DEF, QUOTA.DEF, chosen.DEF, teamCounts, MAX_PER_TEAM, budget, () => spend, p => { spend += p.price; });
    pickGreedy(pool.MID, QUOTA.MID, chosen.MID, teamCounts, MAX_PER_TEAM, budget, () => spend, p => { spend += p.price; });
    pickGreedy(pool.FWD, QUOTA.FWD, chosen.FWD, teamCounts, MAX_PER_TEAM, budget, () => spend, p => { spend += p.price; });

    // Cheap fill if any quota missed
    cheapFill(pool, chosen, QUOTA, teamCounts, MAX_PER_TEAM, budget, () => spend, p => { spend += p.price; });

    const totalPicked = chosen.GK.length + chosen.DEF.length + chosen.MID.length + chosen.FWD.length;
    if (totalPicked < 15) {
      lines.push("");
      lines.push(B("Draft note"));
      lines.push("• Couldn’t build a full wildcard squad under budget (pool too tight). Try relaxing minutes cut.");
    } else {
      const bankLeft = Math.max(0, budget - spend);
      const xi = suggestXI(chosen);
      const benchOut = calcBench(chosen, xi);

      lines.push("");
      lines.push(`${B("Wildcard Draft")} — ${B("Budget")}: ${gbp(budget)} | ${B("Bank left")}: ${gbp(bankLeft)}`);

      lines.push(`\n${B("GK")}`);
      chosen.GK.forEach(p => lines.push(`• ${esc(p.name)} (${esc(p.team)}) — ${gbp(p.price)}`));

      lines.push(`\n${B("DEF")}`);
      chosen.DEF.forEach(p => lines.push(`• ${esc(p.name)} (${esc(p.team)}) — ${gbp(p.price)}`));

      lines.push(`\n${B("MID")}`);
      chosen.MID.forEach(p => lines.push(`• ${esc(p.name)} (${esc(p.team)}) — ${gbp(p.price)}`));

      lines.push(`\n${B("FWD")}`);
      chosen.FWD.forEach(p => lines.push(`• ${esc(p.name)} (${esc(p.team)}) — ${gbp(p.price)}`));

      lines.push(`\n${B("Suggested XI")}`);
      lines.push(`• GK: ${esc(xi.gk.name)} (${esc(xi.gk.team)})`);
      lines.push(`• DEF: ${xi.def.map(p => `${esc(p.name)} (${esc(p.team)})`).join(", ")}`);
      lines.push(`• MID: ${xi.mid.map(p => `${esc(p.name)} (${esc(p.team)})`).join(", ")}`);
      lines.push(`• FWD: ${xi.fwd.map(p => `${esc(p.name)} (${esc(p.team)})`).join(", ")}`);

      lines.push(`\n${B("Bench")}`);
      lines.push(`• 1) ${esc(benchOut[0].name)} — ${esc(benchOut[0].pos)} (${esc(benchOut[0].team)})`);
      lines.push(`• 2) ${esc(benchOut[1].name)} — ${esc(benchOut[1].pos)} (${esc(benchOut[1].team)})`);
      lines.push(`• 3) ${esc(benchOut[2].name)} — ${esc(benchOut[2].pos)} (${esc(benchOut[2].team)})`);
      lines.push(`• GK) ${esc(benchOut[3].name)} — GK (${esc(benchOut[3].team)})`);
    }
  }

  // Tag the current XI with DGW/Blank for clarity (compact)
  lines.push("");
  lines.push(B("Your XI next GW"));
  starters.forEach(s => {
    const tag = fixtureBadgeForTeam(s.teamId, countsNext);
    lines.push(`• ${esc(s.name)} (${esc(s.team)}) ${tag}`);
  });

  const html = [head, "", ...lines].join("\n");
  await send(env, chatId, html, "HTML");
}

/* ---------------- helpers ---------------- */
function countWildcardChips(history){
  // history.chips: [{ name: "wildcard", event: 8 }, ...]
  try {
    const chips = Array.isArray(history?.chips) ? history.chips : [];
    return chips.filter(c => String(c?.name || "").toLowerCase() === "wildcard").length;
  } catch { return 0; }
}

function quickSwingNote(starters, fixtures, startGw){
  // Light read: if majority of starters have tough games (FDR 4–5) next GW, mark as “bad”.
  let hard = 0, ok = 0, easy = 0;
  for (const s of starters) {
    const fs = fixturesForTeam(fixtures, startGw, s.teamId);
    if (!fs.length) { hard++; continue; } // blank → treat as hard
    const f = fs[0];
    const home = f.team_h === s.teamId;
    const fdr = getFDR(f, home);
    if (fdr >= 4) hard++; else if (fdr <= 2) easy++; else ok++;
  }
  const bad = hard >= Math.ceil(starters.length / 2); // majority hard → bad swing
  return { bad, hard, ok, easy };
}

function uniqueIds(arr){
  const set = new Set(arr.map(x => x.id));
  return Array.from(set);
}

/* ----- Draft builder helpers (same style as /transfer wild draft file) ----- */
const POS = { 1:"GK", 2:"DEF", 3:"MID", 4:"FWD" };

function pickGreedy(pool, need, outArr, teamCounts, MAX_PER_TEAM, budget, getSpend, addSpend){
  for (const p of pool) {
    if (outArr.length >= need) break;
    if (getSpend() + p.price > budget + 1e-9) continue;
    const cnt = (teamCounts[p.teamId] || 0);
    if (cnt >= MAX_PER_TEAM) continue;
    outArr.push(p);
    teamCounts[p.teamId] = cnt + 1;
    addSpend(p);
  }
}

function cheapFill(pool, chosen, QUOTA, teamCounts, MAX_PER_TEAM, budget, getSpend, addSpend){
  for (const k of ["GK","DEF","MID","FWD"]) {
    const need = QUOTA[k] - chosen[k].length;
    if (need <= 0) continue;
    const already = new Set(chosen[k].map(p => p.id));
    const cheap = pool[k].filter(p => !already.has(p.id)).slice().sort((a,b)=> a.price - b.price);
    for (const p of cheap) {
      if (chosen[k].length >= QUOTA[k]) break;
      if (getSpend() + p.price > budget + 1e-9) continue;
      const cnt = (teamCounts[p.teamId] || 0);
      if (cnt >= MAX_PER_TEAM) continue;
      chosen[k].push(p);
      teamCounts[p.teamId] = cnt + 1;
      addSpend(p);
    }
  }
}

function suggestXI(chosen){
  const gk = chosen.GK.slice().sort((a,b)=> b.ev - a.ev)[0];
  const def = chosen.DEF.slice().sort((a,b)=> b.ev - a.ev);
  const mid = chosen.MID.slice().sort((a,b)=> b.ev - a.ev);
  const fwd = chosen.FWD.slice().sort((a,b)=> b.ev - a.ev);

  const xi = { gk, def:[], mid:[], fwd:[] };
  xi.def = def.slice(0, Math.min(3, def.length));
  xi.mid = mid.slice(0, Math.min(3, mid.length));
  xi.fwd = fwd.slice(0, Math.min(1, fwd.length));

  const used = new Set([...xi.def, ...xi.mid, ...xi.fwd].map(p=>p.id));
  const rest = [...def, ...mid, ...fwd].filter(p => !used.has(p.id)).sort((a,b)=> b.ev - a.ev);

  for (const p of rest) {
    const total = xi.def.length + xi.mid.length + xi.fwd.length;
    if (total >= 10) break;
    if (p.pos === "DEF") xi.def.push(p);
    else if (p.pos === "MID") xi.mid.push(p);
    else xi.fwd.push(p);
  }

  // Ensure minimums: DEF≥3, MID≥2, FWD≥1
  while (xi.def.length < 3 && def.length > xi.def.length) xi.def.push(def[xi.def.length]);
  while (xi.mid.length < 2 && mid.length > xi.mid.length) xi.mid.push(mid[xi.mid.length]);
  while (xi.fwd.length < 1 && fwd.length > xi.fwd.length) xi.fwd.push(fwd[xi.fwd.length]);

  // Trim if >10 outfielders
  while ((xi.def.length + xi.mid.length + xi.fwd.length) > 10) {
    const groups = [["DEF",xi.def],["MID",xi.mid],["FWD",xi.fwd]].sort((a,b)=> b[1].length - a[1].length);
    groups[0][1].pop();
  }
  return xi;
}

function calcBench(chosen, xi){
  const usedIds = new Set([xi.gk.id, ...xi.def.map(p=>p.id), ...xi.mid.map(p=>p.id), ...xi.fwd.map(p=>p.id)]);
  const outfield = [...chosen.DEF, ...chosen.MID, ...chosen.FWD].filter(p => !usedIds.has(p.id)).sort((a,b)=> b.ev - a.ev);

  const b1 = outfield[0] || fallbackAny(chosen, usedIds);
  const b2 = outfield[1] || fallbackAny(chosen, usedIds, b1?.id);
  const b3 = outfield[2] || fallbackAny(chosen, usedIds, b1?.id, b2?.id);
  const gk = chosen.GK.find(p => p.id !== xi.gk.id) || chosen.GK[0];

  return [
    { ...b1, pos: b1?.pos || "—" },
    { ...b2, pos: b2?.pos || "—" },
    { ...b3, pos: b3?.pos || "—" },
    gk || { name:"—", team:"—" }
  ].filter(Boolean);
}

function fallbackAny(chosen, usedIds, a=null, b=null){
  const all = [...chosen.DEF, ...chosen.MID, ...chosen.FWD]
    .filter(p => !usedIds.has(p.id) && p.id !== a && p.id !== b)
    .sort((x,y)=> y.ev - x.ev);
  return all[0];
}

/* ---------------- tiny utils ---------------- */
function num(x){ const n = Number(x); return Number.isFinite(n) ? n : 0; }

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
