// command/transfer.js — minimal stub (to be implemented later)
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

export default async function transfer(env, chatId, arg = "") {
  const html = [
    `${B("Transfer")}`,
    "This feature isn’t implemented yet. We’ll add planning logic here soon."
  ].join("\n");
  await send(env, chatId, html, "HTML");
}
