import {randomBytes} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';

const fail=(status,message)=>{throw Object.assign(new Error(message),{status});};
export function normalizeIP(value){
  const ip=String(value??'').replace(/^::ffff:/i,'').replace(/^\[|\]$/g,'');
  if(!isIP(ip))return '';
  return isIP(ip)===6?new URL('http://['+ip+']/').hostname.slice(1,-1):ip;
}
const headers={'cache-control':'no-store, no-transform','x-content-type-options':'nosniff'};
// Browser measurements only. No arbitrary URL fetching and no access to VPN credentials.
export class Diagnostics {
  constructor({now=Date.now,resolve=lookup}={}){this.now=now;this.resolve=resolve;this.runs=new Map();this.starts=new Map();this.payload=randomBytes(256*1024);}
  prune(){const now=this.now();for(const [key,run] of this.runs)if(run.expires<=now)this.runs.delete(key);for(const [owner,times] of this.starts){const live=times.filter(t=>t>now-60000);if(live.length)this.starts.set(owner,live);else this.starts.delete(owner);}}
  async start(owner,connection){
    this.prune();const times=this.starts.get(owner)??[];
    if(times.length>=6||this.runs.size>=8)fail(429,'Слишком много проверок. Подожди минуту.');
    if([...this.runs.values()].some(r=>r.owner===owner))fail(409,'Проверка уже запущена. Останови её или подожди 5 минут.');
    times.push(this.now());this.starts.set(owner,times);
    const id=randomBytes(16).toString('base64url');
    const run={owner,expires:this.now()+300000,addresses:[],hasConnection:!!connection,requests:0,bytes:0,loadStart:0};
    this.runs.set(id,run);
    if(connection){
      const address=String(connection.address??'').replace(/^\[|\]$/g,'');let timer;
      try{run.addresses=isIP(address)?[normalizeIP(address)]:(await Promise.race([this.resolve(address,{all:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('DNS timeout')),2000);})])).map(a=>normalizeIP(a.address)).filter(Boolean);}catch{}finally{clearTimeout(timer);}
    }
    return {id,expires:run.expires,loadLimit:32*1024*1024};
  }
  run(owner,id){this.prune();const r=this.runs.get(id);if(!r||r.owner!==owner)fail(410,'Проверка завершена или истекла. Запусти новую.');return r;}
  stop(owner,id){const r=this.runs.get(id);if(r?.owner===owner)this.runs.delete(id);return {ok:true};}
  probe(owner,id,nonce,address){
    const r=this.run(owner,id);if(!/^[a-zA-Z0-9-]{1,64}$/.test(nonce??''))fail(400,'Некорректная проба');
    if(++r.requests>400)fail(429,'Лимит проб исчерпан');
    const ip=normalizeIP(address),path=!r.hasConnection?'baseline':!ip||!r.addresses.length?'unknown':r.addresses.includes(ip)?'matched':'different';
    return Response.json({id,nonce,path},{headers});
  }
  load(owner,id){
    const r=this.run(owner,id);if(!r.loadStart)r.loadStart=this.now();
    if(this.now()-r.loadStart>20000||r.bytes+this.payload.length>32*1024*1024)return new Response(null,{status:204,headers});
    r.bytes+=this.payload.length;
    return new Response(this.payload,{headers:{...headers,'content-type':'application/octet-stream','x-vpn-diagnostic':id}});
  }
  close(){this.runs.clear();this.starts.clear();}
}
