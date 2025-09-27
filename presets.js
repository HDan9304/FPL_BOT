// ./presets.js
// Pro AUTO presets for /transfer and /chip.
// Both functions accept { bootstrap, fixtures, picks } and return tuned config objects.

// ---------- Exports ----------
export const PRO_AUTO_BASE = {
  h: 2,          // horizon in GWs to project
  min: 80,       // min chance of playing next round (%)
  damp: 0.94,    // damp the 2nd game in a DGW slightly
  ft: 1,         // assumed free transfers next GW (we overwrite from picks)
  hit: 5         // minimum net Δ to justify hits (combo plans)
};

export const PRO_CHIP_BASE = {
  h: 2,
  min: 80,
  damp: 0.94,
  ft: 1,
  // Minimum projected gains (this GW) to fire the chip
  tc_min: 8.0,   // TC fires if captain ceiling ≥ 8 pts
  bb_min: 10.0,  // BB fires if bench sum ≥ 10 pts
  fh_min: 10.0   // FH fires if market XI beats yours by ≥ 10 pts
};

// Main preset for /transfer
export function chooseAutoConfig({ bootstrap, fixtures, picks }) {
  const cfg = { ...PRO_AUTO_BASE };

  // FT assumption for *next* GW based on how many used this GW
  const used = usedTransfersThisGw(picks);
  cfg.ft = (used === 0) ? 2 : 1;

  // Squad risk → raise minutes floor & hits threshold
  const risky = riskyStartersCount(picks, bootstrap, 80);
  // Produce 80 / 82 / 85 / 88 windows (you saw 82% when risky==1)
  cfg.min = risky >= 3 ? 88 : risky === 2 ? 85 : risky === 1 ? 82 : 80;
  cfg.hit = risky >= 3 ? 6 : 5;

  // Context: next GW DGW/Blank
  const nextGW = getNextGwId(bootstrap);
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.values(counts).filter(c => c > 1).length;
  const blankTeams = blankTeamCount(bootstrap, counts);

  // DGW-heavy → longer horizon and slightly looser hit bar
  if (dgwTeams >= 3) {
    cfg.h = 3;
    cfg.damp = 0.92;
    cfg.hit = Math.min(cfg.hit, 4); // allow good -4/-8 if net clears bar
    // Lower minutes gate a touch to allow popular DGW rotation risks
    cfg.min = Math.max(75, cfg.min - 3);
  }

  // Blank-heavy → be conservative; look only 1 GW and require better net for hits
  if (blankTeams >= 4) {
    cfg.h = 1;
    cfg.hit = Math.max(cfg.hit, 6);
    // Keep minutes high to avoid zeroes; min unchanged unless very risky
    if (risky >= 2) cfg.min = Math.max(cfg.min, 85);
  }

  return cfg;
}

// Pro AUTO preset for /chip
export function chooseChipConfig({ bootstrap, fixtures, picks }) {
  const cfg = { ...PRO_CHIP_BASE };

  // Basic squad risk → increase minutes floor
  const risky = riskyStartersCount(picks, bootstrap, 80);
  cfg.min = risky >= 3 ? 88 : risky === 2 ? 85 : risky === 1 ? 82 : 80;

  // Next GW context
  const nextGW = getNextGwId(bootstrap);
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.values(counts).filter(c => c > 1).length;
  const blankTeams = blankTeamCount(bootstrap, counts);

  // DGW-heavy: encourage TC/BB, slightly longer horizon
  if (dgwTeams >= 3) {
    cfg.h = 3;
    cfg.damp = 0.90;
    cfg.tc_min = 7.0;  // easier to TC on DGW ceiling
    cfg.bb_min = 10.0; // bench likely stronger anyway
    cfg.fh_min = 12.0; // FH reserved unless very strong edge
    // allow some DGW rotation risks
    cfg.min = Math.max(75, cfg.min - 3);
  }

  // Blank-heavy: encourage FH, be stricter on TC/BB
  if (blankTeams >= 4) {
    cfg.h = 1;
    cfg.tc_min = Math.max(cfg.tc_min, 8.5);
    cfg.bb_min = Math.max(cfg.bb_min, 12.0);
    cfg.fh_min = Math.min(cfg.fh_min, 8.0); // FH becomes attractive
    // keep minutes gate high to avoid 0s
    cfg.min = Math.max(cfg.min, risky >= 1 ? 85 : 82);
  }

  return cfg;
}

// ---------- Helpers (local only) ----------
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

function gwFixtureCounts(fixtures, gw) {
  const map = {};
  for (const f of (fixtures || [])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h] || 0) + 1;
    map[f.team_a] = (map[f.team_a] || 0) + 1;
  }
  return map;
}

function blankTeamCount(bootstrap, counts) {
  const ids = (bootstrap?.teams || []).map(t => t.id);
  let c = 0;
  for (const id of ids) if ((counts[id] || 0) === 0) c++;
  return c;
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