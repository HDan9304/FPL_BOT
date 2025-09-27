// lib/util.js — small helpers shared across modules
export function num(x){ const n = parseFloat(x); return Number.isFinite(n) ? n : 0; }
export function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }
export function fmt(x){ return Number.isFinite(x) ? x.toFixed(2) : "0.00"; }
export function gbp(n){ return n == null ? "—" : `£${Number(n).toFixed(1)}`; }
