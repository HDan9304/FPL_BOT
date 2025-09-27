// lib/reasons.js — human-friendly explanations for suggested moves
import { minutesProb } from "./ev.js";
import { fixturesForTeam, getFDR } from "./fixtures.js";
import { num } from "./util.js";

export function reason(code, OUT, IN, extra = {}){
  const gbp = (n)=> n==null ? "—" : `£${Number(n).toFixed(1)}`;
  const fmt = (x)=> Number.isFinite(x) ? x.toFixed(2) : "0.00";
  const msg = {
    "same-player":   "Candidate equals OUT player",
    "already-owned": "Already in your team",
    "bank":          `Insufficient bank (need ${gbp(extra.need || 0)})`,
    "team-limit":    "Would break per-team limit (max 3)",
    "min-delta":     `Upgrade below +0.5 (Δ=${fmt(extra.delta)})`,
  }[code] || "Filtered";
  return { code, text: `${OUT.name} → ${IN.name}: ${msg}` };
}

export function humanReasonSummary(code, n){
  const label = {
    "same-player":"same-player collisions",
    "already-owned":"already-owned targets",
    "bank":"bank shortfall",
    "team-limit":"team limit >3",
    "min-delta":"Δ below +0.5"
  }[code] || code;
  return `${label}: ${n}×`;
}

export function explainMoveHuman(m, elements, fixtures, startGw, H){
  const outEl = elements[m.outId];
  const inEl  = elements[m.inId];
  if (!outEl || !inEl) return "";

  // Minutes labels
  const outMin = minutesLabel(minutesProb(outEl));
  const inMin  = minutesLabel(minutesProb(inEl));

  // Fixtures mood over horizon
  const outFix = fixturesMood(outEl.team, fixtures, startGw, H);
  const inFix  = fixturesMood(inEl.team, fixtures, startGw, H);

  // Recent output (simple ppg comparison)
  const ppgOut = num(outEl.points_per_game);
  const ppgIn  = num(inEl.points_per_game);
  const formPhrase =
    (ppgIn >= ppgOut + 0.4) ? "hotter recent form" : "solid recent form";

  const outBits = [];
  if (outMin === "rotation risk") outBits.push("minutes risk");
  if (outMin === "major doubt")   outBits.push("injury/doubt");
  if (outFix.key === "blank")     outBits.push("blank week");
  if (outFix.key === "tough")     outBits.push("tough fixtures");

  const inBits = [];
  if (inMin === "nailed")         inBits.push("regular starter");
  if (inFix.key === "good")       inBits.push("kinder fixtures");
  if (inFix.key === "double")     inBits.push("Double Gameweek");
  inBits.push(formPhrase);

  const outTxt = outBits.length ? `replace due to ${outBits.join(" + ")}` : "upgrade the spot";
  const inTxt  = inBits.length ? `bring in for ${inBits.join(" + ")}` : "more reliable pick";

  return `${m.outName}: ${outTxt}. ${m.inName}: ${inTxt}.`;
}

function minutesLabel(cp){
  if (cp >= 90) return "nailed";
  if (cp >= 70) return "rotation risk";
  return "major doubt";
}

function fixturesMood(teamId, fixtures, startGw, H){
  const diffs = [];
  for (let g = startGw; g < startGw + Math.max(1, H); g++){
    const fs = fixturesForTeam(fixtures, g, teamId);
    if (!fs.length) { diffs.push(999); continue; } // blank
    fs.forEach((f) => {
      const home = f.team_h === teamId;
      diffs.push(Number(getFDR(f, home))||3);
    });
  }
  const n = diffs.length;
  if (!n || diffs.every(v => v === 999)) return { key:"blank", desc:"blank" };
  if (n >= 2) return { key:"double", desc:"double" };
  const vals = diffs.filter(v => v !== 999);
  const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
  if (avg <= 2.7) return { key:"good",  desc:"good" };
  if (avg >= 3.7) return { key:"tough", desc:"tough" };
  return { key:"mixed", desc:"mixed" };
}
