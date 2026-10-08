import dns from 'node:dns/promises';
import tls from 'node:tls';
import https from 'node:https';
import {isIP} from 'node:net';
import {X509Certificate} from 'node:crypto';
import {hubAddress} from '../02-hub/src/agent-protocol.mjs';
const failure=(code,phase,extra={})=>Object.assign(new Error(code),{code,phase,...extra});
const tlsFailure=code=>/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code??'');
export function connectionError(error) {
  const status=Number(error?.status),phase=error?.phase;
  if(status===401)return 'Хаб отклонил регистрацию или ключ (HTTP 401). Проверь новый код из Атланта и время VPS; код действует 15 минут.';
  if(status===403)return 'Хаб запретил запрос (HTTP 403). Проверь HTTPS и настройки обратного прокси.';
  if(status===404||status===405)return 'API агентов недоступен (HTTP '+status+'). Проверь адрес и обнови хаб.';
  if(status===429)return 'Хаб ограничил частоту запросов (HTTP 429). Повтори позже'+(error.retryAfter?' — через '+Math.ceil(error.retryAfter/1000)+' с':'')+'.';
  if(status>=300&&status<400)return 'Хаб вернул перенаправление (HTTP '+status+'). Укажи конечный HTTPS-адрес без страницы входа; секреты по редиректу не отправляются.';
  if(status>=500)return 'Ошибка хаба или обратного прокси (HTTP '+status+'). Проверь службу хаба.';
  if(status>=400)return 'Хаб отклонил запрос (HTTP '+status+').';
  if(phase==='dns')return 'Не удалось определить IP хаба: DNS недоступен или не ответил вовремя.';
  if(tlsFailure(error?.code))return 'Проверка TLS хаба не пройдена: проверь имя/IP сертификата, доверенную цепочку, срок и время VPS. Проверка сертификата не отключена.';
  if(phase==='tcp')return 'Не удалось соединиться с хабом по доступным IPv4/IPv6: проверь адрес, HTTPS-порт и сетевой доступ.';
  if(phase==='tls')return 'TCP-соединение установлено, но хаб не завершил TLS вовремя. Проверь HTTPS-порт и обратный прокси.';
  if(phase==='response')return error?.code==='EAGENT_RESPONSE'?'Хаб вернул некорректный или слишком большой ответ API.':'TLS установлен, но ответ хаба не получен полностью. Проверь службу хаба и обратный прокси.';
  if(error?.code==='EACCES'||error?.code==='EPERM')return 'Нет прав на файлы или сеть агента. Проверь владельца каталогов агента.';
  return 'Регистрация не завершена. Проверь состояние хаба и журнал установки.';
}
export function retryable(error) {
  return !tlsFailure(error?.code)&&(error?.status===502||error?.status===503||error?.status===504||['EAGENT_DNS','EAGENT_CONNECT','ETIMEDOUT','ECONNRESET','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','EAI_AGAIN','ENOTFOUND'].includes(error?.code));
}
function verifyPeer(host,cert) {
  if(!isIP(host))return tls.checkServerIdentity(host,cert);
  try{if(new X509Certificate(cert.raw).checkIP(host))return;}catch{}
  return failure('ERR_TLS_CERT_ALTNAME_INVALID','tls');
}
function retryAfter(value){const seconds=/^\d+$/.test(value??'')?Number(value):(Date.parse(value)-Date.now())/1000;return Number.isFinite(seconds)?Math.min(86400000,Math.max(1000,seconds*1000)):null;}
export function createTransport({lookup=(host)=>dns.lookup(host,{all:true,verbatim:true}),connect=tls.connect,dnsTimeout=5000,connectTimeout=7000,responseTimeout=15000,stagger=250,ca}={}) {
  async function addresses(host) {
    if(isIP(host))return [{address:host,family:isIP(host)}];
    let timer;try{
      const found=await Promise.race([lookup(host),new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('EAGENT_DNS','dns')),dnsTimeout);})]);
      const unique=[...new Map(found.filter(v=>isIP(v.address)===v.family).map(v=>[v.address,v])).values()];
      const v4=unique.filter(v=>v.family===4),v6=unique.filter(v=>v.family===6),rows=[];
      while(rows.length<6&&(v4.length||v6.length)){if(v4.length)rows.push(v4.shift());if(v6.length)rows.push(v6.shift());}
      if(!rows.length)throw failure('EAGENT_DNS','dns');return rows;
    }catch{throw failure('EAGENT_DNS','dns');}finally{clearTimeout(timer);}
  }
  async function secureSocket(url) {
    const host=url.hostname.replace(/^\[|\]$/g,''),rows=await addresses(host);
    return new Promise((resolve,reject)=>{
      const sockets=new Set(),timers=new Set(),errors=[];let done=false,remaining=rows.length;
      const cleanup=winner=>{for(const timer of timers)clearTimeout(timer);for(const socket of sockets)if(socket!==winner)socket.destroy();};
      const failed=(error,row,phase)=>{
        if(done)return;errors.push({family:row.family,phase,code:tlsFailure(error.code)?error.code:error.code==='ETIMEDOUT'?'ETIMEDOUT':'EAGENT_CONNECT'});
        if(--remaining===0){done=true;cleanup();const last=errors.find(e=>tlsFailure(e.code))??errors.find(e=>e.phase==='tls')??errors.at(-1);reject(failure(last.code,last.phase,{attempts:errors}));}
      };
      rows.forEach((row,i)=>{const scheduled=setTimeout(()=>{
        if(done)return;let socket,phase='tcp',settled=false;
        const fail=error=>{if(settled||done)return;settled=true;clearTimeout(deadline);socket?.destroy();failed(error,row,phase);};
        const deadline=setTimeout(()=>fail(failure('ETIMEDOUT',phase)),connectTimeout);timers.add(deadline);
        try{
          socket=connect({host:row.address,port:Number(url.port)||443,family:row.family,servername:isIP(host)?undefined:host,rejectUnauthorized:true,minVersion:'TLSv1.2',...(ca?{ca}:{}),checkServerIdentity:(_name,cert)=>verifyPeer(host,cert),ALPNProtocols:['http/1.1']});sockets.add(socket);
          socket.once('connect',()=>{phase='tls';});socket.once('error',fail);
          socket.once('secureConnect',()=>{if(done||settled)return;if(!socket.authorized)return fail(failure('EAGENT_TLS_CERT','tls'));settled=true;done=true;cleanup(socket);resolve(socket);});
          socket.once('close',()=>{if(!done&&!settled)fail(failure('ECONNRESET',phase));});
        }catch(e){fail(e);}
      },i*stagger);timers.add(scheduled);});
    });
  }
  return async function transport(hub,route,raw,headers) {
    hubAddress(hub);
    if(!['/api/agents/register','/api/agents/exchange'].includes(route))throw failure('EAGENT_ROUTE','request');
    const url=new URL(hub+route),socket=await secureSocket(url);
    // Race only verified TLS connections. Send the signed POST exactly once, to the winner.
    const agent=new https.Agent({keepAlive:false,maxSockets:1});agent.createConnection=()=>socket;
    return new Promise((resolve,reject)=>{
      let request,timer,settled=false;
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);agent.destroy();socket.destroy();if(error)reject(error);else resolve(value);};
      try{
        request=https.request(url,{method:'POST',agent,headers:{...headers,'content-length':Buffer.byteLength(raw)},rejectUnauthorized:true},response=>{
          let size=0;const chunks=[];
          response.on('data',chunk=>{size+=chunk.length;if(size>128*1024){finish(failure('EAGENT_RESPONSE','response'));return;}chunks.push(chunk);});
          response.once('error',()=>finish(failure('ECONNRESET','response')));response.once('aborted',()=>finish(failure('ECONNRESET','response')));
          response.once('end',()=>{
            if(response.statusCode!==200)return finish(failure('EAGENT_HTTP','response',{status:response.statusCode,retryAfter:retryAfter(response.headers['retry-after'])}));
            try{const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw Error();finish(null,value);}catch{finish(failure('EAGENT_RESPONSE','response'));}
          });
        });
        request.once('error',error=>finish(failure(error.code??'ECONNRESET','response')));
        timer=setTimeout(()=>{finish(failure('ETIMEDOUT','response'));request.destroy();},responseTimeout);
        request.end(raw);
      }catch(e){finish(failure(e.code??'EAGENT_RESPONSE','response'));}
    });
  };
}
export const transport=createTransport();
