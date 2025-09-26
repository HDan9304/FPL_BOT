// src/config/presets.js
// "Best" Auto Pro preset + light tuner used by /transfer and /plan

/* ---------- Core preset (best default) ---------- */
/**
 * Tuned for strong week-ahead planning:
 * - h=2: next GW + a peek at the following one (catches DGW/blank edges without overfitting)
 * - min=80: filters most rotation/flag risks, still flexible for popular mins risks
 * - damp=0.93: slightly devalues the 2nd DGW fixture
 * - hit=5: requires solid raw gain before a -4
 * - ft: computed by tuner (roll logic)
 */
export const AUTO_PRO_PRESET = {
  h: 2,
  min: 80,
  damp: 0.93,
  hit: 5
};

/* ---------- Light auto-tuner on top of Auto Pro ---------- */
/**
 * Produces the final preset + reasons (`why`) so you can display them.
 *
 * @param {Object} ctx
 * @param {number} [ctx.riskyStarters=0]          starters below minutes threshold (≈<80–85)
 * @param {number|null} [ctx.usedTransfersThisGw] transfers used this current GW (0/1/2… or null)
 * @param {number} [ctx.bank=0]                   ITB (millions)
 * @param {boolean} [ctx.hasNearDGW=false]        true if several teams double next GW
 * @param {boolean} [ctx.hasNearBlank=false]      true if many blanks next GW
 * @returns {{h:number,min:number,damp:number,ft:number,hit:number,why:string[]}}
 */
export function autoProFromSignals(ctx = {}) {
  const {
    riskyStarters = 0,
    usedTransfersThisGw = null,
    bank = 0,
    hasNearDGW = false,
    hasNearBlank = false
  } = ctx;

  let h    = AUTO_PRO_PRESET.h;
  let min  = AUTO_PRO_PRESET.min;
  let damp = AUTO_PRO_PRESET.damp;
  let hit  = AUTO_PRO_PRESET.hit;
  let ft   = 1;

  const why = [];

  // FT rollover logic (what you'll have next GW)
  if (usedTransfersThisGw === 0) { ft = 2; why.push("FT=2 next GW (rolled)."); }
  else if (usedTransfersThisGw > 0) { ft = 1; why.push("FT=1 next GW (used transfer)."); }
  else { ft = 1; why.push("FT=1 assumed (usage unknown)."); }

  // Squad fragility -> stricter minutes & hits
  if (riskyStarters >= 3) { min = Math.max(min, 85); hit = Math.max(hit, 6); why.push("Fragile XI: min%→85, hits stricter."); }
  else if (riskyStarters === 2) { min = Math.max(min, 82); why.push("Some risk: min%→82."); }

  // DGW/Blank context: widen horizon slightly and tweak damping/hit
  if (hasNearDGW) { h = Math.max(h, 3); damp = Math.min(damp, 0.92); why.push("DGW ahead: horizon→3, damp→0.92."); }
  if (hasNearBlank) { h = Math.max(h, 3); hit = Math.max(hit, 6); why.push("Blank risk: horizon→3, hits stricter."); }

  // Healthy bank → slightly easier to justify a hit
  if (bank >= 2.0) { hit = Math.max(4, hit - 1); why.push("Bank≥£2.0m: hits slightly easier (hit→" + hit + ")."); }

  // Clamp for safety
  h    = clamp(h, 1, 4);
  min  = clamp(min, 75, 90);
  damp = clamp(damp, 0.88, 0.97);
  hit  = clamp(hit, 3, 8);
  ft   = clamp(ft, 1, 2);

  if (!why.length) why.push("Auto Pro baseline.");

  return { h, min, damp, ft, hit, why };
}

/* ---------- tiny util ---------- */
function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
