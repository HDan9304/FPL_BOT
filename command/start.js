// command/start.js — updated start with /wildcard listed
import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

export default async function start(env, chatId, from) {
  const first = (from?.first_name || "there").trim();

  const html = [
    `${B(`Hey ${first}!`)}`,
    "",
    `${B("What I can do now")}`,
    "• /link        — save your FPL team",
    "• /unlink      — forget the saved team",
    "• /transfer    — get Pro plans (A–D) with simple summary",
    "• /plan        — best formation & XI per plan (uses /transfer plans)",
    "• /chip        — simplified Pro advice on when/what chip to use",
    "• /benchboost  — deep-dive BB readiness (checks Plans A–D)",
    "• /wildcard    — should you play the Wildcard now?",
  ].join("\n");

  await send(env, chatId, html, "HTML");
}