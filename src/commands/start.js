import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

export default async function start(env, chatId, from) {
  const first = (from?.first_name || "there").trim();

  // NOTE: commands are plain text (no <code>) so Telegram makes them tappable.
  const html = [
    `${B(`Hey ${first}!`)}`,
    "",
    `${B("Commands")}`,
    "• /link <TeamID> — save your FPL team",
    "• /unlink — forget the saved team",
    "",
    `${B("Where to find Team ID")}`,
    "Open fantasy.premierleague.com → My Team (URL shows /entry/1234567/)",
    "",
    `${B("Example")}`,
    "/link 1234567"
  ].join("\n");

  await send(env, chatId, html, "HTML");
}
