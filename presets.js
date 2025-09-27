// presets.js
// Pro FPL Manager — Auto (Adaptive) config shared by /transfer and /plan
// Exports:
//   - PRO_BASE            (reference defaults)
//   - chooseAutoConfig({ bootstrap, fixtures, picks, chase=false })
//
// Notes:
//  • Adaptive tuning looks at squad risk, FT state, and near-term DGW/Blanks
//  • /transfer & /plan call this once per request and use the returned cfg
//  • If you pass chase=true, we loosen the guardrails (more aggressive)

export const PRO_BASE = {
  h: 3,           // horizon (GWs to look ahead)
  min: 82,        // minutes / availability floor (%)
  damp: 0.94,     // slight discount for the 2nd match in a DGW
  hit: 5,         // minimum net gain required to justify paid hits
  ft: 1,          // assumed free transfers for the NEXT GW
  benchPolicy: "smart", // keep bench moves out unless needed for legality/bank
};

// Main chooser used by /transfer and /plan
export function chooseAutoConfig({ bootstrap, fixtures, picks, chase = false }) {
  const cfg = { ...PRO_BASE };

  // === 1) Free transfers assumption for next GW
  const usedThis = usedTransfersThisGw(picks);
  cfg.ft = usedThis === 0 ? 2 : 1;

  // === 2) Risk profile from your XI health → adjusts minutes floor & hit bar
  // Count starters below a soft availability threshold
  const riskyN = riskyStartersCount(picks, bootstrap, 80);
  if (riskyN >= 3) {
    cfg.min = 86;   // be pickier: avoid rotation traps
    cfg.hit = 6;    // demand more net before spending hits
  } else if (riskyN === 2) {
    cfg.min = 84;
    cfg.hit = 6;    // still conservative on hits
  } else {
    cfg.min = 82;
    cfg.hit = 5;
  }

  // === 3) Schedule look-ahead → adjust horizon
  const nextGW = getNextGwId(bootstrap);
  const dgwNow    = countDgwTeams(fixtures, nextGW);
  const dgwSoon   = countDgwTeams(fixtures, nextGW + 1);
  const blankNow  = countBlankTeams(fixtures, nextGW);
  // If a big DGW wave is now/soon → extend horizon to capture it
  if ((dgwNow + dgwSoon) >= 4) {
    cfg.h = 4;
  }
  // If an immediate blank → shorten horizon to prioritise fielding XI
  if (blankNow >= 4) {
    cfg.h = Math.min(cfg.h, 2);
  }

  // === 4) DGW damping (keep stable)
  cfg.damp = 0.94;

  // === 5) Chase override (optional via /transfer chase)
  if (chase) {
    // more aggressive: relax minutes floor and hit bar slightly
    cfg.min = Math.min(cfg.min, 75);
    cfg.hit = Math.max(4, cfg.hit - 1);
  }

  // Safety clamps
  cfg.h   = clamp(cfg.h, 2, 5);
  cfg.min = clamp(cfg.min, 70, 92);
  cfg.hit = clamp(cfg.hit, 4, 8);

  return cfg;
}

/* ----------------- helpers (local to presets) ----------------- */

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function usedTransfersThisGw(picks) {
  const n = picks?.entry_history?.event_transfers;
  return Number.isFinite(n) ? n : 0;
}

function riskyStartersCount(picks, bootstrap, cut = 80) {
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const xi = (picks?.picks || []).filter(p => (p.position || 16) <= 11);
  let n = 0;
  for (const p of xi) {
    const el = byId[p.element];
    if (!el) continue;
    const prob = toProb(el?.chance_of_playing_next_round);
    if (prob < cut) n++;
  }
  return n;
}

function toProb(v) {
  const x = parseInt(v ?? "100", 10);
  return Number.isFinite(x) ? Math.max(0, Math.min(100, x)) : 100;
}

function getNextGwId(bootstrap) {
  const ev = bootstrap?.events || [];
  const nxt = ev.find(e => e.is_next);
  if (nxt) return nxt.id;
  const cur = ev.find(e => e.is_current);
  if (cur) {
    const i = ev.findIndex(x => x.id === cur.id);
    return ev[i + 1]?.id || cur.id;
  }
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length - 1]?.id || 1);
}

function countDgwTeams(fixtures, gw) {
  if (!gw) return 0;
  const cnt = {};
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    cnt[f.team_h] = (cnt[f.team_h] || 0) + 1;
    cnt[f.team_a] = (cnt[f.team_a] || 0) + 1;
  }
  // how many teams play more than once
  return Object.values(cnt).filter(n => n > 1).length;
}

function countBlankTeams(fixtures, gw) {
  if (!gw) return 0;
  const seen = new Set();
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    seen.add(f.team_h);
    seen.add(f.team_a);
  }
  // 20 Premier League teams → blanks = teams with no match that GW
  const TOTAL_TEAMS = 20;
  const played = seen.size;
  return Math.max(0, TOTAL_TEAMS - played);
}