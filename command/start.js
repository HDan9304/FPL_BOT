// ./command/start.js
// Start screen with tappable commands and link status

import { send } from "../utils/telegram.js";
import { esc }  from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;
const kUser = (id) => `user:${id}:profile`;

export default async function start(env, chatId, from) {
  const first = ((from?.first_name || "there") + "").trim();

  // Check if this chat is already linked
  let linkLine = "";
  try {
    const raw = await env.FPL_BOT_KV.get(kUser(chatId));
    if (raw) {
      const p = JSON.parse(raw);
      if (p?.teamId) {
        linkLine = `${B("Linked")}: Team ID ${esc(String(p.teamId))}`;
      }
    }
  } catch {}

  const html = [
    `${B(`Hey ${first}!`)}`,
    linkLine ? `\n${linkLine}\n` : "",
    `${B("What I can do now")}`,
    "• /link — link your FPL team",
    "• /unlink — forget the saved team",
    "• /transfer — next-GW transfer plans (auto)",
    "• /plan — best XI now (Plan A)\n  also: /planb /planc /pland",
    "• /chip — chip windows (Pro auto)",
    "",
    `${B("Tip")}: just tap a command above to run it.`
  ].join("\n");

  await send(env, chatId, html, "HTML");
}