import fs from 'node:fs';
import path from 'node:path';
import {VPN} from './store.mjs';
import {countries,connectionLabel} from './countries.mjs';
import {exportSubscription,uri,refreshSources,MIHOMO_TROJAN_XHTTP} from './subscriptions.mjs';
import {Diagnostics} from './diagnostics.mjs';
const diagnostics=new Diagnostics();
import {qr} from './qr.mjs';
import {modulePage} from '#hub/views.mjs';
import {readJSON} from '#hub/input.mjs';
import {PROFILES,check,serverConfig} from '#hub/vpn-protocol.mjs';
let instance,timer,pending;
export const store=()=>instance??=new VPN(path.join(process.env.DATA_DIR??'/app/data','vpn'));
function subscriptionURL(u,origin){
  check(store().active(u),'Доступ пользователя отключён или истёк');
  check(/^[A-Za-z0-9_-]{22}$/.test(u.token),'Старый формат подписки удалён. Пересоздай пользователя в Арго.');
  return origin+'/s/'+u.token;
}
export const agentExchange=(id,report)=>store().exchange(id,report);
const headingControls=`<div class="vpn-header-controls"><nav class="vpn-tabs" aria-label="Разделы Арго"><button type="button" data-tab="users" aria-controls="vpnView" aria-pressed="true">Пользователи</button><button type="button" data-tab="nodes" aria-controls="vpnView" aria-pressed="false">Серверы</button><button type="button" data-tab="routing" aria-controls="vpnView" aria-pressed="false">Маршрутизация</button><button type="button" data-tab="diagnostics" aria-controls="vpnView" aria-pressed="false">Диагностика</button></nav><div id="vpnHeaderActions" class="vpn-actions"></div></div>`;
const content=`<link rel="stylesheet" href="/modules/vpn/style.css"><script src="/modules/vpn/country-picker.js" defer></script><script src="/modules/vpn/routing-fields.js" defer></script><script src="/modules/vpn/hysteria-fields.js" defer></script><script src="/modules/vpn/diagnostic-stats.js" defer></script><script src="/modules/vpn/diagnostics.js" defer></script><script src="/modules/vpn/cloudflare-fields.js" defer></script><script src="/modules/vpn/app.js" defer></script><section id="vpn"><p id="vpnStatus" role="status"></p><div id="vpnView" role="region" aria-label="Пользователи"></div><dialog id="vpnDialog" aria-labelledby="vpnDialogTitle"><form id="vpnForm"><div id="vpnFields"></div><div class="vpn-actions"><button type="submit">Сохранить</button><button id="vpnCancel" type="button">Отмена</button></div></form></dialog></section>`;
export async function handle({request,path:route,user,searchParams,authorized=()=>false,agents,origin,clientAddress}){
  try{
    if(!authorized())return Response.json({error:'Нужен вход'},{status:401});
    if(request.method==='GET'){
      if(route==='/')return new Response(modulePage({embedded:user.embedded,username:user.username,title:'Арго',content,headingControls}),{headers:{'content-type':'text/html; charset=utf-8'}});
      if(['/app.js','/cloudflare-fields.js','/diagnostics.js','/diagnostic-stats.js','/hysteria-fields.js','/country-picker.js','/routing-fields.js','/style.css'].includes(route))return new Response(fs.readFileSync(new URL('.'+route,import.meta.url)),{headers:{'content-type':route.endsWith('.js')?'text/javascript':'text/css'}});
      if(/^\/flags\/[a-z]{2}\.svg$/.test(route)&&countries.some(c=>route==='/flags/'+c.code.toLowerCase()+'.svg'))return new Response(fs.readFileSync(new URL('.'+route,import.meta.url)),{headers:{'content-type':'image/svg+xml','cache-control':'private, max-age=86400'}});
      if(route==='/api/diagnostics/probe')return diagnostics.probe(user.username,request.headers['x-vpn-diagnostic'],searchParams.get('nonce'),clientAddress);
      if(route==='/api/diagnostics/load')return diagnostics.load(user.username,request.headers['x-vpn-diagnostic']);
      if(route==='/api')return Response.json({...store().snapshot(agents?.list()??[]),profiles:PROFILES,countries});
      if(route==='/api/history')return Response.json({rows:store().history(searchParams.get('user'))});
      if(route==='/api/subscription'){
        const u=store().get('user',searchParams.get('user'));const base=subscriptionURL(u,origin);exportSubscription(store(),u,'xray');
        return Response.json({url:base,alternatives:{mihomo:base+'/m',base64:base+'/b'},links:store().subscriptionConnections(u).map(c=>({name:connectionLabel(c),uri:uri(c,u)})),qr:'/modules/vpn/api/qr?user='+u.id});
      }
      if(route==='/api/qr'){const u=store().get('user',searchParams.get('user'));const url=subscriptionURL(u,origin);exportSubscription(store(),u,'xray');return new Response(qr(url),{headers:{'content-type':'image/svg+xml','cache-control':'no-store'}});}
      if(route==='/api/config'){const node=searchParams.get('node');agents.get(node);const bundle=store().preview(node);check(bundle,'Сначала включи VPN на агенте');return Response.json({config:serverConfig(bundle),settings:bundle.settings,notice:'Редактируются порт, SNI, цель Reality, путь XHTTP, имя gRPC, DNS и правила direct/block. Учётные данные, API и пути сертификатов защищены. Итог проверяется и применяется на ноде.'});}
    }
    if(request.method==='POST'){
      const v=await readJSON(request,524288);if(!authorized())return Response.json({error:'Нужен вход'},{status:401});
      if(route==='/api/diagnostics/start'){const connection=v.connection?store().get('connection',v.connection):null;check(!connection||connection.enabled,'Подключение выключено');const result=await diagnostics.start(user.username,connection);if(!authorized()){diagnostics.stop(user.username,result.id);return Response.json({error:'Нужен вход'},{status:401});}return Response.json(result,{headers:{'cache-control':'no-store'}});}
      if(route==='/api/diagnostics/stop')return Response.json(diagnostics.stop(user.username,v.id));
      if(route==='/api/node'){const a=agents.get(v.id);check(!a.revoked,'Доступ агента отозван');return Response.json(store().node(v.id,v.settings,v.version,v.country));}
      if(route==='/api/node-country'){const a=agents.get(v.id);check(!a.revoked,'Доступ агента отозван');return Response.json(store().nodeCountry(v.id,v.country,v.version));}
      if(route==='/api/config'){const a=agents.get(v.id);check(!a.revoked,'Доступ агента отозван');return Response.json(store().saveConfig(v.id,v.config,v.version));}
      if(route==='/api/connection'){const a=agents.get(v.value?.node);check(!a.revoked,'Доступ агента отозван');return Response.json(store().saveConnection(v.value,v.version));}
      if(route==='/api/user')return Response.json(store().saveUser(v.value,v.version));
      if(route==='/api/user/delete')return Response.json(store().deleteUser(v.id,v.version));
      if(route==='/api/rotate')return Response.json(store().rotate(v.id,v.version,{credentials:v.credentials===true}));
      if(route==='/api/routing')return Response.json(store().saveRouting(v.value,v.version));
      if(route==='/api/refresh'){const result=await refreshLists(true);if(!authorized())return Response.json({error:'Нужен вход'},{status:401});return Response.json({ok:result.failed===0,...result});}
    }
    return Response.json({error:'Не найдено'},{status:404});
  }catch(e){return Response.json({error:e.status?e.message:'Не удалось выполнить действие'},{status:e.status??500});}
}
export async function publicHandle({request,path:route}){
  if(request.method!=='GET')return new Response(null,{status:405});
  const match=/^\/([A-Za-z0-9_-]{22})(?:\/([mbl]))?$/.exec(route);if(!match)return new Response(null,{status:404});
  const format=({m:'mihomo',b:'base64',l:'links'})[match[2]]??'xray';
  try{const u=store().subscription(match[1]),body=exportSubscription(store(),u,format);return new Response(body,{headers:{'content-type':['xray','mihomo'].includes(format)?'application/json; charset=utf-8':'text/plain; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','profile-update-interval':'1',...(format==='xray'?{'profile-title':'NEXUS404','dns-from-json-enable':'true'}:{}),'subscription-userinfo':`upload=${store().total(u.id).up}; download=${store().total(u.id).down}; total=${u.limit}; expire=${Math.floor(u.expires/1000)}`}});}catch(error){if(error.unsupportedTransport)return new Response(MIHOMO_TROJAN_XHTTP,{status:400,headers:{'cache-control':'no-store'}});return new Response('Подписка недоступна или профиль ещё не готов',{status:404});}
}
export function home(){const s=store().snapshot();return {items:s.connections.filter(c=>c.enabled).slice(0,3).map(c=>({title:connectionLabel(c),cloud:c.delivery==='cloudflare',href:'/modules/vpn/'})),total:s.connections.filter(c=>c.enabled).length};}
export async function summary(){const s=store().snapshot();return {state:'ok',items:[{label:'Пользователи',value:s.users.filter(u=>u.active).length},{label:'Ноды',value:s.nodes.length},{label:'Подключения',value:s.connections.filter(c=>c.enabled).length}]};}
async function refreshLists(force=false){
  if(pending&&!force)return pending;
  const previous=pending,job=(async()=>{await previous;return refreshSources(store(),undefined,{force});})();pending=job;
  try{return await job;}finally{if(pending===job)pending=null;}
}
export function start(){if(timer)return;store();timer=setInterval(()=>{if(!pending)void refreshLists().catch(()=>{});},60000);timer.unref();}
export async function close(){diagnostics.close();clearInterval(timer);timer=null;try{await pending;}finally{instance?.close();instance=null;}}
