/* FPL Telegram Bot — Cloudflare Workers (all-in-one)
   Commands:
   /start /help /settings /linkteam /unlink /myteam /squad /captain
   /transfers /plan /formation /risk /chipplan /suggest
   /alerts on|off|when|set H,H|tz Region/City|test
   /wcwhen [horizon] — Wildcard window advice
   /compare <A> vs <B> [h=N] — player comparison
   /replace <player> [+bank] [max=7.5] [n=3] [team_id] — top swaps for a player

   Scoring (fast):
     Score = PPG × FDR_mult × Minutes × (1 + 0.02 × Form)
     FDR_mult = 1.30  0.10 × clamp(FDR, 2..5)

   Env:
     - Secret: BOT_TOKEN
     - KV binding: TEAM_KV
     - Optional: SETTINGS_CSV_URL (Google Sheet CSV “Settings”)
*/

// ---------- UI toggles ----------
const UI_ASCII = true; // set true if you want pure ASCII symbols
const DASH  = UI_ASCII ? "-"   : "—";
const POUND = UI_ASCII ? "GBP " : "£";

const S = {
  bullet: UI_ASCII ? "-" : "•",
  sep:    UI_ASCII ? "|" : "•",
  none:   UI_ASCII ? "-" : "—",
  times:  UI_ASCII ? "x" : "×",
  warn:   UI_ASCII ? " !" : " ",
  gbp:    (n) => `${POUND}${Number(n).toFixed(1)}m`,
};

// ===============================================================
// Cloudflare Worker entry
// ===============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // manual cron
    if (request.method === "GET" && url.pathname === "/cron") {
      ctx.waitUntil(runAlertsSweep(env));
      return new Response("cron ok");
    }

    if (request.method === "GET" && url.pathname === "/diag") {
      const info = {
        ok: true,
        has_BOT_TOKEN: !!env.BOT_TOKEN,
        has_TEAM_KV: !!env.TEAM_KV,
        has_SETTINGS_CSV_URL: !!env.SETTINGS_CSV_URL
      };
      return new Response(JSON.stringify(info, null, 2), { headers: { "content-type": "application/json" }});
    }

    if (request.method === "GET") return new Response("OK");

    if (request.method === "POST" && url.pathname === "/webhook") {
      let update;
      try { update = await request.json(); } catch { return new Response("OK"); }
      ctx.waitUntil(handleUpdate(env, update).catch(()=>{}));
      return new Response("OK");
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runAlertsSweep(env));
  }
};

// ===============================================================
// Telegram update handler
// ===============================================================
async function handleUpdate(env, update) {
  // --- Inline button callbacks (must run before any other logic) ---
  if (update?.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id;
    const msgId  = cb.message?.message_id;
    const data   = cb.data || "";
    if (!chatId || !msgId) { await answerCb(env, cb.id); return; }

    try {
      const [ns, action] = String(data).split(":"); // e.g., "nav:formation"
      if (ns === "nav") {
        const cfg       = await getSettings(env);
        const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
        const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
        const nextGW    = nextGwId(bootstrap);
        const curGW     = currentGw(bootstrap);
        const teamId    = await resolveTeamId(env, chatId, null);

        let text = "";
        if (!teamId && ["myteam","formation","risk","captain","transfers","plan2","squad_next"].includes(action)) {
          text = "Link your team first: /linkteam <team_id>";
        } else {
          if (action === "myteam") {
            const entry = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            const hist  = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`, 12000);
            const tz    = (await loadAlertsCfg(env, chatId))?.tz || "UTC";
            text = (entry && picks) ? ascii(renderMyTeamDetails(teamId, entry, picks, bootstrap, fixtures, cfg, hist, tz))
                                    : "Couldn't fetch your team. Is it public?";
          }
          else if (action === "formation") {
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            text = picks ? buildFormationReport(picks, bootstrap, fixtures, cfg, nextGW) : "Couldn't fetch your picks.";
          }
          else if (action === "risk") {
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            text = picks ? buildRiskReport(picks, bootstrap, fixtures, cfg, nextGW) : "Couldn't fetch your picks.";
          }
          else if (action === "captain") {
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            text = picks ? ascii(buildCaptainReportPlain(picks, bootstrap, fixtures, cfg, nextGW)) : "Couldn't fetch your picks.";
          }
          else if (action === "transfers") {
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            const entry = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
            if (!picks || !entry) text = "Couldn't fetch your team.";
            else {
              const baseBank = deriveBank(entry, picks, cfg);
              const res = transferSuggestImproved(picks, bootstrap, fixtures, cfg, nextGW, baseBank);
              const LIMIT = 5;
              const header = [
                "Transfer suggestions — next GW",
                `Bank used: ${S.gbp(baseBank)}`,
                `Minutes  ${cfg.min_play_prob}% • Horizon ${cfg.horizon_gw}`
              ].join("\n");
              if (res.best.length) {
                const lines = [header, ""];
                res.best.slice(0, LIMIT).forEach((s, i) => {
                  const dir = s.priceDiff >= 0 ? "+" : "";
                  lines.push(
                    `${i+1}) ${s.outName}  ${s.inName}`,
                    `    Score +${s.delta.toFixed(2)}  ${S.sep}  Price £${dir}${s.priceDiff.toFixed(1)}  ${S.sep}  Bank left ${S.gbp(s.bankLeft)}`
                  );
                });
                text = lines.join("\n");
              } else {
                text = header + "\n\nNo guaranteed upgrades within constraints.";
              }
            }
          }
          else if (action === "plan2") {
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            const entry = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
            if (!picks || !entry) text = "Couldn't fetch your team.";
            else {
              const baseBank = deriveBank(entry, picks, cfg);
              const singles  = transferSuggestImproved(picks, bootstrap, fixtures, cfg, nextGW, baseBank).best.slice(0, 14);
              const freeT    = Number(cfg.free_transfers ?? 1);
              const best2    = bestComboFromSingles(singles, picks, bootstrap, fixtures, cfg, nextGW, baseBank, 2);
              if (!best2) text = "No affordable two-move combo within constraints.";
              else {
                const hit2 = Math.max(0, 2 - freeT) * 4;
                const net2 = best2.deltaTotal - hit2;
                const [a,b] = best2.moves;
                text = [
                  "Plan (2 moves):",
                  `• ${a.outName}  ${a.inName}  ( +${a.delta.toFixed(2)})`,
                  `• ${b.outName}  ${b.inName}  ( +${b.delta.toFixed(2)})`,
                  `Total  +${best2.deltaTotal.toFixed(2)}  ${S.sep}  Bank left ${S.gbp(best2.bankLeft)}`,
                  `Hit ${hit2?`-${hit2}`:"0"}    Net ${net2.toFixed(2)}`
                ].join("\n");
              }
            }
          }
          else if (action === "squad_next") {
            const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${curGW}/picks/`, 12000);
            text = picks ? renderSquadEnhanced(picks, bootstrap, fixtures, cfg, nextGW) : "Couldn't fetch your picks.";
          }
          else {
            text = "Unknown action.";
          }
        }

        await answerCb(env, cb.id);
        await editMessage(env, chatId, msgId, text, "Markdown", navInlineKeyboard());
        return;
      }
    } catch (e) {
      await answerCb(env, cb.id, "Something went wrong. Try again.");
    }
    return;
  }

  // auto-intro on bot added to a private chat
  if (update?.my_chat_member && isUserStartedPrivate(update.my_chat_member)) {
    const chatId = update.my_chat_member.chat.id;
    await reply(env, chatId, welcomeText() + "\n\n" + helpText(), "Markdown");
    return;
  }

  const msg = update?.message || update?.edited_message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;
  const { cmd, arg } = extractCommand(msg);   // <<< NOW IMPLEMENTED

  if (!cmd) { await reply(env, chatId, "Hi! Type /help for what I can do."); return; }
  if (cmd === "/ping") { await reply(env, chatId, "pong "); return; }
  if (cmd === "/help_more") { 
    await reply(env, chatId, helpTextFull(), "Markdown"); 
    return; 
  }
  if (cmd === "/help" || cmd === "/start") {
    await reply(env, chatId, welcomeText() + "\n\n" + helpText(), "Markdown"); 
    return;
  }

  // ---------- Settings ----------
  if (["/settings","/setting","/config"].includes(cmd)) {
    if (!env.SETTINGS_CSV_URL) {
      await reply(env, chatId,
`No SETTINGS_CSV_URL configured.

1) Google Sheets  File  Share  Publish to web  pick "Settings" tab  CSV  copy link.
2) Cloudflare  Worker  Settings  Variables  add SETTINGS_CSV_URL (Text).
3) Deploy.`);
      return;
    }
    const cfg = await getSettings(env);
    const lines = Object.entries(cfg).map(([k,v]) => `${S.bullet} ${k}: ${v}`);
    await reply(env, chatId, "*Current settings:*\n" + lines.join("\n"), "Markdown");
    return;
  }

  // ---------- Link / Unlink ----------
  if (cmd === "/linkteam") {
    if (!/^\d+$/.test(arg)) { await reply(env, chatId, "Usage: /linkteam <team_id>"); return; }
    if (!env.TEAM_KV) { await reply(env, chatId, "KV not configured — pass the id each time (e.g. /squad 1234567)."); return; }
    await env.TEAM_KV.put(kvKey(chatId), String(arg), { expirationTtl: 60*60*24*365 });
    await reply(env, chatId, `Linked this chat to team ${arg}. Use /myteam to confirm.`);
    return;
  }
  if (cmd === "/unlink") {
    if (env.TEAM_KV) await env.TEAM_KV.delete(kvKey(chatId));
    await reply(env, chatId, "Unlinked. You can /linkteam again anytime.");
    return;
  }

  // ---------- Alerts ----------
  if (cmd === "/alerts") {
    if (!env.TEAM_KV) { await reply(env, chatId, "Alerts need KV. Bind TEAM_KV first."); return; }
    const cfg = await loadAlertsCfg(env, chatId);
    const a = (arg || "").trim();

    if (/^on$/i.test(a))  { cfg.on = true;  await saveAlertsCfg(env, chatId, cfg); await reply(env, chatId, "Alerts  ON. Use /alerts set 24,2 and /alerts tz Asia/Kuala_Lumpur"); return; }
    if (/^off$/i.test(a)) { cfg.on = false; await saveAlertsCfg(env, chatId, cfg); await reply(env, chatId, "Alerts  OFF."); return; }
    if (/^when$/i.test(a)){ await reply(env, chatId, `Alerts: ${cfg.on ? "ON" : "OFF"} • windows: ${cfg.tminus.join(",")}h • tz: ${cfg.tz}`); return; }

    const mSet = a.match(/^set\s+([\d,\s]+)$/i);
    if (mSet) {
      const arr = mSet[1].split(",").map(s => parseInt(s.trim(),10)).filter(n => Number.isFinite(n) && n>0 && n<=96);
      if (!arr.length) { await reply(env, chatId, "Usage: /alerts set 24,2"); return; }
      cfg.tminus = Array.from(new Set(arr)).sort((x,y)=>x-y);
      await saveAlertsCfg(env, chatId, cfg);
      await reply(env, chatId, `Alert windows set to: ${cfg.tminus.join(",")}h`);
      return;
    }

    const mTz = a.match(/^tz\s+([A-Za-z_\/-]+)$/i);
    if (mTz) { cfg.tz = mTz[1]; await saveAlertsCfg(env, chatId, cfg); await reply(env, chatId, `Alert timezone set to: ${cfg.tz}`); return; }

    if (/^test$/i.test(a)) { await sendAlertForChat(env, String(chatId), await getSettings(env), cfg, true); return; }

    await reply(env, chatId,
`/alerts on — enable reminders
/alerts off — disable
/alerts when — show windows & timezone
/alerts set 24,2 — set hours before deadline
/alerts tz Asia/Kuala_Lumpur — set your local time
/alerts test — send a test message now`);
    return;
  }

