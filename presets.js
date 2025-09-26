// presets.js — v1.3 Pro + Adaptive auto presets (shared by /transfer, /plan, /chip)
// Exports:
//   - chooseAutoConfig({ bootstrap, fixtures, picks }, mode="pro")
//   - PRESETS (named) & default (for convenience)

export const VERSION = "1.3";

// ---------- public API ----------
export function chooseAutoConfig(input, mode = "pro") {
  const fn = PRESETS[mode] || PRESETS.pro;
  return fn(input);
}

export const PRESETS = {
  // Stable, hand-tuned settings a Pro manager would use most of the season.
  pro: ({ bootstrap, fixtures, picks }) => {
    const ft = inferFT(picks); // 1 or 2 (assumes you roll if you haven't used any this GW)
    const nextGW = getNextGwId(bootstrap);
    const ctx = summarizeContext({ bootstrap, fixtures, picks, nextGW });

    // Slight nudge if a DGW week is next: look a bit further (h=3) but keep minutes sensible.
    const isDGWNext = ctx.dgwTeamsNext > 0;
    const h = isDGWNext ? 3 : 2;

    return {
      // Transfers engine
      h,                // horizon (GWs) for scoring
      min: 80,          // minutes threshold to avoid fragile picks
      damp: 0.94,       // slight downweight for second fixture in a DGW
      ft,               // assumed free transfers for next week planning
      hit: 5,           // require ≥ +5 raw gain before paying a hit (net gate handled in /transfer)

      // Optional knobs (kept for future use & consistency)
      weights: { ppg: 1.0, fdr: 1.0, form: 0.2 }, // informative; your transfer logic already wraps PPG, FDR, minutes

      // Chip heuristics shared with /chip (if it reads cfg.chip)
      chip: {
        horizon: 6,                 // lookahead window for chip windows
        bbBenchSafeMin: 4,          // prefer BB when all 4 bench slots have solid min% & fixtures
        tcCaptainFloor: 1.60,       // captain “multiplier” floor to feel like a TC week (internal heuristic)
        fhPain: { startersMin: 9, hardInXI: 8, riskyMax: 3 }, // if below these, FH week candidate
        minutesFloor: 80,           // ensure chip scans share the same durability view
        dgwDamp: 0.92               // slightly more generous damp inside chip calc for multiple fixtures
      },

      // Telemetry (optional)
      _explain: {
        preset: "pro",
        hReason: isDGWNext ? "DGW next: horizon↑ to 3" : "Regular: horizon=2",
        ftAssumption: ft,
        dgwTeamsNext: ctx.dgwTeamsNext,
        blankTeamsNext: ctx.blankTeamsNext,
      }
    };
  },

  // Tightens when your XI is fragile, eases when it's healthy.
  adaptive: ({ bootstrap, fixtures, picks }) => {
    const nextGW = getNextGwId(bootstrap);
    const ctx = summarizeContext({ bootstrap, fixtures, picks, nextGW });
    const risky = ctx.riskyStarters;         // starters with chance% < 80
    const benchSafe = ctx.benchSafe;         // bench with chance% ≥ 80 (incl. GK count if fit)
    const isDGWNext = ctx.dgwTeamsNext > 0;

    // Base
    let min = 78;
    let hit = 5;
    let h   = isDGWNext ? 3 : 2;

    // If fragile XI, tighten minutes and be stricter with hits
    if (risky >= 3) { min = 85; hit = 6; h = 2; }
    else if (risky === 2) { min = 82; hit = 5; h = isDGWNext ? 3 : 2; }
    else if (benchSafe <= 1) { min = 82; hit = 6; h = 2; } // shallow bench → avoid risky picks

    const ft = inferFT(picks);

    return {
      h,
      min,
      damp: 0.94,
      ft,
      hit,

      weights: { ppg: 1.0, fdr: 1.0, form: 0.2 },

      chip: {
        horizon: isDGWNext ? 7 : 6,
        bbBenchSafeMin: benchSafe >= 3 ? 4 : 3,  // if bench is borderline, lower the bar a touch
        tcCaptainFloor: risky >= 3 ? 1.70 : 1.60,
        fhPain: {
          startersMin: risky >= 3 ? 10 : 9,
          hardInXI:    risky >= 3 ? 7  : 8,
          riskyMax:    risky >= 3 ? 4  : 3
        },
        minutesFloor: min,
        dgwDamp: 0.92
      },

      _explain: {
        preset: "adaptive",
        riskyStarters: risky,
        benchSafe,
        dgwTeamsNext: ctx.dgwTeamsNext,
        minChosen: min,
        hitChosen: hit,
        hChosen: h,
        ftAssumption: ft
      }
    };
  }
};

// ---------- helpers used by both presets ----------

// Estimate FT for next week from current GW usage
function inferFT(picks) {
  const used = picks?.entry_history?.event_transfers;
  // If you haven’t used any transfers this GW, assume you’ll carry 2 into next week
  if (typeof used === "number") return used === 0 ? 2 : 1;
  // fallback
  return 1;
}

function summarizeContext({ bootstrap, fixtures, picks, nextGW }) {
  const riskyStarters = countRiskyStarters(picks, bootstrap, 80);
  const benchSafe = countBenchSafe(picks, bootstrap, 80);
  const counts = gwFixtureCounts(fixtures, nextGW);
  const teamIds = (bootstrap?.teams || []).map(t => t.id);
  const dgwTeamsNext = teamIds.filter(id => (counts[id] || 0) > 1).length;
  const blankTeamsNext = teamIds.filter(id => (counts[id] || 0) === 0).length;
  return { riskyStarters, benchSafe, dgwTeamsNext, blankTeamsNext };
}

function countRiskyStarters(picks, bootstrap, minCut = 80) {
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const xi = (picks?.picks || []).filter(p => (p.position || 16) <= 11);
  let n = 0;
  for (const p of xi) {
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}

function countBenchSafe(picks, bootstrap, minCut = 80) {
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const bench = (picks?.picks || []).filter(p => (p.position || 16) > 11);
  let n = 0;
  for (const p of bench) {
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
    if (Number.isFinite(mp) && mp >= minCut) n++;
  }
  return n;
}

// Count number of fixtures each team has in a specific GW (detect DGW/Blank)
function gwFixtureCounts(fixtures, gw) {
  const map = {};
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h] || 0) + 1;
    map[f.team_a] = (map[f.team_a] || 0) + 1;
  }
  return map;
}

function getCurrentGw(bootstrap) {
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next); if (nxt) return nxt.id;
  const up  = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length - 1]?.id || 1);
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

export default { chooseAutoConfig, PRESETS, VERSION };