import { send } from "../utils/telegram.js";

const kUser = (id) => `user:${id}:profile`;

export default async function unlink(env, chatId) {
  try {
    if (env.FPL_BOT_KV) await env.FPL_BOT_KV.delete(kUser(chatId));
    await send(
      env,
      chatId,
      "<b>Unlinked.</b>\nYou can link again anytime with <code>/link &lt;team_id&gt;</code>.",
      "HTML"
    );
  } catch {
    await send(env, chatId, "Unlink failed. Please try again.", "HTML");
  }
}