/* ---------- MyTeam ---------- */
if (cmd === "/myteam") {
  try {
    const explicitId = /^\d+$/.test((arg||"").trim()) ? parseInt(arg,10) : null;
    const teamId = await resolveTeamId(env, chatId, arg);
    if (!teamId) { await reply(env, chatId, "No team linked. Use /linkteam <team_id> or /myteam <team_id>."); return; }
    if (explicitId && env.TEAM_KV) await env.TEAM_KV.put(kvKey(chatId), String(explicitId), { expirationTtl: 60*60*24*365 });

    const cfg       = await getSettings(env);
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const entry     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
    const gw        = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`, 12000);
    const hist      = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`, 12000);

    if (!entry || !picks) { await reply(env, chatId, "Couldn't fetch your team. Check the team id and that your team is public."); return; }

    const alertsCfg = await loadAlertsCfg(env, chatId);
    const tz = (alertsCfg && typeof alertsCfg.tz === "string") ? alertsCfg.tz.trim() : "UTC";

    const txt = renderMyTeamDetails(teamId, entry, picks, bootstrap, fixtures, cfg, hist, tz);
    await reply(env, chatId, ascii(txt), "Markdown", navInlineKeyboard());
  } catch (e) {
    console.error("myteam error", e && (e.stack || e));
    await reply(env, chatId,
      "I hit an error rendering your team.\n" +
      "Try setting your timezone again: `/alerts tz Asia/Kuala_Lumpur` (or your city)\n" +
      "Then run `/myteam` once more.",
      "Markdown"
    );
  }
  return;
}

  // ---------- Captain (PLAIN version) ----------
if (cmd === "/captain") {
  const cArgs  = parseCaptainArgs(arg);
  const teamId = await resolveTeamId(env, chatId, cArgs.teamIdOverride ?? "");
  if (!teamId) { await reply(env, chatId, "Include a team id (e.g., /captain 1234567) or /linkteam first."); return; }

  const cfg0 = await getSettings(env);
  const cfg  = { ...cfg0 };
  if (cArgs.h)   cfg.horizon_gw    = cArgs.h;
  if (cArgs.min) cfg.min_play_prob = cArgs.min;
  if (cArgs.top) cfg.captain_top_k = cArgs.top;

  const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
  const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
  const nextGW    = nextGwId(bootstrap);
  const currentGW = currentGw(bootstrap);
  const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
  if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

  const txt = buildCaptainReportPlain(picks, bootstrap, fixtures, cfg, nextGW);
  await reply(env, chatId, ascii(txt));
  return;
}

  // ---------- Transfers (ranked 1-move upgrades) ----------
  if (cmd === "/transfers") {
    const tArgs = parseTransferArgs(arg); // countOverride, teamIdOverride, bankOverride, minOverride
    const teamId = await resolveTeamId(env, chatId, tArgs.teamIdOverride ?? "");
    if (!teamId) { await reply(env, chatId, "Include your team id (e.g., /transfers 1234567) or /linkteam first."); return; }

    const cfg0      = await getSettings(env);
    const cfg       = { ...cfg0 };
    if (tArgs.minOverride) cfg.min_play_prob = tArgs.minOverride;

    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const nextGW    = nextGwId(bootstrap);
    const currentGW = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
    const entry     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    const baseBank = deriveBank(entry, picks, cfg0);
    const useBank  = baseBank + (tArgs.bankOverride || 0);

    const res = transferSuggestImproved(picks, bootstrap, fixtures, cfg, nextGW, useBank);
    const LIMIT = Math.max(1, Math.min(50, tArgs.countOverride ?? 5));

    const header = [
      "Transfer suggestions — next GW",
      `Bank used: ${S.gbp(useBank)} (base ${S.gbp(baseBank)}${tArgs.bankOverride?` + override ${S.gbp(tArgs.bankOverride)}`:``})`,
      `Minutes  ${cfg.min_play_prob}% • Horizon ${cfg.horizon_gw}`
    ].join("\n");

    if (res.best.length) {
      const lines = [header, ""];
      res.best.slice(0, LIMIT).forEach((s, i) => {
        const dir = s.priceDiff >= 0 ? "+" : "";
        lines.push(
          `${i+1}) ${s.outName}  ${s.inName}`,
          `    Score +${s.delta.toFixed(2)}  ${S.sep}  Price £${dir}${s.priceDiff.toFixed(1)}  ${S.sep}  Bank left ${S.gbp(s.bankLeft)}`,
          `    OUT: ${s.outPos} ${S.gbp(s.outSell)}   |   IN: ${s.inPos} ${S.gbp(s.inPrice)}`,
          ""
        );
      });
      if (res.nearMiss.length) {
        lines.push("Near-miss upgrades (need extra funds):");
        res.nearMiss.forEach(s => lines.push(`${S.bullet} ${s.outName}  ${s.inName}  |   +${s.delta.toFixed(2)}  |  Short £${s.shortfall.toFixed(1)}m`));
      }
      lines.push("", "Tip: `/transfers 10` to see more • `+0.5` to add bank • `min=75` to relax minutes.");
      await reply(env, chatId, lines.join("\n"));
      return;
    }

    const lines = [header, "", "No guaranteed upgrades within constraints."];
    if (res.nearMiss.length) {
      lines.push("", "Near-miss upgrades (positive Score but short of cash):");
      res.nearMiss.forEach(s => lines.push(`${S.bullet} ${s.outName} (${s.outPos})  ${s.inName} (${s.inPos})  |   +${s.delta.toFixed(2)}  |  Short £${s.shortfall.toFixed(1)}m`));
    }
    if (res.sidegrades.length) {
      lines.push("", "Sidegrades (affordable, tiny negative ):");
      res.sidegrades.forEach(s => lines.push(`${S.bullet} ${s.outName} (${s.outPos})  ${s.inName} (${s.inPos})  |   ${s.delta.toFixed(2)}  |  Bank left ${S.gbp(s.bankLeft)}`));
    }
    lines.push("", "Tip: try `/transfers +0.5` or `/transfers min=75`.");
    await reply(env, chatId, lines.join("\n"));
    return;
  }

  // ---------- Plan (0/1/2/3 moves with hits) ----------
  if (cmd === "/plan") {
    // /plan [N] [+0.5] [min=75] [team_id]
    const tArgs = parseTransferArgs(arg);
    const firstTok = (arg||"").trim().split(/\s+/)[0];
    let N = 3;
    if (/^[0-3]$/.test(firstTok)) N = parseInt(firstTok,10);

    const teamId = await resolveTeamId(env, chatId, tArgs.teamIdOverride ?? "");
    if (!teamId) { await reply(env, chatId, "Include your team id (e.g., /plan 2 1234567) or /linkteam first."); return; }

    const cfg0      = await getSettings(env);
    const cfg       = { ...cfg0 };
    if (tArgs.minOverride) cfg.min_play_prob = tArgs.minOverride;

    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const nextGW    = nextGwId(bootstrap);
    const currentGW = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
    const entry     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    const baseBank = deriveBank(entry, picks, cfg0);
    const useBank  = baseBank + (tArgs.bankOverride || 0);
    const freeT    = Number(cfg.free_transfers ?? 1);

    const singles = transferSuggestImproved(picks, bootstrap, fixtures, cfg, nextGW, useBank).best.slice(0, 14);

    const best1 = singles[0] || null;
    const hit1  = Math.max(0, 1 - freeT) * 4;
    const net1  = best1 ? best1.delta - hit1 : -Infinity;

    const best2 = bestComboFromSingles(singles, picks, bootstrap, fixtures, cfg, nextGW, useBank, 2);
    const hit2  = Math.max(0, 2 - freeT) * 4;
    const net2  = best2 ? (best2.deltaTotal - hit2) : -Infinity;

    let best3=null, hit3=0, net3=-Infinity;
    if (N>=3) {
      best3 = bestComboFromSingles(singles, picks, bootstrap, fixtures, cfg, nextGW, useBank, 3);
      hit3  = Math.max(0, 3 - freeT) * 4;
      net3  = best3 ? (best3.deltaTotal - hit3) : -Infinity;
    }

    const lines = [];
    lines.push(`Transfer planner — next GW`);
    lines.push(`Bank ${S.gbp(useBank)} • FT ${freeT} • Minutes  ${cfg.min_play_prob}% • Horizon ${cfg.horizon_gw}`);
    lines.push("");

    // 0
    lines.push("0) Save transfer");
    lines.push("   Net +0.00");
    lines.push("");

    // 1
    if (best1) {
      const dir = best1.priceDiff >= 0 ? "+" : "";
      lines.push("1) One move");
      lines.push(`   ${best1.outName}  ${best1.inName}`);
      lines.push(`    +${best1.delta.toFixed(2)}   ${S.sep}   Price £${dir}${best1.priceDiff.toFixed(1)}   ${S.sep}   Bank left ${S.gbp(best1.bankLeft)}`);
      lines.push(`   Hit ${hit1?`-${hit1}`:"0"}      Net ${net1.toFixed(2)}`);
    } else {
      lines.push("1) One move");
      lines.push("   No affordable upgrade found.");
    }
    lines.push("");

    // 2
    if (N>=2) {
      if (best2) {
        const [a,b] = best2.moves;
        lines.push("2) Two moves");
        lines.push(`   ${S.bullet} ${a.outName}  ${a.inName}  ( +${a.delta.toFixed(2)}, £${a.priceDiff>=0?"+":""}${a.priceDiff.toFixed(1)})`);
        lines.push(`   ${S.bullet} ${b.outName}  ${b.inName}  ( +${b.delta.toFixed(2)}, £${b.priceDiff>=0?"+":""}${b.priceDiff.toFixed(1)})`);
        lines.push(`   Total  +${best2.deltaTotal.toFixed(2)}   ${S.sep}   Total £ ${best2.priceDiffTotal>=0?"+":""}${best2.priceDiffTotal.toFixed(1)}   ${S.sep}   Bank left ${S.gbp(best2.bankLeft)}`);
        lines.push(`   Hit ${hit2?`-${hit2}`:"0"}      Net ${net2.toFixed(2)}`);
      } else {
        lines.push("2) Two moves");
        lines.push("   No affordable two-move combo within constraints.");
      }
      lines.push("");
    }

    // 3
    if (N>=3) {
      if (best3) {
        const [a,b,c] = best3.moves;
        lines.push("3) Three moves");
        lines.push(`   ${S.bullet} ${a.outName}  ${a.inName}  ( +${a.delta.toFixed(2)}, £${a.priceDiff>=0?"+":""}${a.priceDiff.toFixed(1)})`);
        lines.push(`   ${S.bullet} ${b.outName}  ${b.inName}  ( +${b.delta.toFixed(2)}, £${b.priceDiff>=0?"+":""}${b.priceDiff.toFixed(1)})`);
        lines.push(`   ${S.bullet} ${c.outName}  ${c.inName}  ( +${c.delta.toFixed(2)}, £${c.priceDiff>=0?"+":""}${c.priceDiff.toFixed(1)})`);
        lines.push(`   Total  +${best3.deltaTotal.toFixed(2)}   ${S.sep}   Total £ ${best3.priceDiffTotal>=0?"+":""}${best3.priceDiffTotal.toFixed(1)}   ${S.sep}   Bank left ${S.gbp(best3.bankLeft)}`);
        lines.push(`   Hit ${hit3?`-${hit3}`:"0"}      Net ${net3.toFixed(2)}`);
      } else {
        lines.push("3) Three moves");
        lines.push("   No affordable triple-move combo within constraints.");
      }
      lines.push("");
    }

    // Recommendation
    let rec = "0 (save)";
    const candidates = [{k:0,net:0},{k:1,net:net1},{k:2,net:(N>=2?net2:-Infinity)},{k:3,net:(N>=3?net3:-Infinity)}];
    const bestNet = Math.max(...candidates.map(c=>c.net));
    const bestK = candidates.find(c=>c.net===bestNet)?.k ?? 0;
    if (bestK===1) rec="1 move";
    if (bestK===2) rec="2 moves";
    if (bestK===3) rec="3 moves";
    lines.push(`Recommendation: **${rec}** (highest net expected gain).`);
    lines.push("");
    lines.push("Tips: raise bank with `+0.5` or relax minutes with `min=75`. Update `free_transfers` in Settings weekly.");
    await reply(env, chatId, lines.join("\n"));
    return;
  }

  // ---------- Formation ----------
  if (cmd === "/formation") {
    const teamId = await resolveTeamId(env, chatId, arg);
    if (!teamId) { await reply(env, chatId, "Include your team id (e.g., /formation 1234567) or /linkteam first."); return; }

    const cfg       = await getSettings(env);
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const nextGW    = nextGwId(bootstrap);
    const currentGW = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    const txt = buildFormationReport(picks, bootstrap, fixtures, cfg, nextGW);
    await reply(env, chatId, txt);
    return;
  }

  // ---------- Risk ----------
  if (cmd === "/risk") {
    const teamId = await resolveTeamId(env, chatId, arg);
    if (!teamId) { await reply(env, chatId, "Include a team id (e.g., /risk 1234567) or /linkteam first."); return; }

    const cfg       = await getSettings(env);
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const nextGW    = nextGwId(bootstrap);
    const currentGW = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    const txt = buildRiskReport(picks, bootstrap, fixtures, cfg, nextGW);
    await reply(env, chatId, txt);
    return;
  }

  // ---------- Chip plan ----------
  if (cmd === "/chipplan") {
    const nArg = parseInt((arg||"").trim().split(/\s+/)[0], 10);
    const horizon = Number.isFinite(nArg) ? Math.max(2, Math.min(10, nArg)) : null;

    const teamId = await resolveTeamId(env, chatId, arg);
    if (!teamId) { await reply(env, chatId, "Include a team id (e.g., /chipplan 6 1234567) or /linkteam first."); return; }

    const cfg0      = await getSettings(env);
    const cfg       = { ...cfg0, chip_horizon: horizon || Number(cfg0.chip_horizon || 6) };
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);

    const currentGW = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    const nextGW    = nextGwId(bootstrap);
    const history   = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/history/`, 12000);
    const usedChips = new Set((history?.chips || []).map(c => c.name)); // "bench_boost","triple_captain","freehit"

    const txt = buildChipPlanReport(picks, bootstrap, fixtures, cfg, nextGW, cfg.chip_horizon, usedChips);
    await reply(env, chatId, txt);
    return;
  }

  // ---------- Wildcard advisor ----------
  if (cmd === "/wcwhen") {
    const nArg = parseInt((arg||"").trim().split(/\s+/)[0], 10);
    const horizon = Number.isFinite(nArg) ? Math.max(4, Math.min(10, nArg)) : 6;

    const teamId = await resolveTeamId(env, chatId, arg);
    if (!teamId) { await reply(env, chatId, "Include a team id (e.g., /wcwhen 6 1234567) or /linkteam first."); return; }

    const cfg       = await getSettings(env);
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);

    const currentGW = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    const nextGW    = nextGwId(bootstrap);
    const txt = buildWildcardAdvice(picks, bootstrap, fixtures, cfg, nextGW, horizon);
    await reply(env, chatId, txt);
    return;
  }

  // ---------- Compare two players ----------
  if (cmd === "/compare") {
    const cfg       = await getSettings(env);
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const nextGW    = nextGwId(bootstrap);

    const { a, b, horizon } = parseCompareArgs(arg);
    if (!a || !b) {
      await reply(env, chatId, "Usage: /compare <Player A> vs <Player B> [h=6]\nExample: /compare Watkins vs Isak h=6");
      return;
    }

    const A = resolvePlayerByName(a, bootstrap);
    const B = resolvePlayerByName(b, bootstrap);
    if (!A || !B) { await reply(env, chatId, "I couldn't resolve one of those names. Try a more specific query (e.g., 'Rodrigo MUN')."); return; }

    const ra = compareRow(A, bootstrap, fixtures, cfg, nextGW, horizon);
    const rb = compareRow(B, bootstrap, fixtures, cfg, nextGW, horizon);

    const lines = [];
    lines.push(`*Player compare (next ${horizon} GW${horizon>1?"s":""})*`);
    lines.push(rowToLine(ra));
    lines.push(rowToLine(rb));
    lines.push("");
    const who = ra.score>rb.score ? `${A.web_name} edged it (+${(ra.score-rb.score).toFixed(2)})` :
               rb.score>ra.score ? `${B.web_name} edged it (+${(rb.score-ra.score).toFixed(2)})` : "Dead even";
    lines.push(`Winner: ${who}`);
    lines.push("");
    lines.push("Tip: minutes threshold and FDR are factored in; big fixture swings can flip this.");
    await reply(env, chatId, lines.join("\n"), "Markdown");
    return;
  }

  // ---------- Replace suggestions ----------
  if (cmd === "/replace") {
    // /replace <player> [+0.5|max=7.5|n=3] [team_id]
    const rArgs = parseReplaceArgs(arg);
    const cfg0  = await getSettings(env);

    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const nextGW    = nextGwId(bootstrap);

    let teamId = await resolveTeamId(env, chatId, rArgs.teamIdOverride ?? "");
    let picks=null, entry=null, bankBase=0, sellValue=null, fromMyTeam=false;

    if (teamId) {
      const currentGW = currentGw(bootstrap);
      picks  = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
      entry  = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
      if (picks && entry) {
        bankBase = deriveBank(entry, picks, cfg0);
        const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
        const pick = (picks?.picks||[]).find(p => {
          const el = byId[p.element]; return el && isNameMatch(el, rArgs.query);
        });
        if (pick) {
          fromMyTeam = true;
          const el = byId[pick.element];
          sellValue = (pick.selling_price ?? pick.purchase_price ?? el.now_cost ?? 0)/10.0;
          rArgs.position = el.element_type;
          rArgs.outTeam  = el.team;
          rArgs.outName  = el.web_name;
        }
      }
    }

    const target = resolvePlayerByName(rArgs.query, bootstrap);
    if (!fromMyTeam && target) {
      sellValue = (target.now_cost || 0)/10.0;
      rArgs.position = target.element_type;
      rArgs.outTeam  = target.team;
      rArgs.outName  = target.web_name;
    }

    if (!sellValue || !rArgs.position) {
      await reply(env, chatId, "Usage: /replace <player> [+0.5|max=7.5|n=3] [team_id]\nI must know the player's position or be able to find them.");
      return;
    }

    const bank = bankBase + (rArgs.bankOverride || 0);
    const maxBudget = rArgs.maxPrice ?? (sellValue + bank);

    const pool = candidatesForReplace(bootstrap, fixtures, cfg0, nextGW, rArgs, picks);
    const best = pool
      .filter(r => r.price <= maxBudget)
      .sort((a,b)=>b.score-a.score)
      .slice(0, Math.max(1, Math.min(10, rArgs.n || 3)));

    const lines = [];
    lines.push(`*Replace suggestions for ${rArgs.outName || rArgs.query}*`);
    lines.push(`Budget: up to ${S.gbp(maxBudget)}  ${S.sep}  Minutes  ${cfg0.min_play_prob}%  ${S.sep}  Horizon ${cfg0.horizon_gw}`);
    lines.push("");
    if (!best.length) {
      lines.push("No upgrades within budget.");
      await reply(env, chatId, lines.join("\n"), "Markdown"); return;
    }
    best.forEach((r,i)=>{
      lines.push(`${i+1}) ${r.name} — ${r.pos} ${r.team}`);
      lines.push(`    Price ${S.gbp(r.price)}  ${S.sep}  Score ${r.score.toFixed(2)}  ${S.sep}  Next: ${r.next}`);
    });
    lines.push("");
    lines.push("Tips: add `+0.5` bank, or `max=7.5`, or pass a team id at the end.");
    await reply(env, chatId, lines.join("\n"), "Markdown");
    return;
  }

  // ---------- Squad & Suggest ----------
  if (["/squad","/suggest"].includes(cmd)) {
    const teamId = await resolveTeamId(env, chatId, arg);
    if (!teamId) { await reply(env, chatId, "Please include your team id (e.g., /squad 1234567) or /linkteam first."); return; }

    const cfg       = await getSettings(env);
    const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 12000);
    const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 12000);
    const gw        = currentGw(bootstrap);
    const picks     = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${gw}/picks/`, 12000);
    if (!picks) { await reply(env, chatId, "Couldn't fetch your picks. Check team id and that your team is public."); return; }

    if (cmd === "/squad") {
      const txt = renderSquadEnhanced(picks, bootstrap, fixtures, cfg, nextGwId(bootstrap));
      await reply(env, chatId, ascii(txt), "Markdown", navInlineKeyboard());
      return;
    }
    if (cmd === "/suggest") {
      const caps  = captainSuggest(picks, bootstrap, fixtures, cfg, nextGwId(bootstrap));
      const entry = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
      const baseBank = deriveBank(entry, picks, cfg);
      const tRes  = transferSuggestImproved(picks, bootstrap, fixtures, cfg, nextGwId(bootstrap), baseBank);
      const A = caps.length ? "*Captaincy (scores):*\n" + caps.map((r,i)=>`${i+1}. ${r.name} — ${r.score.toFixed(2)}`).join("\n") : "No captain candidates.";
      const best = tRes.best.slice(0,3).map((s,i)=>`${i+1}. ${s.outName}  ${s.inName} ( +${s.delta.toFixed(2)})`).join("\n");
      const near = !tRes.best.length && tRes.nearMiss.length ? "\nNear-miss:\n" + tRes.nearMiss.slice(0,3).map(s=>`${S.bullet} ${s.outName}  ${s.inName} (+${s.delta.toFixed(2)}, short £${s.shortfall.toFixed(1)}m)`).join("\n") : "";
      const B = tRes.best.length ? "*Transfers:*\n" + best : "*Transfers:*\nNo guaranteed upgrades." + near;
      await reply(env, chatId, A + "\n\n" + B, "Markdown");
      return;
    }
  }

  await reply(env, chatId, "Unknown command. Type /help");
}

