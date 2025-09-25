// Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET | KV: FPL_BOT_KV
export default{async fetch(req,env,ctx){const u=new URL(req.url),p=u.pathname.replace(/\/$/,"");if(req.method==="GET"&&(!p||p==="/"))return R("OK");if(req.method==="GET"&&p==="/init-webhook")return init(u.origin,env);if(p==="/webhook/telegram"){if(req.method!=="POST")return R("Method Not Allowed",405);if(req.headers.get("x-telegram-bot-api-secret-token")!==env.TELEGRAM_WEBHOOK_SECRET)return R("Forbidden",403);let up;try{up=await req.json()}catch{return R("Bad Request",400)}ctx.waitUntil(handle(up,env));return R("ok")}return R("Not Found",404)}};

const R=(s,st=200)=>new Response(s,{status:st,headers:{"content-type":"text/plain; charset=utf-8"}}),API=t=>`https://api.telegram.org/bot${t}`;
const send=(e,id,text,o={})=>tg(e,"sendMessage",{chat_id:id,text:clean(text),disable_web_page_preview:true,...o});
async function tg(e,m,p){if(p.caption)p.caption=clean(p.caption);const kb=p.reply_markup?.inline_keyboard;if(kb)for(const r of kb)for(const b of r)b.text=clean(b.text);return fetch(`${API(e.TELEGRAM_BOT_TOKEN)}/${m}`,{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify(p)}).catch(()=>{})}
function clean(s){const ok="£$€¥•";let t=(s||"").toString().normalize("NFKC")
.replace(/[–—]/g,"-").replace(/[·]/g,"•")
.replace(/[]/g,"").replace(/[]/g,"")
.replace(/[]/g,x=>x===""?"<-":x===""?"->":x===""?"^":x===""?"v":"-")
.replace(/[±×÷§©®™µ]/g,x=>({ "±":"+/-","×":"x","÷":"/","":"~=","":"!=","":"<=","":">=","":"inf","§":"S","©":"(C)","®":"(R)","™":"TM","µ":"u","":"Ohm","":"alpha","":"beta","":"gamma","":"Delta","":"pi"}[x]||"?"));
return[...t].map(c=>c.codePointAt(0)<128||ok.includes(c)?c:"?").join("")}

const kTeam=id=>`chat:${id}:team`, kIdx=`chats:index`;
async function link(env,chat,id){await env.FPL_BOT_KV.put(kTeam(chat),String(id),{expirationTtl:31536000});let a=[];try{const raw=await env.FPL_BOT_KV.get(kIdx);if(raw)a=JSON.parse(raw)}catch{}if(!a.includes(chat)){a.push(chat);await env.FPL_BOT_KV.put(kIdx,JSON.stringify(a))}}

async function init(origin,env){const r=await fetch(`${API(env.TELEGRAM_BOT_TOKEN)}/setWebhook`,{method:"POST",headers:{"content-type":"application/json; charset=utf-8"},body:JSON.stringify({url:`${origin}/webhook/telegram`,secret_token:env.TELEGRAM_WEBHOOK_SECRET,allowed_updates:["message"],drop_pending_updates:true})});const j=await r.json().catch(()=>({}));return R(j.ok?`Webhook set to ${origin}/webhook/telegram`:`Failed: ${j.description||JSON.stringify(j)}`,j.ok?200:500)}

async function handle(up,env){const m=up?.message; if(!m)return;const chat=m.chat?.id,t=(m.text||"").trim();
if(t.startsWith("/start"))return send(env,chat,"Welcome to the FPL bot\n\nLink your team:\n/linkteam <FPL_TEAM_ID>\n\nSee /help for commands.");
if(t.startsWith("/help")) return send(env,chat,"Commands:\n• /linkteam <FPL_TEAM_ID>\n• /unlink\n• /ping\n• /symbols");
if(t.startsWith("/ping")) return send(env,chat,"pong");
if(t.startsWith("/symbols"))return send(env,chat,"Currency: £ $ € ¥\nArrows:    \nBullet: •\nExample: Bank £1.5m | Team value £100.2m");
if(t.startsWith("/unlink")){await env.FPL_BOT_KV.delete(kTeam(chat));return send(env,chat,"Unlinked. Link again with:\n/linkteam <FPL_TEAM_ID>")}
if(t.startsWith("/linkteam")){const id=(t.split(/\s+/)[1]||"").trim();if(!id)return send(env,chat,"Usage:\n/linkteam 1234567");if(!/^\d{1,10}$/.test(id))return send(env,chat,"That doesn't look like a valid numeric FPL team ID.");await link(env,chat,id);return send(env,chat,`Linked\n\n• Chat ${chat}  FPL Team ${id}\n• /help for commands\n• /unlink to remove`)}
const linked=await env.FPL_BOT_KV.get(kTeam(chat));if(linked)return send(env,chat,`You are linked to FPL Team ${linked}\n• /unlink\n• /help`);return send(env,chat,"I didn't catch that.\nStart with:\n/linkteam <FPL_TEAM_ID>")}