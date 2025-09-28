// command/wildcard.js — Pro/Champion-style WC advice (simple view, clear reasons)

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";
import { playerEV, minutesProb } from "../lib/ev.js";
import { gwFixtureCounts, fixturesForTeam, getFDR, fdrMult, fixtureBadgeForTeam } from "../lib/fixtures.js";
import { annotateSquad } from "../lib/squad.js";
import { gbp, clamp } from "../lib/util.js";
import { PRO_CONF } from "../config/transfer.js"; // reuse same horizon/mins/damp philosophy

const kUser = (id) => `user:${id}:profile`;
const B = (s) => `<b>${esc(s)}</b>`;

// Basic thresholds — conservative Pro defaults
const THRESH = Object.freeze({
  RISKY_MIN: 75,  // starters under this minutes probability are considered risky
  WC_HIT_BAR: 8,  // if likely hits needed exceed this, WC becomes appealing
  RISKY_COUNT_FOR_WC: 4, // many fragile/blank starters → consider WC
  H_LOOKAHEAD: Math.max(2, PRO_CONF.H) // look-ahead windows aligned with transfer model
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

  // 3) availability: check how many wildcards already used
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
      // only nudge if not already decided
      reasons.push("Upcoming fixtures don’t suit many of your starters.");
    }
    if (recommend === "Save Wildcard" && dgwStarters.length >= 3) {
      reasons.push("You already have decent Double Gameweek coverage among starters.");
    }
  }

  // 8) header + output (simple words, no math spam)
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

  // quick next steps
  if (recommend === "Play Wildcard") {
    lines.push(`${B("Focus areas")}:\n• Replace injured/rotation risks\n• Target players with strong fixtures over the next ${THRESH.H_LOOKAHEAD} GWs\n• Balance funds across DEF/MID/FWD to avoid future hits`);
  } else if (wcAvailable) {
    lines.push(`${B("Hold tip")}:\n• Monitor injuries/suspensions\n• Watch for a big Double/Blank window\n• Use 1–2 free transfers to patch short-term issues`);
  }

  // tag the XI with DGW/Blank for clarity (compact)
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
  // Very light read: if majority of starters have tough games (FDR 4–5) next GW, mark as “bad”.
  let hard = 0, ok = 0, easy = 0;
  for (const s of starters) {
    const fs = fixturesForTeam(fixtures, startGw, s.teamId);
    if (!fs.length) continue; // blank — bad
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