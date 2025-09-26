// src/index.js — routes: /start, /link, /unlink, /transfer, /plan[a|b|c|d]

import startCmd     from "./src/commands/start.js";
import linkCmd      from "./src/commands/link.js";
import unlinkCmd    from "./src/commands/unlink.js";
import transferCmd  from "./src/commands/transfer.js";
import planCmd      from "./src/commands/plan.js";
import { send }     from "./src/utils/telegram.js";

// Worker export
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/$/, "");

    if (req.method === "GET" && (path === "" || path === "/")) return new Response("OK");
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
      const j = await r.json().catch(()=>({}));
      return new Response(j?.ok ? "webhook set" : `failed: ${j?.description || "unknown"}`, { status: j?.ok ? 200 : 500 });
    }

    if (path === "/webhook/telegram" && req.method === "POST") {
      if (req.headers.get("x-telegram-bot-api-secret-token") !== env.TELEGRAM_WEBHOOK_SECRET)
        return new Response("Forbidden", { status: 403 });

      let update; try { update = await req.json(); } catch { return new Response("OK"); }
      const msg = update?.message;
      if (!msg?.chat?.id) return new Response("OK");
      const chatId = msg.chat.id;
      const text = (msg.text || "").trim();

      const { cmd, arg } = parseCmd(text);

      try {
        if (!cmd || cmd === "/start")        { await startCmd(env, chatId, msg.from); return new Response("OK"); }
        if (cmd === "/link")                 { await linkCmd(env, chatId, arg);       return new Response("OK"); }
        if (cmd === "/unlink")               { await unlinkCmd(env, chatId);          return new Response("OK"); }
        if (cmd === "/transfer")             { await transferCmd(env, chatId, arg);   return new Response("OK"); }

        // Plan variants
        if (cmd === "/plan")                 { await planCmd(env, chatId, "a");       return new Response("OK"); }
        if (cmd === "/planb")                { await planCmd(env, chatId, "b");       return new Response("OK"); }
        if (cmd === "/planc")                { await planCmd(env, chatId, "c");       return new Response("OK"); }
        if (cmd === "/pland")                { await planCmd(env, chatId, "d");       return new Response("OK"); }

        // Unknown -> small help
        await send(env, chatId, "Try /start, /link <id>, /unlink, /transfer, /plan", "HTML");
      } catch (e) {
        await send(env, chatId, "Oops, I hit an error. Try again shortly.", "HTML");
      }
      return new Response("OK");
    }

    return new Response("Not Found", { status: 404 });
  }
};

function parseCmd(t) {
  if (!t.startsWith("/")) return { cmd: "", arg: "" };
  const space = t.indexOf(" ");
  const cmd = (space === -1 ? t : t.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : t.slice(space + 1).trim();
  return { cmd, arg };
}