import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

// Minimal FPL: just get next GW for the header
async function nextEvent() {
  try {
    const r = await fetch("https://fantasy.premierleague.com/api/bootstrap-static/", {
      signal: AbortSignal.timeout(10000),
      cf: { cacheTtl: 60 }
    });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return (j?.events || []).find(e => e.is_next) || null;
  } catch { return null; }
}

export default async function transfer(env, chatId) {
  const ev = await nextEvent();
  const gw = ev?.id ?? "—";

  // Until team-linking & bank exist, use placeholders
  const teamName = "—";
  const bank = "—";

  const html = [
    `<b>${esc("Team Name")}</b> ${esc(teamName)} | <b>${esc("GW")}</b> ${esc(String(gw))} — <b>${esc("Transfer")}</b>`,
    `<b>${esc("Bank:")}</b> £${esc(String(bank))} | <b>${esc("Free Transfer:")}</b> ${esc("(If not use FT before +1, assume 1)")} | <b>${esc("Hit:")}</b> ${esc("(-4 after 1FT)")}`
  ].join("\n");

  await send(env, chatId, html, "HTML");
}
