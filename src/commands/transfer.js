import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const kUser = (id) => `user:${id}:profile`;

const B = (s) => `<b>${esc(s)}</b>`;
const fmtGBP = (n) => (n == null ? "—" : `£${Number(n).toFixed(1)}`);

export default async function transfer(env, chatId) {
  // 1) read linked team
  const profileRaw = env.FPL_BOT_KV ? await env.FPL_BOT_KV.get(kUser(chatId)) : null;
  const teamId = profileRaw ? (JSON.parse(profileRaw).teamId) : null;
  if (!teamId) {
    await send(env, chatId,
      `${B("Not linked")} Use /link <TeamID> first.\nExample: /link 1234567`,
      "HTML"
    );
    return;
  }

  // 2) fetch basic FPL data (minimal)
  const [bootstrap, entry] = await Promise.all([getJSON("https://fantasy.premierleague.com/api/bootstrap-static/"), getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/`) ]);
  if (!bootstrap || !entry) {
    await send(env, chatId, "Couldn't fetch your team right now. Try again shortly.");
    return;
  }
  const gw = currentGw(bootstrap);
  const picks = await getJSON(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`);

  // 3) header fields
  const teamName = entry?.name || "—";
  const bank =
    (typeof picks?.entry_history?.bank === "number" ? picks.entry_history.bank/10 :
     typeof entry?.last_deadline_bank === "number" ? entry.last_deadline_bank/10 : null);

  const hit = picks?.entry_history?.event_transfers_cost ?? 0;

  // Note: FT logic is complex; keep it simple for v1 (assume 1 FT)
  const ftAssumed = 1;

  // 4) render
  const html = [
    `${B("Team")}: ${esc(teamName)} | ${B("GW")}: ${gw} — Transfer`,
    `${B("Bank")}: ${esc(fmtGBP(bank))} | ${B("Free Transfer")}: ${ftAssumed} | ${B("Hit")}: -${hit}`,
  ].join("\n");

  await send(env, chatId, html, "HTML");
}

/* ------ tiny helpers (local to this command to keep repo minimal) ------ */
function currentGw(bootstrap){
  const ev = bootstrap?.events || [];
  const cur = ev.find(e => e.is_current); if (cur) return cur.id;
  const nxt = ev.find(e => e.is_next); if (nxt) return nxt.id;
  const up  = ev.find(e => !e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}

async function getJSON(url){
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  } catch { return null; }
}