// index.js — Cloudflare Worker router (Telegram Bot)
//
// Env requirements:
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_WEBHOOK_SECRET
// KV binding:
//   FPL_BOT_KV
//
// Folders used:
//   ./command/start.js
//   ./command/link.js
//   ./command/unlink.js
//   ./command/transfer.js
//   ./command/plan.js
//   ./command/chip.js
//   ./utils/telegram.js
//   ./utils/fmt.js
//
// Notes:
// - Eager imports (no lazy/dynamic imports) to avoid bundler path issues.
// - Only handles Telegram "message" updates (as set in /init-webhook).
// - Unknown commands route to /start.

import startCmd    from "./command/start.js";
import linkCmd     from "./command/link.js";
import unlinkCmd   from "./command/unlink.js";
import transferCmd from "./command/transfer.js";
import planCmd     from "./command/plan.js";
import chipCmd     from "./command/chip.js";

import { send }    from "./utils/telegram.js"; // used for generic replies if needed

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    // Health check
    if (req.method === "GET" && (path === "" || path === "/")) {
      return text("OK");
    }

    // Register Telegram webhook
    if (req.method === "GET" && path === "/init-webhook") {
      const webhookUrl = `${url.origin}/webhook/telegram`;
      try {
        const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message"],
            drop_pending_updates: true
          })
        });
        const j = await r.json().catch(() => ({}));
        return text(j?.ok ? `webhook set: ${webhookUrl}` : `failed: ${j?.description || "unknown"}`, j?.ok ? 200 : 500);
      } catch (e) {
        return text("failed: network error", 500);
      }
    }

    // Telegram webhook
    if (path === "/webhook/telegram") {
      if (req.method !== "POST") return text("Method Not Allowed", 405);

      // Verify Telegram secret header
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return text("Forbidden", 403);
      }

      let update;
      try {
        update = await req.json();
      } catch {
        return text("Bad Request", 400);
      }

      const msg = update?.message;
      if (!msg) return text("ok"); // ignore non-message updates (we only subscribe to 'message')

      const chatId = msg?.chat?.id;
      const from   = msg?.from;
      const tRaw   = (msg?.text || "").trim();
      if (!chatId) return text("ok");

      // Touch KV (last seen) — optional but useful
      try { await env.FPL_BOT_KV.put(kLastSeen(chatId), String(Date.now())); } catch {}

      // Parse command
      const { name, args, rawArg } = parseCmd(tRaw);

      try {
        // Route
        switch (name) {
          case "":
          case "start": {
            await startCmd(env, chatId, from);
            break;
          }
          case "link": {
            await linkCmd(env, chatId, args);
            break;
          }
          case "unlink": {
            await unlinkCmd(env, chatId);
            break;
          }
          case "transfer": {
            // Pass the **raw** arg string (space-joined) to preserve options like "chase pos=DEF"
            await transferCmd(env, chatId, rawArg);
            break;
          }
          case "plan": {
            // "/plan" optionally takes a variant (e.g., "B", "C", "D") or none
            await planCmd(env, chatId, rawArg);
            break;
          }
          case "planb": {
            await planCmd(env, chatId, "B");
            break;
          }
          case "planc": {
            await planCmd(env, chatId, "C");
            break;
          }
          case "pland": {
            await planCmd(env, chatId, "D");
            break;
          }
          case "chip": {
            await chipCmd(env, chatId, rawArg);
            break;
          }
          default: {
            // Unknown → show /start
            await startCmd(env, chatId, from);
          }
        }
      } catch (err) {
        // If any command throws, fail gracefully so Telegram doesn't retry forever
        try { await send(env, chatId, "Something went wrong. Please try again in a bit."); } catch {}
      }

      return text("ok");
    }

    return text("Not Found", 404);
  }
};

/* ---------------- utils (local) ---------------- */

const text = (s, status = 200) =>
  new Response(s, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

function kLastSeen(id) { return `chat:${id}:last_seen`; }

// Parse "/cmd arg1 arg2 ..." and strip optional "@BotName"
function parseCmd(t) {
  if (!t || t[0] !== "/") return { name: "", args: [], rawArg: "" };

  const parts = t.split(/\s+/);
  const head = parts[0].slice(1);          // remove leading "/"
  const at   = head.indexOf("@");
  const name = (at >= 0 ? head.slice(0, at) : head).toLowerCase();

  const args = parts.slice(1);
  const rawArg = args.join(" ").trim();

  return { name, args, rawArg };
}