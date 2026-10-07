import fs from 'node:fs';
import https from 'node:https';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {Collector,serviceStates} from './metrics.mjs';
import {Rules} from './signal-rules.mjs';
import {readEvents} from './event-reader.mjs';
import {direct,lock,sleep} from './common.mjs';
import {durable,readState,hubAddress,signedHeaders,agentConfig,uuid} from '../02-hub/src/agent-protocol.mjs';
export const AGENT_DATA='/var/lib/nexus404-agent';
export function credentials(file,hub,code) {
  const saved=readState(file,null);
  if(saved){if(saved.hub!==hubAddress(hub))throw Error('Агент уже связан с другим хабом');return saved;}
  const keys=generateKeyPairSync('ed25519');
  const value={hub:hubAddress(hub),code,privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}),publicKey:keys.publicKey.export({type:'spki',format:'der'}).toString('base64')};
  durable(file,value);return value;
}
export function transport(hub,route,raw,headers) {
  hubAddress(hub);
  return new Promise((resolve,reject)=>{
    const request=https.request(hub+route,{method:'POST',headers:{...headers,'content-length':Buffer.byteLength(raw)},rejectUnauthorized:true},response=>{
      let size=0;const chunks=[];
      response.on('data',chunk=>{size+=chunk.length;if(size>128*1024){response.destroy(Error('Ответ слишком большой'));return;}chunks.push(chunk);});
      response.on('error',reject);response.on('end',()=>{if(response.statusCode!==200){reject(Object.assign(Error('Хаб отклонил запрос'),{status:response.statusCode}));return;}try{resolve(JSON.parse(Buffer.concat(chunks)));}catch{reject(Error('Неверный ответ хаба'));}});
    });
    const timer=setTimeout(()=>request.destroy(Error('Тайм-аут хаба')),15000);request.once('close',()=>clearTimeout(timer));request.once('error',reject);request.end(raw);
  });
}
export class Agent {
  constructor({directory=AGENT_DATA,control='/var/lib/nexus404-agent-control',eventFile='/opt/nexus404/hooks/events/events.jsonl',now=Date.now,send=transport,collector=new Collector(),services=serviceStates}={}) {
    Object.assign(this,{directory,control,eventFile,now,send,collector,services});
    this.file=directory+'/credentials.json';this.identity=readState(this.file,null);if(!this.identity)throw Error('Сначала зарегистрируй агент');
    this.db=new DatabaseSync(directory+'/queue.sqlite');fs.chmodSync(directory+'/queue.sqlite',0o600);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT);');
  }
  state(key,fallback){const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  save(key,value){this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key,JSON.stringify(value));}
  async request(route,data){const raw=JSON.stringify(data);return this.send(this.identity.hub,route,raw,{...signedHeaders(this.identity.privateKey,route,raw,this.now()),'x-nexus-agent':this.identity.id??''});}
  async register(){if(this.identity.id)return;const result=await this.request('/api/agents/register',{code:this.identity.code,publicKey:this.identity.publicKey});if(!uuid(result.id))throw Error('Неверная регистрация');this.identity={...this.identity,id:result.id};delete this.identity.code;durable(this.file,this.identity);}
  sample(){
    const status=readState(this.control+'/status/status.json',null);
    const selected=status?agentConfig(status.config).services:['ssh.service','fail2ban.service','nexus404-agent.service'];
    const data=this.collector.sample();data.services={checkedAt:this.now(),items:this.services(undefined,selected)};
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const cursor=this.state('cursor',{}),state=this.state('rules',{}),rules=new Rules(state,this.now);
      rules.metrics(data);
      const statusKey=JSON.stringify([status?.requestId,status?.result,status?.error]);
      if(statusKey!==this.state('maintenanceStatus',null)){
        if(status?.requestId||status?.error)this.enqueue({id:randomUUID(),time:this.now(),key:'agent.maintenance',title:status.result==='rejected'||status.error?'Настройки обслуживания отклонены':'Расписание применено',body:status.result==='rejected'||status.error?'Прежнее расписание сохранено. Проверь настройки в Атланте.':'Расписание записано на VPS и выполняется без связи с хабом.',level:status.result==='rejected'||status.error?'warning':'info',category:'maintenance'});
        this.save('maintenanceStatus',statusKey);
      }
      for(const s of data.services.items)rules.condition('service.'+s.id,s.state!=='active',{title:'Служба '+s.id,body:'Состояние: '+s.state,delay:30000});
      for(const key of Object.keys(state.conditions??{}))if(key.startsWith('service.')&&!selected.includes(key.slice(8)))delete state.conditions[key];
      for(const e of readEvents(this.eventFile,cursor,64*1024,Infinity))rules.event(e);
      rules.flushGroups();
      for(const event of rules.take())this.enqueue(event);
      const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
      if(this.state('boot','')!==boot){this.enqueue({id:randomUUID(),time:this.now(),key:'agent.started',title:'Агент запущен после загрузки',body:'',level:'info',category:'maintenance'});this.save('boot',boot);}
      this.save('cursor',cursor);this.save('rules',state);this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    this.metrics=data;return data;
  }
  enqueue(event){this.db.prepare('INSERT INTO events(event) VALUES(?)').run(JSON.stringify(event));}
  async exchange(){
    await this.register();
    const events=this.db.prepare('SELECT * FROM events ORDER BY seq LIMIT 100').all().map(r=>({...JSON.parse(r.event),seq:r.seq}));
    const applied=readState(this.control+'/status/status.json',null);
    const vpnDirectory=this.vpnDirectory??'/var/lib/nexus404-vpn';
    let vpn=null;try{const file=vpnDirectory+'/status/report.json';if(fs.statSync(file).size<=65536)vpn=readState(file,null);}catch{}
    const result=await this.request('/api/agents/exchange',{id:this.identity.id,metrics:this.metrics??this.sample(),events,applied,...(vpn?{vpn}:{})});
    if(result.vpn&&fs.existsSync(vpnDirectory+'/requests'))durable(vpnDirectory+'/requests/config.json',result.vpn,0o640);
    const vpnStatus=JSON.stringify([vpn?.state,vpn?.revision,vpn?.complete,result.vpnError]);
    if(vpnStatus!==this.state('vpnStatus',null)){if(vpn||result.vpnError)this.enqueue({id:randomUUID(),time:this.now(),key:'vpn.status',title:result.vpnError??(vpn.state==='applied'?'VPN: настройки применены':'VPN: '+(vpn.state==='expired'?'разрешение истекло':vpn.state==='rejected'?'настройки отклонены':'ядро остановлено')),body:vpn?.error?String(vpn.error).slice(0,200):vpn?.complete===false?'Часть статистики могла быть потеряна при остановке ядра.':'',level:result.vpnError||vpn?.state==='rejected'?'warning':'info',category:'services'});this.save('vpnStatus',vpnStatus);}
    const acknowledged=this.state('ack',0),upper=events.at(-1)?.seq??acknowledged;
    if(!Number.isSafeInteger(result.ack)||result.ack<acknowledged||result.ack>upper)throw Error('Неверное подтверждение событий');
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM events WHERE seq<=?').run(result.ack);this.save('ack',result.ack);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    if(result.desired){const d=result.desired;agentConfig(d.config);if(!uuid(d.id))throw Error('Неверное расписание');durable(this.control+'/requests/request.json',d);}
    if(this.state('disconnected',false)){this.enqueue({id:randomUUID(),time:this.now(),key:'agent.recovered',title:'Соединение с хабом восстановлено',body:'Накопленные события доставляются.',level:'info',category:'recovery'});this.save('disconnected',false);}
  }
  disconnected(){if(!this.state('disconnected',false)){this.db.exec('BEGIN IMMEDIATE');try{this.enqueue({id:randomUUID(),time:this.now(),key:'agent.disconnected',title:'Нет связи с хабом',body:'Расписание продолжает выполняться локально.',level:'warning',category:'services'});this.save('disconnected',true);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}}
  close(){this.db.close();}
}
export async function runAgent(){const release=await lock('/var/lib/nexus404-agent/run.lock',true);const agent=new Agent();let running=true,pending=null,next=0,backoff=5000;for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{running=false;});
  try{while(running){try{agent.sample();if(!pending&&Date.now()>=next){pending=agent.exchange().then(()=>{backoff=5000;next=Date.now()+5000;},()=>{agent.disconnected();next=Date.now()+backoff+Math.random()*1000;backoff=Math.min(60000,backoff*2);}).finally(()=>{pending=null;});}}catch{console.error('Не удалось сохранить данные агента');}for(let i=0;i<25&&running;i++)await sleep(200);}await pending;}finally{agent.close();await release();}}
if(direct(import.meta.url))runAgent().catch(()=>{console.error('Агент остановлен');process.exitCode=1;});
