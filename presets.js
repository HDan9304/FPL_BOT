// src/presets.js
// Shared "Auto Pro" tuning for both /transfer and /chip

export function chooseAutoConfig({ bootstrap, fixtures, picks }) {
  // Basic squad health signals
  const risky = riskyStartersCount(picks, bootstrap, 80); // starters <80% minutes
  const used  = usedTransfersThisGw(picks);

  // ---- Transfer-facing knobs
  const ft   = (used === 0 ? 2 : 1);
  const min  = risky >= 2 ? 85 : 82;       // tighten minutes if fragile
  const damp = 0.94;                       // DGW 2nd-game damp
  const h    = 2;                          // short horizon for near-term edges
  const hit  = risky >= 3 ? 6 : 5;         // allow hits only for bigger gains

  // ---- Chip-facing thresholds (Pro defaults)
  const chip = {
    // Bench Boost: need a real bench, not just DGW hype
    bbBenchEvMin: 16,      // EV threshold for (bench GK + 3 outfield)
    bbBenchSafeMin: 4,     // at least 4 bench players with mins >= min

    // Triple Captain: reward true captain spikes
    tcSpikeMin: 2.8,       // captain EV – median(cap EV over horizon)
    tcCapEvMin: 10.5,      // absolute captain EV floor (helps non-DGW spikes)

    // Free Hit: when pain is high or EV gain is meaningful
    fhGainMin: 12,         // EV(best XI wk) – EV(my XI wk)
    fhMyEvMin: 45,         // if your XI EV below this, FH more reasonable

    // Wildcard: rebuild when stress & EV delta justify it
    wcGainMin: 18,         // (avg next 2–3wks bestXI) – (myXI)
    wcStressMin: 10,       // stress: 3*risky + (4-benchSafe)+ (8-hardInXI clamped)
    wcHorizon: 6           // evaluate 6 weeks for WC planning
  };

  return { ft, min, damp, h, hit, chip, maxPerTeam: 3 };
}

/* ------------- small helpers used above ------------- */
function riskyStartersCount(picks, bootstrap, minCut=80){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  let n=0;
  for (const p of xi){
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}
function usedTransfersThisGw(picks){
  const eh = picks?.entry_history;
  return (typeof eh?.event_transfers === "number") ? eh.event_transfers : null;
}