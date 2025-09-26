// worker.js (ultra-compact, with /transfer planner + selling price + suggestion)
export default{async fetch(req,env){const u=new URL(req.url),p=u.pathname.replace(/\/$/,"");if(req.method==="GET"&&(p===""||p==="/"))return x("OK");if(req.method==="GET"&&p==="/init-webhook"){const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`,{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify({url:`${u.origin}/webhook/telegram`,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message"],drop_pending_updates:true})});const j=await r.json().catch(()=>({}));return x(j?.ok?"webhook set":`failed: ${j?.description||"unknown"}`,j?.ok?200:500)}if(p==="/webhook/telegram"){if(req.method!=="POST")return x("Method Not Allowed",405);if(req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET)return x("Forbidden",403);let up;try{up=await req.json()}catch{return x("Bad Request",400)}const m=up?.message,cid=m?.chat?.id,t=(m?.text||"").trim();if(!cid)return x("ok");await env.FPL_BOT_KV.put(K.last(cid),String(Date.now()));const c=cmd(t);switch(c.name){case"start":await handleStart(env,m);break;case"linkteam":await handleLinkTeam(env,m,c.args);break;case"myteam":await handleMyTeam(env,m);break;case"transfer":await handleTransfer(env,m);break;default:break}return x("ok")}return x("Not Found",404)}};
const x=(s,st=200)=>new Response(s,{status:st,headers:{"content-type":"text/plain; charset=utf-8"}});

/* ---------- commands ---------- */
async function handleStart(env,m){const id=m.chat.id,f=ascii((m.from?.first_name||"there").trim());const html=[`<b>${esc(`Hey ${f}!`)}</b>`,"",esc("I show a clean, current-GW overview of your FPL squad."),"",`${B("Link Team")} <code>/linkteam &lt;YourTeamID&gt;</code>`,"",`${B("My Team (Current GW)")} <code>/myteam</code>`,"",`${B("Transfers (Next GW)")} <code>/transfer</code>`].join("\n");await sendHTML(env,id,html,keys())}

async function handleLinkTeam(env,m,args){const id=m.chat.id,raw=(args[0]||"").trim();if(!raw){const g=[`<b>${esc("Link Your FPL Team")}</b>`,"",`${B("Where To Find Team ID")} ${esc("Open fantasy.premierleague.com -> My Team")}`,`${esc("Look at the URL:")} <code>/entry/1234567/</code> ${esc("- that's your ID")}`,"",B("How To Link"),`<pre><code>/linkteam 1234567</code></pre>`].join("\n");return sendHTML(env,id,g,keys())}const tid=Number(raw);if(!Number.isInteger(tid)||tid<=0)return sendHTML(env,id,`${B("Tip")} ${esc("Use a numeric ID, e.g.")} <code>/linkteam 1234567</code>`,keys());const ent=await fplEntry(tid);if(!ent)return sendHTML(env,id,`${B("Not Found")} ${esc("That team ID didn’t resolve. Double-check and try again.")}`,keys());const now=Date.now();await env.FPL_BOT_KV.put(K.user(id),JSON.stringify({teamId:tid,createdAt:now,updatedAt:now}));const tname=ascii(`${ent.name||"Team"}`),mgr=ascii(`${ent.player_first_name||""} ${ent.player_last_name||""}`.trim());const html=[`<b>${esc("Team Linked")}</b> ✅`,"",`${B("Team")} <b>${esc(tname)}</b>`,mgr?`${B("Manager")} ${esc(mgr)}`:"",`${B("Team ID")} ${esc(String(tid))}`,"",`${B("Next")} <code>/myteam</code> ${esc("(current GW)")}`].filter(Boolean).join("\n");await sendHTML(env,id,html,keys())}

async function handleMyTeam(env,m){const id=m.chat.id,prof=await env.FPL_BOT_KV.get(K.user(id)).then(j=>j&&JSON.parse(j)).catch(()=>null),tid=prof?.teamId;if(!tid)return sendHTML(env,id,[`${B("No Team Linked")} ${esc("Add your team first:")}`,"",`<code>/linkteam &lt;YourTeamID&gt;</code>`].join("\n"),keys());const boot=await bootStatic();if(!boot)return sendHTML(env,id,`${B("Busy")} ${esc("FPL is busy. Try again shortly.")}`,keys());const ev=boot.events||[],els=boot.elements||[],tms=boot.teams||[],el=new Map(els.map(e=>[e.id,e])),abbr=i=>(tms.find(x=>x.id===i)?.short_name||""),pos=t=>({1:"GK",2:"DEF",3:"MID",4:"FWD"}[t]||"");const cur=ev.find(e=>e.is_current)||ev.filter(e=>e.finished).sort((a,b)=>b.id-a.id)[0]||null;if(!cur)return sendHTML(env,id,`${B("Oops")} ${esc("Couldn't determine the current gameweek.")}`,keys());const gw=cur.id;const [entry,hist,picks,live]=await Promise.all([fplEntry(tid),fplEntryHistory(tid),fplEntryPicks(tid,gw),fplEventLive(gw)]);if(!entry||!hist||!picks||!live)return sendHTML(env,id,`${B("Error")} ${esc("Couldn't load your team right now.")}`,keys());const row=(hist.current||[]).find(r=>r.event===gw),pts=row?.points??null,rank=row?.overall_rank??row?.rank??null,val=row?.value??hist?.current?.slice(-1)?.[0]?.value??entry?.value??null,bank=row?.bank??hist?.current?.slice(-1)?.[0]?.bank??entry?.bank??null;const arr=(picks.picks||[]).slice().sort((a,b)=>a.position-b.position),XI=arr.filter(p=>p.position<=11),BN=arr.filter(p=>p.position>=12);const liveMap=new Map();(live.elements||[]).forEach(e=>{let bonus=0,mins=0;if(Array.isArray(e.explain))for(const ex of e.explain)for(const st of(ex.stats||[])){if(st.identifier==="bonus")bonus+=(st.points||0);if(st.identifier==="minutes")mins+=(st.value||0)}if(typeof e.stats?.bonus==="number")bonus=e.stats.bonus;if(typeof e.stats?.minutes==="number")mins=e.stats.minutes;liveMap.set(e.id,{total:e.stats?.total_points??0,bonus,minutes:mins})});const C=XI.find(p=>p.is_captain)?.element,VC=arr.find(p=>p.is_vice_captain)?.element;const grp={GK:[],DEF:[],MID:[],FWD:[]},line=p=>{const e=el.get(p.element);if(!e)return null;const L=liveMap.get(p.element)||{total:0,bonus:0},name=`${e.web_name}`,club=abbr(e.team),ps=pos(e.element_type),mul=p.multiplier||0,isC=p.element===C,isVC=p.element===VC,raw=L.total,bon=L.bonus>0?` (+${L.bonus} bonus)`:"",mulN=mul===0?" (bench)":(mul===1?"":` (x${mul}=${raw*mul})`),tag=isC?" (C)":(isVC?" (VC)":"");return `${esc(`${name}${tag}`)} ${esc(`(${club}, ${ps})`)} ${esc(String(raw))}${esc(bon)}${esc(mulN)}`};for(const p of XI){const e=el.get(p.element);if(!e)continue;const ps=pos(e.element_type),ln=line(p);if(!ln)continue;if(ps==="GK")grp.GK.push(ln);else if(ps==="DEF")grp.DEF.push(ln);else if(ps==="MID")grp.MID.push(ln);else grp.FWD.push(ln)}const bnLines=BN.map(line).filter(Boolean);const act=picks.active_chip||null,played=(hist.chips||[]).map(c=>c.name),avail=remainingChips(played),subs=simulateAutosubs(XI,BN,liveMap,el);const tn=ascii(`${entry.name||"Team"}`),money=v=>typeof v==="number"?(v/10).toFixed(1):"-",fmt=n=>typeof n==="number"?n.toLocaleString("en-GB"):"-";const head=`<b>${esc(tn)}</b>\n${esc(`Gameweek ${gw} (current)`)}`,sum1=pipes([F("Points",pts!=null?String(pts):"-"),F("Overall Rank",rank!=null?fmt(rank):"-"),F("Team Value",money(val)),F("Bank",money(bank))]),sum2=pipes([F("Captain",C?(el.get(C)?.web_name||""):"—"),F("Vice-Captain",VC?(el.get(VC)?.web_name||""):"—"),F("Active Chip",act?niceChip(act):"None")]);const XIblk=[section("GK",grp.GK),section("DEF",grp.DEF),section("MID",grp.MID),section("FWD",grp.FWD)].filter(Boolean).join("\n"),BNblk=bnLines.length?section("Bench",bnLines):"",ASblk=subs.length?section("Auto-subs (projected)",subs.map(s=>esc(`${s.outName} (${s.outPos}) -> ${s.inName} (${s.inPos})`))):"",chips=`${B("Available Chips")} ${esc((avail.join(", ")||"None").trim())}`;const html=[head,"",sum1,sum2,"","",XIblk,BNblk,ASblk,chips].filter(Boolean).join("\n");await sendHTML(env,id,html,keys())}

async function handleTransfer(env,m){
  const id=m.chat.id,prof=await env.FPL_BOT_KV.get(K.user(id)).then(j=>j&&JSON.parse(j)).catch(()=>null),tid=prof?.teamId;
  if(!tid)return sendHTML(env,id,[`${B("No Team Linked")} ${esc("Add your team first:")}`,"",`<code>/linkteam &lt;YourTeamID&gt;</code>`].join("\n"),keys());

  const boot=await bootStatic(); if(!boot)return sendHTML(env,id,`${B("Busy")} ${esc("FPL is busy. Try again shortly.")}`,keys());
  const ev=boot.events||[], els=boot.elements||[], tms=boot.teams||[], elMap=new Map(els.map(e=>[e.id,e]));
  const abbr=i=>(tms.find(x=>x.id===i)?.short_name||""), pos=t=>({1:"GK",2:"DEF",3:"MID",4:"FWD"}[t]||"");

  const cur=ev.find(e=>e.is_current)||ev.filter(e=>e.finished).sort((a,b)=>b.id-a.id)[0]||null;
  const next=ev.find(e=>e.is_next)||((cur&&ev.find(e=>e.id===cur.id+1))||null);
  const curId=cur?.id, nextId=next?.id||(curId?curId+1:null);
  const dlRaw=next?.deadline_time||null, dlMs=dlRaw?new Date(dlRaw).getTime():null, beforeDL=dlMs?Date.now()<dlMs:false;
  if(!curId||!nextId) return sendHTML(env,id,`${B("Oops")} ${esc("Can't resolve next gameweek yet.")}`,keys());

  const curPicks=await fplEntryPicks(tid,curId);
  const prevPicks=(curId>1)?await fplEntryPicks(tid,curId-1):null;
  const activeChip=curPicks?.active_chip||null;
  const base = (activeChip==="freehit" && prevPicks?.picks?.length) ? prevPicks : curPicks;

  const bank = curPicks?.entry_history?.bank ?? 0; // tenths
  const usedThisGW = curPicks?.entry_history?.event_transfers ?? 0;
  const ftNext = (beforeDL && usedThisGW===0) ? 2 : 1;

  const baseP=(base?.picks||[]).slice().sort((a,b)=>a.position-b.position);
  const group={GK:[],DEF:[],MID:[],FWD:[]};
  for(const p of baseP){
    const e=elMap.get(p.element); if(!e) continue;
    const sp=sellPrice(p,e); // tenths
    const line=`${esc(e.web_name)} ${esc(`(${abbr(e.team)}, ${pos(e.element_type)})`)} ${esc(`£${(sp/10).toFixed(1)} sell`)}`;
    if(e.element_type===1)group.GK.push(line); else if(e.element_type===2)group.DEF.push(line); else if(e.element_type===3)group.MID.push(line); else group.FWD.push(line);
  )}

  const fmtUTC=d=>{const z=n=>String(n).padStart(2,"0");return `${d.getUTCFullYear()}-${z(d.getUTCMonth()+1)}-${z(d.getUTCDate())} ${z(d.getUTCHours())}:${z(d.getUTCMinutes())} UTC`};
  const countdown=ms=>{if(ms<=0)return "deadline passed";const d=Math.floor(ms/864e5),h=Math.floor(ms%864e5/36e5),m=Math.floor(ms%36e5/6e4);return `${d}d ${h}h ${m}m`};
  const dlStr=dlRaw?fmtUTC(new Date(dlRaw)):"—", leftMs=dlMs!=null?dlMs-Date.now():null, leftStr=leftMs!=null?countdown(leftMs):"—";

  const reasonFT=(ftNext===2)?"0 transfers used this GW + before deadline → rollover to 2 FTs.":"Standard 1 FT for next GW.";
  const fhNote=(activeChip==="freehit")?"Free Hit active this GW → base squad reverts to last GW picks.":"";
  const tip = leftMs==null ? "When prices are volatile, act after pressers; otherwise 12–24h before deadline."
           : leftMs>72*36e5 ? "Plenty of time: wait for press conferences and injuries, move ~12–24h before deadline."
           : leftMs>6*36e5  ? "Hold until key team news; consider moving ~2–6h before deadline."
           : leftMs>0       ? "Tight window: finalize moves now to avoid a last-minute rush."
           :                  "Deadline passed—plan for the following GW.";

  const head=`<b>${esc("Transfers (Planner)")}</b>`;
  const top=[`${B("Target GW")} ${esc(String(nextId))}`,`${B("Deadline (UTC)")} ${esc(dlStr)}`,`${B("Countdown")} ${esc(leftStr)}`].join("\n");
  const ft=[`${B("Free Transfers (next)")} ${esc(String(ftNext))}`,`  ${esc(reasonFT)}`].join("\n");
  const itb=`${B("Bank (ITB)")} ${esc(`£${(bank/10).toFixed(1)}`)}`;
  const sugg=`${B("Suggestion")} ${esc(tip)}`;
  const baseTitle=`${B("Base Squad")} ${esc("(selling prices)")}`;
  const baseBlock=[section("GK",group.GK),section("DEF",group.DEF),section("MID",group.MID),section("FWD",group.FWD)].filter(Boolean).join("\n");
  const html=[head,"",top,"",ft,itb,fhNote?`\n${esc(fhNote)}`:"",sugg,"",baseTitle,baseBlock].filter(Boolean).join("\n");
  await sendHTML(env,id,html,keys())
}

/* ---------- Telegram ---------- */
const keys=()=>({keyboard:[[{text:"/myteam"},{text:"/linkteam"}],[{text:"/transfer"}]],resize_keyboard:true,one_time_keyboard:false});
async function sendHTML(env,chat_id,html,reply){const p={chat_id,text:html,parse_mode:"HTML",disable_web_page_preview:true};if(reply)p.reply_markup=reply;const r=await tg(env,"sendMessage",p);if(r?.ok)return;const p2={chat_id,text:strip(html),disable_web_page_preview:true};if(reply)p2.reply_markup=reply;await tg(env,"sendMessage",p2)}
async function tg(env,meth,payload){try{const r=await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${meth}`,{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify(payload)});return await r.json()}catch{return{ok:false}}}

