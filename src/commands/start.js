import { send } from "../utils/telegram.js";

// small helper for safe bold
const esc = (s) => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const B = (s) => `<b>${esc(s)}</b>`;

export default async function start(env, chatId, from) {
  const first = (from?.first_name || "there").trim();

  // NOTE:
  // - Commands are plain text (no <code>) so they are tappable.
  // - We send with parse_mode "HTML" so <b> works.
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

  await send(env, chatId, html, "HTML"); // <= ensure HTML parse mode
}
