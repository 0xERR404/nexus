import {connectionLabel} from './countries.mjs';
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
const isIPRule = rule => rule.type === 'ip' || rule.type === 'geoip';
const domain = rule => (rule.type === 'geosite' ? 'geosite:' : rule.type === 'suffix' ? 'domain:' : 'full:') + rule.value;
export function xrayRuleGroups(rules,target){
  const result=[];let previousKey;
  for(const rule of rules){
    const field=isIPRule(rule)?'ip':'domain',route=target(rule.target),key=JSON.stringify([field,route,!!rule.exception]);
    const value=field==='ip'?(rule.type==='geoip'?'geoip:':'')+rule.value:domain(rule);
    if(key===previousKey){const list=result.at(-1)[field];if(!list.includes(value))list.push(value);}
    else result.push({type:'field',[field]:[value],...route});
    previousKey=key;
  }
  return result;
}

// This is a client profile, not a node/server configuration.
// DNS and transport values come from the assigned panel profile and connection.
export function xrayProfiles(connections, user, route, rules) {
  const allowed = new Set(connections.map(connection => connection.id));
  const groups = new Map((route.groups ?? []).map(group => [
    group.id, group.connections.filter(id => allowed.has(id))
  ]));
  const orderedRules = rules.map((rule, index) => ({...rule, index}))
    .sort((a, b) => Number(!!b.exception) - Number(!!a.exception) || a.index - b.index);
  for (const rule of orderedRules) {
    check(['domain', 'suffix', 'ip', 'geosite', 'geoip'].includes(rule.type), 'Неизвестный тип правила');
    check(['vpn', 'direct', 'block'].includes(rule.target) ||
      allowed.has(rule.target) || groups.get(rule.target)?.length,
      'Маршрутизация ссылается на недоступное пользователю подключение или группу');
  }

  return connections.map(selected => {
    const ordered = [selected, ...connections.filter(connection => connection.id !== selected.id)];
    const balancers = new Map();
    const target = value => {
      if (value === 'direct' || value === 'block') return {outboundTag: value};
      const ids = value === 'vpn' ? [selected.id] : allowed.has(value) ? [value] : groups.get(value);
      check(ids?.length, 'Пустая группа маршрутизации');
      if (ids.length === 1 && route.fallback !== 'direct') return {outboundTag: 'proxy-' + ids[0]};
      const tag = 'balance-' + value;
      balancers.set(tag, {
        tag, selector: ids.map(id => 'proxy-' + id),
        fallbackTag: route.fallback === 'direct' ? 'direct' : 'block',
        strategy: {type: 'leastPing'}
      });
      return {balancerTag: tag};
    };

    const routingRules = xrayRuleGroups(orderedRules,target);
    // Unlisted destinations use DIRECT for both TCP and UDP (including QUIC).
    // Never add a catch-all UDP proxy or hard-code a user's domains here.
    routingRules.push({type: 'field', network: 'tcp,udp', outboundTag: 'direct'});
    const sniffing = () => ({
      enabled: true, routeOnly: false, destOverride: ['http', 'tls', 'quic']
    });
    const config = {
      remarks: connectionLabel(selected),
      log: {access: 'none', loglevel: 'warning'},
      dns: {servers: [route.dns], queryStrategy: 'UseIP'},
      inbounds: [
        {tag: 'socks', port: 10808, listen: '127.0.0.1', protocol: 'socks',
          settings: {udp: true, auth: 'noauth'}, sniffing: sniffing()},
        {tag: 'http', port: 10809, listen: '127.0.0.1', protocol: 'http',
          settings: {allowTransparent: false}, sniffing: sniffing()}
      ],
      outbounds: [
        ...ordered.map(connection => clientOutbound(connection, user)),
        {tag: 'direct', protocol: 'freedom'},
        {tag: 'block', protocol: 'blackhole'}
      ],
      routing: {
        domainMatcher: 'hybrid', domainStrategy: orderedRules.some(isIPRule)?'IPOnDemand':'IPIfNonMatch', rules: routingRules,
        ...(balancers.size ? {balancers: [...balancers.values()]} : {})
      }
    };
    if (balancers.size) config.observatory = {
      subjectSelector: ['proxy-'], probeURL: 'https://www.gstatic.com/generate_204',
      probeInterval: '60s', enableConcurrency: true
    };
    return config;
  });
}
