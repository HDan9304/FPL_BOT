// command/chip.js — Pro Auto (simplified) chip advisor
// Output: shows chips still available, and a clear recommendation (when & why)
// Uses: next 6 GWs scan, your actual 15-man squad, DGW/Blank detection

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

import { PRO_CONF } from "../config/transfer.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts, fixturesForTeam, badgeLine } from "../lib/fixtures.js";
import { annotateSquad } from "../lib/squad.js";
import { clamp } from "../lib/util.js";

/* ---------- KV key ---------- */
const kUser = (id) => `user:${id}:profile`;

/* ---------- Public entry ---------- */
export default async function chip(env, chatId) {
  // 1) Guard: linked?
  const userRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = userRaw ? (JSON.parse(userRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId, `<b>${esc("Not linked")}</b> Use <code>/link &lt;TeamID&gt;</code> first.\nExample: <code>/link 1234567</code>`, "HTML");
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

  // 3) Available chips
  const avail = chipsAvailable(hist);
  const availStr = friendlyChips(avail);

  // 4) Index + EV preload for squad
  const elements = Object.fromEntries((bootstrap.elements || []).map(e => [e.id, e]));
  const teams    = Object.fromEntries((bootstrap.teams    || []).map(t => [t.id, t]));
  const evById   = {};
  for (const el of (bootstrap.elements || [])) {
    evById[el.id] = playerEV(el, fixtures, nextGW, PRO_CONF); // same EV model used by /transfer
  }
  const rows = annotateSquad(picks.picks, elements, teams, evById);

  // 5) Scan next 6 GWs for DGW/Blank context
  const H = 6;
  const windows = [];
  for (let g = nextGW; g < nextGW + H; g++) {
    const counts = gwFixtureCounts(fixtures, g);
    const dgwTeams   = Object.keys(counts).filter(tid => (counts[tid] || 0) > 1).length;
    const blanks     = Object.keys(teams).filter(tid => (counts[tid] || 0) === 0).length;
    const myDGW      = countMyForGW(rows, counts, c => c > 1);
    const myBlanks   = countMyForGW(rows, counts, c => c === 0);
    windows.push({ gw: g, counts, dgwTeams, blanks, myDGW, myBlanks });
  }

  // 6) Quick heuristics (Pro mindset, simple output)
  //    - Triple Captain: look for earliest GW with DGW & a strong captain in your XI pool
  //    - Bench Boost: use when bench is strong AND many DGWs (or very healthy bench)
  //    - Free Hit: use on a big Blank GW where you’d field < 9 without hits
  //    - Wildcard: when squad needs a reshape before a rough patch (many blanks/injuries)
  const head = [
    `<b>${esc("Chips available")}:</b> ${esc(availStr)}`,
    `<b>${esc("Scan")}:</b> next ${H} GWs | ${esc(badgeLine(gwFixtureCounts(fixtures, nextGW), teams))}`
  ].join("\n");

  // Recommendations
  const recs = [];

  // Triple Captain (3xc)
  if (avail.tc) {
    const tcPick = pickTripleCaptainWindow(rows, windows, elements, fixtures);
    if (tcPick) {
      recs.push(section(
        "Triple Captain",
        `Use in GW ${tcPick.gw}.`,
        brief(`Reason: your top captain has a good chance to play and ${tcPick.dgw ? "it’s a Double Gameweek." : "the matchup is very favorable."}`)
      ));
    } else {
      recs.push(section(
        "Triple Captain",
        "Hold for a better week.",
        brief("Reason: no standout captaincy week in the next few GWs.")
      ));
    }
  }

  // Bench Boost (bboost)
  if (avail.bb) {
    const bbPick = pickBenchBoostWindow(rows, windows, elements, fixtures);
    if (bbPick) {
      recs.push(section(
        "Bench Boost",
        `Use in GW ${bbPick.gw}.`,
        brief(`Reason: all 15 look playable and ${bbPick.dgwTeams >= 4 ? "there are plenty of doubles." : "your bench is strong and likely to score."}`)
      ));
    } else {
      recs.push(section(
        "Bench Boost",
        "Hold for now.",
        brief("Reason: bench isn’t strong enough or few doubles.")
      ));
    }
  }

  // Free Hit (freehit)
  if (avail.fh) {
    const fhPick = pickFreeHitWindow(rows, windows);
    if (fhPick) {
      recs.push(section(
        "Free Hit",
        `Consider in GW ${fhPick.gw}.`,
        brief(`Reason: large blank. You likely field ~${fhPick.expectedStarters} without hits.`)
      ));
    } else {
      recs.push(section(
        "Free Hit",
        "No need soon.",
        brief("Reason: you should manage blanks with normal transfers.")
      ));
    }
  }

  // Wildcard (wildcard)
  if (avail.wc > 0) {
    const wcPick = pickWildcardWindow(rows, windows, elements);
    if (wcPick) {
      recs.push(section(
        `Wildcard (${avail.wc} left)`,
        `Consider before GW ${wcPick.beforeGw}.`,
        brief("Reason: too many weak spots or bad fixture run — a reset improves structure.")
      ));
    } else {
      recs.push(section(
        `Wildcard (${avail.wc} left)`,
        "Hold for now.",
        brief("Reason: team is broadly fine; transfers should be enough.")
      ));
    }
  }

  // If nothing to say (edge)
  if (!recs.length) {
    recs.push(section(
      "Chips",
      "No chip needed soon.",
      brief("Reason: your squad covers the next few weeks well.")
    ));
  }

  const html = [head, "", ...recs].join("\n\n");
  await send(env, chatId, html, "HTML");
}

/* ---------------------- Chip logic helpers (simple & clear) ---------------------- */

function chipsAvailable(hist){
  const used = (hist?.chips || []).map(c => String(c?.name || c?.chip_name || "").toLowerCase());
  // Normalize names we expect: "3xc", "bboost", "freehit", "wildcard"
  const count = (key) => used.filter(x => x === key).length;

  const wcUsed = count("wildcard");     // FPL has 2 per season (window-locked), we don’t model halves here
  const fhUsed = count("freehit");
  const bbUsed = count("bboost");
  const tcUsed = count("3xc");

  return {
    wc: clamp(2 - wcUsed, 0, 2),  // remaining (0..2)
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

// Count how many of your 15 belong to teams matching predicate over counts map
function countMyForGW(rows, counts, pred){
  let n = 0;
  for (const r of (rows || [])) {
    const c = counts?.[r.teamId] || 0;
    if (pred(c)) n++;
  }
  return n;
}

// TRIPLE CAPTAIN: pick earliest GW (in next 6) where:
// - there is at least one strong captain candidate among your starters
// - prefer DGW weeks
function pickTripleCaptainWindow(rows, windows, elements, fixtures){
  const starters = pickStartersByEV(rows);
  if (starters.length === 0) return null;

  // Rank captain candidates by simple EV + DGW bump
  function capScore(r, counts){
    const dgw = (counts?.[r.teamId] || 0) > 1 ? 0.10 : 0.0;
    const posBias = (r.posT === 3 || r.posT === 4) ? 0.02 : 0.00;
    return (r.ev || 0) * (1 + dgw + posBias);
  }

  let best = null;
  for (const w of windows) {
    const ordered = starters.slice().sort((a,b)=> capScore(b, w.counts) - capScore(a, w.counts));
    const top = ordered[0];
    if (!top) continue;

    // simple thresholds: prefer DGW; otherwise strong single
    const isDGW = (w.counts?.[top.teamId] || 0) > 1;
    const strong = (top.ev || 0) >= 5.0; // coarse: strong enough baseline

    if (isDGW || strong) {
      const cand = { gw: w.gw, dgw: isDGW, topId: top.id };
      if (!best || isDGW) { best = cand; if (isDGW) break; }
    }
  }
  return best;
}

// BENCH BOOST: pick a GW where bench is playable and ideally DGW-rich
function pickBenchBoostWindow(rows, windows, elements, fixtures){
  // Build an XI, the rest is bench. If bench pieces have decent EV and minutes, it’s a go.
  const xi = pickXI(rows);
  if (!xi) return null;
  const bench = benchRows(rows, xi);

  // Bench quality signals
  const benchLikely = bench.filter(b => minutesOK(b)).length >= 3;
  const benchSumEV  = bench.reduce((s,r)=> s + (r.ev || 0), 0);

  let best = null;
  for (const w of windows) {
    const dgwTeams = w.dgwTeams;
    const benchDGW = bench.filter(b => (w.counts?.[b.teamId] || 0) > 1).length;
    const ok = (benchLikely && benchSumEV >= 6.0) || (benchDGW >= 2) || (dgwTeams >= 4);
    if (ok) {
      const cand = { gw: w.gw, dgwTeams };
      best = cand; break; // earliest acceptable
    }
  }
  return best;
}

// FREE HIT: use on big blank when you’d otherwise field < 9
function pickFreeHitWindow(rows, windows){
  for (const w of windows) {
    if (w.blanks <= 0) continue;
    // estimate how many starters you can field (GK + 10 outfield) whose team isn’t blank
    const playable = rows.filter(r => (w.counts?.[r.teamId] || 0) > 0 && minutesOK(r))
                         .sort((a,b)=> b.ev - a.ev);
    const expectedStarters = Math.min(11, playable.length);
    if (expectedStarters < 9) {
      return { gw: w.gw, expectedStarters };
    }
  }
  return null;
}

// WILDCARD: team needs reshape: many risky starters or upcoming blank exposure
function pickWildcardWindow(rows, windows, elements){
  const risky = rows.filter(r => minutesOK(r) === false).length;
  const nextBlanks = windows[0]?.myBlanks || 0;
  if (risky >= 3 || nextBlanks >= 4) {
    return { beforeGw: windows[0].gw };
  }
  // Look ahead: if any window has myBlanks >= 5, suggest WC before it
  for (const w of windows.slice(1)) {
    if (w.myBlanks >= 5) return { beforeGw: w.gw };
  }
  return null;
}

/* ---------------------- XI / helpers (simple) ---------------------- */

function pickStartersByEV(rows){
  // choose best XI by EV with valid formation (fast heuristic 3-4-3 / 3-5-2 / 4-4-2 fallback)
  const xi = pickXI(rows);
  if (!xi) return [];
  return [...xi.gk, ...xi.def, ...xi.mid, ...xi.fwd];
}

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

function minutesOK(r){
  const v = r?.mp ?? r?.minProb ?? r?.minutesProb;
  if (typeof v === "number") return v >= PRO_CONF.MIN_PCT;
  return true; // rows from annotateSquad don’t carry mp; rely on EV filter done earlier
}

/* ---------------------- tiny rendering helpers ---------------------- */
function section(title, line1, line2){
  return `<b>${esc(title)}:</b>\n• ${esc(line1)}\n• ${esc(line2)}`;
}
function brief(s){ return s; }
function sumEV(list){ return list.reduce((s,r)=> s + (r.ev||0), 0); }

/* ---------------------- boilerplate utils ---------------------- */
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