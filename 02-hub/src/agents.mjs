import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID} from 'node:crypto';
import {fail,digest,uuid,publicKey,verifyRequest,agentConfig,snapshot,agentEvent} from './agent-protocol.mjs';
export class Agents {
  constructor(directory,now=Date.now) {
    this.now=now;if(directory)fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const file=directory?path.join(directory,'agents.sqlite'):':memory:';
    this.db=new DatabaseSync(file);if(directory)fs.chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, name TEXT, expires INTEGER, server TEXT, pubkey TEXT);
      CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, name TEXT, pubkey TEXT, revoked INTEGER DEFAULT 0, created INTEGER, seen INTEGER DEFAULT 0, linked INTEGER DEFAULT 0, sequence INTEGER DEFAULT 0, sample TEXT, desired TEXT, applied TEXT, revision INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS nonces (server TEXT, nonce TEXT, time INTEGER, PRIMARY KEY(server,nonce));
      CREATE TABLE IF NOT EXISTS events (server TEXT, id TEXT, time INTEGER, event TEXT, PRIMARY KEY(server,id));
      CREATE INDEX IF NOT EXISTS events_time ON events(server,time);
      CREATE TABLE IF NOT EXISTS history (server TEXT, minute INTEGER, sample TEXT, PRIMARY KEY(server,minute));`);
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  issue(name) {
    if(typeof name!=='string'||!name.trim()||name.length>60||/[\x00-\x1f]/.test(name))fail('Укажи имя сервера до 60 символов');
    if(this.db.prepare('SELECT count(*) n FROM servers').get().n>=128)fail('Достигнут предел 128 серверов',409);
    this.db.prepare('DELETE FROM codes WHERE server IS NULL AND expires < ?').run(this.now());
    if(this.db.prepare('SELECT count(*) n FROM codes WHERE server IS NULL').get().n>=32)fail('Слишком много неистёкших кодов',429);
    const code=randomBytes(24).toString('base64url'),expires=this.now()+15*60000;
    this.db.prepare('INSERT INTO codes(hash,name,expires) VALUES(?,?,?)').run(digest(code),name.trim(),expires);
    return {code,expires};
  }
  register(raw,headers) {
    const data=JSON.parse(raw);if(typeof data.code!=='string'||data.code.length>100)fail('Недействительный код',401);
    publicKey(data.publicKey);verifyRequest(data.publicKey,'/api/agents/register',raw,headers,this.now());
    return this.tx(()=>{
      const code=this.db.prepare('SELECT * FROM codes WHERE hash=?').get(digest(data.code));
      if(!code)fail('Код истёк или недействителен',401);
      if(code.server){const server=this.get(code.server);if(code.pubkey!==data.publicKey||server.revoked)fail('Код уже использован',401);return {id:code.server};}
      if(this.db.prepare('SELECT count(*) n FROM servers').get().n>=128)fail('Достигнут предел серверов',409);
      if(code.expires<this.now())fail('Код истёк или недействителен',401);
      const id=randomUUID();
      this.db.prepare('INSERT INTO servers(id,name,pubkey,created) VALUES(?,?,?,?)').run(id,code.name,data.publicKey,this.now());
      this.db.prepare('UPDATE codes SET server=?,pubkey=? WHERE hash=?').run(id,data.publicKey,digest(data.code));
      return {id};
    });
  }
  get(id){if(!uuid(id))fail('Сервер не найден',404);const s=this.db.prepare('SELECT * FROM servers WHERE id=?').get(id);if(!s)fail('Сервер не найден',404);return s;}
  authenticate(id,raw,headers) {const s=this.get(id);if(s.revoked)fail('Доступ отозван',401);return verifyRequest(s.pubkey,'/api/agents/exchange',raw,headers,this.now());}
  exchange(raw,headers) {
    const data=JSON.parse(raw),nonce=this.authenticate(data.id,raw,headers);
    const metrics=snapshot(data.metrics,this.now());
    if(!Array.isArray(data.events)||data.events.length>100)fail('Неверный пакет событий');
    const events=data.events.map(agentEvent);
    const applied=data.applied;
    if(applied){if(!Number.isSafeInteger(applied.version)||applied.version<0||(!uuid(applied.requestId)&&applied.requestId!==null)||!['applied','rejected'].includes(applied.result))fail('Неверное подтверждение');agentConfig(applied.config);}
    return this.tx(()=>{
      const s=this.get(data.id);if(s.revoked)fail('Доступ отозван',401);
      this.db.prepare('DELETE FROM nonces WHERE time < ?').run(this.now()-600000);
      if(this.db.prepare('SELECT 1 FROM nonces WHERE server=? AND nonce=?').get(s.id,nonce))fail('Повтор запроса',409);
      if(this.db.prepare('SELECT count(*) n FROM nonces WHERE server=? AND time>?').get(s.id,this.now()-60000).n>=120)fail('Слишком много запросов',429);
      this.db.prepare('INSERT INTO nonces VALUES(?,?,?)').run(s.id,nonce,this.now());
      let seq=s.sequence;
      for(const e of events){if(e.seq<=seq)continue;if(e.seq!==seq+1)fail('Разрыв последовательности событий',409);this.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(s.id,e.id,e.time,JSON.stringify(e));seq=e.seq;}
      const old=s.sample?JSON.parse(s.sample):null;
      if(!old||metrics.generated_at>old.generated_at){
        this.db.prepare('INSERT OR REPLACE INTO history VALUES(?,?,?)').run(s.id,Math.floor(metrics.generated_at/60000),JSON.stringify({time:metrics.generated_at,cpu:metrics.cpu?.percent??null,memory:metrics.memory?.percent??null,disk:(metrics.disks.find(d=>d.mount==='/')??metrics.disks[0])?.percent??null,uptime:metrics.uptime_seconds}));
        this.db.prepare('UPDATE servers SET sample=? WHERE id=?').run(JSON.stringify(metrics),s.id);
      }
      if(!s.linked)this.linkEvent(s.id,s.seen?'Связь восстановлена':'Агент подключён','info');
      let acknowledgement=s.applied;
      const desired=s.desired?JSON.parse(s.desired):null;
      if(applied && ((!desired&&applied.version===0)||(desired&&applied.requestId===desired.id&&((applied.result==='applied'&&applied.version===desired.version&&JSON.stringify(agentConfig(applied.config))===JSON.stringify(desired.config))||(applied.result==='rejected'&&applied.version<desired.version)))))acknowledgement=JSON.stringify({version:applied.version,requestId:applied.requestId,result:applied.result,config:agentConfig(applied.config),error:applied.result==='rejected'?'Агент отклонил расписание. Отправь настройки заново.':null});
      this.db.prepare('UPDATE servers SET seen=?, linked=1, sequence=?, applied=? WHERE id=?').run(this.now(),seq,acknowledgement,s.id);
      this.db.prepare('DELETE FROM history WHERE server=? AND minute<?').run(s.id,Math.floor(this.now()/60000)-10080);
      this.db.prepare('DELETE FROM events WHERE server=? AND id NOT IN (SELECT id FROM events WHERE server=? ORDER BY time DESC LIMIT 5000)').run(s.id,s.id);
      return {ack:seq,desired};
    });
  }
  linkEvent(id,title,level){const e={id:randomUUID(),time:this.now(),title,body:'',level,category:'services',key:'agent.connection'};this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(id,e.id,e.time,JSON.stringify(e));}
  sweep(){for(const s of this.db.prepare('SELECT id FROM servers WHERE linked=1 AND revoked=0 AND seen<?').all(this.now()-90000)){this.tx(()=>{this.db.prepare('UPDATE servers SET linked=0 WHERE id=?').run(s.id);this.linkEvent(s.id,'Связь с агентом потеряна','warning');});}}
  list(){this.sweep();return this.db.prepare('SELECT * FROM servers ORDER BY created').all().map(s=>({id:s.id,name:s.name,revoked:!!s.revoked,seen:s.seen,state:s.revoked?'revoked':!s.seen?'waiting':s.linked?'online':'offline',revision:s.revision,desired:s.desired?JSON.parse(s.desired):null,applied:s.applied?JSON.parse(s.applied):null}));}
  configure(id,value){return this.tx(()=>{const s=this.get(id);if(s.revoked)fail('Доступ отозван',409);if(value.version!==s.revision)fail('Настройки уже изменились. Обнови страницу',409);const desired={id:randomUUID(),version:s.revision+1,created:this.now(),expires:this.now()+15*60000,config:agentConfig(value.config)};this.db.prepare('UPDATE servers SET desired=?,revision=? WHERE id=?').run(JSON.stringify(desired),desired.version,id);return desired;});}
  revoke(id){this.tx(()=>{this.get(id);this.db.prepare('UPDATE servers SET revoked=1,linked=0 WHERE id=?').run(id);this.db.prepare('DELETE FROM codes WHERE server=?').run(id);this.linkEvent(id,'Доступ агента отозван','warning');});return {ok:true};}
  metrics(id){const s=this.get(id);if(!s.sample)fail('Первый замер ещё не получен',503);const data=JSON.parse(s.sample);return {...data,stale:!!s.revoked||this.now()-s.seen>90000||this.now()-data.generated_at>90000};}
  events(id){this.sweep();if(id)this.get(id);const rows=id?this.db.prepare('SELECT e.*,s.name FROM events e JOIN servers s ON s.id=e.server WHERE server=? ORDER BY time DESC LIMIT 1000').all(id):this.db.prepare('SELECT e.*,s.name FROM events e JOIN servers s ON s.id=e.server ORDER BY time DESC LIMIT 1000').all();return rows.map(r=>({...JSON.parse(r.event),serverId:r.server,serverName:r.name,title:r.name+' · '+JSON.parse(r.event).title}));}
  history(id,hours){this.get(id);const range=[1,6,24,168].includes(+hours)?+hours:24,to=this.now(),from=to-range*3600000,interval=Math.max(60000,Math.ceil(range*3600000/360));const input=this.db.prepare('SELECT sample FROM history WHERE server=? AND minute>=? ORDER BY minute').all(id,Math.ceil(from/60000)).map(r=>JSON.parse(r.sample));const buckets=new Map();for(const r of input){const bucket=Math.floor((r.time-from)/interval);if(!buckets.has(bucket))buckets.set(bucket,[]);buckets.get(bucket).push(r);}const points=[...buckets].map(([bucket,rows])=>{const avg=fn=>{const a=rows.map(fn).filter(Number.isFinite);return a.length?a.reduce((x,y)=>x+y,0)/a.length:null;};return {bucket,time:rows.at(-1).time,cpu:avg(r=>r.cpu),memory:avg(r=>r.memory),disk:avg(r=>r.disk),uptime:rows.at(-1).uptime};});return {available:!!input.length,from,to,hours:range,interval,points,samples:input.length,first:input[0]?.time??null,last:input.at(-1)?.time??null,stale:!input.length||to-input.at(-1).time>90000};}
  close(){this.db.close();}
}
