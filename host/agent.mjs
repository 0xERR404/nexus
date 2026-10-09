import fs from 'node:fs';
import {transport,connectionError,retryable} from './agent-http.mjs';
export {transport} from './agent-http.mjs';
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
export class Agent {
  constructor({directory=AGENT_DATA,control='/var/lib/nexus404-agent-control',eventFile='/opt/nexus404/hooks/events/events.jsonl',now=Date.now,send=transport,collector=new Collector(),services=serviceStates}={}) {
    Object.assign(this,{directory,control,eventFile,now,send,collector,services});
    this.file=directory+'/credentials.json';this.identity=readState(this.file,null);if(!this.identity)throw Error('Сначала зарегистрируй агент');
    this.db=new DatabaseSync(directory+'/queue.sqlite');fs.chmodSync(directory+'/queue.sqlite',0o600);this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event TEXT);');
  }
  state(key,fallback){const row=this.db.prepare('SELECT value FROM state WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  save(key,value){this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key,JSON.stringify(value));}
  async request(route,data){const raw=JSON.stringify(data);return this.send(this.identity.hub,route,raw,{...signedHeaders(this.identity.privateKey,route,raw,this.now()),'x-nexus-agent':this.identity.id??''});}
  async register(){if(this.identity.id)return;const result=await this.request('/api/agents/register',{code:this.identity.code,publicKey:this.identity.publicKey});if(!uuid(result.id))throw Object.assign(Error('Неверный ответ регистрации'),{code:'EAGENT_RESPONSE',phase:'response'});this.identity={...this.identity,id:result.id};delete this.identity.code;durable(this.file,this.identity);}
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
    if(vpnStatus!==this.state('vpnStatus',null)){if(vpn||result.vpnError)this.enqueue({id:randomUUID(),time:this.now(),key:'vpn.status',title:result.vpnError??(vpn.state==='applied'?'VPN: настройки применены':'VPN: '+(vpn.state==='expired'?'разрешение истекло':vpn.state==='rejected'?'настройки отклонены':'ядро остановлено')),body:vpn?.error?String(vpn.error).slice(0,200):vpn?.complete===false?'Ранее зафиксирован незавершённый интервал учёта. Это сообщение не означает новую потерю статистики.':'',level:result.vpnError||vpn?.state==='rejected'?'warning':'info',category:'services'});this.save('vpnStatus',vpnStatus);}
    const acknowledged=this.state('ack',0),upper=events.at(-1)?.seq??acknowledged;
    if(!Number.isSafeInteger(result.ack)||result.ack<acknowledged||result.ack>upper)throw Error('Неверное подтверждение событий');
    this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare('DELETE FROM events WHERE seq<=?').run(result.ack);this.save('ack',result.ack);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}
    if(result.desired){const d=result.desired;agentConfig(d.config);if(!uuid(d.id))throw Error('Неверное расписание');durable(this.control+'/requests/request.json',d);}
    if(this.state('disconnected',false)){this.enqueue({id:randomUUID(),time:this.now(),key:'agent.recovered',title:'Соединение с хабом восстановлено',body:'Накопленные события доставляются.',level:'info',category:'recovery'});this.save('disconnected',false);}
  }
  disconnected(error){if(!this.state('disconnected',false)){this.db.exec('BEGIN IMMEDIATE');try{this.enqueue({id:randomUUID(),time:this.now(),key:'agent.disconnected',title:'Нет связи с хабом',body:(error?connectionError(error)+' ':'')+'Расписание продолжает выполняться локально.',level:'warning',category:'services'});this.save('disconnected',true);this.db.exec('COMMIT');}catch(e){this.db.exec('ROLLBACK');throw e;}}}
  close(){this.db.close();}
}
export async function runAgent(){const release=await lock('/var/lib/nexus404-agent/run.lock',true);const agent=new Agent();let running=true,pending=null,next=0,backoff=5000,lastError='';for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{running=false;});
  try{while(running){try{agent.sample();if(!pending&&Date.now()>=next){pending=agent.exchange().then(()=>{backoff=5000;next=Date.now()+5000;lastError='';},error=>{const detail=connectionError(error);if(detail!==lastError){console.error(detail);lastError=detail;}agent.disconnected(error);next=Date.now()+Math.max(backoff,error.retryAfter??0)+Math.random()*1000;backoff=Math.min(60000,backoff*2);}).finally(()=>{pending=null;});}}catch{console.error('Не удалось сохранить данные агента');}for(let i=0;i<25&&running;i++)await sleep(200);}await pending;}finally{agent.close();await release();}}
export async function registerWithRetry(agent,{pause=sleep,attempts=3}={}) {
  for(let n=0;n<attempts;n++){
    try{await agent.register();return;}catch(error){if(n===attempts-1||!retryable(error))throw error;await pause(1000*(n+1));}
  }
}
export async function registrationCLI(attempt,{directory=AGENT_DATA,create=()=>new Agent({directory}),pause=sleep,report=console.error}={}) {
  if(!uuid(attempt))throw Error('Некорректный идентификатор попытки');
  let agent,result;
  try{agent=create();await registerWithRetry(agent,{pause});result={attempt,ok:true};}
  catch(error){result={attempt,ok:false,code:String(error.code??'').slice(0,80),phase:error.phase,status:error.status,retryAfter:error.retryAfter};report(connectionError(result));}
  finally{agent?.close();}
  durable(directory+'/registration-result.json',result);return result.ok;
}
if(direct(import.meta.url)){
  (process.argv[2]==='--register'?registrationCLI(process.argv[3]).then(ok=>{if(!ok)process.exitCode=1;}):runAgent()).catch(()=>{console.error('Агент остановлен: не удалось открыть или сохранить локальное состояние');process.exitCode=1;});
}