/* ---------- FPL ---------- */
const bootStatic=async()=>{try{const r=await fetch("https://fantasy.premierleague.com/api/bootstrap-static/",{cf:{cacheTtl:60}});if(!r.ok)return null;return await r.json().catch(()=>null)}catch{return null}};
const fplEntry=async(id)=>{try{const r=await fetch(`https://fantasy.premierleague.com/api/entry/${id}/`,{cf:{cacheTtl:0}});if(!r.ok)return null;const j=await r.json().catch(()=>null);if(!j||(j.id!==id&&typeof j.id!=="number"))return null;return j}catch{return null}};
const fplEntryHistory=async(id)=>{try{const r=await fetch(`https://fantasy.premierleague.com/api/entry/${id}/history/`,{cf:{cacheTtl:0}});if(!r.ok)return null;return await r.json().catch(()=>null)}catch{return null}};
const fplEntryPicks=async(id,gw)=>{try{const r=await fetch(`https://fantasy.premierleague.com/api/entry/${id}/event/${gw}/picks/`,{cf:{cacheTtl:0}});if(!r.ok)return null;return await r.json().catch(()=>null)}catch{return null}};
const fplEventLive=async(gw)=>{try{const r=await fetch(`https://fantasy.premierleague.com/api/event/${gw}/live/`,{cf:{cacheTtl:30}});if(!r.ok)return null;return await r.json().catch(()=>null)}catch{return null}};