// ===============================================================
// Telegram helpers
// ===============================================================

// Extract /command and arg safely from a Telegram message
function extractCommand(msg) {
  const raw = (msg.text || msg.caption || "").trim();
  if (!raw) return { cmd: null, arg: "" };

  // Prefer bot_command entity at offset 0 when present
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

  // Strip "@botusername" suffix if present
  cmd = cmd.replace(/@\S+$/, "").toLowerCase();

  return { cmd, arg };
}

// Detect when the user has (re)started a 1:1 chat with the bot
function isUserStartedPrivate(mc) {
  const chat = mc?.chat;
  if (!chat || chat.type !== "private") return false;
  const newStatus = mc?.new_chat_member?.status;
  // Typical: old "kicked"/"left" -> new "member" when user presses Start
  return newStatus === "member";
}

async function reply(env, chatId, text, parseMode = null, replyMarkup = null) {
  const MAX = 4096;             // Telegram hard limit
  const SOFT = 3800;            // safety cushion for metadata

  const chunks = chunkForTelegram(String(text), SOFT);

  for (let i = 0; i < chunks.length; i++) {
    await sendMessage(
      env,
      chatId,
      chunks[i],
      parseMode,
      i === 0 ? replyMarkup : null // only attach keyboard to first chunk
    );
  }
}

function chunkForTelegram(s, limit = 3800) {
  // Split on lines, pack into chunks without breaking Markdown blocks too much.
  const lines = s.split("\n");
  const out = [];
  let buf = "";

  for (const ln of lines) {
    const next = buf ? buf + "\n" + ln : ln;
    if (next.length > limit) {
      if (buf) out.push(buf);
      // if a single line is huge, hard split it
      if (ln.length > limit) {
        for (let i = 0; i < ln.length; i += limit) out.push(ln.slice(i, i + limit));
        buf = "";
      } else {
        buf = ln;
      }
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out;
}

async function sendMessage(env, chatId, text, parseMode = null, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    let data = null; try { data = await r.json(); } catch {}
    if (!r.ok || (data && data.ok === false)) {
      // fallback retry without formatting/keyboard
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
      });
    }
  } catch {}
}

function splitForTelegram(s, limit = 3500) {
  const str = String(s);
  if (str.length <= limit) return [str];
  const out = [];
  let i = 0;
  while (i < str.length) {
    let j = Math.min(i + limit, str.length);
    const k = str.lastIndexOf("\n", j);
    if (k > i + 1000) j = k;
    out.push(str.slice(i, j));
    i = j;
  }
  return out;
}

