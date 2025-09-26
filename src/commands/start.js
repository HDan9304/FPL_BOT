import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

export default async function start(env, chatId, from) {
  const first = (from?.first_name || "there").trim();
  const html = [
    `${B(`Hey ${first}!`)}`,
    "",
    `${B("What I can do now")}`,
    "• <code>/link &lt;TeamID&gt;</code> — save your FPL team",
    "• <code>/unlink</code> — forget the saved team",
    "",
    `${B("Where to find Team ID")}`,
    "Open <u>fantasy.premierleague.com</u> → My Team (URL shows <code>/entry/1234567/</code>)",
    "",
    `${B("Example")}`,
    "<code>/link 1234567</code>"
  ].join("\n");

  await send(env, chatId, html, "HTML");
}