/* ---------- utils ---------- */
const cmd=t=>!t.startsWith("/")?{name:"",args:[]}:{name:t.split(/\s+/)[0].slice(1).toLowerCase(),args:t.split(/\s+/).slice(1)};
const remainingChips=played=>{const c={wildcard:0,freehit:0,bench_boost:0,triple_captain:0};for(const n of played)if(n in c)c[n]++;const out=[],wc=Math.max(0,2-c.wildcard);if(wc>0)out.push("Wildcard");if(c.freehit===0)out.push("Free Hit");if(c.bench_boost===0)out.push("Bench Boost");if(c.triple_captain===0)out.push("Triple Captain");return out};
const niceChip=n=>({freehit:"Free Hit",bench_boost:"Bench Boost",triple_captain:"Triple Captain",wildcard:"Wildcard"}[n]||n);
// safe selling price: prefer API selling_price; else buy + floor((now-buy)/2); fallback to now or buy; default 0 (all tenths)
const sellPrice=(p,e)=>Number.isFinite(p?.selling_price)?p.selling_price:
  (Number.isFinite(p?.purchase_price)&&Number.isFinite(e?.now_cost)?(p.purchase_price+Math.floor(Math.max(0,e.now_cost-p.purchase_price)/2)):
  (Number.isFinite(e?.now_cost)?e.now_cost:Number.isFinite(p?.purchase_price)?p.purchase_price:0));
