// src/presets.js — named presets + adaptive auto

export const PRESETS = {
  PRO:   { h: 2, min: 80, damp: 0.93, ft: 1, hit: 5 },
  SAFE:  { h: 2, min: 85, damp: 0.95, ft: 1, hit: 6 },
  CHASE: { h: 3, min: 75, damp: 0.92, ft: 1, hit: 4 }
};

// ---- adaptive auto (Pro baseline) ----
export function autoPreset(ctx, base = PRESETS.PRO) {
  // ctx: { bootstrap, fixtures, picks }
  const { bootstrap, fixtures, picks } = ctx || {};
  const cfg = { ...base };

  // FT assumption for next GW
  const used = usedTransfersThisGw(picks);
  cfg.ft = (used === 0) ? 2 : 1;

  // Team fragility → tighten minutes + raise hit threshold
  const risky = riskyStartersCount(picks, bootstrap, 80);
  if (risky >= 3) { cfg.min = Math.max(cfg.min, 86); cfg.hit = Math.max(cfg.hit, 6); }
  else if (risky >= 2) { cfg.min = Math.max(cfg.min, 83); cfg.hit = Math.max(cfg.hit, 6); }

  // Calendar context (DGW/Blank) → adjust horizon & damp
  const nextGW = nextGwId(bootstrap);
  const counts = gwFixtureCounts(fixtures, nextGW);
  const dgwTeams = Object.keys(counts).filter(t => counts[t] > 1).length;
  const blankTeams = teamIds(bootstrap).filter(t => (counts[t] || 0) === 0).length;

  if (dgwTeams >= 6) { cfg.h = Math.max(cfg.h, 3); cfg.damp = Math.max(cfg.damp, 0.94); }
  if (blankTeams >= 6) { cfg.h = Math.min(cfg.h, 2); cfg.min = Math.max(cfg.min, 85); }

  return cfg;
}

/* ---- small helpers (local to preset) ---- */
function riskyStartersCount(picks, bootstrap, minCut=80){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  let n=0;
  for (const p of xi){
    const el = byId[p.element]; if (!el) continue;
    const mp = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
    if (!Number.isFinite(mp) || mp < minCut) n++;
  }
  return n;
}
function usedTransfersThisGw(picks){
  const eh = picks?.entry_history;
  return (typeof eh?.event_transfers === "number") ? eh.event_transfers : null;
}
function nextGwId(bootstrap){
  const ev = bootstrap?.events || [];
  const nxt = ev.find(e => e.is_next); if (nxt) return nxt.id;
  const cur = ev.find(e => e.is_current);
  if (cur) {
    const i = ev.findIndex(x => x.id === cur.id);
    return ev[i+1]?.id || cur.id;
  }
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}
function teamIds(bootstrap){ return (bootstrap?.teams||[]).map(t=>String(t.id)); }
function gwFixtureCounts(fixtures, gw){
  const map = {};
  for (const f of (fixtures||[])) {
    if (f.event !== gw) continue;
    map[f.team_h] = (map[f.team_h]||0) + 1;
    map[f.team_a] = (map[f.team_a]||0) + 1;
  }
  return map;
}
