import { send } from "../utils/telegram.js";
import { ascii, esc, B, startLink } from "../utils/fmt.js";

export default async function start(env, chatId, msg) {
  const first = ascii((msg?.from?.first_name || "there").trim());
  const tapStart = startLink(env) || "<code>/start</code>"; // deep link if BOT_USERNAME exists

  const html = [
    `<b>${esc(`Hey ${first}!`)}</b>`,
    "",
    `${B("This bot is alive")}`,
    `Right now I only support ${tapStart}.`,
    "",
    `${B("Tip")}`,
    `You can tap ${tapStart} to run it again.`
  ].join("\n");

  await send(env, chatId, html, "HTML");
}
