// lib/fixtures.js — fixture lookups + difficulty + badges
import { clamp } from "./util.js";

// Treat a fixture as "scheduled" only if it has a kickoff_time
function isScheduled(f) {
  return Boolean(f?.kickoff_time);
}

export function gwFixtureCounts(fixtures, gw, opts = {}) {
  const scheduledOnly = !!opts.scheduledOnly;
  const map = {};
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    if (scheduledOnly && !isScheduled(f)) continue; // ignore placeholders
    map[f.team_h] = (map[f.team_h] || 0) + 1;
    map[f.team_a] = (map[f.team_a] || 0) + 1;
  }
  return map;
}

export function fixturesForTeam(fixtures, gw, teamId, opts = {}) {
  const scheduledOnly = !!opts.scheduledOnly;
  const fs = (fixtures || []).filter(
    f =>
      f.event === gw &&
      (f.team_h === teamId || f.team_a === teamId) &&
      (!scheduledOnly || isScheduled(f))
  );
  // stable order so DGW damp applies to 2nd match consistently
  fs.sort((a, b) => (a.kickoff_time || "") < (b.kickoff_time || "") ? -1 : 1);
  return fs;
}

export function getFDR(f, home) {
  const key = home ? "team_h_difficulty" : "team_a_difficulty";
  const v = f?.[key];
  return Number.isFinite(v) ? v : (f?.difficulty ?? 3);
}

export function fdrMult(fdr) {
  const x = clamp(Number(fdr) || 3, 2, 5);
  // 2 (easy) → 1.10, 5 (hard) → 0.80 — smooth, monotonic
  return 1.30 - 0.10 * x;
}

export function fixtureBadgeForTeam(teamId, countsNext) {
  const c = countsNext?.[teamId] || 0;
  if (c > 1)  return "(DGW)";
  if (c === 0) return "(Blank)";
  return "";
}

export function badgeLine(countsNext, teams) {
  const dgw = Object.keys(countsNext || {}).filter(tid => (countsNext[tid] || 0) > 1).length;
  const blanks = Object.keys(teams || {}).filter(tid => (countsNext?.[tid] || 0) === 0).length;
  const bits = [];
  if (dgw > 0)   bits.push(`[DGW:${dgw}]`);
  if (blanks > 0) bits.push(`[BLANK:${blanks}]`);
  return bits.length ? `• ${bits.join(" ")}` : "";
}
