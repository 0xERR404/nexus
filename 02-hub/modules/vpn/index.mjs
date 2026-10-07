import fs from 'node:fs';
import path from 'node:path';
import {VPN} from './store.mjs';
import {exportSubscription,uri,refreshSources} from './subscriptions.mjs';
import {qr} from './qr.mjs';
import {modulePage} from '../../src/views.mjs';
import {readJSON} from '../../src/input.mjs';
import {PROFILES,check,serverConfig} from '../../src/vpn-protocol.mjs';
let instance,timer,pending;
export const store=()=>instance??=new VPN(path.join(process.env.DATA_DIR??'/app/data','vpn'));
export const agentExchange=(id,report)=>store().exchange(id,report);
const content=`<link rel="stylesheet" href="/modules/vpn/style.css"><script src="/modules/vpn/app.js" defer></script><section id="vpn"><nav class="vpn-tabs" aria-label="Разделы Арго"><button data-tab="users">Пользователи</button><button data-tab="nodes">Серверы и подключения</button><button data-tab="routing">Маршрутизация</button><button data-tab="settings">Подписки и настройки</button></nav><p id="vpnStatus" role="status"></p><div id="vpnView"></div><dialog id="vpnDialog"><form id="vpnForm"><div id="vpnFields"></div><div class="vpn-actions"><button type="submit">Сохранить</button><button id="vpnCancel" type="button">Отмена</button></div></form></dialog></section>`;
export async function handle({request,path:route,user,searchParams,authorized=()=>false,agents,origin}){
  try{
    if(!authorized())return Response.json({error:'Нужен вход'},{status:401});
    if(request.method==='GET'){
      if(route==='/')return new Response(modulePage({embedded:user.embedded,username:user.username,title:'Арго',content}),{headers:{'content-type':'text/html; charset=utf-8'}});
      if(['/app.js','/style.css'].includes(route))return new Response(fs.readFileSync(new URL('.'+route,import.meta.url)),{headers:{'content-type':route.endsWith('.js')?'text/javascript':'text/css'}});
      if(route==='/api')return Response.json({...store().snapshot(agents?.list()??[]),profiles:PROFILES});
      if(route==='/api/history')return Response.json({rows:store().history(searchParams.get('user'))});
      if(route==='/api/subscription'){
        const u=store().get('user',searchParams.get('user'));check(store().active(u),'Доступ пользователя отключён или истёк');exportSubscription(store(),u,'mihomo');const base=origin+'/subscriptions/vpn/'+u.token;
        return Response.json({url:base+'/mihomo',links:store().all('connection').filter(c=>c.enabled&&u.connections.includes(c.id)).map(c=>({name:c.name,uri:uri(c,u)})),qr:'/modules/vpn/api/qr?user='+u.id});
      }
      if(route==='/api/qr'){const u=store().get('user',searchParams.get('user'));return new Response(qr(origin+'/subscriptions/vpn/'+u.token+'/mihomo'),{headers:{'content-type':'image/svg+xml','cache-control':'no-store'}});}
      if(route==='/api/config'){const node=searchParams.get('node');agents.get(node);const bundle=store().preview(node);check(bundle,'Сначала включи VPN на агенте');return Response.json({config:serverConfig(bundle),settings:bundle.settings,notice:'Редактируются порт, SNI, цель Reality, путь XHTTP, имя gRPC, DNS и правила direct/block. Учётные данные, API и пути сертификатов защищены. Итог проверяется и применяется на ноде.'});}
    }
    if(request.method==='POST'){
      const v=await readJSON(request,131072);if(!authorized())return Response.json({error:'Нужен вход'},{status:401});
      if(route==='/api/node'){const a=agents.get(v.id);check(!a.revoked,'Доступ агента отозван');return Response.json(store().node(v.id,v.settings,v.version));}
      if(route==='/api/config'){const a=agents.get(v.id);check(!a.revoked,'Доступ агента отозван');return Response.json(store().saveConfig(v.id,v.config,v.version));}
      if(route==='/api/connection'){const a=agents.get(v.value?.node);check(!a.revoked,'Доступ агента отозван');return Response.json(store().saveConnection(v.value,v.version));}
      if(route==='/api/user')return Response.json(store().saveUser(v.value,v.version));
      if(route==='/api/rotate')return Response.json(store().rotate(v.id,v.version,{credentials:v.credentials===true}));
      if(route==='/api/routing')return Response.json(store().saveRouting(v.value,v.version));
      if(route==='/api/refresh'){await refreshSources(store());if(!authorized())return Response.json({error:'Нужен вход'},{status:401});return Response.json({ok:true});}
    }
    return Response.json({error:'Не найдено'},{status:404});
  }catch(e){return Response.json({error:e.status?e.message:'Не удалось выполнить действие'},{status:e.status??500});}
}
export async function publicHandle({request,path:route}){
  if(request.method!=='GET')return new Response(null,{status:405});
  const match=/^\/([A-Za-z0-9_-]{43})\/(mihomo|links|base64)$/.exec(route);if(!match)return new Response(null,{status:404});
  try{const u=store().subscription(match[1]),body=exportSubscription(store(),u,match[2]);return new Response(body,{headers:{'content-type':match[2]==='mihomo'?'application/json; charset=utf-8':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','profile-update-interval':'1','subscription-userinfo':`upload=${store().total(u.id).up}; download=${store().total(u.id).down}; total=${u.limit}; expire=${Math.floor(u.expires/1000)}`}});}catch{return new Response('Подписка недоступна или профиль ещё не готов',{status:404});}
}
export async function summary(){const s=store().snapshot();return {state:'ok',items:[{label:'Пользователи',value:s.users.filter(u=>u.active).length},{label:'Ноды',value:s.nodes.length},{label:'Подключения',value:s.connections.filter(c=>c.enabled).length}]};}
export function start(){store();timer=setInterval(()=>{if(!pending)pending=refreshSources(store()).catch(()=>{}).finally(()=>{pending=null;});},60000);timer.unref();}
export async function close(){clearInterval(timer);await pending;instance?.close();instance=null;}
