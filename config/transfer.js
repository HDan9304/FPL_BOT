// config/transfer.js — knobs for the Pro preset used by /transfer
export const PRO_CONF = Object.freeze({
  H: 2,                  // horizon (next GW + one after)
  MIN_PCT: 80,           // minutes probability cut-off
  DGW_DAMP: 0.94,        // 2nd+ game damp in DGW
  HOME_BUMP: 1.05,
  AWAY_BUMP: 0.95,
  HIT_OK: 6,             // only take hits if net ≥ this
  EXTRA_MOVE_STEP: 1.0,
  RECO_SOFT_PENALTY: 0.6,
  MIN_DELTA_SINGLE: 0.5, // ignore tiny upgrades
  MIN_DELTA_COMBO: 1.7,  // min raw gain for 2–3 moves (pre-hits)
  MAX_POOL_PER_POS: 500,
  MAX_SINGLE_SCAN: 600,
});