async function editMessage(env, chatId, messageId, text, parseMode = null, replyMarkup = null) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`;
  const chunks = splitForTelegram(String(text), 3500);
  if (chunks.length > 1) {
    return reply(env, chatId, text, parseMode, replyMarkup);
  }
  const payload = { chat_id: chatId, message_id: messageId, text: chunks[0] };
  if (parseMode)   payload.parse_mode   = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  try {
    await fetch(url, { method:"POST", headers:{ "content-type":"application/json" }, body: JSON.stringify(payload) });
  } catch {}
}

async function answerCb(env, cbId, text = "", showAlert = false) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ callback_query_id: cbId, text, show_alert: showAlert })
    });
  } catch {}
}

function navInlineKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "Formation",   callback_data: "nav:formation" }, { text: "Risk",       callback_data: "nav:risk" }],
      [{ text: "Captain",     callback_data: "nav:captain"   }, { text: "Transfers",  callback_data: "nav:transfers" }],
      [{ text: "Plan (2)",    callback_data: "nav:plan2"     }, { text: "Squad Next", callback_data: "nav:squad_next" }],
      [{ text: "My Team",     callback_data: "nav:myteam"    }, { text: "Refresh",    callback_data: "nav:myteam" }]
    ]
  };
}

// ===============================================================
/* HTTP & Settings */
// ===============================================================
async function getJSONCached(url, cacheTtlSeconds=60, timeoutMs=10000){
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), cf:{ cacheTtl: cacheTtlSeconds, cacheEverything: true }});
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.json();
}
async function getJSONSafe(url, timeoutMs=10000){
  try{ const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) }); if(!r.ok) return null; return r.json(); } catch { return null; }
}

const DEFAULT_CFG = {
  bank: 0, horizon_gw: 2, w_form: 0.45, w_value: 0.20, w_fdr: 0.35,
  min_play_prob: 80, max_per_team: 3, captain_top_k: 5,
  form_cap: 8, pro_mode: 1,
  free_transfers: 1,
  chip_horizon: 6
};
async function getSettings(env){
  const cfg = { ...DEFAULT_CFG };
  const url = env.SETTINGS_CSV_URL;
  if (!url) return cfg;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), cf:{ cacheTtl:60 }});
    if (!r.ok) return cfg;
    const csv = await r.text();
    const lines = csv.trim().split(/\r?\n/);
    for (let i=1;i<lines.length;i++){
      const [kRaw,vRaw] = lines[i].split(",");
      const k=(kRaw||"").trim(), v=(vRaw||"").trim();
      if (!k) continue;
      if (["bank","w_form","w_value","w_fdr"].includes(k)) { const f=parseFloat(v); if(!Number.isNaN(f)) cfg[k]=f; }
      else if (["horizon_gw","min_play_prob","max_per_team","captain_top_k","form_cap","pro_mode","free_transfers","chip_horizon"].includes(k)) {
        const n=parseInt(v,10); if(!Number.isNaN(n)) cfg[k]=n;
      } else cfg[k]=v;
    }
  } catch {}
  return cfg;
}

// ===============================================================
/* FPL helpers & scoring */
// ===============================================================
function currentGw(bootstrap){
  const ev=bootstrap?.events??[];
  const cur=ev.find(e=>e.is_current); if(cur) return cur.id;
  const nxt=ev.find(e=>e.is_next); if(nxt) return nxt.id;
  const up=ev.find(e=>!e.finished); return up ? up.id : (ev[ev.length-1]?.id||1);
}
function nextGwId(bootstrap){
  const ev=bootstrap?.events??[];
  const nxt=ev.find(e=>e.is_next); if(nxt) return nxt.id;
  const cur=ev.find(e=>e.is_current);
  if(cur){
    const i=ev.findIndex(x=>x.id===cur.id);
    if(i>=0 && ev[i+1]) return ev[i+1].id;
    return cur.id;
  }
  const up=ev.find(e=>!e.finished);
  return up ? up.id : (ev[ev.length-1]?.id || 1);
}
function minutesProb(el){ return parseInt(el.chance_of_playing_next_round ?? 100, 10); }
function scaledForm(el, cap){ const raw=parseFloat(el.form||0)||0; return Math.min(raw, cap||10); }
function posName(t){ return ({1:"GKP",2:"DEF",3:"MID",4:"FWD"})[t] || "?"; }
function teamShort(bootstrap, id){ const t=bootstrap?.teams?.find(x=>x.id===id); return t?.short_name || "?"; }
function fdrAvg(fixtures, teamId, startGw, horizon){
  const games = fixtures.filter(f=>f.event && f.event>=startGw && (f.team_h===teamId || f.team_a===teamId))
                        .sort((a,b)=>a.event-b.event).slice(0,horizon);
  if (!games.length) return 3.0;
  const s = games.reduce((a,f)=>a+(sideDifficulty(f,teamId)||3),0);
  return s/games.length;
}
function sideDifficulty(f, teamId){
  if (f.team_h===teamId) return f.team_h_difficulty ?? f.difficulty ?? 3;
  if (f.team_a===teamId) return f.team_a_difficulty ?? f.difficulty ?? 3;
  return 3;
}
function p90Approx(el){ return parseFloat(el.points_per_game||0)||0; }
function fdrMult(avg){ const f=Math.max(2,Math.min(5,avg||3)); return 1.30-0.10*f; }
function score(el, avgFdr, cfg){
  const p90 = p90Approx(el);
  const mult = fdrMult(avgFdr);
  const xM = minutesProb(el) / 100;
  const f10 = scaledForm(el, cfg.form_cap);
  return (p90 * mult * xM) * (1 + 0.02 * f10);
}
function upcomingForTeam(fixtures, teamId, startGw, n, bootstrap){
  const list=[], future=fixtures.filter(f=>f.event && f.event>=startGw && (f.team_h===teamId||f.team_a===teamId)).sort((a,b)=>a.event-b.event);
  for (const f of future){
    const home=f.team_h===teamId, oppId=home?f.team_a:f.team_h, opp=teamShort(bootstrap, oppId);
    const diff=home?(f.team_h_difficulty ?? f.difficulty ?? 3):(f.team_a_difficulty ?? f.difficulty ?? 3);
    list.push(`GW${f.event} ${home?'H':'A'} ${opp} (FDR ${diff})`);
    if (list.length>=n) break;
  }
  return list;
}

// ===============================================================
/* Name resolution */
// ===============================================================
const _slug = (s) => String(s||"").toLowerCase().replace(/[^a-z0-9]+/g,"");
function isNameMatch(el, q){
  const k=_slug(q);
  return _slug(el.web_name).includes(k) || _slug(el.first_name).includes(k) || _slug(el.second_name).includes(k);
}
function resolvePlayerByName(query, bootstrap){
  const els = bootstrap?.elements || [];
  const key = _slug(query);
  let exact = els.find(el => _slug(el.web_name) === key);
  if (exact) return exact;
  // also support tokens like "rodri mci"
  const parts = key.split(/(?=[a-z0-9])/g).filter(Boolean);
  let pool = els.filter(el => isNameMatch(el, query));
  if (pool.length === 1) return pool[0];
  if (!pool.length) {
    // try token includes
    pool = els.filter(el => parts.every(p => _slug(el.web_name+el.first_name+el.second_name+teamShort(bootstrap, el.team)).includes(p)));
  }
  if (pool.length === 1) return pool[0];
  // tie-break by selected_by_percent then points_per_game
  pool.sort((a,b)=>(parseFloat(b.selected_by_percent||0)-parseFloat(a.selected_by_percent||0)) || (parseFloat(b.points_per_game||0)-parseFloat(a.points_per_game||0)));
  return pool[0] || null;
}

// ===============================================================
/* Rendering: MyTeam & Squad */
// ===============================================================
function formatPlayer(el, bootstrap, cfg, withFlags=true){
  const name=el?.web_name||"—", tm=teamShort(bootstrap, el.team), pos=posName(el.element_type);
  const mp=minutesProb(el), flag=withFlags && mp<(cfg.min_play_prob||85) ? (UI_ASCII?" !":" ") : "";
  const form10=(Math.min(parseFloat(el.form||0)||0,10)).toFixed(1);
  return `${name} (${pos} ${tm}, form ${form10}/10, min% ${mp})${flag}`;
}
function renderMyTeamDetails(teamId, entry, picks, bootstrap, fixtures, cfg, history, tz="Asia/Kuala_Lumpur"){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const gw   = picks?.entry_history?.event;
  const eh   = picks?.entry_history || {};

  // basic profile
  const teamName = entry?.name || "—";
  const mgr      = [entry?.player_first_name, entry?.player_last_name].filter(Boolean).join(" ") || "—";
  const favTeam  = entry?.favourite_team ? teamShort(bootstrap, entry.favourite_team) : "—";
  const link     = `https://fantasy.premierleague.com/entry/${teamId}/event/${gw}`;

  // money
  const bankNum  = (typeof eh.bank  === "number") ? eh.bank/10
                  : (typeof entry?.last_deadline_bank  === "number" ? entry.last_deadline_bank/10 : null);
  const valueNum = (typeof eh.value === "number") ? eh.value/10
                  : (typeof entry?.last_deadline_value === "number" ? entry.last_deadline_value/10 : null);

  // points + chips
  const points   = eh.points ?? eh.event_points ?? "—";
  const benchPts = eh.points_on_bench ?? "—";
  const rank     = eh.rank ?? eh.overall_rank ?? "—";
  const xfers    = eh.event_transfers ?? 0;
  const hitStr   = eh.event_transfers_cost ? ` (-${eh.event_transfers_cost} pts)` : "";
  const chipActive = picks?.active_chip ? picks.active_chip.replace(/_/g," ").toUpperCase() : "—";
  const usedChips  = Array.isArray(history?.chips) ? history.chips.map(c=>c.name) : [];
  const allChips   = ["wildcard","wildcard","freehit","bench_boost","triple_captain"];
  const usedPretty = usedChips.map(n=>n.replace(/_/g," ").toUpperCase()).join(", ") || "—";
  const remaining  = summarizeRemainingChips(allChips, usedChips);

  // FT + deadline
  const ft      = Number(cfg.free_transfers ?? 1);
  const nextGW  = nextGwId(bootstrap);
  const evNext  = (bootstrap?.events||[]).find(e=>e.id===nextGW);
  const deadlineStr = evNext?.deadline_time ? formatLocalDeadline(evNext.deadline_time, tz) : "—";

  // XI + bench
  const xiPicks  = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  const xiEls    = xiPicks.map(p=>byId[p.element]).filter(Boolean);
  const counts   = {1:0,2:0,3:0,4:0}; xiEls.forEach(el=>counts[el.element_type]++);
  const formation= `${counts[1]}-${counts[2]}-${counts[3]}-${counts[4]}`;

  const line = t => xiEls
    .filter(el=>el.element_type===t)
    .map(el=>{
      const form10 = Math.min(parseFloat(el.form||0)||0,10).toFixed(1);
      return `${el.web_name} (${posName(el.element_type)} ${teamShort(bootstrap, el.team)}, form ${form10}/10, min% ${minutesProb(el)})`;
    }).join(", ") || "—";

  const gkLine  = line(1), defLine = line(2), midLine = line(3), fwdLine = line(4);

  const benchP  = (picks?.picks||[]).filter(p=>(p.position||16)>11).sort((a,b)=>a.position-b.position);
  const benchOut= benchP.filter(p=>byId[p.element]?.element_type!==1);
  const benchGk = benchP.find(p=>byId[p.element]?.element_type===1);
  const benchOrder = [
    benchOut[0]?.element ? `${byId[benchOut[0].element].web_name} (DEF/MID/FWD)` : null,
    benchOut[1]?.element ? `${byId[benchOut[1].element].web_name} (DEF/MID/FWD)` : null,
    benchOut[2]?.element ? `${byId[benchOut[2].element].web_name} (DEF/MID/FWD)` : null,
    benchGk?.element     ? `${byId[benchGk.element].web_name} (GKP)` : null
  ].filter(Boolean).join(", ") || "—";

  // captain / vice with short future fixtures
  const capPick = xiPicks.find(p=>p.is_captain);
  const vcPick  = xiPicks.find(p=>p.is_vice_captain);
  const capEl   = capPick ? byId[capPick.element] : null;
  const vcEl    = vcPick  ? byId[vcPick.element]  : null;

  const capNext = capEl ? upcomingForTeam(fixtures, capEl.team, gw+1, 2, bootstrap).join(", ") : "—";
  const capName = capEl ? `${capEl.web_name} (${posName(capEl.element_type)} ${teamShort(bootstrap, capEl.team)}, form ${Math.min(parseFloat(capEl.form||0)||0,10).toFixed(1)}/10, min% ${minutesProb(capEl)})` : "—";
  const vcName  = vcEl  ? `${vcEl .web_name} (${posName(vcEl .element_type)} ${teamShort(bootstrap, vcEl .team)}, form ${Math.min(parseFloat(vcEl .form||0)||0,10).toFixed(1)}/10, min% ${minutesProb(vcEl )})` : "—";

  // autosub risk details
  const risky = xiEls.filter(el => minutesProb(el) < (cfg.min_play_prob||80));
  const riskLine = risky.length
    ? `${risky.length} starter(s): ` + risky.map(el=>`${el.web_name} (${minutesProb(el)}%)`).join(", ")
    : "0 starter(s) flagged (min% < " + (cfg.min_play_prob||80) + ")";

  // assemble
  const lines = [];
  lines.push(`*${teamName}* — ${mgr}`);
  lines.push(`Favourite team: ${favTeam}`);
  lines.push(`[Link](${link})`);
  lines.push("");
  lines.push(`*Overview*`);
  lines.push(`GW ${gw} • FT ${ft} • Deadline: ${deadlineStr}`);
  lines.push(`Points ${points} | Bench ${benchPts} | Rank ${rank}`);
  lines.push(`Bank: ${bankNum!=null?fmtMoney(bankNum):"—"} | Team value: ${valueNum!=null?fmtMoney(valueNum):"—"}`);
  lines.push(`Transfers used: ${xfers}${hitStr} | Active chip: ${chipActive}`);
  lines.push(`Chips used: ${usedPretty}`);
  lines.push(`Chips remaining: ${remaining}`);
  lines.push("");
  lines.push(`*Captain*`);
  lines.push(`Captain: ${capName}`);
  lines.push(`Vice: ${vcName}`);
  lines.push(`Captain next: ${capNext}`);
  lines.push("");
  lines.push(`*Formation:* ${formation}`);
  lines.push("```");
  lines.push(`GKP: ${gkLine}`);
  lines.push(`DEF: ${defLine}`);
  lines.push(`MID: ${midLine}`);
  lines.push(`FWD: ${fwdLine}`);
  lines.push("```");
  lines.push(`Bench order: ${benchOrder}`);
  lines.push(`Autosub risk: ${riskLine}`);
  lines.push("");
  lines.push(`Next: /formation · /risk · /transfers · /plan 2`);

  return lines.join("\n");
}

