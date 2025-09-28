// config/transfer.js
export const PRO_CONF = Object.freeze({
  H: 2,
  MIN_PCT: 82,
  DGW_DAMP: 0.94,
  HOME_BUMP: 1.05,
  AWAY_BUMP: 0.95,

  // Hit/upgrade thresholds
  HIT_OK: 6,                // base: only take hits if net ≥ this
  MIN_DELTA_SINGLE: 0.8,    // smallest useful single-move upgrade
  MIN_DELTA_COMBO: 2.0,     // base raw Δ needed for 2–3 moves (before hits)

  // 🔧 New controls
  HIT_OK_PER_EXTRA: 1.0,    // raise the bar by +1 for each extra move beyond the first
  STEP_RAW_PER_EXTRA: 0.6,  // extra raw Δ required for 3rd move (2nd extra)
  SOFT_PEN_PER_EXTRA: 0.5,  // subtract 0.5 per extra move when comparing plans (recommendation only)

  // Pools/scan
  MAX_POOL_PER_POS: 500,
  MAX_SINGLE_SCAN: 600
});
