import {isIP} from 'node:net';
import {createHash} from 'node:crypto';
export const CORE_VERSION='26.9.30';
export const PROFILES={
  'vless-raw':'VLESS · RAW/TCP · Reality',
  'vless-xhttp':'VLESS · XHTTP · Reality',
  'vless-grpc':'VLESS · gRPC · Reality',
  'trojan':'Trojan · TLS',
  'hysteria2':'Hysteria 2'
};
export const LEASE_MS=120000, API_PORT=10085;
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export function check(ok,message='Некорректные настройки VPN'){if(!ok)throw Object.assign(Error(message),{status:400});}
export const id=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const integer=(v,min=0,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
export function text(value,max=80){check(typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\x00-\x1f]/.test(value));return value.trim();}
export function hostname(value){check(typeof value==='string'&&value.length<=253&&(isIP(value)||/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(value)),'Неверный адрес / SNI');return value.toLowerCase();}
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
  check(v&&id(v.id)&&id(v.node)&&Object.hasOwn(PROFILES,v.profile));
  const c={id:v.id,node:v.node,name:text(v.name),profile:v.profile,address:hostname(v.address),port:Number(v.port),sni:hostname(v.sni||v.address),enabled:v.enabled!==false,path:v.path||'/nexus',serviceName:v.serviceName||'nexus'};
  check(integer(c.port,1,65535)&&c.port!==API_PORT&&c.port!==22&&c.port!==80,'Порт зарезервирован для SSH, проверки TLS или локального API');
  check(/^\/[a-zA-Z0-9/_-]{0,119}$/.test(c.path)&&/^[a-zA-Z0-9_-]{1,80}$/.test(c.serviceName));
  if(c.profile.startsWith('vless')){check(/^[A-Za-z0-9_-]{43}$/.test(v.privateKey)&&/^[A-Za-z0-9_-]{43}$/.test(v.publicKey)&&/^[a-f0-9]{16}$/.test(v.shortId),'Неверные ключи Reality');Object.assign(c,{privateKey:v.privateKey,publicKey:v.publicKey,shortId:v.shortId,target:hostname(v.target||c.sni)});}
  for(const key of ['realitySni','tlsSni'])if(v[key])c[key]=hostname(v[key]);
  c.fingerprint=['chrome','firefox','safari','randomized'].includes(v.fingerprint)?v.fingerprint:'chrome';
  return c;
}
export function serverSettings(value={}){
  const v=structuredClone(value);check(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>['dns','rules'].includes(k)),'Расширенные настройки: допустимы dns и rules');
  const dns=v.dns??['1.1.1.1'];check(Array.isArray(dns)&&dns.length>0&&dns.length<=4&&dns.every(x=>isIP(x)),'DNS ноды: от 1 до 4 IP-адресов');
  const rules=v.rules??[];check(Array.isArray(rules)&&rules.length<=256);
  return {dns,rules:rules.map(r=>{check(['direct','block'].includes(r.action));const d=destination(r.value);check(['domain','suffix','ip'].includes(r.type)&&(r.type==='ip')===(d.type==='ip'));return {type:r.type,value:d.value,action:r.action};})};
}
export function routing(value){
  check(value&&id(value.id));const result={id:value.id,name:text(value.name),fallback:value.fallback==='direct'?'direct':'block',dns:value.dns||'1.1.1.1',rules:[],groups:[],sources:[]};
  check(isIP(result.dns),'DNS клиента: укажи IP');
  check(Array.isArray(value.rules)&&value.rules.length<=2000);
  result.groups=(value.groups??[]).map(g=>{check(id(g.id)&&Array.isArray(g.connections)&&g.connections.length>0&&g.connections.length<=32&&g.connections.every(id));return {id:g.id,name:text(g.name),connections:[...new Set(g.connections)]};});check(result.groups.length<=16);
  const targets=['direct','block','vpn',...result.groups.map(g=>g.id)];
  result.rules=value.rules.map(r=>{check(typeof r.target==='string'&&(targets.includes(r.target)||id(r.target)));return {...routingEntry(r.type,r.value),target:r.target,exception:!!r.exception};});
  result.sources=(value.sources??[]).map(s=>{const url=new URL(s.url);check(url.protocol==='https:'&&!url.username&&!url.password&&!url.hash&&url.href.length<1500,'Списки доступны только по HTTPS');check(['domain','suffix','ip','geosite','geoip'].includes(s.type)&&typeof s.target==='string'&&(targets.includes(s.target)||id(s.target)));return {id:id(s.id)?s.id:null,url:url.href,type:s.type,target:s.target,exception:!!s.exception};});check(result.sources.length<=8);return result;
}
export function envelope(v,node,now=Date.now()){
  check(v&&v.node===node&&id(v.id)&&integer(v.revision,1)&&integer(v.created)&&integer(v.expires)&&v.created<=now+30000&&v.expires>now&&v.expires-v.created<=LEASE_MS&&v.core===CORE_VERSION,'Просроченное или несовместимое задание VPN');
  check(Array.isArray(v.connections)&&v.connections.length<=32&&Array.isArray(v.users)&&v.users.length<=50);
  const connections=v.connections.map(connection);check(connections.every(c=>c.node===node));
  const ports=connections.map(c=>(c.profile==='hysteria2'?'udp':'tcp')+c.port);check(new Set(ports).size===ports.length,'Порты подключений пересекаются');
  const users=v.users.map(u=>{check(id(u.id)&&id(u.uuid)&&/^[A-Za-z0-9_-]{32,64}$/.test(u.password)&&integer(u.expires)&&integer(u.ceiling)&&Array.isArray(u.connections)&&u.connections.every(x=>connections.some(c=>c.id===x)));return {...u};});
  return {...v,connections,users,settings:serverSettings(v.settings)};
}
export function serverConfig(bundle,active=bundle.users,certDirectory='/var/lib/nexus404-vpn/certs'){
  const inbounds=bundle.connections.filter(c=>c.enabled&&active.some(u=>u.connections.includes(c.id))).map(c=>{
    const users=active.filter(u=>u.connections.includes(c.id));const protocol=c.profile.startsWith('vless')?'vless':c.profile==='hysteria2'?'hysteria':'trojan';
    const method=c.profile.startsWith('vless')?c.profile.slice(6):c.profile==='hysteria2'?'hysteria':'raw';
    const streamSettings={network:method,security:protocol==='vless'?'reality':'tls'};
    if(protocol==='vless')streamSettings.realitySettings={show:false,target:c.target+':443',xver:0,serverNames:[c.sni],privateKey:c.privateKey,shortIds:[c.shortId]};
    else streamSettings.tlsSettings={serverName:c.sni,minVersion:'1.3',alpn:protocol==='hysteria'?['h3']:['h2','http/1.1'],certificates:[{certificateFile:certDirectory+'/fullchain.pem',keyFile:certDirectory+'/privkey.pem'}]};
    if(method==='xhttp')streamSettings.xhttpSettings={path:c.path,mode:'auto'};
    if(method==='grpc')streamSettings.grpcSettings={serviceName:c.serviceName};
    if(method==='hysteria')streamSettings.hysteriaSettings={version:2};
    const clients=users.map(u=>({email:u.id,level:0,...(protocol==='vless'?{id:u.uuid,...(method==='raw'?{flow:'xtls-rprx-vision'}:{})}:protocol==='trojan'?{password:u.password}:{auth:u.password})}));
    return {tag:c.id,listen:'0.0.0.0',port:c.port,protocol,settings:protocol==='hysteria'?{version:2,users:clients}:{clients,...(protocol==='vless'?{decryption:'none'}:{})},streamSettings};
  });
  const settings=serverSettings(bundle.settings);
  const rules=settings.rules.map(r=>({type:'field',outboundTag:r.action,...(r.type==='ip'?{ip:[r.value]}:{domain:[(r.type==='suffix'?'domain:':'full:')+r.value]})}));
  return {log:{access:'none',error:'none',loglevel:'none'},stats:{},api:{tag:'api',services:['StatsService']},policy:{levels:{0:{statsUserUplink:true,statsUserDownlink:true}}},dns:{servers:settings.dns},inbounds:[...inbounds,{tag:'api-in',listen:'127.0.0.1',port:API_PORT,protocol:'dokodemo-door',settings:{address:'127.0.0.1'}}],outbounds:[{tag:'direct',protocol:'freedom'},{tag:'block',protocol:'blackhole'}],routing:{domainStrategy:'IPIfNonMatch',rules:[{type:'field',inboundTag:['api-in'],outboundTag:'api'},{type:'field',ip:['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','::1/128','fc00::/7','fe80::/10'],outboundTag:'block'},...rules]}};
}
