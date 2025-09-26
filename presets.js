// presets.js — separate "Pro Auto" presets for TRANSFER and CHIP
// Exported APIs:
//   chooseAutoConfig({ bootstrap, fixtures, picks })
//   chooseChipAutoConfig({ bootstrap, fixtures, picks })

/** ---------- TRANSFER (Pro) ---------- **/
export function chooseAutoConfig({ bootstrap, fixtures, picks }) {
  const riskyN   = riskyStartersCount(picks, bootstrap, 80);
  const usedThis = usedTransfersThisGw(picks);

  // Base Pro settings (kept stable per your request)
  const cfg = {
    h: 2,         // horizon (GWs) for upgrade scoring
    min: 78,      // minutes/availability floor (%)
    damp: 0.94,   // damp 2nd fixture in DGW slightly
    ft: 1,        // assumed FT for next GW (will adjust below)
    hit: 5        // allow hits if net gain >= 5
  };

  // Nudge based on team fragility & FT usage this GW
  cfg.ft  = (usedThis === 0 ? 2 : 1);
  cfg.min = (riskyN >= 2 ? 85 : 78);
  cfg.hit = (riskyN >= 3 ? 6  : 5);

  return cfg;
}

function riskyStartersCount(picks, bootstrap, minCut = 80) {
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const xi = (picks?.picks || []).filter(p => (p.position || 16) <= 11);
  let n = 0;
  for (const p of xi) {
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}
function usedTransfersThisGw(picks) {
  const eh = picks?.entry_history;
  return (typeof eh?.event_transfers === "number") ? eh.event_transfers : null;
}

/** ---------- CHIPS (Pro) ---------- **/
export function chooseChipAutoConfig({ bootstrap, fixtures, picks }) {
  const riskyN = riskyStartersCount(picks, bootstrap, 80);

  // Separate tuning specifically for chip advice (more schedule-aware)
  const cfg = {
    // Look further ahead for chip planning
    horizon: 5,          // GWs to scan for DGW/blank clusters
    min: 78,             // minutes floor for bench/captain projections
    damp: 0.94,          // 2nd game dampening in DGW projections

    // Triple Captain
    tcCaptainMinSingle: 6.8,  // min projected score for single GW to consider TC (rare)
    tcCaptainMinDouble: 9.5,  // min projected score in DGW to consider TC
    tcPreferDGW: true,

    // Bench Boost
    bbBenchThreshold: 10.5,   // projected bench sum to make BB attractive (no DGW)
    bbBenchDgwBoost: 2.0,     // add this if ≥2 bench players have a DGW

    // Free Hit
    fhBlankStarterFloor: 8,   // if expected starters < 8 in a blank → strong FH

    // Wildcard (coarse trigger; we don’t rebuild market here)
    wcRiskyStarterTrigger: 4, // many flagged/low-minutes starters → consider WC
    wcLookaheadDrop: 6.0      // if horizon XI projection drops by this vs next GW → consider WC
  };

  // Toughen minutes if your XI looks fragile
  if (riskyN >= 3) cfg.min = Math.max(cfg.min, 85);

  return cfg;
}