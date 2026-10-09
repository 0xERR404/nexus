import {validateCertificatePair,certificateStatus} from './vpn-cert.mjs';
import fs from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {once} from 'node:events';
import {durable,readState} from '../02-hub/src/agent-protocol.mjs';
import {CORE_VERSION,API_PORT,envelope,serverConfig,hash,integer,id,check} from '../02-hub/src/vpn-protocol.mjs';
import {direct,lock,sleep} from './common.mjs';
export const VPN_DIR='/var/lib/nexus404-vpn';
const execute=promisify(execFile);
export class Xray {
  constructor(directory,binary='/opt/nexus404/vpn/xray'){this.directory=directory;this.binary=binary;this.child=null;}
  async command(args,timeout=10000){return execute(this.binary,args,{timeout,maxBuffer:1024*1024,env:{...process.env,XRAY_LOCATION_ASSET:'/opt/nexus404/vpn'}});}
  async validate(config){
    for(const inbound of config.inbounds){const tls=inbound.streamSettings?.tlsSettings;if(!tls)continue;const c=tls.certificates[0];try{validateCertificatePair(fs.readFileSync(c.certificateFile),fs.readFileSync(c.keyFile),{name:tls.serverName});}catch{throw Object.assign(Error('TLS: нужен действующий сертификат ноды на '+tls.serverName+'. Настрой TLS через меню VPN-ноды.'),{vpnTLS:true});}}
    durable(this.directory+'/candidate.json',config);const version=await this.command(['version']);check(new RegExp('Xray '+CORE_VERSION.replaceAll('.','\\.')+'(?:\\s|$)').test(version.stdout),'Установлена другая версия Xray');await this.command(['run','-test','-config',this.directory+'/candidate.json']);}
  async start(config){await this.stop();durable(this.directory+'/running.json',config);this.child=spawn(this.binary,['run','-config',this.directory+'/running.json'],{stdio:'ignore',env:{...process.env,XRAY_LOCATION_ASSET:'/opt/nexus404/vpn'}});this.child.on('error',()=>{});const deadline=Date.now()+10000;while(Date.now()<deadline){await sleep(100);if(!this.alive())throw Error('Ядро не запустилось');const remaining=deadline-Date.now();if(remaining<=0)break;try{await this.stats(Math.min(1000,remaining));return;}catch{}}await this.stop();throw Error('API ядра не отвечает');}
  alive(){return !!this.child&&this.child.exitCode===null&&this.child.signalCode===null;}
  async stop(){const c=this.child;if(!c)return;this.child=null;if(c.exitCode===null&&c.signalCode===null){const closed=once(c,'close').catch(()=>{});c.kill('SIGTERM');const timer=setTimeout(()=>c.kill('SIGKILL'),3000);try{await closed;}finally{clearTimeout(timer);}}}
  async stats(budget=10000){
    const deadline=Date.now()+budget;let result;
    // Counters are cumulative: retry a failed read without resetting them.
    // Invalid data still fails closed; both reads share one time budget.
    for(let attempt=0;attempt<2;attempt++){
      check(this.alive(),'Ядро остановлено');
      const remaining=deadline-Date.now();check(remaining>0,'API ядра не отвечает');
      try{result=await this.command(['api','statsquery','--server=127.0.0.1:'+API_PORT,'-pattern','user>>>'],Math.max(1,Math.floor(remaining/(2-attempt))));break;}
      catch(error){if(attempt===1||!this.alive()||deadline-Date.now()<=100)throw error;await sleep(100);}
    }
    const value=JSON.parse(result.stdout);check(Array.isArray(value.stat??[]));const users={};for(const item of value.stat??[]){const m=/^user>>>([a-f0-9-]{36})>>>traffic>>>(uplink|downlink)$/.exec(item.name);if(!m)continue;const n=Number(item.value);check(integer(n),'Неверный счётчик ядра');users[m[1]]??={up:0,down:0};users[m[1]][m[2]==='uplink'?'up':'down']=n;}return users;
  }
}
export class VPNNode {
  constructor({directory=VPN_DIR,node,core,now=Date.now}={}){
    Object.assign(this,{directory,node,core:core??new Xray(directory+'/private'),now});fs.mkdirSync(directory+'/private',{recursive:true,mode:0o700});
    this.db=new DatabaseSync(directory+'/private/ledger.sqlite');fs.chmodSync(directory+'/private/ledger.sqlite',0o600);this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS usage(user TEXT PRIMARY KEY,up INTEGER DEFAULT 0,down INTEGER DEFAULT 0);`);
    if(!this.get('ledger'))this.set('ledger',randomUUID());if(this.get('running'))this.set('complete',false);this.set('running',false);this.last={};this.configHash='';this.reportState='stopped';this.error='';this.bundle=this.get('bundle');
  }
  get(k){const r=this.db.prepare('SELECT value FROM state WHERE key=?').get(k);return r?JSON.parse(r.value):null;}
  set(k,v){this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(k,JSON.stringify(v));}
  totals(){return this.db.prepare('SELECT * FROM usage ORDER BY user').all();}
  async collect(){if(!this.core.alive())return;const counters=await this.core.stats();this.db.exec('BEGIN IMMEDIATE');try{for(const [user,r]of Object.entries(counters)){if(!id(user))continue;const prev=this.last[user]??{up:0,down:0};check(integer(r.up)&&integer(r.down)&&r.up>=prev.up&&r.down>=prev.down,'Счётчики ядра сброшены');this.db.prepare('INSERT INTO usage VALUES(?,?,?) ON CONFLICT(user) DO UPDATE SET up=up+excluded.up,down=down+excluded.down').run(user,r.up-prev.up,r.down-prev.down);}this.set('sampled',this.now());this.db.exec('COMMIT');this.last=counters;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  active(bundle){const totals=new Map(this.totals().map(u=>[u.user,u.up+u.down]));return bundle.users.filter(u=>(!u.expires||u.expires>this.now())&&(!u.ceiling||(totals.get(u.id)??0)<u.ceiling));}
  async stop(){
    let failed=false;
    if(this.core.alive()){
      try{await this.collect();}catch{failed=true;}
      // Closing sockets must not depend on a writable database.
      await this.core.stop();
      if(Object.values(this.last).some(r=>r.up||r.down))failed=true;
    }
    this.configHash='';this.last={};
    if(failed)this.set('complete',false);
    this.set('running',false);
  }
  async apply(bundle){
    const active=this.active(bundle),config=serverConfig(bundle,active,this.directory+'/certs');let renewal='';try{renewal=fs.readFileSync(this.directory+'/certs/renewed','utf8');}catch{}const digest=hash([config,renewal]);
    if(this.configHash===digest&&this.core.alive()){this.set('working',bundle);return;}
    const rejectionKey=hash([digest,bundle.revision]);if(this.rejectionKey===rejectionKey&&this.now()<this.retryAt){this.set('rollback',this.core.alive());this.phase=this.rejectionPhase;throw Object.assign(Error(this.rejectionMessage||'Эта версия уже отклонена'),{vpnTLS:!!this.rejectionMessage});}
    const previous=this.get('working');
    try{this.phase='validate';await this.core.validate(config);check(bundle.expires>this.now(),'Разрешение истекло во время проверки');await this.stop();this.set('running',true);this.phase='start';await this.core.start(config);check(bundle.expires>this.now(),'Разрешение истекло во время запуска');this.configHash=digest;this.last={};this.set('working',bundle);this.set('running',true);this.rejectionKey='';this.retryAt=0;}
    catch(error){this.retryFailures=this.rejectionKey===rejectionKey?(this.retryFailures??0)+1:1;this.rejectionKey=rejectionKey;this.retryAt=this.now()+Math.min(300000,30000*2**Math.min(this.retryFailures-1,4));this.rejectionPhase=this.phase;this.rejectionMessage=error.vpnTLS?error.message:null;
      if(previous&&bundle.expires>this.now()){
        // Roll back transport settings, never resurrect withdrawn user credentials.
        const allowed=new Map(active.map(u=>[u.id,u]));
        const safe={...previous,created:bundle.created,expires:bundle.expires,users:previous.users.filter(u=>allowed.has(u.id)&&u.uuid===allowed.get(u.id).uuid&&u.password===allowed.get(u.id).password).map(u=>({...allowed.get(u.id),connections:u.connections.filter(c=>allowed.get(u.id).connections.includes(c))}))};
        const rollback=serverConfig(safe,this.active(safe),this.directory+'/certs'),rollbackHash=hash([rollback,renewal]);
        if(!this.core.alive()||this.configHash!==rollbackHash){await this.stop();await this.core.validate(rollback);this.set('running',true);await this.core.start(rollback);this.last={};}
        check(bundle.expires>this.now(),'Разрешение истекло');this.configHash=rollbackHash;this.set('working',safe);this.set('rollback',true);
      }
      if(!this.get('rollback'))await this.stop();
      throw error;
    }
  }
  async tick(input){
    try{
      if(this.get('running')&&!this.core.alive()){this.set('complete',false);this.set('running',false);this.configHash='';this.last={};}
      try{this.phase='stats';await this.collect();}catch{await this.core.stop();this.configHash='';this.last={};this.set('complete',false);this.set('running',false);throw Error('Учёт недоступен');}
      this.set('rollback',false);
      if(input&&hash(input)!==this.get('acceptedInputHash')){
        this.phase='request';
        const b=envelope(input,this.node,this.now()),old=this.bundle;
        check(!old||b.revision>=old.revision&&b.created>=old.created,'Устаревшая версия VPN');
        if(!old||b.created>old.created){this.bundle=b;this.set('bundle',b);}
        this.set('acceptedInputHash',hash(input));
      }
      if(!this.bundle||this.bundle.expires<=this.now()){
        await this.stop();this.reportState=this.bundle?'expired':'stopped';this.error='';
      }else{
        await this.apply(this.bundle);this.reportState='applied';this.error='';this.set('applied',this.bundle.revision);
        // Purge counters only after credentials have been removed from the running core.
        for(const user of this.bundle.retiredUsers??[]){this.db.prepare('DELETE FROM usage WHERE user=?').run(user);delete this.last[user];}
      }
    }catch(error){
      this.reportState='rejected';this.error=error.vpnTLS?error.message:this.phase==='request'?'Задание VPN: '+String(error.message).slice(0,160):{validate:'Проверка конфигурации, версии ядра или TLS не пройдена.',start:'Ядро не запустилось или его локальный API недоступен.',stats:'Учёт трафика недоступен. Передача остановлена.'}[this.phase]??'Неверное или просроченное задание VPN.';
      // A malformed new request must not keep previously granted credentials alive.
      if(!this.bundle||this.bundle.expires<=this.now()||this.bundle.revision!==this.get('applied')&&!this.get('rollback'))await this.stop();
    }
    return this.publish();
  }
  publish(){const seq=(this.get('seq')??0)+1;this.set('seq',seq);const report={ledger:this.get('ledger'),seq,core:CORE_VERSION,time:this.get('sampled')??this.now(),complete:this.get('complete')!==false,revision:this.get('applied')??0,state:this.reportState,error:this.error,running:this.core.alive(),tls:certificateStatus(this.directory,this.now()),usage:this.totals()};durable(this.directory+'/status/report.json',report,0o640);return report;}
  async close(){try{await this.stop();this.publish();}finally{await this.core.stop();this.db.close();}}
}
export async function runVPN(){
  const settings=readState(VPN_DIR+'/settings.json',null);check(id(settings?.node),'Нода не зарегистрирована');
  const release=await lock(VPN_DIR+'/private/run.lock',true),worker=new VPNNode({node:settings.node});let running=true;
  for(const sig of ['SIGTERM','SIGINT'])process.once(sig,()=>{running=false;});
  try{while(running){let request;try{const file=VPN_DIR+'/requests/config.json';if(fs.statSync(file).size<=131072)request=readState(file,null);}catch{}await worker.tick(request);await sleep(1000);}}finally{await worker.close();await release();}
}
if(direct(import.meta.url))runVPN().catch(()=>{console.error('VPN-нода остановлена');process.exitCode=1;});
