import fs from 'node:fs';
import {countryCode} from './countries.mjs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes,randomUUID,generateKeyPairSync} from 'node:crypto';
import {check,id,integer,text,connection,routing,serverSettings,CORE_VERSION,LEASE_MS,hash,serverConfig} from '../../src/vpn-protocol.mjs';
const secret=()=>randomBytes(32).toString('base64url');
const CHUNK=16*1024*1024;
export function applicationState(node){
  const s=node.status;
  if(node.agent?.revoked)return 'revoked';
  if(node.stale)return 'offline';
  if(s?.state==='rejected')return 'rejected';
  if(s?.state==='expired')return 'expired';
  if(s?.revision!==node.revision)return 'pending';
  return s?.state==='applied'&&s.running?'applied':'stopped';
}
export class VPN {
  constructor(directory,now=Date.now){
    this.now=now;if(directory)fs.mkdirSync(directory,{recursive:true,mode:0o700});
    const file=directory?path.join(directory,'vpn.sqlite'):':memory:';this.db=new DatabaseSync(file);if(directory)fs.chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS objects(kind TEXT,id TEXT,value TEXT,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS nodes(id TEXT PRIMARY KEY,revision INTEGER DEFAULT 1,settings TEXT DEFAULT '{}',status TEXT,ledger TEXT,seq INTEGER DEFAULT 0,seen INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS usage(node TEXT,user TEXT,up INTEGER DEFAULT 0,down INTEGER DEFAULT 0,ceiling INTEGER DEFAULT 0,PRIMARY KEY(node,user));
    CREATE TABLE IF NOT EXISTS history(node TEXT,user TEXT,hour INTEGER,up INTEGER,down INTEGER,PRIMARY KEY(node,user,hour));
    CREATE TABLE IF NOT EXISTS retired_users(node TEXT,user TEXT,PRIMARY KEY(node,user));
    CREATE TABLE IF NOT EXISTS deployments(node TEXT,revision INTEGER,value TEXT,PRIMARY KEY(node,revision));
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER);
    INSERT OR IGNORE INTO meta VALUES('revision',0);`);
  }
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  all(kind){return this.db.prepare('SELECT value FROM objects WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(r.value));}
  get(kind,key){const row=this.db.prepare('SELECT value FROM objects WHERE kind=? AND id=?').get(kind,key);check(row,'Запись не найдена');return JSON.parse(row.value);}
  put(kind,v){this.db.prepare('INSERT OR REPLACE INTO objects VALUES(?,?,?)').run(kind,v.id,JSON.stringify(v));return v;}
  revision(){return this.db.prepare("SELECT value FROM meta WHERE key='revision'").get().value;}
  change(version,fn){return this.tx(()=>{check(version===this.revision(),'Данные изменились: обнови страницу');const r=fn();this.db.exec("UPDATE meta SET value=value+1 WHERE key='revision';UPDATE nodes SET revision=revision+1");return r;});}
  nodeCountry(node,code,version){return this.tx(()=>{
    check(version===this.revision(),'Данные изменились: обнови страницу');
    check(this.db.prepare('SELECT 1 FROM nodes WHERE id=?').get(node),'Сначала включи VPN на агенте');
    const country=countryCode(code);this.put('location',{id:node,country});
    // Display metadata is immediate and must not create a VPN deployment.
    this.db.exec("UPDATE meta SET value=value+1 WHERE key='revision'");return {ok:true,country};
  });}
  node(agent,settings,version,country){return this.change(version,()=>{check(id(agent));this.db.prepare('INSERT INTO nodes(id,settings) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET settings=excluded.settings').run(agent,JSON.stringify(serverSettings(settings)));if(country!==undefined)this.put('location',{id:agent,country:countryCode(country)});return {ok:true};});}
  saveConnection(value,version){return this.change(version,()=>{
    const old=value.id?this.get('connection',value.id):null;
    const saved=old?this.all('connection-state').find(x=>x.id===old.id):null;
    const keys=old?.privateKey?old:saved?.privateKey?saved:(()=>{const k=generateKeyPairSync('x25519');return {privateKey:k.privateKey.export({format:'jwk'}).d,publicKey:k.publicKey.export({format:'jwk'}).x,shortId:randomBytes(8).toString('hex')};})();
    const reality=value.profile?.startsWith('vless'),wasReality=old?.profile.startsWith('vless');
    const memory={...saved,...(old?{[wasReality?'realitySni':'tlsSni']:old.sni}:{} )};
    const node=this.db.prepare('SELECT * FROM nodes WHERE id=?').get(value.node);
    const tls=node?.status?JSON.parse(node.status).tls:null;
    let sni=value.sni;
    if(old&&reality!==wasReality&&(!sni||sni===old.sni))sni=memory[reality?'realitySni':'tlsSni']||(reality?value.target||saved?.target:tls?.names?.find(x=>x===value.address)||tls?.names?.[0])||value.address;
    const c=connection({...old,...keys,...memory,...value,id:old?.id??randomUUID(),sni,target:value.target||saved?.target});
    if(c.enabled&&!reality&&tls){check(tls.ready&&tls.expires>this.now(),'На ноде нет действующего TLS. Запусти настройку TLS на VPN-ноде.');check(tls.names.includes(c.sni),'SNI должен совпадать с сертификатом ноды: '+tls.names.join(', '));}
    c[reality?'realitySni':'tlsSni']=c.sni;
    this.put('connection-state',{...memory,id:c.id,privateKey:c.privateKey??keys.privateKey,publicKey:c.publicKey??keys.publicKey,shortId:c.shortId??keys.shortId,[reality?'realitySni':'tlsSni']:c.sni,target:c.target||old?.target||saved?.target});
    // Seed an upgraded installation only when the previous settings were acknowledged.
    if(old&&node?.status){const status=JSON.parse(node.status);if(status.state==='applied'&&status.revision===node.revision&&!this.all('deployed').some(x=>x.id===old.node))this.put('deployed',{id:old.node,revision:node.revision,connections:this.all('connection').filter(x=>x.node===old.node)});}
    check(this.db.prepare('SELECT 1 FROM nodes WHERE id=?').get(c.node),'Сначала включи VPN на агенте');
    const rest=this.all('connection').filter(x=>x.id!==c.id&&x.node===c.node);check(rest.length<32&&!rest.some(x=>x.enabled&&c.enabled&&x.port===c.port&&(x.profile==='hysteria2')===(c.profile==='hysteria2')),'Порт уже занят другим подключением');return this.put('connection',c);
  });}
  saveUser(value,version){return this.change(version,()=>{
    const old=value.id?this.get('user',value.id):null;check(old||this.all('user').length<50,'Достигнут предел пользователей');
    const u={id:old?.id??randomUUID(),name:text(value.name),enabled:value.enabled!==false,expires:Number(value.expires??0),limit:Number(value.limit??0),connections:[...new Set(value.connections??[])],routing:value.routing||null,uuid:old?.uuid??randomUUID(),password:old?.password??secret(),token:old?.token??secret()};
    check(integer(u.expires)&&integer(u.limit)&&u.connections.length<=128);for(const c of u.connections)this.get('connection',c);if(u.routing)this.get('routing',u.routing);
    if(u.limit&&(!old?.limit||u.limit<old.limit)){
      const rows=this.db.prepare('SELECT * FROM usage WHERE user=? ORDER BY node').all(u.id),remaining=Math.max(0,u.limit-this.total(u.id).total);
      const share=rows.length?Math.floor(remaining/rows.length):0;for(const row of rows)this.db.prepare('UPDATE usage SET ceiling=? WHERE node=? AND user=?').run(row.up+row.down+share,row.node,u.id);
    }
    return this.put('user',u);
  });}
  deleteUser(key,version){return this.change(version,()=>{
    check(id(key));this.get('user',key);
    // Keep only node/user IDs to recognize delayed reports, never credentials or personal data.
    this.db.prepare('INSERT OR IGNORE INTO retired_users SELECT node,user FROM usage WHERE user=?').run(key);
    this.db.prepare('DELETE FROM history WHERE user=?').run(key);
    this.db.prepare('DELETE FROM usage WHERE user=?').run(key);
    this.db.prepare("DELETE FROM objects WHERE kind='user' AND id=?").run(key);
    return {ok:true};
  });}
  rotate(key,version,{credentials=false}={}){return this.change(version,()=>{const u=this.get('user',key);u.token=secret();if(credentials){u.uuid=randomUUID();u.password=secret();}this.put('user',u);return {ok:true};});}
  saveRouting(value,version){return this.change(version,()=>{const r=routing({...value,id:value.id||randomUUID()});r.sources=r.sources.map(s=>({...s,id:s.id??randomUUID()}));for(const g of r.groups)for(const c of g.connections)this.get('connection',c);for(const rule of r.rules)if(id(rule.target)&&!r.groups.some(g=>g.id===rule.target))this.get('connection',rule.target);return this.put('routing',r);});}
  total(user){const r=this.db.prepare('SELECT COALESCE(sum(up),0) up,COALESCE(sum(down),0) down FROM usage WHERE user=?').get(user);return {...r,total:r.up+r.down};}
  active(u){return u.enabled&&(!u.expires||u.expires>this.now())&&(!u.limit||this.total(u.id).total<u.limit);}
  report(node,v){
    const retired=new Set(this.db.prepare('SELECT user FROM retired_users WHERE node=?').all(node).map(r=>r.user));
    check(v&&v.core===CORE_VERSION&&id(v.ledger)&&integer(v.seq)&&integer(v.time)&&v.time<=this.now()+30000&&Array.isArray(v.usage)&&v.usage.length<=100+retired.size,'Неверный отчёт ноды');
    const n=this.db.prepare('SELECT * FROM nodes WHERE id=?').get(node);if(!n)return;
    check(!n.ledger||n.ledger===v.ledger,'Локальный журнал ноды заменён: требуется восстановление базы');
    if(v.seq<=n.seq&&n.ledger)return;
    check(new Set(v.usage.map(r=>r?.user)).size===v.usage.length);
    const rows=v.usage.flatMap(r=>{check(r&&id(r.user)&&integer(r.up)&&integer(r.down)&&integer(r.up+r.down));if(retired.has(r.user))return [];this.get('user',r.user);const known=this.db.prepare('SELECT * FROM usage WHERE node=? AND user=?').get(node,r.user);check(known,'Статистика чужого пользователя');check(r.up>=known.up&&r.down>=known.down,'Счётчик ноды уменьшился');return [{r,known}];});
    for(const {r,known} of rows){const up=r.up-known.up,down=r.down-known.down;this.db.prepare('UPDATE usage SET up=?,down=? WHERE node=? AND user=?').run(r.up,r.down,node,r.user);if(up||down)this.db.prepare('INSERT INTO history VALUES(?,?,?,?,?) ON CONFLICT(node,user,hour) DO UPDATE SET up=up+excluded.up,down=down+excluded.down').run(node,r.user,Math.floor(v.time/3600000),up,down);}
    const status={core:v.core,time:v.time,complete:v.complete===true,revision:integer(v.revision)?v.revision:0,state:['applied','rejected','expired','stopped'].includes(v.state)?v.state:'stopped',error:typeof v.error==='string'?v.error.slice(0,200):'',running:v.running===true};
    if(v.tls&&Array.isArray(v.tls.names))status.tls={ready:v.tls.ready===true,names:v.tls.names.filter(x=>typeof x==='string'&&x.length<=253&&/^[a-z0-9.:-]+$/i.test(x)).slice(0,32),expires:integer(v.tls.expires)?v.tls.expires:0};
    if(status.state==='applied'&&status.running){
      const sent=this.db.prepare('SELECT value FROM deployments WHERE node=? AND revision=?').get(node,status.revision);
      const deployed=this.all('deployed').find(x=>x.id===node);
      if(sent&&(!deployed||deployed.revision<=status.revision))this.put('deployed',{id:node,revision:status.revision,connections:JSON.parse(sent.value)});
    }
    this.db.prepare('UPDATE nodes SET ledger=?,seq=?,seen=?,status=? WHERE id=?').run(v.ledger,v.seq,this.now(),JSON.stringify(status),node);
    this.db.prepare('DELETE FROM history WHERE hour<?').run(Math.floor(this.now()/3600000)-24*366);
  }
  exchange(node,report){return this.tx(()=>{
    const n=this.db.prepare('SELECT * FROM nodes WHERE id=?').get(node);if(!n)return null;
    if(report)this.report(node,report);
    const connections=this.all('connection').filter(c=>c.node===node&&c.enabled),users=[];
    for(const u of this.all('user')){
      const selected=connections.filter(c=>u.connections.includes(c.id));
      if(!selected.length||!this.active(u))continue;
      this.db.prepare('INSERT OR IGNORE INTO usage(node,user) VALUES(?,?)').run(node,u.id);
      let row=this.db.prepare('SELECT * FROM usage WHERE node=? AND user=?').get(node,u.id);
      let ceiling=0;
      if(u.limit){
        const committed=this.db.prepare('SELECT COALESCE(sum(max(ceiling,up+down)),0) n FROM usage WHERE user=?').get(u.id).n;
        const available=Math.max(0,u.limit-committed),remaining=row.ceiling-row.up-row.down;
        if(remaining<CHUNK/4&&available){const peers=new Set(this.all('connection').filter(c=>c.enabled&&u.connections.includes(c.id)).map(c=>c.node));const waiting=[...peers].filter(peer=>{const r=this.db.prepare('SELECT * FROM usage WHERE node=? AND user=?').get(peer,u.id);return !r||r.ceiling<=r.up+r.down;}).length;const grant=Math.min(CHUNK,Math.max(1,Math.floor(available/Math.max(1,waiting))));this.db.prepare('UPDATE usage SET ceiling=ceiling+? WHERE node=? AND user=?').run(grant,node,u.id);row.ceiling+=grant;}
        ceiling=row.ceiling;if(ceiling<=row.up+row.down)continue;
      }
      users.push({id:u.id,uuid:u.uuid,password:u.password,expires:u.expires,ceiling,connections:selected.map(c=>c.id)});
    }
    this.db.prepare('INSERT OR REPLACE INTO deployments VALUES(?,?,?)').run(node,n.revision,JSON.stringify(connections));
    this.db.prepare('DELETE FROM deployments WHERE node=? AND revision<?').run(node,n.revision-32);
    const created=this.now();
    const reported=report?new Set(report.usage.map(r=>r.user)):null;
    const retiredUsers=this.db.prepare('SELECT user FROM retired_users WHERE node=?').all(node).map(r=>r.user).filter(key=>!reported||reported.has(key)).slice(0,100);
    return {node,id:randomUUID(),revision:n.revision,core:CORE_VERSION,created,expires:created+LEASE_MS,connections,users,retiredUsers,settings:JSON.parse(n.settings)};
  });}
  snapshot(agents=[]){
    const locations=new Map(this.all('location').map(x=>[x.id,x.country]));
    const nodes=this.db.prepare('SELECT * FROM nodes').all().map(n=>({id:n.id,country:locations.get(n.id)||'',revision:n.revision,settings:JSON.parse(n.settings),status:n.status?JSON.parse(n.status):null,seen:n.seen,stale:!n.seen||this.now()-n.seen>15000||this.now()-(n.status?JSON.parse(n.status).time:0)>15000,...{agent:agents.find(a=>a.id===n.id)??null}}));
    return {version:this.revision(),core:CORE_VERSION,nodes:nodes.map(n=>({...n,applicationState:applicationState(n)})),agents:agents.map(a=>({id:a.id,name:a.name,state:a.state,revoked:a.revoked})),connections:this.all('connection'),users:this.all('user').map(u=>{const {token,password,uuid,...safe}=u;return {...safe,...this.total(u.id),active:this.active(u),nodes:this.db.prepare('SELECT * FROM usage WHERE user=?').all(u.id)};}),routing:this.all('routing'),sources:this.db.prepare('SELECT value FROM sources').all().map(r=>JSON.parse(r.value))};
  }
  preview(node){
    const n=this.db.prepare('SELECT * FROM nodes WHERE id=?').get(node);check(n,'Нода не найдена');
    const connections=this.all('connection').filter(c=>c.node===node&&c.enabled),users=this.all('user').filter(u=>this.active(u)).map(u=>({...u,ceiling:0,connections:u.connections.filter(id=>connections.some(c=>c.id===id))}));
    return {node,connections,users,settings:JSON.parse(n.settings)};
  }
  saveConfig(node,config,version){return this.change(version,()=>{
    const bundle=this.preview(node),before=serverConfig(bundle);check(config&&Array.isArray(config.inbounds)&&Array.isArray(config.routing?.rules),'Неверная конфигурация');
    check(config.inbounds.length===before.inbounds.length,'Подключения создаются отдельной формой');
    for(const inbound of config.inbounds){
      if(inbound.tag==='api-in')continue;
      const c=bundle.connections.find(c=>c.id===inbound.tag);check(c,'Неизвестное подключение');
      c.port=inbound.port;const stream=inbound.streamSettings;check(stream,'Нет транспорта');
      if(c.profile.startsWith('vless')){const r=stream.realitySettings;check(r?.serverNames?.length===1&&typeof r.target==='string'&&r.target.endsWith(':443'),'Reality: нужен один SNI и цель на порту 443');c.sni=r.serverNames[0];c.target=r.target.slice(0,-4);}
      else c.sni=stream.tlsSettings?.serverName;
      if(c.profile==='vless-xhttp')c.path=stream.xhttpSettings?.path;
      if(c.profile==='vless-grpc')c.serviceName=stream.grpcSettings?.serviceName;
      Object.assign(c,connection(c));
    }
    const settings=serverSettings({dns:config.dns?.servers,rules:config.routing.rules.slice(2).map(r=>{check(['direct','block'].includes(r.outboundTag));if(r.ip?.length===1)return {type:'ip',value:r.ip[0],action:r.outboundTag};check(r.domain?.length===1&&/^(?:full|domain):/.test(r.domain[0]));return {type:r.domain[0].startsWith('full:')?'domain':'suffix',value:r.domain[0].slice(r.domain[0].indexOf(':')+1),action:r.outboundTag};})});
    const generated=serverConfig({...bundle,settings});check(isDeepStrictEqual(config,generated),'Учётные данные, API, журналы, пути TLS и служебные правила управляются системой. Изменяй транспорт, SNI, порт, DNS и правила direct/block.');
    const ports=bundle.connections.map(c=>(c.profile==='hysteria2'?'udp':'tcp')+c.port);check(new Set(ports).size===ports.length,'Пересечение портов');
    for(const c of bundle.connections)this.put('connection',c);this.db.prepare('UPDATE nodes SET settings=? WHERE id=?').run(JSON.stringify(settings),node);return {ok:true};
  });}
  history(user){this.get('user',user);return this.db.prepare('SELECT * FROM history WHERE user=? ORDER BY hour DESC LIMIT 2000').all(user);}
  subscriptionConnections(u){
    const locations=new Map(this.all('location').map(x=>[x.id,x.country]));
    const deployed=new Map(this.all('deployed').map(d=>[d.id,d.connections]));
    return this.all('connection').filter(c=>c.enabled&&u.connections.includes(c.id)).flatMap(c=>{
      if(!deployed.has(c.node))return []; // Wait for the first acknowledged exchange, including after an upgrade.
      const running=deployed.get(c.node).find(x=>x.id===c.id&&x.enabled);
      return running?[{...running,name:c.name,country:locations.get(c.node)||''}]:[];
    });
  }
  subscription(token){check(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token),'Подписка недоступна');const digest=hash(token);const u=this.all('user').find(u=>hash(u.token)===digest);check(u&&this.active(u),'Подписка недоступна');return u;}
  source(value){this.db.prepare('INSERT OR REPLACE INTO sources VALUES(?,?)').run(value.id,JSON.stringify(value));}
  sourceData(id){const r=this.db.prepare('SELECT value FROM sources WHERE id=?').get(id);return r?JSON.parse(r.value):null;}
  close(){this.db.close();}
}
