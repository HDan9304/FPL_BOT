// src/index.js — Worker entry/router

import startCmd     from "./src/commands/start.js";
import linkCmd      from "./src/commands/link.js";
import unlinkCmd    from "./src/commands/unlink.js";
import transferCmd  from "./src/commands/transfer.js";
import planCmd      from "./src/commands/plan.js";
import chipCmd      from "./src/commands/chip.js";     // <— NEW
import { send }     from "./src/utils/telegram.js";

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // Webhook init
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

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) return text("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }

      const msg = update?.message;
      if (!msg) return text("ok");
      const chatId = msg?.chat?.id;
      const t = (msg?.text || "").trim();
      if (!chatId) return text("ok");

      const { name, arg } = parseCmd(t);

      switch (name) {
        case "start":
        case "":
          await startCmd(env, chatId, msg.from);
          break;
        case "link":
          await linkCmd(env, chatId, arg);
          break;
        case "unlink":
          await unlinkCmd(env, chatId);
          break;
        case "transfer":
          await transferCmd(env, chatId, arg);
          break;
        case "plan":
          await planCmd?.(env, chatId, arg);
          break;
        case "chip":                         // <— NEW
          await chipCmd(env, chatId, arg);
          break;
        default:
          await startCmd(env, chatId, msg.from);
      }
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

function parseCmd(t) {
  if (!t.startsWith("/")) return { name: "", arg: "" };
  const space = t.indexOf(" ");
  const name = (space === -1 ? t.slice(1) : t.slice(1, space)).toLowerCase();
  const arg  = (space === -1 ? "" : t.slice(space+1)).trim();
  return { name, arg };
}