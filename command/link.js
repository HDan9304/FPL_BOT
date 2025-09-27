// ./command/link.js
// /link <teamId> — link FPL team, confirm with XI + bench (short names)

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

const B     = (s) => `<b>${esc(s)}</b>`;
const kUser = (id) => `user:${id}:profile`;

export default async function linkCmd(env, chatId, arg = "", from = null) {
  const raw = String(arg || "").trim();

  if (!raw) {
    const html = [
      B("Link your FPL team"),
      "",
      "Find your Team ID at fantasy.premierleague.com → My Team (URL contains /entry/1234567/).",
      "",
      B("How to link"),
      "<code>/link 1234567</code>"
    ].join("\n");
    await send(env, chatId, html, "HTML");
    return;
  }

  const teamId = Number(raw);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await send(env, chatId, `${B("Tip")} Use a numeric Team ID, e.g. <code>/link 1234567</code>`, "HTML");
    return;
  }

  // Check entry exists
  const entry = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`);
  if (!entry || typeof entry.id !== "number") {
    await send(env, chatId, `${B("Not Found")} That Team ID didn’t resolve. Double-check and try again.`, "HTML");
    return;
  }

  // Save profile in KV
  const now = Date.now();
  let createdAt = now;
  try {
    const prev = await env.FPL_BOT_KV.get(kUser(chatId));
    if (prev) {
      const p = JSON.parse(prev);
      if (p?.createdAt) createdAt = p.createdAt;
    }
  } catch {}
  await env.FPL_BOT_KV.put(kUser(chatId), JSON.stringify({ teamId, createdAt, updatedAt: now }));

  // Try to enrich confirmation with XI/bench (if public)
  const bootstrap = await getJSON(`https://fantasy.premierleague.com/api/bootstrap-static/`);
  const curGW     = currentGw(bootstrap);
  const picks     = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`);
  const history   = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`);

  const teamName  = entry?.name || "Team";
  const manager   = [entry?.player_first_name, entry?.player_last_name].filter(Boolean).join(" ");

  // Try to obtain OVR & GW points
  const overall =
    (typeof entry?.summary_overall_rank === "number" && entry.summary_overall_rank) ||
    rankFromHistory(history, curGW);
  const gwPts =
    (typeof picks?.entry_history?.points === "number" && picks.entry_history.points) ||
    gwPointsFromHistory(history, curGW);

  // If picks unavailable (private team), show minimal confirmation
  if (!picks || !bootstrap) {
    const html = [
      `${B("Linked to:")} ${esc(teamName)}${manager ? ` (Manager: ${esc(manager)})` : ""}`,
      `${B("OVR:")} ${fmtRank(overall)}  |  ${B("GW Points:")} ${fmtNum(gwPts)}`,
      "",
      "Team is linked. If your team is private, I can’t show XI. You can still use /transfer, /plan, /chip.",
    ].join("\n");
    await send(env, chatId, html, "HTML");
    return;
  }

  // Build XI + Bench with short names (web_name), plus (C)/(VC)
  const byId   = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const teams  = Object.fromEntries((bootstrap?.teams || []).map(t => [t.id, t.short_name]));
  const all    = (picks?.picks || []).slice().sort((a,b)=> (a.position||99)-(b.position||99));
  const xiP    = all.filter(p => (p.position || 99) <= 11);
  const benchP = all.filter(p => (p.position || 99) >  11);

  const isC  = new Set(xiP.filter(p => p.is_captain).map(p => p.element));
  const isVC = new Set(xiP.filter(p => p.is_vice_captain).map(p => p.element));

  const chunk = (type) => xiP
    .map(p => byId[p.element])
    .filter(el => el && el.element_type === type)
    .map(el => {
      const tag = isC.has(el.id) ? " (C)" : isVC.has(el.id) ? " (VC)" : "";
      return `• ${esc(shortName(el))} (${esc(teams[el.team] || "?")})${tag}`;
    });

  const gk  = chunk(1);
  const def = chunk(2);
  const mid = chunk(3);
  const fwd = chunk(4);

  // Bench order: 1,2,3 are outfield; GK last
  const benchOut = benchP.filter(p => (byId[p.element]?.element_type || 0) !== 1);
  const benchGk  = benchP.find(p => (byId[p.element]?.element_type || 0) === 1);
  const benchLines = [];
  benchOut.forEach((p, i) => {
    const el = byId[p.element]; if (!el) return;
    benchLines.push(`• ${i+1}) ${esc(shortName(el))} — ${posCode(el.element_type)}`);
  });
  if (benchGk) {
    const el = byId[benchGk.element];
    if (el) benchLines.push(`• GK) ${esc(shortName(el))}`);
  }

  const html = [
    `${B("Linked to:")} ${esc(teamName)}${manager ? ` (Manager: ${esc(manager)})` : ""}`,
    `${B("OVR:")} ${fmtRank(overall)}  |  ${B("GW Points:")} ${fmtNum(gwPts)}`,
    "",
    B("Current XI:"),
    "",
    B("GK:"),
    ...(gk.length ? gk : ["• —"]),
    "",
    B("DEF:"),
    ...(def.length ? def : ["• —"]),
    "",
    B("MID:"),
    ...(mid.length ? mid : ["• —"]),
    "",
    B("FWD:"),
    ...(fwd.length ? fwd : ["• —"]),
    "",
    B("Bench:"),
    ...(benchLines.length ? benchLines : ["• —"])
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

/* ---------------- helpers ---------------- */

async function getJSON(url, timeoutMs = 10000) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

function currentGw(bootstrap) {
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current);
  if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next);
  if (nxt) return nxt.id;
  const up = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length - 1]?.id || 1);
}

function shortName(el) {
  // Prefer FPL short (web_name)
  return (el?.web_name || "").trim() || (el?.second_name || "").trim() || (el?.first_name || "").trim() || "—";
}

function posCode(t) {
  return ({1:"GK", 2:"DEF", 3:"MID", 4:"FWD"})[t] || "?";
}

function fmtRank(n) {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toLocaleString("en-GB");
}

function fmtNum(n) {
  return Number.isFinite(n) ? String(n) : "—";
}

function rankFromHistory(history, gw) {
  try {
    const cur = (history?.current || []).find(r => r.event === gw);
    return cur?.overall_rank || null;
  } catch { return null; }
}

function gwPointsFromHistory(history, gw) {
  try {
    const cur = (history?.current || []).find(r => r.event === gw);
    return cur?.points ?? null;
  } catch { return null; }
}