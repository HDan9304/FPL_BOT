// index.js — Cloudflare Worker entry (no lazy imports, ./command/* paths)
// Env:
//   TELEGRAM_BOT_TOKEN (secret)
//   TELEGRAM_WEBHOOK_SECRET (secret)
// KV:
//   FPL_BOT_KV

import startCmd    from "./command/start.js";
import linkCmd     from "./command/link.js";
import unlinkCmd   from "./command/unlink.js";
import transferCmd from "./command/transfer.js";
import planCmd     from "./command/plan.js";
import chipCmd     from "./command/chip.js";

import { send } from "./utils/telegram.js";

// Small helpers
const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function parseCmdFromMessage(msg) {
  // Prefer Telegram entities when available (tappable commands, etc.)
  const raw = (msg?.text || msg?.caption || "").trim();
  const entities = msg?.entities || msg?.caption_entities || [];
  const botEnt = entities.find(e => e.type === "bot_command" && e.offset === 0);
  if (botEnt) {
    const cmd = raw.slice(botEnt.offset, botEnt.offset + botEnt.length).toLowerCase();
    const name = cmd.replace(/^\/+/,"").replace(/@\S+$/,""); // strip leading / and @bot
    const args = raw.slice(botEnt.offset + botEnt.length).trim();
    return { name, args };
  }
  // Fallback: simple split when no entities
  if (raw.startsWith("/")) {
    const sp = raw.indexOf(" ");
    const cmd = sp === -1 ? raw.slice(1) : raw.slice(1, sp);
    const args = sp === -1 ? "" : raw.slice(sp + 1).trim();
    return { name: cmd.toLowerCase(), args };
  }
  return { name: "", args: "" };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health
    if (req.method === "GET" && (path === "" || path === "/")) return text("OK");

    // Webhook registration
    if (req.method === "GET" && path === "/init-webhook") {
      try {
        const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            url: `${url.origin}/webhook/telegram`,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message","edited_message"],
            drop_pending_updates: true
          })
        });
        const j = await r.json().catch(()=>({}));
        return text(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
      } catch {
        return text("failed: network", 500);
      }
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return text("Forbidden", 403);
      }

      let update;
      try { update = await req.json(); } catch { return text("Bad Request", 400); }

      const msg = update?.message || update?.edited_message;
      if (!msg?.chat?.id) return text("ok");
      const chatId = msg.chat.id;

      // Light heartbeat to KV (optional)
      try { await env.FPL_BOT_KV.put(`chat:${chatId}:last_seen`, String(Date.now())); } catch {}

      const { name, args } = parseCmdFromMessage(msg);

      // Route
      try {
        // /start
        if (name === "start" || name === "") {
          await startCmd(env, chatId, msg.from);
          return text("ok");
        }

        // /link
        if (name === "link") {
          await linkCmd(env, chatId, args);
          return text("ok");
        }

        // /unlink
        if (name === "unlink") {
          await unlinkCmd(env, chatId);
          return text("ok");
        }

        // /transfer
        if (name === "transfer") {
          await transferCmd(env, chatId, args);
          return text("ok");
        }

        // /plan, /planb, /planc, /pland
        if (name === "plan" || name === "planb" || name === "planc" || name === "pland") {
          // Pass the command name so the handler can pick the variant (A/B/C/D)
          await planCmd(env, chatId, name, args);
          return text("ok");
        }

        // /chip (Pro Auto mode inside chip.js uses presets)
        if (name === "chip") {
          await chipCmd(env, chatId, args);
          return text("ok");
        }

        // Unknown → show /start
        await startCmd(env, chatId, msg.from);
        return text("ok");
      } catch (e) {
        // last-resort user-friendly error
        try { await send(env, chatId, "I hit an error. Try again in a moment."); } catch {}
        return text("ok");
      }
    }

    return text("Not Found", 404);
  }
};