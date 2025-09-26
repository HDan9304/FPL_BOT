import { send } from "../utils/telegram.js";
import { ascii, esc, B } from "../utils/fmt.js";

export default async function start(env, chatId, msg) {
  const first = ascii((msg?.from?.first_name || "there").trim());
  const html = [
    `<b>${esc(`Hey ${first}!`)}</b>`,
    "",
    `${B("Link your team")}`,
    `Use <code>/link &lt;team_id&gt;</code> (find it in the FPL URL like <code>/entry/1234567/</code>).`
  ].join("\n");
  await send(env, chatId, html, "HTML");
}
