// src/commands/link.js
// Updates:
// - Accept raw ID or full URL (extracts digits from /entry/<id>/…)
// - Detect already linked vs updated (re-link)
// - Safe KV save with createdAt/updatedAt
// - XI + Bench with short names & C/VC
// - Quick actions listed after success

import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;
const B     = (s) => `<b>${esc(s)}</b>`;
const pos   = (t) => ({1:"GK",2:"DEF",3:"MID",4:"FWD"})[t] || "?";

/* ------------ main ------------- */
export default async function link(env, chatId, arg = "") {
  // If no ID: show guide
  const raw = (arg || "").trim();
  if (!raw) {
    const html = [
      `${B("Link Your FPL Team")}`,
      "",
      `${B("Find Team ID")} Open fantasy.premierleague.com → My Team (URL has <code>/entry/1234567/</code>)`,
      "",
      `${B("How To Link")}`,
      `<code>/link 1234567</code>  — or paste your full team URL`,
    ].join("\n");
    await send(env, chatId, html, "HTML");
    return;
  }

  // Parse numeric team id (supports full URL)
  const teamId = parseTeamId(raw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await send(env, chatId, `${B("Tip")} send a numeric Team ID (e.g. <code>/link 1234567</code>) or paste your full team URL.`, "HTML");
    return;
  }

  // Validate entry
  const entry = await fplEntry(teamId);
  if (!entry) {
    await send(env, chatId, `${B("Not Found")} that Team ID didn’t resolve. Double-check and try again.`, "HTML");
    return;
  }

  // Read previous link (if any)
  let prev = null;
  try {
    const r = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
    prev = r ? JSON.parse(r) : null;
  } catch {}

  // Save to KV
  const now = Date.now();
  const payload = JSON.stringify({
    teamId,
    createdAt: prev?.createdAt || now,
    updatedAt: now
  });

  try {
    await env.FPL_BOT_KV.put(kUser(chatId), payload);
  } catch {
    await send(env, chatId, "Failed to save link in KV. Check your KV binding (FPL_BOT_KV).");
    return;
  }

  // Bootstrap + picks
  const [bootstrap, curGW] = await Promise.all([
    getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"),
    getCurrentGwId()
  ]);

  let picks = null;
  if (curGW && Number.isFinite(curGW)) {
    picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  }

  const teamName = (entry.name || "Team").trim();
  const mgr = [entry.player_first_name, entry.player_last_name].filter(Boolean).join(" ").trim();
  const ovr = fmtInt(entry?.summary_overall_rank);
  const gwp = picks?.entry_history?.points ?? picks?.entry_history?.event_points ?? "—";

  // Status line: new vs replaced vs refreshed
  let status = `${B("Linked to:")} ${esc(teamName)}${mgr ? ` (Manager: ${esc(mgr)})` : ""}`;
  if (prev?.teamId && prev.teamId !== teamId) {
    status = `${B("Updated link:")} ${esc(prev.teamId)} → ${esc(String(teamId))}\n${B("Linked to:")} ${esc(teamName)}${mgr ? ` (Manager: ${esc(mgr)})` : ""}`;
  } else if (prev?.teamId === teamId) {
    status = `${B("Already linked")} (refreshed)\n${B("Linked to:")} ${esc(teamName)}${mgr ? ` (Manager: ${esc(mgr)})` : ""}`;
  }

  // If we can’t fetch picks, still confirm link
  if (!picks || !bootstrap) {
    const html = [
      status,
      `${B("OVR:")} ${esc(ovr)}  |  ${B("GW Points:")} ${esc(String(gwp))}`,
      "",
      esc("I couldn’t fetch your XI right now (team private or API busy), but the link is saved."),
      "",
      `${B("Quick actions")}`,
      "/transfer",
      "/plan",
      "/unlink"
    ].join("\n");
    await send(env, chatId, html, "HTML");
    return;
  }

  // Build XI & Bench with short names and C/VC
  const teams = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t.short_name]));
  const els   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const all   = (picks?.picks || []).slice().sort((a,b)=>a.position-b.position);
  const xi    = all.filter(p => (p.position || 16) <= 11);
  const bench = all.filter(p => (p.position || 16) > 11);

  const isC  = new Set(xi.filter(p=>p.is_captain).map(p=>p.element));
  const isVC = new Set(xi.filter(p=>p.is_vice_captain).map(p=>p.element));

  const short = (el) => {
    const w = (el?.web_name || "").trim();
    const first = (el?.first_name || "").trim();
    const last  = (el?.second_name || "").trim();
    if (!first || !last) return w || last || first || "—";
    const initLast = `${first[0]}. ${last}`;
    return (w && w.length <= initLast.length) ? w : initLast;
  };

  const adorn = (el) => isC.has(el.id) ? `${short(el)} (C)` : isVC.has(el.id) ? `${short(el)} (VC)` : short(el);

  const group = {1:[],2:[],3:[],4:[]};
  for (const p of xi) {
    const el = els[p.element]; if (!el) continue;
    group[el.element_type].push(`• ${esc(adorn(el))} (${esc(teams[el.team] || "?")})`);
  }

  const benchLines = [];
  const bOut = bench.filter(p => (els[p.element]?.element_type) !== 1);
  const bGk  = bench.find(p => (els[p.element]?.element_type) === 1);
  if (bOut[0]) benchLines.push(`• 1) ${esc(short(els[bOut[0].element]))} — ${pos(els[bOut[0].element].element_type)}`);
  if (bOut[1]) benchLines.push(`• 2) ${esc(short(els[bOut[1].element]))} — ${pos(els[bOut[1].element].element_type)}`);
  if (bOut[2]) benchLines.push(`• 3) ${esc(short(els[bOut[2].element]))} — ${pos(els[bOut[2].element].element_type)}`);
  if (bGk)     benchLines.push(`• GK) ${esc(short(els[bGk.element]))}`);

  const html = [
    status,
    `${B("OVR:")} ${esc(ovr)}  |  ${B("GW Points:")} ${esc(String(gwp))}`,
    "",
    `${B("Current XI:")}`,
    "",
    `${B("GK:")}`,
    ...(group[1].length ? group[1] : ["• —"]),
    "",
    `${B("DEF:")}`,
    ...(group[2].length ? group[2] : ["• —"]),
    "",
    `${B("MID:")}`,
    ...(group[3].length ? group[3] : ["• —"]),
    "",
    `${B("FWD:")}`,
    ...(group[4].length ? group[4] : ["• —"]),
    "",
    `${B("Bench:")}`,
    ...(benchLines.length ? benchLines : ["• —"]),
    "",
    `${B("Quick actions")}`,
    "/transfer",
    "/plan",
    "/unlink"
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

/* ------------- helpers -------------- */
function parseTeamId(s) {
  const str = String(s);
  // Try explicit /entry/<id> first
  const m1 = str.match(/entry\/(\d{4,9})/i);
  if (m1) return Number(m1[1]);
  // Otherwise first 4–9 digit run in the string
  const m2 = str.match(/\b(\d{4,9})\b/);
  return m2 ? Number(m2[1]) : NaN;
}

async function fplEntry(id) {
  try {
    const r = await fetch(`https://fantasy.premierleague.com/api/entry/${id}/`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return (j && typeof j.id === "number") ? j : null;
  } catch { return null; }
}

async function getCurrentGwId() {
  try {
    const r = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    const ev = j?.events || [];
    const cur = ev.find(e => e.is_current); if (cur) return cur.id;
    const nxt = ev.find(e => e.is_next);    if (nxt) return nxt.id;
    const up  = ev.find(e => !e.finished);  return up ? up.id : (ev[ev.length-1]?.id || 1);
  } catch { return null; }
}

async function getJSON(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}

function fmtInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  return v.toLocaleString("en-GB");
}