function renderSquadEnhanced(picks, bootstrap, fixtures, cfg, nextGW){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const minPct = cfg?.min_play_prob ?? 80;

  const all = (picks?.picks||[]).slice().sort((a,b)=>a.position-b.position);
  const starters = all.filter(p => (p.position||16) <= 11);
  const bench    = all.filter(p => (p.position||16) > 11);

  const fmtRisk = (el) => {
    const mp = minutesProb(el);
    if (mp < minPct) return UI_ASCII ? " !" : " ";
    return "";
  };
  const nextOpp = (el) => {
    const fut = fixtures
      .filter(f => f.event === nextGW && (f.team_h===el.team || f.team_a===el.team))
      .map(f => {
        const home = f.team_h===el.team;
        const oppId = home ? f.team_a : f.team_h;
        const opp   = teamShort(bootstrap, oppId);
        const diff  = home ? (f.team_h_difficulty ?? f.difficulty ?? 3) : (f.team_a_difficulty ?? f.difficulty ?? 3);
        return `${home?"H":"A"} ${opp} (FDR ${diff})`;
      })[0];
    return fut || S.none;
  };
  const line = (el, withNext=false, benchLabel="") => {
    const pos = posName(el.element_type);
    const tm  = teamShort(bootstrap, el.team);
    const price = ((el.now_cost||0)/10).toFixed(1);
    const form10 = (Math.min(parseFloat(el.form||0)||0,10)).toFixed(1);
    const mp = minutesProb(el);
    const tag = benchLabel ? ` ${benchLabel}` : "";
    const nx  = withNext ? ` ${S.sep} next: ${nextOpp(el)}` : "";
    return `${S.bullet} ${el.web_name}${tag} ${DASH} ${pos} ${tm} ${S.sep} ${S.gbp(price)} ${S.sep} form ${form10}/10 ${S.sep} min% ${mp}${fmtRisk(el)}${nx}`;
  };

  const elFrom = p => byId[p.element];
  const xiEls = starters.map(elFrom).filter(Boolean);
  const counts = {1:0,2:0,3:0,4:0}; xiEls.forEach(el=>counts[el.element_type]++);
  const formation = `${counts[1]}-${counts[2]}-${counts[3]}-${counts[4]}`;

  const isC  = new Set(starters.filter(p=>p.is_captain).map(p=>p.element));
  const isVC = new Set(starters.filter(p=>p.is_vice_captain).map(p=>p.element));
  const deco = (el) => isC.has(el.id) ? `${el.web_name} (C)` : isVC.has(el.id) ? `${el.web_name} (VC)` : el.web_name;

  const group = (t) => xiEls.filter(e=>e.element_type===t).map(e=>{ const save=e.web_name; e.web_name=deco(e); const s=line(e,true); e.web_name=save; return s; });

  const gks  = group(1);
  const defs = group(2);
  const mids = group(3);
  const fwds = group(4);

  const bOut = bench.filter(p=>byId[p.element]?.element_type!==1).slice(0,3).map((p,i)=> {
    const el = byId[p.element]; if (!el) return null;
    return `${i+1}) ${el.web_name} (${posName(el.element_type)})`;
  }).filter(Boolean);
  const bGkPick = bench.find(p=>byId[p.element]?.element_type===1);
  const bGk = bGkPick ? `GK: ${byId[bGkPick.element].web_name}` : null;
  const benchLine = [...bOut, bGk].filter(Boolean).join(", ") || S.none;

  const riskCount = xiEls.filter(el => minutesProb(el) < minPct).length;

  const gw = picks?.entry_history?.event;
  const lines = [];
  lines.push(`*Your squad (GW ${gw})*`);
  lines.push(`Formation: ${formation}`);
  lines.push("");
  lines.push("*Starters*");
  if (gks.length)  { lines.push("GKP"); gks.forEach(l=>lines.push(l)); }
  if (defs.length) { lines.push(""); lines.push("DEF"); defs.forEach(l=>lines.push(l)); }
  if (mids.length) { lines.push(""); lines.push("MID"); mids.forEach(l=>lines.push(l)); }
  if (fwds.length) { lines.push(""); lines.push("FWD"); fwds.forEach(l=>lines.push(l)); }
  lines.push("");
  lines.push("*Bench*");
  bench.forEach((p,i)=>{
    const el = byId[p.element]; if (!el) return;
    const lbl = i<3 ? `(bench ${i+1})` : "(bench)";
    lines.push(line(el,false,lbl));
  });
  lines.push("");
  lines.push(`Bench order: ${benchLine}`);
  lines.push(`Autosub risk: ${riskCount} starter(s) flagged (min% < ${minPct})`);

  return lines.join("\n");
}

// ===============================================================
/* Captain report (PLAIN) */
// ===============================================================
function buildCaptainReportPlain(picks, bootstrap, fixtures, cfg, nextGW){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  const out = [];
  for (const p of xi) {
    const el = byId[p.element]; if (!el) continue;
    const minPct = minutesProb(el); if (minPct < (cfg.min_play_prob||85)) continue;
    const avg = fdrAvg(fixtures, el.team, nextGW, cfg.horizon_gw);
    const mult = fdrMult(avg), ppg = p90Approx(el), form10 = Math.min(parseFloat(el.form||0)||0, cfg.form_cap||10);
    const scoreVal = (ppg*mult*(minPct/100)*(1+0.02*form10));
    const nextStr = upcomingForTeam(fixtures, el.team, nextGW, Math.min(3, cfg.horizon_gw), bootstrap).join(", ");
    out.push({ name: el.web_name, team: teamShort(bootstrap, el.team), pos: posName(el.element_type), score: scoreVal, ppg, minPct, form10, avg, mult, next: nextStr });
  }
  out.sort((a,b)=>b.score-a.score);
  const top = out.slice(0, Math.max(1, cfg.captain_top_k || 3));
  if (!top.length) return "No captain candidates passed your minutes threshold.";
  const lines = [];
  lines.push(`Captaincy ranking (GW ${nextGW})`);
  top.forEach((r,i) => {
    lines.push(`${i+1}) ${r.name} — ${r.pos} ${r.team}`);
    lines.push(`   Score: ${r.score.toFixed(2)}`);
    lines.push(`   Baseline PPG: ${r.ppg.toFixed(2)}`);
    lines.push(`   Minutes: ${r.minPct}%`);
    lines.push(`   Form: ${r.form10.toFixed(1)}/10 (+${(r.form10*2).toFixed(0)}%)`);
    lines.push(`   Fixtures: avg FDR ${r.avg.toFixed(2)}  x${r.mult.toFixed(2)}`);
    if (r.next) lines.push(`   Next: ${r.next}`);
  });
  lines.push("");
  lines.push(`Formula: PPG × FDR_mult × Minutes × (1 + 0.02×Form)`);
  lines.push(`Horizon: next ${cfg.horizon_gw} GW(s) • Ignoring players with minutes < ${cfg.min_play_prob}%`);
  return lines.join("\n");
}
function captainSuggest(picks, bootstrap, fixtures, cfg, nextGW){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  const arr = [];
  for (const p of xi) {
    const el = byId[p.element]; if (!el) continue;
    const minPct = minutesProb(el); if (minPct < (cfg.min_play_prob||85)) continue;
    const avg = fdrAvg(fixtures, el.team, nextGW, cfg.horizon_gw);
    const s = score(el, avg, cfg);
    arr.push({ id: el.id, name: el.web_name, team: teamShort(bootstrap, el.team), pos: posName(el.element_type), score: s });
  }
  arr.sort((a,b)=>b.score-a.score);
  return arr.slice(0, Math.max(1, cfg.captain_top_k || 3));
}

