import {hysteriaOptions,hoppingPlan,applyHysteria} from './vpn-hysteria.mjs';
import {stabilityMode,applyTCPStability} from './vpn-transport.mjs';
import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
export const CORE_VERSION='26.9.30';
export const NODE_VERSION='0.35.243';
export const PROFILES={
  'vless-raw':'VLESS · RAW/TCP · Reality',
  'vless-xhttp':'VLESS · XHTTP · Reality',
  'vless-grpc':'VLESS · gRPC · Reality',
  'trojan':'Trojan · TCP · TLS',
  'trojan-xhttp':'Trojan · XHTTP · TLS',
  'trojan-grpc':'Trojan · gRPC · TLS',
  'hysteria2':'Hysteria 2'
};
// Legacy Trojan profiles continue to use raw TCP.
export const transport=profile=>profile==='hysteria2'?'hysteria':profile==='trojan'?'raw':profile.slice(profile.indexOf('-')+1);
export const CLOUDFLARE_PROFILES=['trojan-xhttp','trojan-grpc'];
export const CLOUDFLARE_PORTS=[443,2053,2083,2087,2096,8443];
export const clientAddress=c=>c.delivery==='cloudflare'?c.cloudflareDomain:c.address;
export const LEASE_MS=120000, API_PORT=10085;
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function check(ok,message='Некорректные настройки VPN'){if(!ok)throw Object.assign(Error(message),{status:400});}
export const id=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export function text(value,max=80){check(typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value));return value.trim();}
export function hostname(value){check(typeof value==='string'&&value.length<=253&&(isIP(value)||/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)),'Неверный адрес / SNI');return value.toLowerCase();}
export function certificateNameMatches(name,names){
  if(typeof name!=='string'||!Array.isArray(names))return false;
  const normalize=value=>{const n=value.toLowerCase();return isIP(n)===6?new URL('https://['+n+']/').hostname:n;};
  const requested=normalize(name);
  return names.some(value=>{
    if(typeof value!=='string')return false;
    const pattern=normalize(value);
    if(pattern===requested)return true;
    if(isIP(name)||!pattern.startsWith('*.'))return false;
    const suffix=pattern.slice(1),label=requested.endsWith(suffix)?requested.slice(0,-suffix.length):'';
    return !!label&&!label.includes('.');
  });
}
export function destination(value){const [host,prefix,...tail]=String(value).split('/');if(isIP(host)){check(!tail.length&&(prefix===undefined||integer(Number(prefix),0,isIP(host)===4?32:128)),'Неверная подсеть');return {type:'ip',value:prefix===undefined?host+'/'+(isIP(host)===4?'32':'128'):value};}check(prefix===undefined);return {type:'domain',value:hostname(host)};}
export function routingEntry(type,value){
  check(['domain','suffix','ip','geosite','geoip'].includes(type),'Неизвестный тип правила');
  check(typeof value==='string','Правило должно быть строкой');value=value.trim();
  const ipField=type==='ip'||type==='geoip',prefix=/^(geosite|geoip|domain|full):(.+)$/i.exec(value);
  if(prefix){const kind=prefix[1].toLowerCase();check(ipField===(kind==='geoip'),'Домены и IP нужно указывать в разных полях');type={domain:'suffix',full:'domain',geosite:'geosite',geoip:'geoip'}[kind];value=prefix[2];}
  if(type==='geosite'||type==='geoip'){
    value=value.toLowerCase();check((type==='geosite'?/^[a-z0-9][a-z0-9_-]{0,79}(?:@[a-z0-9_-]{1,32})?$/:/^[a-z0-9][a-z0-9_-]{0,79}$/).test(value),'Неверное имя группы '+type);
    return {type,value};
  }
  const d=destination(value);check(ipField===(d.type==='ip'),'Домены и IP нужно указывать в разных полях');return {type,value:d.value};
}
export function connection(v){
  check(v&&id(v.id)&&id(v.node),'Неверный идентификатор подключения или ноды');
  check(Object.hasOwn(PROFILES,v.profile),'Профиль подключения не поддерживается этой версией VPN-ноды. Обнови ноду.');
  const c={id:v.id,node:v.node,name:text(v.name),profile:v.profile,address:hostname(v.address),port:Number(v.port),sni:hostname(v.sni||v.address),enabled:v.enabled!==false,path:v.path||'/nexus',serviceName:v.serviceName||'nexus'};
  check(integer(c.port,1,65535)&&c.port!==API_PORT&&c.port!==22&&c.port!==80,'Порт зарезервирован для SSH, проверки TLS или локального API');
  check(v.delivery===undefined||['direct','cloudflare'].includes(v.delivery),'Выбери способ подключения');
  if(v.delivery==='cloudflare'){
    check(CLOUDFLARE_PROFILES.includes(c.profile),'Cloudflare: выбери Trojan XHTTP + TLS или Trojan gRPC + TLS');
    const domain=hostname(v.cloudflareDomain);
    check(!isIP(domain)&&domain.includes('.')&&!domain.endsWith('.localhost'),'Cloudflare: нужен полный домен, без IP, протокола и пути');
    check(isIP(c.address),'Cloudflare: в адресе ноды укажи её настоящий IP, а домен — в отдельном поле');
    check(c.profile==='trojan-grpc'?c.port===443:CLOUDFLARE_PORTS.includes(c.port),c.profile==='trojan-grpc'?'Cloudflare gRPC: нужен порт 443':'Cloudflare XHTTP: допустимы TLS-порты 443, 2053, 2083, 2087, 2096, 8443');
    check(c.sni===domain,'Cloudflare: SNI должен совпадать с доменом подключения');
    Object.assign(c,{delivery:'cloudflare',cloudflareDomain:domain});
  }
  check(/^\/[a-zA-Z0-9/_-]{0,119}$/.test(c.path),'Путь XHTTP: от / до 120 символов; допустимы латиница, цифры, /, _ и -');
  check(/^[a-zA-Z0-9_-]{1,80}$/.test(c.serviceName),'Имя службы gRPC: 1–80 символов; допустимы латиница, цифры, _ и -');
  if(c.profile.startsWith('vless')){check(/^[A-Za-z0-9_-]{43}$/.test(v.privateKey)&&/^[A-Za-z0-9_-]{43}$/.test(v.publicKey)&&/^[a-f0-9]{16}$/.test(v.shortId),'Неверные ключи Reality');Object.assign(c,{privateKey:v.privateKey,publicKey:v.publicKey,shortId:v.shortId,target:hostname(v.target||c.sni)});}
  for(const key of ['realitySni','tlsSni'])if(v[key])c[key]=hostname(v[key]);
  if(v.hy2!==undefined)c.hy2=hysteriaOptions(v.hy2);
  c.stability=stabilityMode(v.stability);
  c.fingerprint=['chrome','firefox','safari','randomized'].includes(v.fingerprint)?v.fingerprint:'chrome';
  return c;
}
export function serverSettings(value={}){
  const v=structuredClone(value);check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['dns','rules'].includes(k)),'Расширенные настройки: допустимы dns и rules');
  const dns=v.dns??['1.1.1.1'];check(Array.isArray(dns)&&dns.length>0&&dns.length<=4&&dns.every(x=>isIP(x)),'DNS ноды: от 1 до 4 IP-адресов');
  const rules=v.rules??[];check(Array.isArray(rules)&&rules.length<=256);
  return {dns,rules:rules.map(r=>{check(['direct','block'].includes(r.action));const d=destination(r.value);check(['domain','suffix','ip'].includes(r.type)&&(r.type==='ip')===(d.type==='ip'));return {type:r.type,value:d.value,action:r.action};})};
}
export function clientNetwork(value={}){
  const dns=value.dns||'1.1.1.1',backups=value.dnsBackups??[];
  check(typeof dns==='string'&&isIP(dns),'DNS клиента: укажи IP');
  check(Array.isArray(backups)&&backups.length<=3&&backups.every(x=>typeof x==='string'&&isIP(x)),'Резервные DNS: до 3 IP-адресов');
  const dnsParallel=value.dnsParallel??true,dnsStrategy=value.dnsStrategy??'UseIP';
  check(typeof dnsParallel==='boolean','Неверный режим запросов DNS');
  check(['UseIP','UseIPv4'].includes(dnsStrategy),'DNS: выбери IPv4 + IPv6 или только IPv4');
  const probeURL=value.probeURL??'https://www.gstatic.com/generate_204',probeInterval=value.probeInterval??15;
  check(typeof probeURL==='string'&&probeURL.length<=512&&!/[\x00-\x20\x7f]/.test(probeURL),'Неверный адрес проверки соединения');
  let url;try{url=new URL(probeURL);}catch{check(false,'Неверный адрес проверки соединения');}
  check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash,'Проверка соединения: HTTPS без пароля и фрагмента');
  check(Number.isSafeInteger(probeInterval)&&probeInterval>=10&&probeInterval<=300,'Интервал проверки: 10–300 секунд');
  return {dns,dnsBackups:[...new Set(backups)].filter(x=>x!==dns),dnsParallel,dnsStrategy,probeURL:url.href,probeInterval};
}
export function defaultRoute(value={}){const target=value.defaultTarget??'direct';check(['direct','vpn','block'].includes(target),'Выбери маршрут для адресов вне правил');return target;}
export function routing(value){
  check(value&&typeof value==='object'&&!Array.isArray(value)&&id(value.id),'Неверный профиль маршрутизации');
  check(value.fallback===undefined||['direct','block'].includes(value.fallback),'Выбери поведение при недоступном VPN');
  const result={id:value.id,name:text(value.name),fallback:value.fallback??'block',defaultTarget:defaultRoute(value),...clientNetwork(value),rules:[],groups:[],sources:[]};
  check(Array.isArray(value.rules)&&value.rules.length<=2000,'Правила: массив, не более 2000 записей');
  check(Array.isArray(value.groups??[])&&(value.groups??[]).length<=16,'Группы: массив, не более 16 записей');
  result.groups=(value.groups??[]).map(g=>{
    check(g&&id(g.id)&&Array.isArray(g.connections)&&g.connections.length>0&&g.connections.length<=32&&g.connections.every(id),'Неверная группа подключений');
    return {id:g.id,name:text(g.name),connections:[...new Set(g.connections)]};
  });
  check(new Set(result.groups.map(g=>g.id)).size===result.groups.length,'Идентификаторы групп не должны повторяться');
  const targets=['direct','block','vpn',...result.groups.map(g=>g.id)];
  const validTarget=target=>typeof target==='string'&&(targets.includes(target)||id(target));
  result.rules=value.rules.map(r=>{check(r&&validTarget(r.target),'Неверное направление правила');return {...routingEntry(r.type,r.value),target:r.target,exception:!!r.exception};});
  check(Array.isArray(value.sources??[])&&(value.sources??[]).length<=8,'Внешние списки: массив, не более 8 записей');
  result.sources=(value.sources??[]).map(s=>{
    check(s&&typeof s.url==='string','Укажи адрес внешнего списка');let url;
    try{url=new URL(s.url);}catch{check(false,'Неверный адрес внешнего списка');}
    check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&(!url.port||url.port==='443')&&url.href.length<1500,'Списки доступны только по HTTPS на порту 443, без пароля и фрагмента');
    check(['domain','suffix','ip','geosite','geoip'].includes(s.type)&&validTarget(s.target),'Неверный тип или направление внешнего списка');
    check(s.id===undefined||s.id===null||id(s.id),'Неверный идентификатор внешнего списка');
    return {id:s.id??null,url:url.href,type:s.type,target:s.target,exception:!!s.exception};
  });
  const sourceIDs=result.sources.map(s=>s.id).filter(Boolean);check(new Set(sourceIDs).size===sourceIDs.length,'Идентификаторы внешних списков не должны повторяться');
  return result;
}
export function envelope(v,node,now=Date.now()){
  check(v&&v.node===node&&id(v.id)&&integer(v.revision,1)&&integer(v.created)&&integer(v.expires)&&v.created<=now+30000&&v.expires>now&&v.expires-v.created<=LEASE_MS&&v.core===CORE_VERSION,'Просроченное или несовместимое задание VPN');
  check(Array.isArray(v.connections)&&v.connections.length<=32,'Задание должно содержать не более 32 подключений');
  check(Array.isArray(v.users)&&v.users.length<=50,'Задание должно содержать не более 50 пользователей');
  const connections=v.connections.map(connection);hoppingPlan(connections);check(connections.every(c=>c.node===node),'Подключение назначено другой ноде');
  const ports=connections.map(c=>(c.profile==='hysteria2'?'udp':'tcp')+c.port);check(new Set(ports).size===ports.length,'Порты подключений пересекаются');
  const users=v.users.map(u=>{check(id(u.id)&&id(u.uuid)&&/^[A-Za-z0-9_-]{32,64}$/.test(u.password)&&integer(u.expires)&&integer(u.ceiling)&&Array.isArray(u.connections)&&u.connections.every(x=>connections.some(c=>c.id===x)),'Неверные ключи, ограничения или подключения пользователя');return {...u};});
  const retiredUsers=v.retiredUsers??[];
  check(Array.isArray(retiredUsers)&&retiredUsers.length<=100&&retiredUsers.every(id)&&new Set(retiredUsers).size===retiredUsers.length&&!retiredUsers.some(key=>users.some(u=>u.id===key)),'Неверный список удалённых пользователей');
  return {...v,connections,users,retiredUsers,settings:serverSettings(v.settings)};
}
export function serverConfig(bundle,active=bundle.users,certDirectory='/var/lib/nexus404-vpn/certs',network={}){
  const inbounds=bundle.connections.filter(c=>c.enabled&&active.some(u=>u.connections.includes(c.id))).map(c=>{
    const users=active.filter(u=>u.connections.includes(c.id));const protocol=c.profile.startsWith('vless')?'vless':c.profile==='hysteria2'?'hysteria':'trojan';
    const method=transport(c.profile);
    const streamSettings={network:method,security:protocol==='vless'?'reality':'tls'};
    if(protocol==='vless')streamSettings.realitySettings={show:false,target:c.target+':443',xver:0,serverNames:[c.sni],privateKey:c.privateKey,shortIds:[c.shortId]};
    else streamSettings.tlsSettings={serverName:c.sni,minVersion:'1.3',alpn:protocol==='hysteria'?['h3']:method==='grpc'?['h2']:['h2','http/1.1'],certificates:[{certificateFile:certDirectory+'/fullchain.pem',keyFile:certDirectory+'/privkey.pem'}]};
    if(method==='xhttp')streamSettings.xhttpSettings={path:c.path,mode:'auto'};
    if(method==='grpc')streamSettings.grpcSettings={serviceName:c.serviceName};
    if(method==='hysteria'){streamSettings.hysteriaSettings={version:2};applyHysteria(streamSettings,c,{server:true});}
    applyTCPStability(streamSettings,c,{server:true,bbr:network.bbr===true});
    const clients=users.map(u=>({email:u.id,level:0,...(protocol==='vless'?{id:u.uuid,...(method==='raw'?{flow:'xtls-rprx-vision'}:{})}:protocol==='trojan'?{password:u.password}:{auth:u.password})}));
    return {tag:c.id,listen:'::',port:c.port,protocol,
      settings:protocol==='hysteria'?{clients,version:2}:{clients,...(protocol==='vless'?{decryption:'none'}:{})},
      ...(protocol==='hysteria'?{sniffing:{enabled:true,routeOnly:false,destOverride:['http','tls','quic']}}:{}),
      streamSettings};
  });
  const settings=serverSettings(bundle.settings);
  const direct={tag:'direct',protocol:'freedom'};
  if(bundle.connections.some(c=>c.enabled&&stabilityMode(c.stability)==='stable'))direct.streamSettings=applyTCPStability({network:'raw'},{},{server:true,bbr:network.bbr===true});
  const rules=settings.rules.map(r=>({type:'field',outboundTag:r.action,...(r.type==='ip'?{ip:[r.value]}:{domain:[(r.type==='suffix'?'domain:':'full:')+r.value]})}));
  return {log:{access:'none',error:'none',loglevel:'none'},stats:{},api:{tag:'api',services:['StatsService']},policy:{levels:{0:{statsUserUplink:true,statsUserDownlink:true}}},dns:{servers:settings.dns},inbounds:[...inbounds,{tag:'api-in',listen:'127.0.0.1',port:API_PORT,protocol:'dokodemo-door',settings:{address:'127.0.0.1'}}],outbounds:[direct,{tag:'block',protocol:'blackhole'}],routing:{domainStrategy:'IPIfNonMatch',rules:[{type:'field',inboundTag:['api-in'],outboundTag:'api'},{type:'field',ip:['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','::1/128','fc00::/7','fe80::/10'],outboundTag:'block'},...rules]}};
}
