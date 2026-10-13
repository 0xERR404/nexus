// Shared validation for the panel, node, installer and subscription exporters.
const check=(ok,message)=>{if(!ok)throw Object.assign(Error(message),{status:400});};
const number=(value,fallback,min,max,label)=>{const n=value===undefined?fallback:Number(value);check(Number.isSafeInteger(n)&&n>=min&&n<=max,'Hysteria 2: '+label);return n;};
const choice=(value,fallback,values,label)=>{const v=value??fallback;check(values.includes(v),'Hysteria 2: '+label);return v;};
export function hopRanges(value=''){
  check(typeof value==='string'&&value.length<=180,'Смена портов: неверный диапазон');
  if(!value.trim())return [];
  const ranges=value.split(',').map(part=>{
    const m=/^\s*(\d{1,5})(?:\s*-\s*(\d{1,5}))?\s*$/.exec(part);check(m,'Смена портов: пример 20000-20100,21000');
    const from=Number(m[1]),to=Number(m[2]??m[1]);
    check(from>=1024&&to>=from&&to<=65535&&!(from<=10085&&to>=10085),'Смена портов: порты 1024–65535, кроме API 10085');return [from,to];
  }).sort((a,b)=>a[0]-b[0]);
  check(ranges.length<=8&&ranges.reduce((n,[a,b])=>n+b-a+1,0)<=1024,'Смена портов: не больше 8 диапазонов и 1024 портов');
  for(let i=1;i<ranges.length;i++)check(ranges[i][0]>ranges[i-1][1],'Диапазоны смены портов пересекаются');
  return ranges;
}
export const formatRanges=ranges=>ranges.map(([a,b])=>a===b?String(a):a+'-'+b).join(',');
export function hysteriaOptions(value={}){
  check(value&&typeof value==='object'&&!Array.isArray(value),'Неверные настройки Hysteria 2');
  const h={
    congestion:choice(value.congestion,'bbr',['auto','bbr','brutal'],'режим скорости'),
    bbrProfile:choice(value.bbrProfile,'standard',['conservative','standard','aggressive'],'профиль BBR'),
    upMbps:number(value.upMbps,0,0,100000,'отдача: 0–100000 Мбит/с'),
    downMbps:number(value.downMbps,0,0,100000,'загрузка: 0–100000 Мбит/с'),
    obfs:choice(value.obfs,'none',['none','salamander'],'маскировка'),
    obfsPassword:value.obfsPassword??'',
    hopPorts:formatRanges(hopRanges(value.hopPorts)),
    hopInterval:number(value.hopInterval,30,5,3600,'интервал смены портов: 5–3600 с'),
    hopFormat:choice(value.hopFormat,'xray',['happ','xray'],'формат смены портов'),
    masquerade:choice(value.masquerade,'none',['none','html'],'страница HTTP/3'),
    html:value.html??'',
    udpIdleTimeout:number(value.udpIdleTimeout,60,5,600,'тайм-аут UDP: 5–600 с'),
    maxIdleTimeout:number(value.maxIdleTimeout,30,4,120,'тайм-аут QUIC: 4–120 с'),
    keepAlivePeriod:number(value.keepAlivePeriod,value.maxIdleTimeout===undefined?10:Math.min(10,Number(value.maxIdleTimeout)-1),0,60,'KeepAlive: 0 или 2–60 с'),
    disablePathMTUDiscovery:value.disablePathMTUDiscovery===true,
    initStreamReceiveWindow:number(value.initStreamReceiveWindow,0,0,67108864,'начальное окно потока: до 64 МиБ'),
    maxStreamReceiveWindow:number(value.maxStreamReceiveWindow,0,0,67108864,'максимальное окно потока: до 64 МиБ'),
    initConnectionReceiveWindow:number(value.initConnectionReceiveWindow,0,0,167772160,'начальное окно соединения: до 160 МиБ'),
    maxConnectionReceiveWindow:number(value.maxConnectionReceiveWindow,0,0,167772160,'максимальное окно соединения: до 160 МиБ'),
    maxIncomingStreams:number(value.maxIncomingStreams,1024,8,8192,'число потоков: 8–8192')
  };
  check(h.congestion!=='brutal'||h.upMbps>0&&h.downMbps>0,'Brutal: укажи скорость загрузки и отдачи от 1 Мбит/с');
  check(typeof h.obfsPassword==='string'&&h.obfsPassword.length<=128&&!/[\x00-\x1f\x7f]/.test(h.obfsPassword),'Salamander: неверный пароль');
  check(h.obfs!=='salamander'||h.obfsPassword.length>=8,'Salamander: пароль от 8 до 128 символов');
  check(typeof h.html==='string'&&Buffer.byteLength(h.html,'utf8')<=2048,'Страница HTTP/3: максимум 2048 байт');
  check(h.masquerade!=='html'||h.html.trim(),'Введи содержимое страницы HTTP/3');
  check(h.masquerade==='none'||h.obfs==='none','Страница HTTP/3 недоступна при включённом Salamander');
  check(!h.keepAlivePeriod||h.keepAlivePeriod>=2&&h.keepAlivePeriod<h.maxIdleTimeout,'KeepAlive должен быть меньше тайм-аута QUIC');
  const windows=['initStreamReceiveWindow','maxStreamReceiveWindow','initConnectionReceiveWindow','maxConnectionReceiveWindow'];
  for(const key of windows)check(!h[key]||h[key]>=16384,'Окно QUIC: 0 — автоматически, иначе минимум 16384 байта');
  const [si,sm,ci,cm]=windows.map((key,i)=>h[key]||(i<2?8388608:20971520));
  check(sm>=si&&cm>=ci&&ci>=si&&cm>=sm,'Окна QUIC: максимум не меньше начального, окно соединения не меньше окна потока');
  return h;
}
export function hoppingPlan(connections){
  const enabled=connections.filter(c=>c.enabled!==false),plan=[];
  for(const c of enabled){
    if(c.profile!=='hysteria2'||!c.hy2?.hopPorts)continue;
    const ranges=hopRanges(c.hy2.hopPorts);check(Number.isSafeInteger(c.port)&&c.port>0&&c.port<=65535&&![22,80,10085].includes(c.port),'Неверный основной порт Hysteria 2');
    for(const [a,b] of ranges)for(const other of enabled)if(other.profile==='hysteria2')check(other.port<a||other.port>b,'Диапазон смены портов пересекается с основным UDP-портом');
    for(const item of plan)for(const [a,b] of ranges)for(const [x,y] of hopRanges(item.ports))check(b<x||a>y,'Диапазоны Hysteria 2 разных подключений пересекаются');
    plan.push({id:c.id,port:c.port,ports:formatRanges(ranges)});
  }
  return plan;
}
export function applyHysteria(stream,c,{server=false}={}){
  if(!c.hy2&&c.stability==='system')return stream;
  const h=hysteriaOptions(c.hy2),q={
    congestion:h.congestion==='auto'?'brutal':h.congestion,bbrProfile:h.bbrProfile,
    brutalUp:(h.congestion==='brutal'?(server?h.downMbps:h.upMbps):0)+' mbps',
    brutalDown:(h.congestion==='brutal'?(server?h.upMbps:h.downMbps):0)+' mbps',
    maxIdleTimeout:h.maxIdleTimeout,keepAlivePeriod:h.keepAlivePeriod,
    disablePathMTUDiscovery:h.disablePathMTUDiscovery,
    ...Object.fromEntries(['initStreamReceiveWindow','maxStreamReceiveWindow','initConnectionReceiveWindow','maxConnectionReceiveWindow'].filter(k=>h[k]).map(k=>[k,h[k]])),
    ...(server?{maxIncomingStreams:h.maxIncomingStreams}:{})
  };
  const masks=[];
  // Xray 26.7.28 uses the old QUIC field; 26.9.9 and later use FinalMask.
  if(!server&&h.hopPorts){
    if(h.hopFormat==='happ')q.udpHop={ports:h.hopPorts,interval:h.hopInterval};
    else masks.push({type:'udphop',settings:{mode:'intervallocal,intervalremote',remotePorts:h.hopPorts,interval:h.hopInterval}});
  }
  // Xray reverses the list: the port-hopping dialer must wrap the socket first.
  if(h.obfs==='salamander')masks.unshift({type:'salamander',settings:{password:h.obfsPassword}});
  stream.finalmask={quicParams:q,...(masks.length?{udp:masks}:{})};
  stream.hysteriaSettings.udpIdleTimeout=h.udpIdleTimeout;
  if(server&&h.masquerade==='html')stream.hysteriaSettings.masquerade={type:'string',content:h.html,headers:{'Content-Type':'text/html; charset=utf-8'},statusCode:200};
  return stream;
}
export function readHysteriaServer(stream,previous={}){
  const q=stream.finalmask?.quicParams??{},masks=stream.finalmask?.udp??[],salamander=masks.find(x=>x.type==='salamander'),masq=stream.hysteriaSettings?.masquerade;
  const rate=v=>{if(!v)return 0;const m=/^(\d+) mbps$/.exec(String(v));check(m,'Скорость задаётся целым числом Мбит/с');return Number(m[1]);};
  return hysteriaOptions({...previous,congestion:q.congestion==='brutal'&&!rate(q.brutalUp)&&!rate(q.brutalDown)?'auto':q.congestion??'auto',bbrProfile:q.bbrProfile,
    upMbps:rate(q.brutalDown),downMbps:rate(q.brutalUp),obfs:salamander?'salamander':'none',obfsPassword:salamander?.settings?.password??previous.obfsPassword??'',
    masquerade:masq?'html':'none',html:masq?.content??previous.html??'',udpIdleTimeout:stream.hysteriaSettings?.udpIdleTimeout,
    ...Object.fromEntries(['maxIdleTimeout','keepAlivePeriod','disablePathMTUDiscovery','initStreamReceiveWindow','maxStreamReceiveWindow','initConnectionReceiveWindow','maxConnectionReceiveWindow','maxIncomingStreams'].map(k=>[k,q[k]]))});
}