// ===============================================================
/* Transfers & combos */
// ===============================================================
function deriveBank(entry, picks, cfg){
  if (picks?.entry_history && typeof picks.entry_history.bank === "number") return picks.entry_history.bank/10.0;
  if (entry && typeof entry.last_deadline_bank === "number") return entry.last_deadline_bank/10.0;
  return cfg?.bank || 0;
}
function parseTransferArgs(arg){
  const out = { teamIdOverride: null, bankOverride: 0, minOverride: null, countOverride: null };
  if (!arg) return out;
  const parts = arg.split(/\s+/).filter(Boolean);
  for (const p of parts){
    if (/^\d{5,8}$/.test(p)) { out.teamIdOverride = parseInt(p,10); continue; }             // team id
    if (/^\d{1,2}$/.test(p)) { out.countOverride = parseInt(p,10); continue; }               // result limit
    const mBank = p.match(/^(\+|\-)?(\d+(\.\d+)?)$/);
    if (mBank) { out.bankOverride += parseFloat(p); continue; }                              // +0.5, -0.2
    const mMin = p.match(/^min=(\d{1,3})$/i);
    if (mMin) { out.minOverride = Math.max(50, Math.min(100, parseInt(mMin[1],10))); continue; }
  }
  return out;
}
function parseCaptainArgs(arg){
  const out = { h:null, min:null, top:null, diff:null, teamIdOverride:null };
  if (!arg) return out;
  const parts = arg.split(/\s+/).filter(Boolean);
  for (const p of parts){
    const mH   = p.match(/^h=(\d{1,2})$/i);
    const mMin = p.match(/^min=(\d{1,3})$/i);
    const mTop = p.match(/^top=(\d{1,2})$/i);
    const mDif = p.match(/^diff=(\d{1,3})$/i);
    if (mH)   { out.h   = Math.max(1, Math.min(10, parseInt(mH[1],10))); continue; }
    if (mMin) { out.min = Math.max(50, Math.min(100, parseInt(mMin[1],10))); continue; }
    if (mTop) { out.top = Math.max(1, Math.min(10, parseInt(mTop[1],10))); continue; }
    if (mDif) { out.diff= Math.max(1, Math.min(100, parseInt(mDif[1],10))); continue; }
    if (/^\d{5,8}$/.test(p)) { out.teamIdOverride = parseInt(p,10); continue; }
  }
  return out;
}
function transferSuggestImproved(picks, bootstrap, fixtures, cfg, startGw, bank){
  const maxPerTeam = cfg.max_per_team || 3;
  const els = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const myIds = new Set((picks?.picks||[]).map(p=>p.element));

  // selling values
  const sellVal = {};
  for (const p of (picks?.picks||[])) {
    const el = els[p.element] || {};
    const raw = (p.selling_price ?? p.purchase_price ?? el.now_cost ?? 0);
    sellVal[p.element] = raw / 10.0;
  }

  // team counts
  const teamCounts = {};
  for (const p of (picks?.picks||[])) { const el=els[p.element]; if(!el) continue; teamCounts[el.team]=(teamCounts[el.team]||0)+1; }

  // my scores (worst-first)
  const mine = [];
  for (const id of myIds) { const el=els[id]; if(!el) continue; const avg=fdrAvg(fixtures, el.team, startGw, cfg.horizon_gw); mine.push([id, score(el, avg, cfg)]); }
  mine.sort((a,b)=>a[1]-b[1]);

  // market pool (best-first)
  const pool = [];
  for (const [idStr, el] of Object.entries(els)) {
    const id=+idStr; if (myIds.has(id)) continue;
    if (minutesProb(el)<cfg.min_play_prob) continue;
    const avg=fdrAvg(fixtures, el.team, startGw, cfg.horizon_gw);
    pool.push([id, score(el, avg, cfg)]);
  }
  pool.sort((a,b)=>b[1]-a[1]);

  const best=[], nearMiss=[], sidegrades=[];
  const seen = new Set();
  const OUT_SCAN=Math.min(11, mine.length), IN_SCAN=Math.min(500, pool.length);

  for (let m=0;m<OUT_SCAN;m++){
    const outId=mine[m][0], outEl=els[outId]; if(!outEl) continue;
    const outScore=mine[m][1], outPos=outEl.element_type, outTeam=outEl.team, outSell=sellVal[outId];

    for (let p=0;p<IN_SCAN;p++){
      const inId=pool[p][0], inEl=els[inId]; if(!inEl || inEl.element_type!==outPos) continue;

      const inTeam=inEl.team, inPrice=(inEl.now_cost||0)/10.0;
      const newCountIn=(teamCounts[inTeam]||0) + (inTeam===outTeam?0:1);
      if (newCountIn>maxPerTeam) continue;

      const priceDiff=inPrice - outSell;
      const affordable=(priceDiff<=bank);

      const key=`${outId}->${inId}`; if(seen.has(key)) continue; seen.add(key);

      const avgIn=fdrAvg(fixtures, inTeam, startGw, cfg.horizon_gw);
      const inScore=score(inEl, avgIn, cfg);
      const delta=inScore - outScore;

      if (affordable && delta>0){
        const bankLeft=bank - priceDiff;
        best.push({
          outId, inId, outTeam, inTeam,
          delta, outName: outEl.web_name, outPos: posName(outPos), outSell,
          inName: inEl.web_name, inPos: posName(inEl.element_type), inPrice,
          priceDiff, bankLeft
        });
        if (best.length>=60) break;
      } else if (!affordable && delta>0){
        const shortfall=priceDiff - bank;
        nearMiss.push({ delta, shortfall, outName: outEl.web_name, outPos: posName(outPos), inName: inEl.web_name, inPos: posName(inEl.element_type) });
      } else if (affordable && delta<=0 && delta>-0.4){
        const bankLeft=bank - priceDiff;
        sidegrades.push({ delta, bankLeft, outName: outEl.web_name, outPos: posName(outPos), inName: inEl.web_name, inPos: posName(inEl.element_type) });
      }
    }
  }

  best.sort((a,b)=>b.delta-a.delta);
  nearMiss.sort((a,b)=> (a.shortfall-b.shortfall) || (b.delta-a.delta) );
  sidegrades.sort((a,b)=> b.delta-a.delta);
  return { best: best.slice(0,20), nearMiss: nearMiss.slice(0,5), sidegrades: sidegrades.slice(0,5) };
}
function bestComboFromSingles(singles, picks, bootstrap, fixtures, cfg, startGw, bank, K){
  if (singles.length < K) return null;
  const els = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const maxPerTeam = cfg.max_per_team || 3;

  // base team counts
  const counts0 = {};
  for (const p of (picks?.picks||[])) { const el=els[p.element]; if(!el) continue; counts0[el.team]=(counts0[el.team]||0)+1; }

  let best=null;

  function validCombo(combo){
    // unique outs/ins
    const outIds=new Set(), inIds=new Set();
    for (const m of combo) {
      if (outIds.has(m.outId) || inIds.has(m.inId)) return false;
      outIds.add(m.outId); inIds.add(m.inId);
    }
    // team limits
    const counts = {...counts0};
    for (const m of combo) {
      if (m.inTeam !== m.outTeam) {
        counts[m.outTeam] = (counts[m.outTeam]||0) - 1;
        counts[m.inTeam]  = (counts[m.inTeam]||0) + 1;
      }
    }
    for (const c of Object.values(counts)) if (c > maxPerTeam) return false;

    // bank
    const priceDiffTotal = combo.reduce((s,m)=>s+m.priceDiff,0);
    if (priceDiffTotal > bank) return false;
    return true;
  }

  function* combos(arr, k, start=0, acc=[]){
    if (k===0) { yield acc; return; }
    for (let i=start;i<=arr.length-k;i++){
      yield* combos(arr, k-1, i+1, [...acc, arr[i]]);
    }
  }

  for (const combo of combos(singles, K)) {
    if (!validCombo(combo)) continue;
    const deltaTotal = combo.reduce((s,m)=>s+m.delta,0);
    const priceDiffTotal = combo.reduce((s,m)=>s+m.priceDiff,0);
    const bankLeft = bank - priceDiffTotal;
    const cand = { moves: combo, deltaTotal, priceDiffTotal, bankLeft };
    if (!best || deltaTotal > best.deltaTotal) best = cand;
  }
  return best;
}

// ===============================================================
/* Formation / Risk */
// ===============================================================
function asRow(el, bootstrap, fixtures, cfg, nextGW){
  const avg = fdrAvg(fixtures, el.team, nextGW, cfg.horizon_gw);
  return {
    id: el.id,
    type: el.element_type,
    pos: posName(el.element_type),
    team: teamShort(bootstrap, el.team),
    name: el.web_name,
    mp: minutesProb(el),
    score: score(el, avg, cfg)
  };
}
function descScore(a,b){ return b.score - a.score; }
function pickN(arr, n, minPct){
  const safe = arr.filter(r=>r.mp>=minPct);
  const unsafe = arr.filter(r=>r.mp<minPct);
  const chosen = [...safe.slice(0,n)];
  let relaxed=false;
  if (chosen.length<n){
    relaxed=true;
    const need = n - chosen.length;
    chosen.push(...unsafe.slice(0,need));
  }
  return { chosen, relaxed };
}
function pickGK(gks, minPct){
  if (!gks.length) return null;
  const safe = gks.filter(r=>r.mp>=minPct).sort(descScore);
  if (safe.length) return safe[0];
  return gks.slice().sort(descScore)[0];
}
function shortLine(r){ return `${r.name} (${r.team})`; }

function buildFormationReport(picks, bootstrap, fixtures, cfg, nextGW){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const allPicks = (picks?.picks||[]);
  const starters = allPicks.filter(p=>(p.position||16)<=11);

  const squadEls = allPicks.map(p=>byId[p.element]).filter(Boolean);

  const startEls = starters.map(p=>byId[p.element]).filter(Boolean).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW));
  const curCounts = {1:0,2:0,3:0,4:0}; startEls.forEach(r=>curCounts[r.type]++);
  const curForm = `${curCounts[1]}-${curCounts[2]}-${curCounts[3]}-${curCounts[4]}`;
  const currentTotal = startEls.reduce((s,r)=>s+r.score,0);

  const best = bestFormationForSquad(squadEls, bootstrap, fixtures, cfg, nextGW);
  if (!best) return "Couldn't build a valid XI. (Do you have less than 11 available players?)";

  const gain = best.total - currentTotal;

  const lines = [];
  lines.push(`Recommended formation: ${best.shape} (Projected ${best.total.toFixed(1)})`);
  lines.push(`Your current: ${curForm} (Projected ${currentTotal.toFixed(1)})  Gain ${gain>=0?"+":""}${gain.toFixed(1)}`);
  lines.push("");
  lines.push("Starters");
  lines.push(`GKP: ${best.gk}`);
  lines.push(`DEF (${best.d}): ${best.defLine}`);
  lines.push(`MID (${best.m}): ${best.midLine}`);
  lines.push(`FWD (${best.f}): ${best.fwdLine}`);
  lines.push("");
  lines.push(`Bench order: ${best.benchLine || S.none}`);
  lines.push("");
  lines.push(`Minutes threshold: ${cfg.min_play_prob}%`);
  if (best.riskList) lines.push(`Minutes risk in XI: ${best.riskList}`);
  lines.push(best.relaxedMsg);
  lines.push(`Horizon: next ${cfg.horizon_gw} GW(s)`);
  return lines.join("\n");
}
function bestFormationForSquad(els, bootstrap, fixtures, cfg, nextGW){
  const gks  = els.filter(el=>el.element_type===1).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW));
  const defs = els.filter(el=>el.element_type===2).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW)).sort(descScore);
  const mids = els.filter(el=>el.element_type===3).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW)).sort(descScore);
  const fwds = els.filter(el=>el.element_type===4).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW)).sort(descScore);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];
  const minPct = cfg.min_play_prob || 80;

  let best=null;
  for (const [d,m,f] of shapes) {
    const gkPick = pickGK(gks, minPct);
    const {chosen: D, relaxedD} = pickN(defs, d, minPct);
    const {chosen: M, relaxedM} = pickN(mids, m, minPct);
    const {chosen: F, relaxedF} = pickN(fwds, f, minPct);
    if (!gkPick || D.length<d || M.length<m || F.length<f) continue;

    const xi = [gkPick, ...D, ...M, ...F];
    const total = xi.reduce((s,r)=>s+r.score,0);
    const bench = [...defs, ...mids, ...fwds].filter(r=>!xi.find(x=>x.id===r.id)).sort(descScore);
    const benchOut = bench.slice(0,3);
    const benchGK  = gks.find(r=>!xi.find(x=>x.id===r.id));
    const benchLine = [
      benchOut[0] ? `1) ${benchOut[0].name} (${benchOut[0].pos})` : null,
      benchOut[1] ? `2) ${benchOut[1].name} (${benchOut[1].pos})` : null,
      benchOut[2] ? `3) ${benchOut[2].name} (${benchOut[2].pos})` : null,
      benchGK     ? `GK: ${benchGK.name}` : null
    ].filter(Boolean).join(", ");

    const riskList = xi.filter(r=>r.mp < minPct).map(r=>`${r.name} (${r.mp}%)`).join(", ");
    const relaxedNotes = [];
    if (D.length<d) relaxedNotes.push("DEF");
    if (M.length<m) relaxedNotes.push("MID");
    if (F.length<f) relaxedNotes.push("FWD");
    const relaxedMsg = relaxedNotes.length ? `Minutes filter was relaxed to fill: ${relaxedNotes.join(", ")}.` : "All starters meet the minutes threshold.";

    const defLine = xi.filter(r=>r.type===2).map(shortLine).join(", ") || "—";
    const midLine = xi.filter(r=>r.type===3).map(shortLine).join(", ") || "—";
    const fwdLine = xi.filter(r=>r.type===4).map(shortLine).join(", ") || "—";
    const gkName  = xi.find(r=>r.type===1)?.name || "—";

    const cand = { d, m, f, total, benchLine, riskList, relaxedMsg, defLine, midLine, fwdLine, gk: gkName };
    if (!best || total>best.total) best=cand;
  }
  if (!best) return null;
  best.shape = `${best.d}-${best.m}-${best.f}`;
  return best;
}

