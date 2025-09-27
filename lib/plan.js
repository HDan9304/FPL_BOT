// lib/plan.js — planning helpers + SIMPLE renderer
import { gbp } from "./util.js";
import { esc } from "../utils/fmt.js";
export { badgeLine } from "./fixtures.js";

/* -------------------- A/B/D logic stays the same -------------------- */
export function mkPlanA(rejections){
  const why = [];
  if (Array.isArray(rejections) && rejections.length) {
    const counts = {};
    for (const r of rejections) counts[r.code] = (counts[r.code]||0) + 1;
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,3)
      .map(([code,n]) => humanReasonSummary(code, n));
    if (top.length) {
      why.push("No legal upgrades cleared the bar.");
      top.forEach(t => why.push(`• ${t}`));
    } else {
      why.push("No clear upgrades; better to roll FT.");
    }
  } else {
    why.push("No clear upgrades; better to roll FT.");
  }
  return { moves: [], delta: 0, hit: 0, net: 0, why };
}

export function mkPlanB(singles, ft, CFG){
  if (!singles.length) return mkPlanA();
  const s = singles[0];
  const hit = Math.max(0, 1 - ft) * 4;
  const raw = s.delta;
  if (raw < CFG.MIN_DELTA_SINGLE) {
    return { ...mkPlanA(), why: ["Best single was below +0.5."] };
  }
  const why = [];
  if (hit > 0) why.push(`-4 applied (only ${ft} FT assumed)`);
  return { moves:[s], delta: raw, hit, net: raw - hit, why };
}

export function bestCombo(singles, K, teamCounts, bank, ft, CFG){
  if (!singles.length || K < 2) return mkPlanA();

  function validCombo(ms){
    const outIds = new Set(), inIds = new Set();
    const counts = { ...teamCounts };
    let spend = 0, deltaSum = 0;

    for (const m of ms){
      if (outIds.has(m.outId) || inIds.has(m.inId)) return { invalid:true };
      outIds.add(m.outId); inIds.add(m.inId);

      if (m.inTeamId !== m.outTeamId) {
        counts[m.outTeamId] = (counts[m.outTeamId]||0) - 1;
        counts[m.inTeamId]  = (counts[m.inTeamId] ||0) + 1;
      }
      spend += m.priceDiff;
      deltaSum += m.delta;
    }
    if (Object.values(counts).some(c => c > 3)) return { invalid:true };
    if (spend > bank + 1e-9) return { invalid:true };
    if (deltaSum < CFG.MIN_DELTA_COMBO) return { invalid:true };

    const hit = Math.max(0, ms.length - ft) * 4;
    return { invalid:false, delta: deltaSum, hit, net: deltaSum - hit, spend };
  }

  const S = Math.min(90, singles.length);
  let best = null;

  function* kComb(k, start=0, acc=[]){
    if (k===0) { yield acc; return; }
    for (let i=start;i<=S-k;i++) yield* kComb(k-1, i+1, [...acc, i]);
  }

  const base = singles.slice(0, S);
  for (const ids of kComb(K)) {
    const ms = ids.map(i => base[i]);
    const chk = validCombo(ms);
    if (chk.invalid) continue;
    const cand = { moves: ms, delta: chk.delta, hit: chk.hit, net: chk.net, spend: chk.spend, why: [] };
    if (!best || cand.net > best.net) best = cand;
  }

  if (!best) return mkPlanA(["No affordable/legal combo found."]);
  if (best.hit > 0) best.why.push(`Includes -${best.hit} hit; net ${best.net>=0?"+":""}${best.net.toFixed(2)}`);
  return best;
}

/* -------------------- SIMPLE renderer -------------------- */
/**
 * Minimal output per plan:
 *  - Plan title (recommended tick handled by caller)
 *  - For A: “Save FT.”
 *  - For B/C/D: show the single best move within that plan (largest delta)
 *  - Under it: “Net: +X.XX | Bank after: £Y.Y | Hits: -N”
 */
export function renderPlan(title, plan, countsNext, currentBank){
  const lines = [];
  lines.push(`<b>${esc(title)}</b>`);

  if (!plan || !plan.moves || plan.moves.length === 0) {
    lines.push(`• Save FT`);
    lines.push(`Net: +0.00 | Bank after: ${gbp(currentBank)} | Hits: -0`);
    return lines.join("\n");
  }

  // pick the single biggest-impact move inside this plan
  const top = plan.moves.slice().sort((a,b)=> (b.delta - a.delta))[0];

  // Compute “bank after”
  let bankAfter = currentBank;
  if (plan.moves.length === 1 && Number.isFinite(top.bankLeft)) {
    bankAfter = top.bankLeft;
  } else {
    const spend = Number.isFinite(plan.spend)
      ? plan.spend
      : plan.moves.reduce((s,m)=> s + (m.priceDiff || 0), 0);
    bankAfter = currentBank - spend;
  }

  const inTag  = tag(countsNext?.[top.inTeamId] || 0);
  const outTag = tag(countsNext?.[top.outTeamId] || 0);

  lines.push(`• OUT: ${esc(top.outName)} (${esc(top.outTeam)}) ${outTag} → IN: ${esc(top.inName)} (${esc(top.inTeam)}) ${inTag}`);
  lines.push(`Net: ${(plan.net>=0?"+":"")}${plan.net.toFixed(2)} | Bank after: ${gbp(bankAfter)} | Hits: -${plan.hit}`);

  return lines.join("\n");
}

/* -------------------- helpers -------------------- */
function tag(cnt){
  if (cnt > 1) return "(DGW)";
  if (cnt === 0) return "(Blank)";
  return "";
}
function humanReasonSummary(code, n){
  const label = {
    "same-player":"same-player collisions",
    "already-owned":"already-owned targets",
    "bank":"bank shortfall",
    "team-limit":"team limit >3",
    "min-delta":"Δ below +0.5"
  }[code] || code;
  return `${label}: ${n}×`;
}
