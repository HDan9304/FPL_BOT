// worker.js — commands + inline buttons on /transfer: [Refresh] [Full/Simple]

export default {
  async fetch(req, env) {
    const u = new URL(req.url), p = u.pathname.replace(/\/$/,"");
    if (req.method==="GET" && (p===""||p==="/")) return R("OK");

    // Init webhook (message + callback_query)
    if (req.method==="GET" && p==="/init-webhook") {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`, {
        method:"POST",
        headers:{"content-type":"application/json; charset=utf-8"},
        body:JSON.stringify({
          url:`${u.origin}/webhook/telegram`,
          secret_token: env.TELEGRAM_WEBHOOK_SECRET,
          allowed_updates:["message","callback_query"],
          drop_pending_updates:true
        })
      });
      const j = await r.json().catch(()=>({}));
      return R(j?.ok ? "webhook set" : `failed: ${j?.description||"unknown"}`, j?.ok?200:500);
    }

    // Telegram webhook
    if (p==="/webhook/telegram") {
      if (req.method!=="POST") return R("Method Not Allowed",405);
      if (req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET) return R("Forbidden",403);
      let up; try { up = await req.json() } catch { return R("Bad Request",400) }

      const msg = up?.message, cq = up?.callback_query;

      // text commands
      if (msg) {
        const chatId = msg?.chat?.id, t = (msg?.text||"").trim();
        if (!chatId) return R("ok");
        await env.FPL_BOT_KV.put(K.last(chatId), String(Date.now()));
        const c = cmd(t);
        switch (c.name) {
          case "start":       await handleStart(env, chatId, msg.from); break;
          case "linkteam":    await handleLinkTeam(env, chatId, c.args); break;
          case "myteam":      await handleMyTeam(env, chatId); break;
          case "transfer":    await handleTransfer(env, chatId, {h: num(c.args?.[0])||1, view:"full"}); break;
          case "transfer1":   await handleTransfer(env, chatId, {h:1, view:"full"}); break;
          case "transfer3":   await handleTransfer(env, chatId, {h:3, view:"full"}); break;
          case "tranfer3":    await handleTransfer(env, chatId, {h:3, view:"full"}); break; // typo-safe
          default:            await handleStart(env, chatId, msg.from); break;
        }
        return R("ok");
      }

      // inline button callbacks
      if (cq) {
        const chatId = cq?.message?.chat?.id;
        const data = cq?.data||"";
        if (!chatId) return R("ok");
        await env.FPL_BOT_KV.put(K.last(chatId), String(Date.now()));
        await tg(env,"answerCallbackQuery",{callback_query_id:cq.id});
        // formats:
        // xfer:refresh:h=1:v=full
        // xfer:toggle:h=1:v=full|simple
        if (data.startsWith("xfer:")) {
          const m = Object.fromEntries((data.split(":").slice(1).join(":").split("&").map(kv=>kv.split("="))).map(([k,v])=>[k,v]));
          const h = Math.max(1, Math.min(3, num(m.h)||1));
          const view = (m.v==="simple")?"simple":"full";
          if (data.startsWith("xfer:toggle")) {
            const nextView = view==="full" ? "simple" : "full";
            await handleTransfer(env, chatId, {h, view: nextView}, cq.message);
          } else {
            await handleTransfer(env, chatId, {h, view}, cq.message);
          }
        }
        return R("ok");
      }

      return R("ok");
    }

    return R("Not Found",404);
  }
};

const R = (s, st=200) => new Response(s, { status: st, headers:{"content-type":"text/plain; charset=utf-8"} });

/* ---------- commands ---------- */
async function handleStart(env, chatId, from){
  const f = ascii((from?.first_name||"there").trim());
  const html = [
    `<b>${esc(`Hey ${f}!`)}</b>`,
    "",
    esc("Use commands (buttons only under /transfer):"),
    "",
    `${B("Link Team")} <code>/linkteam &lt;YourTeamID&gt;</code>`,
    `${B("My Team")} <code>/myteam</code>`,
    `${B("Transfer Planner (full)")} <code>/transfer</code>`,
    `${B("Transfer Planner horizon 3")} <code>/transfer 3</code>`
  ].join("\n");
  await sendHTML(env, chatId, html);
}

async function handleLinkTeam(env, chatId, args){
  const raw = (args?.[0]||"").trim();
  if (!raw) {
    const g = [
      `<b>${esc("Link Your FPL Team")}</b>`,
      "",
      `${B("Where To Find Team ID")} ${esc("fantasy.premierleague.com → My Team")}`,
      `${esc("URL example:")} <code>/entry/1234567/</code>`,
      "",
      `${B("How To Link")}`,
      `<pre><code>/linkteam 1234567</code></pre>`
    ].join("\n");
    return sendHTML(env, chatId, g);
  }
  const tid = Number(raw);
  if (!Number.isInteger(tid)||tid<=0) return sendHTML(env, chatId, `${B("Tip")} ${esc("Use a numeric ID, e.g.")} <code>/linkteam 1234567</code>`);
  const ent = await fplEntry(tid);
  if (!ent) return sendHTML(env, chatId, `${B("Not Found")} ${esc("That team ID didn’t resolve. Double-check and try again.")}`);

  const now = Date.now();
  await env.FPL_BOT_KV.put(K.user(chatId), JSON.stringify({ teamId:tid, createdAt:now, updatedAt:now }));
  const tname = ascii(`${ent.name||"Team"}`), mgr = ascii(`${ent.player_first_name||""} ${ent.player_last_name||""}`.trim());
  const html = [
    `<b>${esc("Team Linked")}</b> ✅`,
    "",
    `${B("Team")} <b>${esc(tname)}</b>`,
    mgr?`${B("Manager")} ${esc(mgr)}`:"",
    `${B("Team ID")} ${esc(String(tid))}`,
    "",
    `${B("Next")} ${esc("try")} <code>/myteam</code> ${esc("or")} <code>/transfer</code>`
  ].filter(Boolean).join("\n");
  await sendHTML(env, chatId, html);
}

async function handleMyTeam(env, chatId){
  const prof = await env.FPL_BOT_KV.get(K.user(chatId)).then(j=>j&&JSON.parse(j)).catch(()=>null);
  const tid = prof?.teamId;
  if (!tid) return sendHTML(env, chatId, [`${B("No Team Linked")} ${esc("Add your team first:")}`,"",`<code>/linkteam &lt;YourTeamID&gt;</code>`].join("\n"));

  const boot = await bootStatic(); if(!boot) return sendHTML(env, chatId, `${B("Busy")} ${esc("FPL is busy. Try again shortly.")}`);
  const ev = boot.events||[], els=boot.elements||[], tms=boot.teams||[];
  const el = new Map(els.map(e=>[e.id,e])), abbr=i=>(tms.find(x=>x.id===i)?.short_name||"");
  const posName=t=>({1:"GK",2:"DEF",3:"MID",4:"FWD"}[t]||"");
  const cur = ev.find(e=>e.is_current) || ev.filter(e=>e.finished).sort((a,b)=>b.id-a.id)[0] || null;
  if(!cur) return sendHTML(env, chatId, `${B("Oops")} ${esc("Couldn't determine the current gameweek.")}`);
  const gw = cur.id;

  const [entry,hist,picks,live] = await Promise.all([fplEntry(tid), fplEntryHistory(tid), fplEntryPicks(tid,gw), fplEventLive(gw)]);
  if(!entry||!hist||!picks||!live) return sendHTML(env, chatId, `${B("Error")} ${esc("Couldn't load your team right now.")}`);

  const row = (hist.current||[]).find(r=>r.event===gw);
  const pts=row?.points??null, rank=row?.overall_rank??row?.rank??null, val=row?.value??hist?.current?.slice(-1)?.[0]?.value??entry?.value??null, bank=row?.bank??hist?.current?.slice(-1)?.[0]?.bank??entry?.bank??null;

  const arr=(picks.picks||[]).slice().sort((a,b)=>a.position-b.position), XI=arr.filter(p=>p.position<=11), BN=arr.filter(p=>p.position>=12);
  const liveMap=new Map(); (live.elements||[]).forEach(e=>{
    let bonus=0,mins=0;
    if(Array.isArray(e.explain)) for(const ex of e.explain) for(const st of(ex.stats||[])){ if(st.identifier==="bonus") bonus+=(st.points||0); if(st.identifier==="minutes") mins+=(st.value||0) }
    if(typeof e.stats?.bonus==="number") bonus=e.stats.bonus;
    if(typeof e.stats?.minutes==="number") mins=e.stats.minutes;
    liveMap.set(e.id,{total:e.stats?.total_points??0,bonus,minutes:mins});
  });
  const C=XI.find(p=>p.is_captain)?.element, VC=arr.find(p=>p.is_vice_captain)?.element;

  const group={GK:[],DEF:[],MID:[],FWD:[]};
  const line=p=>{
    const e=el.get(p.element); if(!e) return null;
    const L=liveMap.get(p.element)||{total:0,bonus:0};
    const raw=L.total, bon=L.bonus>0?` (+${L.bonus} bonus)`:"", mul=p.multiplier||0, tag=p.element===C?" (C)":(p.element===VC?" (VC)":"");
    const mulN=mul===0?" (bench)":(mul===1?"":` (x${mul}=${raw*mul})`);
    return `${esc(`${e.web_name}${tag}`)} ${esc(`(${abbr(e.team)}, ${posName(e.element_type)})`)} ${esc(String(raw))}${esc(bon)}${esc(mulN)}`;
  };
  for(const p of XI){ const e=el.get(p.element); if(!e) continue; const ln=line(p); if(!ln) continue;
    const ps=posName(e.element_type); if(ps==="GK")group.GK.push(ln); else if(ps==="DEF")group.DEF.push(ln); else if(ps==="MID")group.MID.push(ln); else group.FWD.push(ln);
  }
  const bn = BN.map(line).filter(Boolean);

  const tn=ascii(`${entry.name||"Team"}`), money=v=>typeof v==="number"?(v/10).toFixed(1):"-", fmt=n=>typeof n==="number"?n.toLocaleString("en-GB"):"-";
  const head=`<b>${esc(tn)}</b>\n${esc(`Gameweek ${gw} (current)`)}`;
  const sum1=pipes([F("Points",pts!=null?String(pts):"-"),F("Overall Rank",rank!=null?fmt(rank):"-"),F("Team Value",money(val)),F("Bank",money(bank))]);
  const sum2=pipes([F("Captain",C?(el.get(C)?.web_name||""):"—"),F("Vice-Captain",VC?(el.get(VC)?.web_name||""):"—")]);
  const XIblk=[section("GK",group.GK),section("DEF",group.DEF),section("MID",group.MID),section("FWD",group.FWD)].filter(Boolean).join("\n");
  const BNblk=bn.length?section("Bench",bn):"";
  const html=[head,"",sum1,sum2,"","",XIblk,BNblk].filter(Boolean).join("\n");
  await sendHTML(env, chatId, html);
}

/* ---------- /transfer core (supports view=full|simple) ---------- */
async function handleTransfer(env, chatId, opts={}, editMsg /* optional message to edit */){
  const h = Math.max(1,Math.min(3, num(opts.h)||1));
  const view = (opts.view==="simple")?"simple":"full";

  const prof=await env.FPL_BOT_KV.get(K.user(chatId)).then(j=>j&&JSON.parse(j)).catch(()=>null), tid=prof?.teamId;
  if(!tid) return sendHTML(env, chatId, [`${B("No Team Linked")} ${esc("Add your team first:")}`,"",`<code>/linkteam &lt;YourTeamID&gt;</code>`].join("\n"));

  const boot=await bootStatic(); if(!boot) return sendHTML(env, chatId, `${B("Busy")} ${esc("FPL is busy. Try again shortly.")}`);
  const ev=boot.events||[], els=boot.elements||[], tms=boot.teams||[];
  const elMap=new Map(els.map(e=>[e.id,e])), abbr=i=>(tms.find(x=>x.id===i)?.short_name||""), pos=t=>({1:"GK",2:"DEF",3:"MID",4:"FWD"}[t]||"");
  const cur=ev.find(e=>e.is_current)||ev.filter(e=>e.finished).sort((a,b)=>b.id-a.id)[0]||null;
  const next=ev.find(e=>e.is_next)||((cur&&ev.find(e=>e.id===cur.id+1))||null);
  const curId=cur?.id, nextId=next?.id||(curId?curId+1:null);
  if(!curId||!nextId) return sendHTML(env, chatId, `${B("Oops")} ${esc("Can't resolve next gameweek yet.")}`);

  const dlRaw=next?.deadline_time||null, dlMs=dlRaw?new Date(dlRaw).getTime():null, beforeDL=dlMs?Date.now()<dlMs:false;

  const curPicks=await fplEntryPicks(tid,curId), prevPicks=(curId>1)?await fplEntryPicks(tid,curId-1):null;
  const activeChip=curPicks?.active_chip||null, base=(activeChip==="freehit"&&prevPicks?.picks?.length)?prevPicks:curPicks;
  const bank=curPicks?.entry_history?.bank??0, usedThisGW=curPicks?.entry_history?.event_transfers??0, ftNext=(beforeDL&&usedThisGW===0)?2:1;

  // Fixtures map gw->teamId -> [{oppId, home, diff}]
  const fixMap=new Map(), key=(gw,tid)=>`${gw}:${tid}`;
  const horizon = h; // overall horizon
  for (let g=0; g<horizon; g++){
    const gw = nextId + g;
    const fx = await fplFixtures(gw); if(!fx) continue;
    for (const f of fx){
      const H={oppId:f.team_a, home:true,  diff:f.team_h_difficulty};
      const A={oppId:f.team_h, home:false, diff:f.team_a_difficulty};
      const hk=key(gw,f.team_h), ak=key(gw,f.team_a);
      (fixMap.get(hk)||fixMap.set(hk,[]).get(hk)).push(H);
      (fixMap.get(ak)||fixMap.set(ak,[]).get(ak)).push(A);
    }
  }
  const fmtF=(teamId,gw)=>{ const a=fixMap.get(key(gw,teamId))||[];
    if(a.length===0) return "BLANK";
    if(a.length>1) return "DGW: "+a.map(v=>`${abbr(v.oppId)} (${v.home?"H":"A"},${v.diff})`).join(" | ");
    const v=a[0]; return `${abbr(v.oppId)} (${v.home?"H":"A"},${v.diff})`;
  };
  const tough=(teamId,gw)=>{const a=fixMap.get(key(gw,teamId))||[];if(a.length===0)return {label:"BLANK",isBlank:true,isTough:false,isDGW:false};const tAny=a.some(v=>v.diff>=4);return {label:fmtF(teamId,gw),isBlank:false,isTough:tAny,isDGW:a.length>1}};

  // Build groups
  const picks=(base?.picks||[]).slice().sort((a,b)=>a.position-b.position), XI=picks.filter(p=>p.position<=11), BN=picks.filter(p=>p.position>=12);
  const perPlayerH = (view==="simple") ? 1 : horizon;
  const mk=(p)=>{ const e=elMap.get(p.element); if(!e) return null;
    const sp=sellPrice(p,e);
    let s=`${e.web_name} (${abbr(e.team)}, ${pos(e.element_type)}) £${(sp/10).toFixed(1)} sell — ${fmtF(e.team,nextId)}`;
    if(perPlayerH>1) s+=`\n   +1: ${fmtF(e.team,nextId+1)}`;
    if(perPlayerH>2) s+=`\n   +2: ${fmtF(e.team,nextId+2)}`;
    return esc(s);
  };
  const G={GK:[],DEF:[],MID:[],FWD:[]}, Bench=[];
  for (const p of XI){ const e=elMap.get(p.element); if(!e) continue; const ln=mk(p); if(!ln) continue;
    const t=e.element_type; if(t===1)G.GK.push(ln); else if(t===2)G.DEF.push(ln); else if(t===3)G.MID.push(ln); else G.FWD.push(ln);
  }
  for (const p of BN){ const ln=mk(p); if(ln) Bench.push(ln); }

  // Priority Watchlist (only in full view)
  let watchTop = "";
  if (view==="full") {
    const riskItems=[], riskFor=(p)=>{ const e=elMap.get(p.element); if(!e) return null;
      const N=tough(e.team,nextId), N1=(horizon>1)?tough(e.team,nextId+1):null;
      const chance=Number.isFinite(e.chance_of_playing_next_round)?e.chance_of_playing_next_round:null;
      const status=e.status||"";
      const injFlag=(status!=="a") || (chance!=null && chance<75);
      const lowMin=(chance!=null && chance>0 && chance<75);
      const blankFlag=N.isBlank, toughN=N.isTough, toughN1=N1?N1.isTough:false, dgwGood=N.isDGW && !toughN;
      const netOut=(e.transfers_out_event||0)-(e.transfers_in_event||0);
      const dropRisk=(netOut>20000)&&((e.cost_change_event_fall||0)===0);
      let score=0;
      if(blankFlag) score+=50; if(injFlag) score+=40; if(lowMin) score+=30; if(toughN) score+=25; if(toughN1) score+=10; if(dropRisk) score+=10; if(dgwGood) score-=10;
      const flags=[]; if(blankFlag) flags.push("BLANK"); if(N.isDGW) flags.push("DGW");
      if(injFlag) flags.push(chance===0?"OUT":"FLAG"); else if(lowMin) flags.push("MIN?");
      if(toughN) flags.push("Tough N"); if(toughN1) flags.push("Tough N+1"); if(dropRisk) flags.push("£ drop?");
      const baseName=`${e.web_name} (${abbr(e.team)}, ${pos(e.element_type)})`;
      const ann=[`N: ${N.label}`]; if(horizon>1) ann.push(`N+1: ${N1?N1.label:"—"}`);
      return {score, text:`${esc(baseName)} — ${esc(flags.join(", ")||"OK")}\n   ${esc(ann.join("  |  "))}`};
    };
    for(const p of picks){ const r=riskFor(p); if(r) riskItems.push(r) }
    riskItems.sort((a,b)=>b.score-a.score);
    watchTop = riskItems.filter(r=>r.score>0).slice(0,8).map(r=>`• ${r.text}`).join("\n");
  }

  // Header
  const fmtUTC=d=>{const z=n=>String(n).padStart(2,"0");return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())} UTC`};
  const countdown=ms=>{ if(ms<=0) return "deadline passed"; const d=Math.floor(ms/864e5), h2=Math.floor(ms%864e5/36e5), m=Math.floor(ms%36e5/6e4); return `${d}d ${h2}h ${m}m` };
  const dlStr=dlRaw?fmtUTC(new Date(dlRaw)):"—", leftMs=dlMs!=null?dlMs-Date.now():null, leftStr=leftMs!=null?countdown(leftMs):"—";
  const reason=(ftNext===2)?"0 transfers used this GW + before deadline → rollover to 2 FTs.":"Standard 1 FT for next GW.";
  const tip= leftMs==null ? "When prices are volatile, act after pressers; otherwise 12–24h before deadline."
          : leftMs>72*36e5 ? "Plenty of time: wait for press conferences and injuries, move ~12–24h before deadline."
          : leftMs>6*36e5  ? "Hold until key team news; consider moving ~2–6h before deadline."
          : leftMs>0       ? "Tight window: finalize moves now to avoid a last-minute rush."
          :                   "Deadline passed—plan for the following GW.";

  const head = `<b>${esc("Transfers (Planner)")}</b>`;
  const line1 = `${B("Target GW")} ${esc(String(nextId))}`;
  const line2 = pipes([`${B("Deadline (UTC)")} ${esc(dlStr)}`, `${B("Countdown")} ${esc(leftStr)}`]);
  const line3 = `${B("Free Transfers (next)")} ${esc(String(ftNext))} - ${esc(reason)}`;
  const line4 = pipes([`${B("Bank (ITB)")} ${esc(`£${(bank/10).toFixed(1)}`)}`, `${B("Suggestion")} ${esc(tip)}`]);

  const bullets = s => s.map(v=>`• ${v}`).join("\n");
  const baseTitle = `\n${B("Base Squad")} ${esc("(selling prices)")}\n`;
  const body = [
    `${B("GK")} \n${bullets(G.GK)}`,
    `\n${B("DEF")} \n${bullets(G.DEF)}`,
    `\n${B("MID")} \n${bullets(G.MID)}`,
    `\n${B("FWD")} \n${bullets(G.FWD)}`,
    `\n${B("Bench")} \n${bullets(Bench)}`
  ].join("\n\n");

  const watchTitle = (view==="full" && watchTop) ? `\n${B("Priority Watchlist (GW N)")} ${esc("(highest concern first)")}\n` : "";
  const shortcuts = `\n${B("Shortcuts")} /transfer1  ${esc("|")}  /transfer3`;

  const html = [head,"",line1,line2,line3,line4,baseTitle,body,watchTitle,watchTop,shortcuts].filter(Boolean).join("\n");

  // Inline keyboard: [Refresh] [Full/Simple]
  const ik = ikTransfer(h, view);
  if (editMsg?.message_id) {
    await tg(env,"editMessageText",{chat_id:chatId, message_id:editMsg.message_id, text:html, parse_mode:"HTML", disable_web_page_preview:true, reply_markup:ik});
  } else {
    await sendHTML(env, chatId, html, ik);
  }
}

/* ---------- Inline keyboard for /transfer ---------- */
const ikTransfer=(h,view)=>({
  inline_keyboard:[
    [
      {text:"Refresh", callback_data:`xfer:refresh&h=${Math.max(1,Math.min(3,num(h)||1))}&v=${view==="simple"?"simple":"full"}`},
      {text: view==="full"?"Simple":"Full", callback_data:`xfer:toggle&h=${Math.max(1,Math.min(3,num(h)||1))}&v=${view==="simple"?"simple":"full"}`}
    ]
  ]
});

/* ---------- Telegram helpers ---------- */
async function sendHTML(env, chat_id, html, reply_markup){
  const p={chat_id, text: html, parse_mode:"HTML", disable_web_page_preview:true};
  if (reply_markup) p.reply_markup = reply_markup;
  try {
    const r = await tg(env,"sendMessage",p);
    if (!r?.ok) await tg(env,"sendMessage",{chat_id,text:strip(html)});
  } catch {
    await tg(env,"sendMessage",{chat_id,text:strip(html)});
  }
}
async function tg(env, meth, payload){
  try {
    const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${meth}`, {
      method:"POST", headers:{"content-type":"application/json; charset=utf-8"}, body:JSON.stringify(payload)
    });
    return await r.json();
  } catch { return { ok:false } }
}

/* ---------- FPL API ---------- */
const bootStatic = async()=>{ try{const r=await fetch("https://fantasy.premierleague.com/api/bootstrap-static/",{cf:{cacheTtl:60}}); if(!r.ok)return null; return await r.json().catch(()=>null)}catch{return null} };
const fplEntry = async(id)=>{ try{const r=await fetch(`https://fantasy.premierleague.com/api/entry/${id}/`,{cf:{cacheTtl:0}}); if(!r.ok)return null; const j=await r.json().catch(()=>null); if(!j||(j.id!==id&&typeof j.id!=="number"))return null; return j}catch{return null}};
const fplEntryHistory = async(id)=>{ try{const r=await fetch(`https://fantasy.premierleague.com/api/entry/${id}/history/`,{cf:{cacheTtl:0}}); if(!r.ok)return null; return await r.json().catch(()=>null)}catch{return null}};
const fplEntryPicks = async(id,gw)=>{ try{const r=await fetch(`https://fantasy.premierleague.com/api/entry/${id}/event/${gw}/picks/`,{cf:{cacheTtl:0}}); if(!r.ok)return null; return await r.json().catch(()=>null)}catch{return null}};
const fplEventLive = async(gw)=>{ try{const r=await fetch(`https://fantasy.premierleague.com/api/event/${gw}/live/`,{cf:{cacheTtl:30}}); if(!r.ok)return null; return await r.json().catch(()=>null)}catch{return null}};
const fplFixtures = async(gw)=>{ try{const r=await fetch(`https://fantasy.premierleague.com/api/fixtures/?event=${gw}`,{cf:{cacheTtl:120}}); if(!r.ok)return null; return await r.json().catch(()=>null)}catch{return null}};

/* ---------- utils ---------- */
const cmd = t => !t.startsWith("/") ? {name:"",args:[]} : {name:t.split(/\s+/)[0].slice(1).toLowerCase(), args:t.split(/\s+/).slice(1)};
const num = v => Number.parseInt(v,10);
const sellPrice = (p,e) => Number.isFinite(p?.selling_price) ? p.selling_price :
  (Number.isFinite(p?.purchase_price)&&Number.isFinite(e?.now_cost) ? (p.purchase_price + Math.floor(Math.max(0,e.now_cost - p.purchase_price)/2)) :
  (Number.isFinite(e?.now_cost) ? e.now_cost : Number.isFinite(p?.purchase_price) ? p.purchase_price : 0));
function simulateAutosubs(XI,BN,live,el){const pos=id=>({1:"GK",2:"DEF",3:"MID",4:"FWD"}[el.get(id)?.element_type]||""),mins=id=>live.get(id)?.minutes||0,ct={GK:0,DEF:0,MID:0,FWD:0};for(const p of XI)ct[pos(p.element)]++;const zeroGK=XI.find(p=>pos(p.element)==="GK"&&mins(p.element)===0)||null,zeroOut=XI.filter(p=>pos(p.element)!=="GK"&&mins(p.element)===0),out=[],used=new Set();const bGK=BN.find(p=>pos(p.element)==="GK");if(zeroGK&&bGK&&mins(bGK.element)>0){out.push({outId:zeroGK.element,inId:bGK.element,outPos:"GK",inPos:"GK",outName:el.get(zeroGK.element)?.web_name||"",inName:el.get(bGK.element)?.web_name||""});used.add(bGK.element)}const need={DEF:3,MID:2,FWD:1},B=BN.filter(p=>pos(p.element)!=="GK");for(const bp of B){if(used.has(bp.element))continue;if(mins(bp.element)<=0)continue;const bP=pos(bp.element);for(let i=0;i<zeroOut.length;i++){const sp=zeroOut[i],sP=pos(sp.element),c={...ct};c[sP]--;c[bP]++;if(c.DEF>=need.DEF&&c.MID>=need.MID&&c.FWD>=need.FWD){ct[sP]--;ct[bP]++;out.push({outId:sp.element,inId:bp.element,outPos:sP,inPos:bP,outName:el.get(sp.element)?.web_name||"",inName:el.get(bp.element)?.web_name||""});zeroOut.splice(i,1);used.add(bp.element);break}}}return out}
const section = (lab,lines)=>lines.length?([`${B(lab)}`,...lines,""].join("\n")):"";
const ascii = s=>String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\u2014|\u2013/g,"-").replace(/\u00A0/g," ");
const esc = s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const strip = s=>s.replace(/<[^>]+>/g,"");
const B = lab=>`<b>${esc(lab)}:</b>`;
const F = (lab,val)=>`<b>${esc(lab)}:</b> ${esc(String(val))}`;
const pipes = arr=>arr.filter(Boolean).join(` ${esc("|")} `);

/* ---------- KV keys ---------- */
const K = { last:id=>`chat:${id}:last_seen`, user:id=>`user:${id}:profile` };