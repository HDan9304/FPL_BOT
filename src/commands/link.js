import { send } from "../utils/telegram.js";
import { esc, B } from "../utils/fmt.js";
import { getBootstrap, getCurrentGw, getEntry, getPicks, nameShort, teamShort, posName } from "../utils/fpl.js";

const kUser = (id) => `user:${id}:profile`;

export default async function link(env, chatId, msg) {
  const parts = (msg?.text || "").trim().split(/\s+/);
  const idStr = parts[1];

  // No ID -> guide
  if (!idStr) {
    const html = [
      `<b>Link Your FPL Team</b>`,
      ``,
      `${B("Find Team ID")} Open fantasy.premierleague.com → My Team (URL shows <code>/entry/1234567/</code>)`,
      ``,
      `${B("How to link")}`,
      `<code>/link 1234567</code>`
    ].join("\n");
    await send(env, chatId, html, "HTML");
    return;
  }

  const teamId = Number(idStr);
  if (!Number.isInteger(teamId) || teamId <= 0) {
    await send(env, chatId, `${B("Tip")} use a numeric Team ID, e.g. <code>/link 1234567</code>`, "HTML");
    return;
  }

  // Fetch FPL data
  const [bootstrap, entry] = await Promise.all([ getBootstrap(), getEntry(teamId) ]);
  if (!entry) {
    await send(env, chatId, `${B("Not Found")} that Team ID didn’t resolve. Double-check or make your team public.`, "HTML");
    return;
  }
  const gw = getCurrentGw(bootstrap);
  const picks = await getPicks(teamId, gw);

  // Save to KV
  const now = Date.now();
  try {
    await env.FPL_BOT_KV.put(kUser(chatId), JSON.stringify({ teamId, createdAt: now, updatedAt: now }), { expirationTtl: 60*60*24*365 });
  } catch {}

  // Build output
  const teamName = entry?.name || "—";
  const manager = [entry?.player_first_name, entry?.player_last_name].filter(Boolean).join(" ") || "—";

  // Overall rank & GW points
  // Prefer picks.entry_history.event_points; OVR from entry.summary_overall_rank (fallbacks handled)
  const gwPoints = picks?.entry_history?.points ?? picks?.entry_history?.event_points ?? "—";
  const overallRank = entry?.summary_overall_rank ?? entry?.overall_rank ?? "—";

  // Map helpers
  const byId = Object.fromEntries((bootstrap?.elements || []).map(e => [e.id, e]));
  const starters = (picks?.picks || []).filter(p => (p.position||16) <= 11);
  const bench    = (picks?.picks || []).filter(p => (p.position||16) > 11).sort((a,b)=>a.position-b.position);
  const isC  = new Set(starters.filter(p=>p.is_captain).map(p=>p.element));
  const isVC = new Set(starters.filter(p=>p.is_vice_captain).map(p=>p.element));

  const tag = (el) => isC.has(el.id) ? " (C)" : isVC.has(el.id) ? " (VC)" : "";
  const pEl = (p) => byId[p.element];

  // Grouped XI lines
  const group = (type) => starters.map(pEl).filter(el => el && el.element_type === type)
    .map(el => `• ${esc(nameShort(el))} (${esc(teamShort(bootstrap, el.team))})${esc(tag(el))}`)
    .join("\n") || "• —";

  const GK = group(1);
  const DF = group(2);
  const MD = group(3);
  const FW = group(4);

  // Bench lines: first three non-GK as 1/2/3, then GK
  const benchOut = bench.filter(p => pEl(p)?.element_type !== 1);
  const benchGk  = bench.find(p => pEl(p)?.element_type === 1);
  const benchLines = [];
  if (benchOut[0]) benchLines.push(`• 1) ${esc(nameShort(pEl(benchOut[0])))} (${esc(teamShort(bootstrap, pEl(benchOut[0]).team))}) — ${esc(posName(pEl(benchOut[0]).element_type))}`);
  if (benchOut[1]) benchLines.push(`• 2) ${esc(nameShort(pEl(benchOut[1])))} (${esc(teamShort(bootstrap, pEl(benchOut[1]).team))}) — ${esc(posName(pEl(benchOut[1]).element_type))}`);
  if (benchOut[2]) benchLines.push(`• 3) ${esc(nameShort(pEl(benchOut[2])))} (${esc(teamShort(bootstrap, pEl(benchOut[2]).team))}) — ${esc(posName(pEl(benchOut[2]).element_type))}`);
  if (benchGk)     benchLines.push(`• GK) ${esc(nameShort(pEl(benchGk)))} (${esc(teamShort(bootstrap, pEl(benchGk).team))})`);

  const html = [
    `<b>Linked to:</b> ${esc(teamName)} (Manager: ${esc(manager)})`,
    `<b>OVR:</b> ${esc(formatNum(overallRank))}  |  <b>GW Points:</b> ${esc(String(gwPoints))}`,
    ``,
    `<b>Current XI:</b>`,
    ``,
    `<b>GK:</b>`,
    GK,
    ``,
    `<b>DEF:</b>`,
    DF,
    ``,
    `<b>MID:</b>`,
    MD,
    ``,
    `<b>FWD:</b>`,
    FW,
    ``,
    `<b>Bench:</b>`,
    benchLines.join("\n") || "• —"
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

function formatNum(n) {
  if (n == null || n === "—") return "—";
  const v = Number(n);
  return Number.isFinite(v) ? v.toLocaleString("en-GB") : String(n);
}