function buildRiskReport(picks, bootstrap, fixtures, cfg, nextGW){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const minPct = cfg.min_play_prob || 80;

  const allPicks = (picks?.picks||[]);
  const starters = allPicks.filter(p => (p.position||16) <= 11);
  const bench    = allPicks.filter(p => (p.position||16) > 11).sort((a,b)=>a.position-b.position);

  const xiRows   = starters.map(p=>byId[p.element]).filter(Boolean).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW));
  const benchRows= bench.map(p=>byId[p.element]).filter(Boolean).map(el=>asRow(el, bootstrap, fixtures, cfg, nextGW));

  const risky = xiRows.filter(r => r.mp < minPct);
  const safeBench = benchRows.filter(r => r.mp >= minPct);

  const benchOut = benchRows.filter(r => r.type !== 1).sort((a,b)=>b.score-a.score);
  const benchGK  = benchRows.find(r => r.type === 1);
  const benchLine = [
    benchOut[0] ? `1) ${benchOut[0].name} (${benchOut[0].pos})` : null,
    benchOut[1] ? `2) ${benchOut[1].name} (${benchOut[1].pos})` : null,
    benchOut[2] ? `3) ${benchOut[2].name} (${benchOut[2].pos})` : null,
    benchGK     ? `GK: ${benchGK.name}` : null
  ].filter(Boolean).join(", ") || "—";

  const swaps = [];
  for (const r of risky) {
    let cand = null;
    if (r.type === 1) cand = safeBench.find(b => b.type === 1) || null;
    else cand = safeBench.find(b => b.type !== 1) || null;
    if (cand) swaps.push(`${r.name}  ${cand.name}`);
  }

  const lines = [];
  lines.push(`Risk scan for next GW (min% ${minPct}, horizon ${cfg.horizon_gw})`);
  if (risky.length) {
    lines.push("");
    lines.push("Risky starters:");
    risky.sort((a,b)=>a.mp-b.mp).forEach(r=>{
      lines.push(`${S.bullet} ${r.name} — ${r.pos} ${r.team} | minutes ${r.mp}% | proj ${r.score.toFixed(2)}`);
    });
  } else {
    lines.push("");
    lines.push("Risky starters: none ");
  }

  if (safeBench.length) {
    lines.push("");
    lines.push("Safer bench options:");
    safeBench.sort((a,b)=>b.score-a.score).slice(0,5).forEach(b=>{
      lines.push(`${S.bullet} ${b.name} — ${b.pos} ${b.team} | minutes ${b.mp}% | proj ${b.score.toFixed(2)}`);
    });
  }

  lines.push("");
  lines.push(`Recommended bench order: ${benchLine}`);

  if (swaps.length) {
    lines.push("");
    lines.push("Consider benching:");
    swaps.forEach(s => lines.push(`${S.bullet} ${s}`));
    lines.push("Note: formation constraints apply for auto-subs; use /formation for the optimal XI.");
  }

  lines.push("");
  lines.push("Quick actions: /formation • /transfers • /captain");
  return lines.join("\n");
}

// ===============================================================
/* Chip planner + Wildcard advisor */
// ===============================================================
function teamFixturesForEvent(fixtures, teamId, gw) {
  return fixtures
    .filter(f => f.event === gw && (f.team_h === teamId || f.team_a === teamId))
    .map(f => {
      const home = f.team_h === teamId;
      const fdr  = home
        ? (f.team_h_difficulty ?? f.difficulty ?? 3)
        : (f.team_a_difficulty ?? f.difficulty ?? 3);
      return { fdr, home };
    });
}
function rowForGw(el, bootstrap, fixtures, cfg, gw){
  const tfs = teamFixturesForEvent(fixtures, el.team, gw);
  if (!tfs.length) {
    return {
      id: el.id, type: el.element_type, pos: posName(el.element_type),
      team: teamShort(bootstrap, el.team), name: el.web_name,
      mp: minutesProb(el), score: 0, hasFixture: false, avgFdr: null, double: 0
    };
  }
  const damp = [1.0, 0.9, 0.8];
  let sum = 0;
  tfs.forEach((tf, i) => { sum += score(el, tf.fdr, cfg) * (damp[i] ?? 0.75); });
  const avg = tfs.reduce((a, x) => a + x.fdr, 0) / tfs.length;
  return {
    id: el.id, type: el.element_type, pos: posName(el.element_type),
    team: teamShort(bootstrap, el.team), name: el.web_name,
    mp: minutesProb(el), score: sum, hasFixture: true, avgFdr: avg, double: tfs.length
  };
}
function bestXIForGw(squadEls, bootstrap, fixtures, cfg, gw){
  const minPct = cfg.min_play_prob || 80;
  const gks  = squadEls.filter(el=>el.element_type===1).map(el=>rowForGw(el, bootstrap, fixtures, cfg, gw));
  const defs = squadEls.filter(el=>el.element_type===2).map(el=>rowForGw(el, bootstrap, fixtures, cfg, gw)).sort((a,b)=>b.score-a.score);
  const mids = squadEls.filter(el=>el.element_type===3).map(el=>rowForGw(el, bootstrap, fixtures, cfg, gw)).sort((a,b)=>b.score-a.score);
  const fwds = squadEls.filter(el=>el.element_type===4).map(el=>rowForGw(el, bootstrap, fixtures, cfg, gw)).sort((a,b)=>b.score-a.score);

  const shapes = [[3,4,3],[3,5,2],[4,4,2],[4,3,3],[4,5,1],[5,3,2],[5,4,1]];

  const pickGK = () => {
    const safe = gks.filter(r=>r.mp>=minPct && r.hasFixture).sort((a,b)=>b.score-a.score);
    if (safe.length) return safe[0];
    return gks.filter(r=>r.hasFixture).sort((a,b)=>b.score-a-score)[0] || null;
  };
  const pickN = (arr,n) => {
    const safe = arr.filter(r=>r.mp>=minPct && r.hasFixture).slice(0,n);
    if (safe.length===n) return { chosen:safe, relaxed:false };
    const need = n - safe.length;
    const fill = arr.filter(r=>r.hasFixture && !safe.find(x=>x.id===r.id)).slice(0,need);
    return { chosen:[...safe,...fill], relaxed: need>0 };
  };

  let best=null;
  for (const [d,m,f] of shapes){
    const gk = pickGK(); if (!gk) continue;
    const {chosen: D, relaxed: rD} = pickN(defs, d);
    const {chosen: M, relaxed: rM} = pickN(mids, m);
    const {chosen: F, relaxed: rF} = pickN(fwds, f);
    if (D.length<d || M.length<m || F.length<f) continue;
    const xi=[gk, ...D, ...M, ...F];
    const total = xi.reduce((s,r)=>s+r.score,0);

    const benchPool = [...defs, ...mids, ...fwds].filter(r=>!xi.find(x=>x.id===r.id));
    const benchOut  = benchPool.sort((a,b)=>b.score-a.score).slice(0,3);
    const benchGK   = gks.find(r=>r.id!==gk.id);

    const benchLine = [
      benchOut[0] ? `1) ${benchOut[0].name} (${benchOut[0].pos})` : null,
      benchOut[1] ? `2) ${benchOut[1].name} (${benchOut[1].pos})` : null,
      benchOut[2] ? `3) ${benchOut[2].name} (${benchOut[2].pos})` : null,
      benchGK     ? `GK: ${benchGK.name}` : null
    ].filter(Boolean).join(", ");

    const benchSafeCount =
      (benchOut.filter(r => r.mp >= minPct && r.hasFixture).length) +
      ((benchGK && benchGK.mp >= minPct && benchGK.hasFixture) ? 1 : 0);

    const hardCount = xi.filter(r=> (r.avgFdr??3) >= 4.5).length;
    const riskyXI   = xi.filter(r=> r.mp < (cfg.min_play_prob||80) || !r.hasFixture).map(r=>r.name);

    const cand = {
      d, m, f,
      gwShape:`${d}-${m}-${f}`,
      xi, total, benchLine, benchSum: (benchOut.reduce((s,r)=>s+r.score,0) + (benchGK?.score||0)),
      benchSafeCount,
      hardCount, riskyXI,
      relaxed: (rD||rM||rF)
    };
    if (!best || total>best.total) best=cand;
  }
  return best;
}
function buildChipPlanReport(picks, bootstrap, fixtures, cfg, startGw, horizon, usedChips = new Set()){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const squadEls = (picks?.picks||[]).map(p=>byId[p.element]).filter(Boolean);

  const res = [];
  for (let g=startGw; g<startGw+horizon; g++){
    const xi = bestXIForGw(squadEls, bootstrap, fixtures, cfg, g);
    if (!xi){ res.push({ gw:g, note:"insufficient players" }); continue; }

    const bestCap = xi.xi.slice().sort((a,b)=>b.score-a.score)[0];
    const tcScore = bestCap.score;

    const availableStarters = xi.xi.filter(r=>r.hasFixture && r.mp >= (cfg.min_play_prob||80)).length;
    const likelyBlank = availableStarters < 10;
    const veryHard    = xi.hardCount >= 8;
    const riskyCount  = xi.riskyXI.length;
    const fhFlag      = likelyBlank || veryHard || riskyCount>=3;

    res.push({
      gw: g,
      xiScore: xi.total,
      benchSum: xi.benchSum,
      benchSafeCount: xi.benchSafeCount,
      bestCap: `${bestCap.name} (${bestCap.team})${bestCap.double>1?" x"+bestCap.double:""}`,
      tcScore,
      fhFlag,
      fhWhy: { availableStarters, hardInXI: xi.hardCount, riskyCount },
      benchLine: xi.benchLine,
      shape: xi.gwShape
    });
  }

  const canBB = !usedChips.has('bench_boost');
  const canTC = !usedChips.has('triple_captain');
  const canFH = !usedChips.has('freehit');

  const bbSafe = res.filter(r => r.benchSafeCount >= 4);
  const bbPool = (bbSafe.length ? bbSafe : res);
  const bbTop  = canBB ? bbPool.slice().sort((a,b)=>b.benchSum-a.benchSum).slice(0,2) : [];
  const tcTop  = canTC ? res.slice().sort((a,b)=>b.tcScore-a.tcScore).slice(0,2) : [];
  const fhCandidates = canFH
    ? res.filter(r => r.fhFlag).sort((a,b)=> (a.fhWhy.availableStarters-b.fhWhy.availableStarters) || (a.xiScore-b.xiScore))
    : [];

  const lines = [];
  lines.push(`Chip planner (next ${horizon} GW${horizon>1?"s":""}, min% ${cfg.min_play_prob})`);
  lines.push("");

  if (!canBB) {
    lines.push("Bench Boost: already used.");
  } else if (bbTop.length) {
    lines.push("Bench Boost windows:");
    bbTop.forEach(r=>{
      const warn = r.benchSafeCount < 4 ? " (risky bench)" : "";
      lines.push(`${S.bullet} GW${r.gw} — Bench sum  ${r.benchSum.toFixed(1)}${warn} | Bench: ${r.benchLine || S.none}`);
    });
  } else {
    lines.push("Bench Boost: no strong windows detected.");
  }
  lines.push("");

  if (!canTC) {
    lines.push("Triple Captain: already used.");
  } else if (tcTop.length) {
    lines.push("Triple Captain windows:");
    tcTop.forEach(r=>{
      lines.push(`${S.bullet} GW${r.gw} — ${r.bestCap} | Captain score  ${r.tcScore.toFixed(1)}`);
    });
  } else {
    lines.push("Triple Captain: no standout week detected.");
  }
  lines.push("");

  if (!canFH) {
    lines.push("Free Hit: already used.");
  } else if (fhCandidates.length) {
    const r = fhCandidates[0];
    lines.push("Free Hit warning:");
    lines.push(`${S.bullet} GW${r.gw} — available starters: ${r.fhWhy.availableStarters}/11, hard fixtures in XI: ${r.fhWhy.hardInXI}, risky: ${r.fhWhy.riskyCount}`);
    lines.push("Note: FH is situational; check doubles/blanks news before committing.");
  } else {
    lines.push("Free Hit: no obvious pain weeks in this horizon.");
  }
  lines.push("");
  lines.push("Tip: `/chipplan 8` to extend the horizon. Use `/formation` and `/transfers` to act on this plan.");
  return lines.join("\n");
}

// Simple Wildcard advisor (fixtures + risk + depth)
function buildWildcardAdvice(picks, bootstrap, fixtures, cfg, nextGW, horizon){
  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const squad = (picks?.picks||[]).map(p=>byId[p.element]).filter(Boolean);
  const lines = [];
  const window = [];
  for (let g=nextGW; g<nextGW+horizon; g++){
    const xi = bestXIForGw(squad, bootstrap, fixtures, cfg, g);
    if (!xi){ window.push({ gw:g, score:0, risk:99, depth:0 }); continue; }
    const risk = xi.riskyXI.length;
    const depth = xi.benchSafeCount;
    const hard = xi.hardCount;
    // heuristic “stress index”
    const stress = (risk*3) + Math.max(0, 8-hard) + Math.max(0, 4-depth);
    window.push({ gw:g, score:xi.total, risk, depth, hard, stress });
  }

  // pick the lowest score + highest stress combo
  const sorted = window.slice().sort((a,b)=>(a.score-b.score) || (b.stress-a.stress));
  const cand = sorted[0];

  lines.push(`*Wildcard advisor (next ${horizon} GWs)*`);
  lines.push(`Worst projected XI: GW${cand.gw} — XI score  ${cand.score.toFixed(1)}  ${S.sep}  risky starters: ${cand.risk}  ${S.sep}  safe bench: ${cand.depth}`);
  const should = (cand.risk>=3) || (cand.depth<2) || (cand.score < 45);
  if (should) {
    lines.push("");
    lines.push(`Recommendation: **Consider WC around GW${cand.gw}** if transfers can't patch 3 issues (flags/minutes/structure).`);
  } else {
    lines.push("");
    lines.push("Recommendation: No urgent WC signal. Patch with transfers; revisit in a week.");
  }
  lines.push("");
  lines.push("Tip: Use `/formation`, `/risk`, and `/transfers` to see if a -4/-8 fixes the problems before committing WC.");
  return lines.join("\n");
}

