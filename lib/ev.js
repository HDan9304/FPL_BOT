// lib/ev.js — minutes filter + expected value model
import { fixturesForTeam, getFDR, fdrMult } from "./fixtures.js";
import { num } from "./util.js";

export function minutesProb(el){
  const v = parseInt(el?.chance_of_playing_next_round ?? "100", 10);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
}

export function playerEV(el, fixtures, startGw, CFG){
  const mp = minutesProb(el);
  if (mp < CFG.MIN_PCT) return { ev: 0 };

  const ppg = num(el.points_per_game);
  if (ppg <= 0) return { ev: 0 };

  let ev = 0;
  const endGw = startGw + Math.max(1, CFG.H) - 1;

  for (let g = startGw; g <= endGw; g++) {
    const fs = fixturesForTeam(fixtures, g, el.team);
    if (!fs.length) continue; // blank contributes 0
    fs.forEach((f, idx) => {
      const home = f.team_h === el.team;
      const fdr = getFDR(f, home);
      const dgwDamp = idx === 0 ? 1.0 : CFG.DGW_DAMP;
      const haMult  = home ? CFG.HOME_BUMP : CFG.AWAY_BUMP;
      ev += ppg * (mp/100) * fdrMult(fdr) * haMult * dgwDamp;
    });
  }
  return { ev };
}
