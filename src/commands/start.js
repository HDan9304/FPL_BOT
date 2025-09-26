import { send } from "../utils/telegram.js";
import { ascii, esc, B } from "../utils/fmt.js";

export default async function start(env, chatId, msg) {
  const first = ascii((msg?.from?.first_name || "there").trim());

  const html = [
    `<b>${esc(`Hey ${first}!`)}</b>`,
    "",
    `${B("This bot is alive")}`,
    `Right now I only support <code>/start</code>.`,
    "",
    `${B("Next step")}`,
    `Tell me when you're ready to add <code>/deadline</code> or reminders.`
  ].join("\n");

  await send(env, chatId, html, "HTML");
}
