import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {HUB,HOST,NODE,atomic,json,exec,query,lock,direct,hubPath} from './common.mjs';
import {composeArgs} from './platform.mjs';
import {readUpdateRequest} from './hub-update.mjs';
import {savedModules} from './hub-lifecycle.mjs';
import {backupID,backupModes,backupPath,backupKind,selectedBackup} from '../02-hub/src/data-backup.mjs';
export const DATA_BACKUP_CONTROL='/var/lib/nexus404-data-backup';
export function initializeDataBackups({control=DATA_BACKUP_CONTROL,write=atomic,ownership=true}={}){
 for(const [name,mode,uid,gid]of [['',0o755,0,0],['requests',0o700,1000,1000],['status',0o755,0,0],['files',0o750,0,1000],['private',0o700,0,0],['private/docker',0o700,0,0]]){
  const dir=path.join(control,name);fs.mkdirSync(dir,{recursive:true,mode});fs.chmodSync(dir,mode);if(ownership)fs.chownSync(dir,uid,gid);
 }
 write('/etc/systemd/system/nexus404-data-backup.service',`[Unit]\nDescription=NEXUS404 user data snapshots\nAfter=docker.service\n[Service]\nType=oneshot\nEnvironment=${JSON.stringify('DOCKER_CONFIG='+path.join(control,'private/docker'))}\nExecStart=${NODE} ${HOST}/data-backup.mjs\nTimeoutStartSec=infinity\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\n`,0o644);
 write('/etc/systemd/system/nexus404-data-backup.timer','[Unit]\nDescription=NEXUS404 prepare and expire user backups\n[Timer]\nOnBootSec=30s\nOnUnitInactiveSec=15s\nAccuracySec=2s\n[Install]\nWantedBy=timers.target\n',0o644);
}
function own(file,dir,ownership){if(ownership){fs.chownSync(file,0,1000);fs.chmodSync(file,dir?0o750:0o640);}}
export function prepareDataSnapshot({hub=HUB,control=DATA_BACKUP_CONTROL,id,mode,ownership=true,now=Date.now(),version='unknown'}={}){
 if(!backupID.test(id)||!backupModes.includes(mode))throw Error('Неверный запрос копии');
 const job=backupPath(path.join(control,'files'),id);fs.mkdirSync(job);own(job,true,ownership);
 const excluded=new Set(),catalog=path.join(hubPath(hub,'data'),'projects/projects.sqlite');
 if(fs.existsSync(catalog)){
  const db=new DatabaseSync(catalog,{readOnly:true});try{for(const row of db.prepare("SELECT releases.id FROM releases JOIN projects ON projects.id=releases.project WHERE upper(trim(projects.name))='NEXUS404'").all())excluded.add(row.id);}finally{db.close();}
 }
 const sources=[];
 function walk(dir,prefix){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
   const name=prefix+'/'+entry.name;
   if(entry.name.startsWith('.')||['tmp','cache','node_modules','modules'].includes(entry.name))continue;
   const source=path.join(dir,entry.name),stat=fs.lstatSync(source);
   if(stat.isSymbolicLink()||!stat.isFile()&&!stat.isDirectory())throw Error('Ссылки и специальные файлы в данных не поддерживаются');
   if(stat.isDirectory())walk(source,name);
   else if(selectedBackup(mode,name)&&!(name.startsWith('data/projects/releases/')&&excluded.has(entry.name)))sources.push({source,name,stat,media:backupKind(name)==='media'});
  }
 }
 if(mode!=='media')walk(hubPath(hub,'config'),'config');walk(hubPath(hub,'data'),'data');
 const required=sources.filter(f=>!f.media).reduce((n,f)=>n+f.stat.size,0),disk=fs.statfsSync(job);
 if(Number(disk.bavail)*Number(disk.bsize)<required+64*1024*1024)throw Error('Недостаточно места для временной копии настроек и баз');
 const dirs=new Set();
 for(const file of sources){
  const target=backupPath(job,'snapshot/'+file.name),dir=path.dirname(target);fs.mkdirSync(dir,{recursive:true,mode:0o750});
  for(let d=dir;d!==job;d=path.dirname(d))dirs.add(d);
  if(file.media)fs.linkSync(file.source,target); // Immutable payload; no second media copy or server archive.
  else{fs.copyFileSync(file.source,target,fs.constants.COPYFILE_EXCL);own(target,false,ownership);}
 }
 for(const dir of dirs)own(dir,true,ownership);
 if(mode!=='media'){
  const config=path.join(job,'snapshot/config');fs.mkdirSync(config,{recursive:true});own(config,true,ownership);
  atomic(path.join(config,'preserved-modules.json'),JSON.stringify(savedModules(hub)),0o640);own(path.join(config,'preserved-modules.json'),false,ownership);
 }
 const copied=path.join(job,'snapshot/data/projects/projects.sqlite');
 if(fs.existsSync(copied)){
  const db=new DatabaseSync(copied);try{
   db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DELETE FROM deliveries WHERE project IN (SELECT id FROM projects WHERE upper(trim(name))='NEXUS404'); DELETE FROM releases WHERE project IN (SELECT id FROM projects WHERE upper(trim(name))='NEXUS404'); UPDATE projects SET selected=NULL,enabled=0 WHERE upper(trim(name))='NEXUS404'; COMMIT; PRAGMA wal_checkpoint(TRUNCATE);");
  }finally{db.close();}
 }
 const entries=[];
 function inventory(dir,prefix=''){
  own(dir,true,ownership);
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,e.name),name=prefix+e.name;if(e.isDirectory())inventory(file,name+'/');else{if(backupKind(name)!=='media')own(file,false,ownership);const st=fs.statSync(file);entries.push({name,size:st.size,mtimeMs:st.mtimeMs});}}
 }
 const snapshot=path.join(job,'snapshot');if(!fs.existsSync(snapshot)){fs.mkdirSync(snapshot);own(snapshot,true,ownership);}inventory(snapshot);
 const index={id,mode,version,created:now,entries};atomic(path.join(job,'index.json'),JSON.stringify(index),0o640);own(path.join(job,'index.json'),false,ownership);
 return {snapshotId:id,mode,created:now,expires:now+3600000,files:entries.length,bytes:entries.reduce((n,f)=>n+f.size,0)};
}
export async function processDataBackup({hub=HUB,control=DATA_BACKUP_CONTROL,run=exec,inspect=query,acquire=lock,prepare=prepareDataSnapshot,ownership=true,now=Date.now}={}){
 let unlock;try{unlock=await acquire('/run/lock/nexus404-setup.lock',true);}catch(e){if(e.code==='ELOCKED')return;throw e;}
 const file=path.join(control,'private/state.json');let state=json(file,{phase:'idle'}),heartbeat;
 const publish=()=>atomic(path.join(control,'status/status.json'),JSON.stringify({...state,heartbeat:now()}),0o644);
 const save=value=>{state={...state,...value};atomic(file,JSON.stringify(state));publish();};
 const clean=id=>{if(backupID.test(id)){const dir=backupPath(path.join(control,'files'),id);if(fs.existsSync(dir)&&fs.lstatSync(dir).isSymbolicLink())throw Error('Ссылка вместо снимка');fs.rmSync(dir,{recursive:true,force:true});}};
 const compose=(...args)=>composeArgs('nexus404-shell',hub,args);
 const resume=async()=>{if(state.hubStopped)await run('docker',compose('start','hub'));if(state.signalStopped)await run('systemctl',['start','nexus404-signal.service']);};
 try{
  publish();heartbeat=setInterval(publish,10000);
  if(state.phase==='preparing'||state.phase==='recovery-required'){
   try{await resume();clean(state.snapshotId);save({phase:'failed',error:'Подготовка была прервана. Хаб запущен, создай копию повторно',hubStopped:false,signalStopped:false});}catch{save({phase:'recovery-required',error:'Не удалось запустить хаб после подготовки. Проверь службу на сервере'});}return;
  }
  let lease;try{lease=readUpdateRequest(path.join(control,'requests/lease.json'));}catch{}
  const downloading=!!lease&&lease.id===state.snapshotId&&now()-lease.updated<45000&&lease.updated<=now()+60000;
  if(state.phase==='ready'&&state.expires<now()&&!downloading){clean(state.snapshotId);save({phase:'expired',snapshotId:null});}
  const request=readUpdateRequest(path.join(control,'requests/request.json'));
  if(!request||request.id===state.requestId)return;
  if(!backupID.test(request.id)||!Number.isSafeInteger(request.created)||now()-request.created>900000||request.created>now()+60000)throw Error('Неверный запрос резервной копии');
  if(downloading)return;
  if(request.action==='delete'){
   if(Object.keys(request).sort().join()!=='action,created,id,snapshotId'||!backupID.test(request.snapshotId)||(request.snapshotId!==state.snapshotId&&!['expired','deleted'].includes(state.phase)))throw Error('Неверный снимок для удаления');
   if(request.snapshotId===state.snapshotId)clean(request.snapshotId);save({phase:'deleted',requestId:request.id,snapshotId:null,error:null});return;
  }
  if(request.action!=='create'||Object.keys(request).sort().join()!=='action,created,id,mode'||!backupModes.includes(request.mode)||state.phase==='ready')throw Error('Неверный состав или уже есть готовая копия');
  save({phase:'preparing',requestId:request.id,snapshotId:request.id,mode:request.mode,error:null,hubStopped:false,signalStopped:false});
  try{
   const signal=inspect('systemctl',['is-active','nexus404-signal.service']).text==='active';
   if(signal){save({signalStopped:true});await run('systemctl',['stop','nexus404-signal.service']);}
   save({hubStopped:true});await run('docker',compose('stop','-t','30','hub'));
   const version=json(path.join(hubPath(hub,'data'),'hub-runtime.json'))?.version||'unknown';
   const snapshot=await prepare({hub,control,id:request.id,mode:request.mode,ownership,now:now(),version});
   await resume();save({...snapshot,phase:'ready',hubStopped:false,signalStopped:false});
  }catch(error){
   fs.appendFileSync(path.join(control,'private/worker.log'),String(error.stack||error)+'\n',{mode:0o600});
   try{await resume();clean(request.id);save({phase:'failed',hubStopped:false,signalStopped:false,error:error.code==='EXDEV'?'Файлы и снимки находятся на разных разделах. Копирование медиа отменено без дублирования':error.message==='Недостаточно места для временной копии настроек и баз'?error.message:'Не удалось подготовить копию. Хаб запущен; подробности в журнале на сервере'});}catch{save({phase:'recovery-required',error:'Не удалось запустить хаб после подготовки. Проверь службу на сервере'});}
  }
 }finally{clearInterval(heartbeat);await unlock();}
}
if(direct(import.meta.url))processDataBackup().catch(()=>{console.error('Data backup worker failed; inspect server journal');process.exitCode=1;});
