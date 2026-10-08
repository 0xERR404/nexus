import {isIP} from 'node:net';
import {check} from '../../src/vpn-protocol.mjs';

export function clientOutbound(c,u){
  const vless=c.profile.startsWith('vless'),network=vless?c.profile.slice(6):c.profile==='hysteria2'?'hysteria':'raw';
  const streamSettings={network,security:vless?'reality':'tls'};
  if(vless)streamSettings.realitySettings={serverName:c.sni,fingerprint:c.fingerprint,publicKey:c.publicKey,shortId:c.shortId};
  else streamSettings.tlsSettings={serverName:c.sni,allowInsecure:false,...(network==='hysteria'?{alpn:['h3']}:{})};
  if(network==='xhttp')streamSettings.xhttpSettings={path:c.path,mode:'auto'};
  if(network==='grpc')streamSettings.grpcSettings={serviceName:c.serviceName};
  if(network==='hysteria')streamSettings.hysteriaSettings={version:2,auth:u.password};
  const settings=vless?{vnext:[{address:c.address,port:c.port,users:[{id:u.uuid,encryption:'none',...(network==='raw'?{flow:'xtls-rprx-vision'}:{})}]}]}:network==='hysteria'?{version:2,address:c.address,port:c.port}:{servers:[{address:c.address,port:c.port,password:u.password}]};
  return {tag:'proxy-'+c.id,protocol:vless?'vless':network==='hysteria'?'hysteria':'trojan',settings,streamSettings};
}
const domain=r=>(r.type==='suffix'?'domain:':'full:')+r.value;
export function xrayProfiles(connections,u,route,rules){
  const allowed=new Set(connections.map(c=>c.id)),groups=new Map(route.groups.map(g=>[g.id,g.connections.filter(id=>allowed.has(id))]));
  for(const r of rules)check(['vpn','direct','block'].includes(r.target)||allowed.has(r.target)||groups.get(r.target)?.length,'Маршрутизация ссылается на недоступное пользователю подключение или группу');
  return connections.map(selected=>{
    const ordered=[selected,...connections.filter(c=>c.id!==selected.id)],balancers=new Map();
    const target=value=>{
      if(value==='direct'||value==='block')return {outboundTag:value};
      const ids=value==='vpn'?[selected.id]:allowed.has(value)?[value]:groups.get(value);
      check(ids?.length,'Пустая группа маршрутизации');
      if(ids.length===1&&route.fallback!=='direct')return {outboundTag:'proxy-'+ids[0]};
      const tag='balance-'+value;
      balancers.set(tag,{tag,selector:ids.map(id=>'proxy-'+id),fallbackTag:route.fallback==='direct'?'direct':'block',strategy:{type:'leastPing'}});
      return {balancerTag:tag};
    };
    const dnsRules=[],servers=[{address:route.dns,tag:'dns-direct'}];
    // Keep one DNS entry per ordered domain rule: merging targets would reorder overlaps.
    rules.forEach((r,i)=>{
      if(r.type==='ip')return;
      const tag='dns-rule-'+i;
      servers.push({address:route.dns,domains:[domain(r)],tag,skipFallback:true,finalQuery:true});
      dnsRules.push({type:'field',inboundTag:[tag],...target(r.target)});
    });
    const routingRules=[
      {type:'field',inboundTag:['dns-direct'],outboundTag:'direct'},...dnsRules,
      {type:'field',port:'53',network:'tcp,udp',outboundTag:'dns-out'},
      ...rules.map(r=>({type:'field',...(r.type==='ip'?{ip:[r.value]}:{domain:[domain(r)]}),...target(r.target)})),
      {type:'field',network:'tcp,udp',outboundTag:'direct'}
    ];
    // Bootstrap proxy addresses outside the tunnel, including when a broad VPN rule matches them.
    const proxyDomains=connections.filter(c=>!isIP(c.address)).map(c=>'full:'+c.address);
    if(proxyDomains.length)servers.splice(1,0,{address:route.dns,domains:[...new Set(proxyDomains)],tag:'dns-direct',skipFallback:true,finalQuery:true});
    const config={remarks:selected.name,log:{access:'none',loglevel:'warning'},
      dns:{servers,tag:'dns-direct',queryStrategy:'UseIP',disableFallbackIfMatch:true},
      inbounds:[{tag:'socks',listen:'127.0.0.1',port:10808,protocol:'socks',settings:{auth:'noauth',udp:true},sniffing:{enabled:true,destOverride:['http','tls','quic'],routeOnly:true}}],
      outbounds:[...ordered.map(c=>clientOutbound(c,u)),{tag:'direct',protocol:'freedom',streamSettings:{sockopt:{domainStrategy:'UseIP'}}},{tag:'block',protocol:'blackhole'},{tag:'dns-out',protocol:'dns',settings:{nonIPQuery:'drop'}}],
      routing:{domainStrategy:'IPOnDemand',rules:routingRules,...(balancers.size?{balancers:[...balancers.values()]}:{})}
    };
    if(balancers.size)config.observatory={subjectSelector:['proxy-'],probeURL:'https://www.gstatic.com/generate_204',probeInterval:'60s',enableConcurrency:true};
    return config;
  });
}
