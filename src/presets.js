// src/presets.js — central presets & auto chooser (Pro Auto)

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

// Base “Pro Auto” defaults (same behavior you had before we centralized config)
const PRO_BASE = { name: "Pro Auto", h: 2, min: 78, damp: 0.94, hit: 5 };

/**
 * Choose the auto config (Pro) with light adaptation to squad fragility.
 * @param {{bootstrap: any, fixtures: any, picks: any, entry?: any, mode?: "pro", chase?: boolean}} ctx
 * @returns {{presetName:string, h:number, min:number, damp:number, hit:number, ft:number}}
 */
export function chooseAutoConfig(ctx) {
  const { bootstrap, picks, chase = false } = (ctx || {});
  const cfg = { ...PRO_BASE };

  // FT assumption for next GW: if you haven't used any FT this GW, assume 2 next; else 1.
  const usedThis = usedTransfersThisGw(picks);
  cfg.ft = (usedThis === 0) ? 2 : 1;

  // Tighten minutes threshold if you have multiple risky starters
  const riskyN = riskyStartersCount(picks, bootstrap, 80);
  if (riskyN >= 2) cfg.min = Math.max(cfg.min, 85);

  // Damp stays gentle for DGW stacking
  cfg.damp = 0.94;

  // Hits tolerance: stricter if very fragile
  if (riskyN >= 3) cfg.hit = Math.max(cfg.hit, 6);

  // “Chasing” mode (optional arg) relaxes minutes & lowers hit threshold slightly
  if (chase) {
    cfg.min = Math.min(cfg.min, 75);
    cfg.hit = 4;
  }

  cfg.presetName = PRO_BASE.name + (chase ? " + Chase" : "");
  return cfg;
}

// Also provide a default export for flexibility (import chooseAutoConfig from "...").
export default { chooseAutoConfig };