// ===============================================================
/* Compare + Replace helpers */
// ===============================================================
function parseCompareArgs(arg){
  const hMatch = arg?.match(/\bh=(\d+)\b/i);
  const horizon = hMatch ? Math.max(1, Math.min(10, parseInt(hMatch[1],10))) : 6;
  const cleaned = (arg||"").replace(/\bh=\d+\b/i,"").trim();
  const vs = cleaned.split(/\bvs\b/i);
  if (vs.length===2) return { a: vs[0].trim(), b: vs[1].trim(), horizon };
  const parts = cleaned.split(/\s+/);
  if (parts.length>=2) return { a: parts[0], b: parts.slice(1).join(" "), horizon };
  return { a:null, b:null, horizon };
}
function compareRow(el, bootstrap, fixtures, cfg, nextGW, horizon){
  const avg = fdrAvg(fixtures, el.team, nextGW, horizon);
  const sc  = score(el, avg, cfg);
  const next = upcomingForTeam(fixtures, el.team, nextGW, Math.min(3,horizon), bootstrap).join(", ");
  return {
    id: el.id,
    name: el.web_name,
    team: teamShort(bootstrap, el.team),
    pos: posName(el.element_type),
    price: (el.now_cost||0)/10.0,
    mp: minutesProb(el),
    form: Math.min(parseFloat(el.form||0)||0,10),
    fdr: avg,
    score: sc,
    next
  };
}
function rowToLine(r){
  return `${S.bullet} ${r.name} ${DASH} ${r.pos} ${r.team}\n`+
         `   Price ${S.gbp(r.price)}  ${S.sep}  min% ${r.mp}  ${S.sep}  form ${r.form.toFixed(1)}/10  ${S.sep}  FDR ${r.fdr.toFixed(2)}  ${S.sep}  score ${r.score.toFixed(2)}\n`+
         (r.next?`   Next: ${r.next}`:"");
}
function parseReplaceArgs(arg){
  const out = { query:"", bankOverride:0, maxPrice:null, n:3, teamIdOverride:null, position:null, outTeam:null, outName:null };
  if (!arg) return out;
  const toks = arg.split(/\s+/).filter(Boolean);
  const buf=[];
  for (const t of toks){
    if (/^\+?\-?\d+(\.\d+)?$/.test(t)) { out.bankOverride += parseFloat(t); continue; }
    const mMax = t.match(/^max=(\d+(\.\d+)?)$/i);
    if (mMax) { out.maxPrice = parseFloat(mMax[1]); continue; }
    const mN = t.match(/^n=(\d{1,2})$/i);
    if (mN) { out.n = parseInt(mN[1],10); continue; }
    if (/^\d{5,8}$/.test(t)) { out.teamIdOverride = parseInt(t,10); continue; }
    buf.push(t);
  }
  out.query = buf.join(" ");
  return out;
}
function candidatesForReplace(bootstrap, fixtures, cfg, nextGW, rArgs, picks){
  const els = bootstrap?.elements || [];
  const myIds = new Set((picks?.picks||[]).map(p=>p.element));
  const pool=[];
  for (const el of els){
    if (rArgs.position && el.element_type !== rArgs.position) continue;
    if (rArgs.outTeam && el.team === rArgs.outTeam) continue; // prefer different team
    if (minutesProb(el) < (cfg.min_play_prob||80)) continue;
    const sc = score(el, fdrAvg(fixtures, el.team, nextGW, cfg.horizon_gw), cfg);
    const price = (el.now_cost||0)/10.0;
    const next = upcomingForTeam(fixtures, el.team, nextGW, Math.min(3,cfg.horizon_gw), bootstrap).join(", ");
    pool.push({ id: el.id, name: el.web_name, team: teamShort(bootstrap, el.team), pos: posName(el.element_type), score: sc, price, next, inMyTeam: myIds.has(el.id) });
  }
  // prioritize not already in my team
  pool.sort((a,b)=> (b.score-a.score) || (a.inMyTeam?1:-1));
  return pool;
}


// ===============================================================
/* Alerts persistence & sweep */
// ===============================================================
const DEFAULT_ALERTS = { on: false, tz: "Asia/Kuala_Lumpur", tminus: [24,2] };
function alertsKey(chatId){ return `alerts:${chatId}`; }
function alertedFlagKey(chatId, gw, T){ return `alerted:${chatId}:${gw}:${T}`; }

async function loadAlertsCfg(env, chatId){
  const raw = env.TEAM_KV ? await env.TEAM_KV.get(alertsKey(chatId)) : null;
  if (!raw) return { ...DEFAULT_ALERTS };
  try { return { ...DEFAULT_ALERTS, ...JSON.parse(raw) }; } catch { return { ...DEFAULT_ALERTS }; }
}
async function saveAlertsCfg(env, chatId, cfg){
  if (!env.TEAM_KV) return;
  await env.TEAM_KV.put(alertsKey(chatId), JSON.stringify({ ...DEFAULT_ALERTS, ...cfg }), { expirationTtl: 60*60*24*365 });
}

async function runAlertsSweep(env){
  if (!env.TEAM_KV) return;

  const settings = await getSettings(env);
  const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 15000);

  const nextGW = nextGwId(bootstrap);
  const ev = (bootstrap?.events || []).find(e => e.id === nextGW);
  if (!ev?.deadline_time) return;
  const deadlineIso = ev.deadline_time;
  const now = new Date();
  const hoursTo = (new Date(deadlineIso) - now) / 36e5;

  let cursor = undefined;
  do {
    const page = await env.TEAM_KV.list({ prefix: "alerts:", cursor });
    cursor = page.cursor;
    for (const k of page.keys) {
      const chatId = k.name.split(":")[1];
      const cfg = await loadAlertsCfg(env, chatId);
      if (!cfg.on) continue;

      for (const T of (cfg.tminus || [24,2])) {
        if (Math.abs(hoursTo - T) <= 0.2) {
          const flagKey = alertedFlagKey(chatId, nextGW, T);
          const seen = await env.TEAM_KV.get(flagKey);
          if (seen) continue;

          await sendAlertForChat(env, chatId, settings, cfg, false);

          const ttl = Math.max(3600, Math.ceil((new Date(deadlineIso) - now)/1000) + 3600);
          await env.TEAM_KV.put(flagKey, "1", { expirationTtl: ttl });
        }
      }
    }
  } while (cursor);
}

function formatLocalDeadline(deadlineIso, tz) {
  // Fall back to UTC if tz is missing/invalid to avoid throwing inside Workers
  try {
    const zone = (typeof tz === "string" && tz.includes("/")) ? tz.trim() : "UTC";
    const d = new Date(deadlineIso);
    const s = new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
    return `${s} ${zone}`;
  } catch (e) {
    // absolute safety net
    const d = new Date(deadlineIso);
    const s = new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    }).format(d);
    return `${s} UTC`;
  }
}

async function sendAlertForChat(env, chatId, settings, alertsCfg, isTest=false){
  const bootstrap = await getJSONCached("https://fantasy.premierleague.com/api/bootstrap-static/", 60, 15000);
  const fixtures  = await getJSONCached("https://fantasy.premierleague.com/api/fixtures/",         60, 15000);
  const nextGW    = nextGwId(bootstrap);
  const ev        = (bootstrap?.events||[]).find(e=>e.id===nextGW);
  const deadline  = ev?.deadline_time;
  const deadlineStr = deadline ? formatLocalDeadline(deadline, alertsCfg.tz || "Asia/Kuala_Lumpur") : "—";

  const teamId = env.TEAM_KV ? await env.TEAM_KV.get(kvKey(chatId)) : null;
  let lines = [];
  lines.push(`GW${nextGW} ${isTest?"test ":""}deadline reminder`);
  lines.push(`Deadline: ${deadlineStr}`);

  if (!teamId) {
    lines.push("");
    lines.push("Tip: /linkteam <team_id> for personalized checks (FT, bank, captain, risks).");
    await reply(env, Number(chatId), lines.join("\n"));
    return;
  }

  const currentGW = currentGw(bootstrap);
  const picks = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/event/${currentGW}/picks/`, 12000);
  const entry = await getJSONSafe(`https://fantasy.premierleague.com/api/entry/${teamId}/`, 12000);
  if (!picks || !entry) {
    lines.push("");
    lines.push("Couldn’t fetch your team (is it private?).");
    await reply(env, Number(chatId), lines.join("\n"));
    return;
  }

  const bank = deriveBank(entry, picks, settings).toFixed(1);
  const ft   = Number(settings.free_transfers ?? 1);

  const caps = captainSuggest(picks, bootstrap, fixtures, settings, nextGW).slice(0,3);
  const capLine = caps.length ? caps.map(c=>c.name).join(", ") : "—";

  const byId = Object.fromEntries((bootstrap?.elements||[]).map(e=>[e.id,e]));
  const xi = (picks?.picks||[]).filter(p => (p.position||16) <= 11);
  const risky = xi.map(p=>byId[p.element]).filter(el=>el && minutesProb(el) < (settings.min_play_prob||80));
  const riskLine = risky.length ? risky.map(el=>`${el.web_name} (${minutesProb(el)}%)`).join(", ") : "none";

  lines.push(`FT: ${ft} • Bank: ${S.gbp(bank)}`);
  lines.push(`Captain picks: ${capLine}`);
  lines.push(`Risky starters (<${settings.min_play_prob}%): ${riskLine}`);
  lines.push("");
  lines.push("Quick checks: /formation /transfers /captain");

  await reply(env, Number(chatId), lines.join("\n"));
}

// ===============================================================
/* Misc helpers */
// ===============================================================
// ASCII-safe formatting for Telegram
function fmtMoney(n){ return `GBP ${Number(n).toFixed(1)}m`; }
function ascii(text){
  return String(text)
    .replace(/£/g,'GBP ')
    .replace(/[–—]/g,'-')
    .replace(/×/g,'x');
}
function welcomeText(){
  return (
`*FPL Assistant*
I help you before each deadline: captain picks, tidy transfers and an optimal XI.`
  );
}

// Short, one-screen help (ASCII only)
function helpText(){ return (
`*Quick start*
1) Link your team: \`/linkteam <team_id>\`
2) Try: \`/myteam\`, \`/squad\`, \`/captain\`, \`/transfers\`, \`/plan\`

*Essentials*
/myteam  - snapshot of your GW
/squad   - starters + bench
/captain - next GW picks
/transfers N +bank min=75 [id] - 1-move upgrades
/plan 0|1|2|3 +bank [id] - compare moves (with hits)

More: /help_more`
);}

// Full command list moved here to keep /start compact
function helpTextFull(){ return (
`*All commands*
/linkteam <id>   - link chat to your team   /unlink
/settings        - current weights & limits
/formation [id]  - optimal XI + bench
/risk [id]       - minutes risk scan
/chipplan N [id] - BB/TC/FH windows
/wcwhen N [id]   - Wildcard suggestion
/compare A vs B h=N - compare two players
/replace <name> [+bank|max=7.5|n=3] [id] - best replacements
/suggest [id]    - captain + top transfer
/alerts on|off|when|set|tz|test - deadline reminders

*Examples*
/transfers 10 +0.5 min=75
/plan 2
/wcwhen 6
/compare Watkins vs Isak h=6
/replace Estupinan +0.5 max=7.0 n=5`
);}
function kvKey(chatId){ return `team:${chatId}`; }
async function resolveTeamId(env, chatId, arg){
  if (/^\d+$/.test(String(arg))) return parseInt(arg,10);
  if (env.TEAM_KV){ const saved = await env.TEAM_KV.get(kvKey(chatId)); if (saved && /^\d+$/.test(saved)) return parseInt(saved,10); }
  return null;
}
function summarizeRemainingChips(all, used){
  const remaining=[...all]; for(const u of used){ const i=remaining.indexOf(u); if(i>=0) remaining.splice(i,1); }
  return remaining.length ? remaining.map(x=>x.replace(/_/g,' ').toUpperCase()).join(", ") : "—";
}