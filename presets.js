// presets.js — centralized auto presets for /transfer (and later /plan, /chip)

// Public: base constants for Pro preset (so you can tweak in one place)
export const PRO_AUTO_BASE = {
  h: 2,            // horizon (GWs)
  minBase: 78,     // minutes floor when XI is fine
  minTight: 85,    // minutes floor when XI is fragile
  damp: 0.94,      // DGW second-game damp
  hit: 5           // minimum raw gain required to justify a -4
};

// Main chooser.
// mode: "pro" (default) or "adaptive"
export function chooseAutoConfig({ bootstrap, fixtures, picks }, mode = "pro") {
  const risky = riskyStartersCount(picks, bootstrap, 80);
  const usedThis = usedTransfersThisGw(picks);
  const ft = (usedThis === 0) ? 2 : 1; // assume 2FT next GW if you haven't used one this GW

  if (mode === "adaptive") {
    // Minutes floor increases with XI fragility:
    // min = clamp(76 + 2 * risky, 76..86)
    const min = clamp(76 + 2 * risky, 76, 86);
    const hit = (risky >= 3) ? 6 : 5;
    return { h: 2, min, damp: 0.94, hit, ft, mode: "Adaptive Auto" };
  }

  // Pro Auto (recommended)
  const min = (risky >= 2) ? PRO_AUTO_BASE.minTight : PRO_AUTO_BASE.minBase;
  const hit = (risky >= 3) ? Math.max(PRO_AUTO_BASE.hit, 6) : PRO_AUTO_BASE.hit;
  return { h: PRO_AUTO_BASE.h, min, damp: PRO_AUTO_BASE.damp, hit, ft, mode: "Pro Auto" };
}

/* ----- local helpers (kept here to avoid import cycles) ----- */
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
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }