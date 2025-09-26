import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

export default async function start(env, chatId, from) {
  const first = (from?.first_name || "there").trim();
  const html = [
    `${B(`Hey ${first}!`)}`,
    "",
    `${B("What I can do now")}`,
    "• /link  — save your FPL team",
    "• /unlink — forget the saved team",
    "• /transfer — view transfer header (bank, FT, hits)"
  ].join("\n");

  await send(env, chatId, html, "HTML");
}