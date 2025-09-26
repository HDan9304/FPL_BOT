// Telegram webhook entry (minimal router)
// Env: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV : FPL_BOT_KV

import startCmd from "./commands/start.js";
import linkCmd from "./commands/link.js";
import unlinkCmd from "./commands/unlink.js";
import transferCmd from "./commands/transfer.js";

function text(s, status = 200) {
  return new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function parseCmd(msg) {
  const raw = (msg?.text || "").trim();
  if (!raw.startsWith("/")) return { name: "", args: [] };
  const parts = raw.split(/\s+/);
  return { name: parts[0].slice(1).toLowerCase(), args: parts.slice(1) };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // register webhook
    if (req.method === "GET" && path === "/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          url: `${url.origin}/webhook/telegram`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates: ["message"],
          drop_pending_updates: true
        })
      });
      const j = await r.json().catch(() => ({}));
      return text(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
    }

    // webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden", 403);

      let update; try { update = await req.json(); } catch { return text("OK"); }
      const msg = update?.message;
      if (!msg?.chat?.id) return text("OK");

      const chatId = msg.chat.id;
      const { name } = parseCmd(msg);

      if (name === "start" || name === "") { await startCmd(env, chatId, msg.from); return text("OK"); }
      if (name === "link"  || name === "linkteam") { await linkCmd(env, chatId, msg); return text("OK"); }
      if (name === "unlink") { await unlinkCmd(env, chatId); return text("OK"); }
      if (name === "transfer" || name === "transfers") { await transferCmd(env, chatId); return text("OK"); }

      await startCmd(env, chatId, msg.from); // fallback
      return text("OK");
    }

    return text("Not Found", 404);
  }
};