function simulateAutosubs(XI,BN,live,el){const pos=id=>({1:"GK",2:"DEF",3:"MID",4:"FWD"}[el.get(id)?.element_type]||""),mins=id=>live.get(id)?.minutes||0,ct={GK:0,DEF:0,MID:0,FWD:0};for(const p of XI)ct[pos(p.element)]++;const zeroGK=XI.find(p=>pos(p.element)==="GK"&&mins(p.element)===0)||null,zeroOut=XI.filter(p=>pos(p.element)!=="GK"&&mins(p.element)===0),out=[],used=new Set();const bGK=BN.find(p=>pos(p.element)==="GK");if(zeroGK&&bGK&&mins(bGK.element)>0){out.push({outId:zeroGK.element,inId:bGK.element,outPos:"GK",inPos:"GK",outName:el.get(zeroGK.element)?.web_name||"",inName:el.get(bGK.element)?.web_name||""});used.add(bGK.element)}const need={DEF:3,MID:2,FWD:1},B=BN.filter(p=>pos(p.element)!=="GK");for(const bp of B){if(used.has(bp.element))continue;if(mins(bp.element)<=0)continue;const bP=pos(bp.element);for(let i=0;i<zeroOut.length;i++){const sp=zeroOut[i],sP=pos(sp.element),c={...ct};c[sP]--;c[bP]++;if(c.DEF>=need.DEF&&c.MID>=need.MID&&c.FWD>=need.FWD){ct[sP]--;ct[bP]++;out.push({outId:sp.element,inId:bp.element,outPos:sP,inPos:bP,outName:el.get(sp.element)?.web_name||"",inName:el.get(bp.element)?.web_name||""});zeroOut.splice(i,1);used.add(bp.element);break}}}return out}
const section=(lab,lines)=>lines.length?([`${B(lab)} ${lines[0]}`,...lines.slice(1).map(s=>`  ${s}`),""].join("\n")):"";
const ascii=s=>String(s).replace(/[‘’]/g,"'").replace(/[“”]/g,'"').replace(/\u2014|\u2013/g,"-").replace(/•/g,"-").replace(/\u00A0/g," ");
const esc=s=>String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
const strip=s=>s.replace(/<[^>]+>/g,"");
const B=lab=>`<b>${esc(lab)}:</b>`;
const F=(lab,val)=>`<b>${esc(lab)}:</b> ${esc(String(val))}`;
const pipes=arr=>arr.filter(Boolean).join(` ${esc("|")} `);

/* ---------- KV keys ---------- */
const K={last:id=>`chat:${id}:last_seen`,user:id=>`user:${id}:profile`};