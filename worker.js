// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET | KV: FPL_BOT_KV
export default{async fetch(req,env,ctx){const u=new URL(req.url),p=u.pathname.replace(/\/$/,"");
if(req.method==="GET"&&(!p||p==="/"))return T("OK");
if(req.method==="GET"&&p==="/init-webhook")return init(u.origin,env);
if(p==="/webhook/telegram"){if(req.method!=="POST")return T("Method Not Allowed",405);
if(req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET)return T("Forbidden",403);
let up;try{up=await req.json()}catch{return T("Bad Request",400)}ctx.waitUntil(handle(up,env));return T("ok")}
return T("Not Found",404)}};

const T=(s,st=200)=>new Response(s,{status:st,headers:{"content-type":"text/plain; charset=utf-8"}}),API=t=>`https://api.telegram.org/bot${t}`;
const kTeam=id=>`chat:${id}:team`,kIdx=`chats:index`,kMode=id=>`chat:${id}:symbols`; // "fancy" | "ascii"
const getMode=e=>async id=>await e.FPL_BOT_KV.get(kMode(id))||"ascii";

async function send(env,chat,text,opts={}){const mode=await getMode(env)(chat);text=fmt(text,mode);
return fetch(`${API(env.TELEGRAM_BOT_TOKEN)}/sendMessage`,{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:true,...opts})}).catch(()=>{})}

function fmt(s,mode){if(mode==="fancy")return s; // try real symbols
// ASCII fallback
return s.replaceAll("£","GBP").replaceAll("€","EUR").replaceAll("¥","YEN")
        .replaceAll("•","-").replaceAll("","<-").replaceAll("","->")
        .replaceAll("","^").replaceAll("","v");}

async function init(origin,env){const r=await fetch(`${API(env.TELEGRAM_BOT_TOKEN)}/setWebhook`,{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify({url:`${origin}/webhook/telegram`,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message"],drop_pending_updates:true})});
const j=await r.json().catch(()=>({}));return T(j.ok?`Webhook set to ${origin}/webhook/telegram`:`Failed: ${j.description||JSON.stringify(j)}`,j.ok?200:500)}

async function link(env,chat,id){await env.FPL_BOT_KV.put(kTeam(chat),String(id),{expirationTtl:31536000});
let arr=[];try{const raw=await env.FPL_BOT_KV.get(kIdx);if(raw)arr=JSON.parse(raw)}catch{}if(!arr.includes(chat)){arr.push(chat);await env.FPL_BOT_KV.put(kIdx,JSON.stringify(arr))}}

async function handle(up,env){const m=up?.message;if(!m)return;const chat=m.chat?.id,t=(m.text||"").trim();

if(t.startsWith("/start"))return send(env,chat,"Welcome to the FPL bot\n\nLink your team:\n/linkteam <FPL_TEAM_ID>\n\nSee /help for commands.");
if(t.startsWith("/help"))return send(env,chat,
"Commands:\n• /linkteam <FPL_TEAM_ID>\n• /unlink\n• /ping\n• /symbols  (show how your phone renders)\n• /symbols_on  (try real £ €     •)\n• /symbols_off (force ASCII)");

if(t.startsWith("/ping"))return send(env,chat,"pong");

if(t.startsWith("/symbols_on")){await env.FPL_BOT_KV.put(kMode(chat),"fancy");return send(env,chat,"Symbols mode: fancy (using £ $ € ¥ and arrows)");}
if(t.startsWith("/symbols_off")){await env.FPL_BOT_KV.put(kMode(chat),"ascii");return send(env,chat,"Symbols mode: ascii (GBP/EUR, <- ->, -)");}

if(t.startsWith("/symbols")){
  const mode=await getMode(env)(chat);
  const demo=mode==="fancy"
    ? "Currency: £ $ € ¥\nArrows:    \nBullet: •\nExample: Bank £1.5m | Team value £100.2m"
    : "Currency: GBP $ EUR YEN\nArrows: <- -> ^ v\nBullet: -\nExample: Bank GBP 1.5m | Team value GBP 100.2m";
  return send(env,chat,demo);
}

if(t.startsWith("/unlink")){await env.FPL_BOT_KV.delete(kTeam(chat));return send(env,chat,"Unlinked. Link again with:\n/linkteam <FPL_TEAM_ID>")}
if(t.startsWith("/linkteam")){const id=(t.split(/\s+/)[1]||"").trim();if(!id)return send(env,chat,"Usage:\n/linkteam 1234567");
if(!/^\d{1,10}$/.test(id))return send(env,chat,"That doesn't look like a valid numeric FPL team ID.");await link(env,chat,id);
return send(env,chat,`Linked\n\n• Chat ${chat}  FPL Team ${id}\n• /help for commands\n• /unlink to remove`)}

const linked=await env.FPL_BOT_KV.get(kTeam(chat));
if(linked)return send(env,chat,`You are linked to FPL Team ${linked}\n• /unlink\n• /help`);
return send(env,chat,"I didn't catch that.\nStart with:\n/linkteam <FPL_TEAM_ID>")}