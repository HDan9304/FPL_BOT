// src/index.js — Cloudflare Worker entry & router
// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET
// KV binding: FPL_BOT_KV
// Commands wired: /start, /link (alias /linkteam), /unlink, /transfer, /plan

import startCmd    from "./commands/start.js";
import linkCmd     from "./commands/link.js";
import unlinkCmd   from "./commands/unlink.js";
import transferCmd from "./commands/transfer.js";
import planCmd     from "./commands/plan.js";
import { send }    from "./utils/telegram.js";

// Small helper
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(req, env) {
    const url  = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // Init webhook
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

    // Simple diag
    if (req.method === "GET" && path === "/diag") {
      const ok = Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET);
      return new Response(JSON.stringify({ ok }, null, 2), {
        headers: { "content-type": "application/json" }
      });
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return text("Forbidden", 403);

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }

      const msg = update?.message || update?.edited_message;
      if (!msg?.chat?.id) return text("ok");

      const chatId = msg.chat.id;
      const { cmd, arg } = extractCommand(msg);

      // No command → show /start
      if (!cmd) { await startCmd(env, chatId, msg.from); return text("ok"); }

      // Route
      if (cmd === "/start") {
        await startCmd(env, chatId, msg.from); return text("ok");
      }

      if (cmd === "/link" || cmd === "/linkteam") {
        await linkCmd(env, chatId, arg); return text("ok");
      }

      if (cmd === "/unlink" || cmd === "/unlinkteam") {
        await unlinkCmd(env, chatId); return text("ok");
      }

      if (cmd === "/transfer") {
        await transferCmd(env, chatId, arg); return text("ok");
      }

      if (cmd === "/plan") {
        await planCmd(env, chatId, arg); return text("ok");
      }

      // Fallback: unknown → /start
      await startCmd(env, chatId, msg.from);
      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ------------ command parsing (robust) ------------- */
function extractCommand(msg) {
  const raw = (msg.text || msg.caption || "").trim();
  if (!raw) return { cmd: null, arg: "" };

  // Prefer Telegram's entity for commands at offset 0 when present
  const ent = (msg.entities || msg.caption_entities || []).find(
    (e) => e.type === "bot_command" && e.offset === 0
  );

  let cmd = null;
  let arg = "";

  if (ent) {
    cmd = raw.slice(ent.offset, ent.offset + ent.length);
    arg = raw.slice(ent.offset + ent.length).trim();
  } else if (raw.startsWith("/")) {
    const sp = raw.indexOf(" ");
    cmd = sp === -1 ? raw : raw.slice(0, sp);
    arg = sp === -1 ? "" : raw.slice(sp + 1).trim();
  }

  if (!cmd) return { cmd: null, arg: "" };

  // Strip @BotUser suffix if present
  cmd = cmd.replace(/@\S+$/, "").toLowerCase();

  return { cmd, arg };
}