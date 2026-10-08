import https from 'node:https';
import {xrayProfiles} from './xray-client.mjs';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {check,destination} from '../../src/vpn-protocol.mjs';
export function uri(c,u){
  const p=new URLSearchParams({sni:c.sni});let scheme,credential;
  if(c.profile.startsWith('vless')){scheme='vless';credential=u.uuid;p.set('encryption','none');p.set('security','reality');p.set('pbk',c.publicKey);p.set('sid',c.shortId);p.set('fp',c.fingerprint);p.set('type',c.profile.slice(6)==='raw'?'tcp':c.profile.slice(6));if(c.profile==='vless-raw')p.set('flow','xtls-rprx-vision');if(c.profile==='vless-xhttp'){p.set('path',c.path);p.set('mode','auto');}if(c.profile==='vless-grpc')p.set('serviceName',c.serviceName);}
  else {scheme=c.profile==='trojan'?'trojan':'hysteria2';credential=u.password;if(scheme==='trojan'){p.set('security','tls');p.set('type','tcp');}}
  return `${scheme}://${encodeURIComponent(credential)}@${isIP(c.address)===6?'['+c.address+']':c.address}:${c.port}?${p}#${encodeURIComponent(c.name)}`;
}
export function proxy(c,u){
  const p={name:c.id,type:c.profile.startsWith('vless')?'vless':c.profile,server:c.address,port:c.port,udp:true};
  if(p.type==='vless'){Object.assign(p,{uuid:u.uuid,tls:true,servername:c.sni,'client-fingerprint':c.fingerprint,'reality-opts':{'public-key':c.publicKey,'short-id':c.shortId}});if(c.profile==='vless-raw')p.flow='xtls-rprx-vision';else p.network=c.profile.slice(6);if(p.network==='xhttp')p['xhttp-opts']={path:c.path,mode:'auto'};if(p.network==='grpc')p['grpc-opts']={'grpc-service-name':c.serviceName};}
  else Object.assign(p,{password:u.password,sni:c.sni,'skip-cert-verify':false});
  return p;
}
export function exportSubscription(store,u,format='mihomo'){
  const connections=store.subscriptionConnections?store.subscriptionConnections(u):store.all('connection').filter(c=>c.enabled&&u.connections.includes(c.id));check(connections.length,'Нет разрешённых подключений');
  if(format==='links')return connections.map(c=>uri(c,u)).join('\n')+'\n';
  if(format==='base64')return Buffer.from(connections.map(c=>uri(c,u)).join('\n')).toString('base64');
  check(['xray','mihomo'].includes(format),'Доступны xray, mihomo, links и base64. URI не переносит правила маршрутизации.');
  const route=u.routing?store.get('routing',u.routing):{fallback:'block',dns:'1.1.1.1',rules:[],groups:[],sources:[]};
  let rules=[...route.rules];
  for(const source of route.sources){const saved=store.sourceData(source.id);check(saved?.url===source.url&&saved?.type===source.type&&saved?.rules?.length,'Внешний список ещё не загружен: импорт остановлен, чтобы не пропустить VPN-направления');rules.push(...saved.rules.map(r=>({...r,target:source.target,exception:source.exception})));}
  rules=rules.map((r,index)=>({...r,index})).sort((a,b)=>Number(b.exception)-Number(a.exception)||a.index-b.index);
  if(format==='xray')return JSON.stringify(xrayProfiles(connections,u,route,rules),null,2);
  const allowed=new Set(connections.map(c=>c.id));
  const groups=[{name:'VPN',type:'select',proxies:[...allowed]}];
  for(const g of route.groups){const proxies=g.connections.filter(c=>allowed.has(c));if(proxies.length)groups.push({name:g.id,type:'fallback',proxies,url:'https://www.gstatic.com/generate_204',interval:300});}
  const fallbackNames=new Map();
  if(route.fallback==='direct'){
    // Explicit opt-in only: fallback groups may select DIRECT when every VPN probe fails.
    for(const group of groups){group.type='fallback';group.proxies.push('DIRECT');group.url='https://www.gstatic.com/generate_204';group.interval=60;}
    for(const c of connections){const name='fallback-'+c.id;fallbackNames.set(c.id,name);groups.push({name,type:'fallback',proxies:[c.id,'DIRECT'],url:'https://www.gstatic.com/generate_204',interval:60});}
  }
  const targets=new Set(['DIRECT','REJECT','VPN',...allowed,...groups.map(g=>g.name)]);
  const formatted=rules.map(r=>{const target={direct:'DIRECT',block:'REJECT',vpn:'VPN'}[r.target]??fallbackNames.get(r.target)??r.target;check(targets.has(target),'Маршрутизация ссылается на недоступное пользователю подключение или группу');const type=r.type==='domain'?'DOMAIN':r.type==='suffix'?'DOMAIN-SUFFIX':r.value.includes(':')?'IP-CIDR6':'IP-CIDR';return `${type},${r.value},${target}${r.type==='ip'?',no-resolve':''}`;});
  const resolver=route.dns,policy={};
  // Use the selected tunnel for DNS of VPN destinations, including fake-IP lookups.
  // Process lowest priority first because a later exception must override it.
  for(const r of [...rules].reverse()){if(r.type==='ip')continue;const target={direct:'DIRECT',block:'REJECT',vpn:'VPN'}[r.target]??r.target;policy[(r.type==='suffix'?'+.':'')+r.value]=target==='DIRECT'?[resolver]:target==='REJECT'?['rcode://refused']:[resolver+'#'+target];}
  return JSON.stringify({'mixed-port':7890,'allow-lan':false,mode:'rule','log-level':'warning',ipv6:true,tun:{enable:true,stack:'mixed','auto-route':true,'auto-detect-interface':true,'dns-hijack':['any:53']},dns:{enable:true,listen:'127.0.0.1:1053',ipv6:true,'enhanced-mode':'fake-ip','respect-rules':true,'default-nameserver':[resolver],'nameserver':[resolver],'proxy-server-nameserver':[resolver],'direct-nameserver':[resolver],'nameserver-policy':policy},proxies:connections.map(c=>proxy(c,u)),'proxy-groups':groups,rules:[...formatted,'MATCH,DIRECT']},null,2);
}
export function publicAddress(address){
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));}
  // Only global-unicast IPv6. Excludes mapped IPv4, local, link-local, multicast and unspecified.
  return isIP(address)===6&&/^[23][0-9a-f]{3}:/i.test(address)&&!/^2001:(?:db8|0):/i.test(address)&&!/^2002:/i.test(address);
}
export async function downloadList(address,{resolve=lookup}={}){
  const url=new URL(address);check(url.protocol==='https:'&&!url.username&&!url.password&&(url.port===''||url.port==='443'),'Список: только HTTPS на порту 443');
  const host=url.hostname.replace(/^\[|\]$/g,'');const records=isIP(host)?[{address:host,family:isIP(host)}]:await resolve(host,{all:true});check(records.length&&records.every(r=>publicAddress(r.address)),'Внешний список не может обращаться к локальной сети');
  return new Promise((resolve,reject)=>{
    const req=https.get(url,{lookup:(_host,options,callback)=>options.all?callback(null,records):callback(null,records[0].address,records[0].family),rejectUnauthorized:true},res=>{
      if(res.statusCode!==200){res.resume();reject(Error('Список недоступен: нужен прямой ответ 200'));return;}
      let size=0;const chunks=[];res.on('data',b=>{size+=b.length;if(size>262144){res.destroy(Error('Список больше 256 КиБ'));return;}chunks.push(b);});res.on('error',reject);res.on('end',()=>resolve(Buffer.concat(chunks).toString('utf8')));
    });const timer=setTimeout(()=>req.destroy(Error('Истекло время загрузки списка')),10000);req.on('close',()=>clearTimeout(timer));req.on('error',reject);
  });
}
export function parseList(body,type){const lines=body.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith('#'));check(lines.length>0&&lines.length<=2000,'Список: от 1 до 2000 правил');return [...new Set(lines)].map(value=>{const d=destination(value);check((type==='ip')===(d.type==='ip'),'В списке смешаны разные типы правил');return {type,value:d.value};});}
export async function refreshSources(store,fetcher=downloadList){
  for(const profile of store.all('routing'))for(const source of profile.sources){
    const cached=store.sourceData(source.id),old=cached?.url===source.url&&cached?.type===source.type?cached:null;if(old?.checked&&store.now()-old.checked<3600000)continue;
    try{const rules=parseList(await fetcher(source.url),source.type);const current=store.all('routing').flatMap(r=>r.sources).find(s=>s.id===source.id);if(!current||current.url!==source.url||current.type!==source.type)continue;store.source({id:source.id,url:source.url,type:source.type,checked:store.now(),updated:store.now(),error:null,rules});}
    catch{store.source({...old,id:source.id,url:source.url,type:source.type,checked:store.now(),error:'Не удалось обновить список. Используется последняя принятая копия.',rules:old?.rules??[]});}
  }
}
