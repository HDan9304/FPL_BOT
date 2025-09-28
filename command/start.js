import { send } from "../utils/telegram.js";
import { esc } from "../utils/fmt.js";

const B = (s) => `<b>${esc(s)}</b>`;

export default async function start(env, chatId, from) {
  const first = (from?.first_name || "there").trim();
  const html = [
    `${B(`Hey ${first}!`)}`,
    "",
    `${B("What I can do now")}`,
    "• /link — save your FPL team",
    "• /unlink — forget the saved team",
    "• /transfer — next-GW plans A–D",
    "• /plan — best XI/formation per plan",
    "• /chip — when to use chips (simple)",
    "• /benchboost — BB helper (plans aware)",
    "• /wildcard — should you WC (w/ draft if yes)",
    "• /wcsquad — what-if wildcard draft (no chip used)" // <— NEW
  ].join("\n");

  await send(env, chatId, html, "HTML");
}
