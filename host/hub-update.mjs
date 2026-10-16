import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {HUB,STATE,HOST,NODE,atomic,json,exec,query,lock,sleep,direct} from './common.mjs';
import {UPDATE_CONTROL,inside,regularTree,savedModules,moduleIDs} from './hub-lifecycle.mjs';
import {updateRequest,rollbackRequest,selectUpdate,versionParts} from '../02-hub/src/hub-update.mjs';
import {validateZip} from '../02-hub/src/archive.mjs';
const active=['preparing','building','backup','installing','checking','rolling-back'];
const phaseText={preparing:'Проверка архива',building:'Сборка новой версии',backup:'Остановка хаба и резервное копирование',installing:'Копия проверена. Установка новой версии',checking:'Проверка устойчивого запуска хаба и модулей',completed:'Обновление установлено. Резервная копия сохранена',failed:'Операция не выполнена','rolling-back':'Возврат предыдущей версии и данных','rolled-back':'Предыдущая версия и данные восстановлены','recovery-required':'Автоматическое восстановление не завершено. Нужна проверка на сервере'};
export function publicFailure(error,phase){
  // Never publish command output, paths, uploaded names, credentials or raw exception messages.
  const codes={ENOSPC:'Недостаточно места на диске',EACCES:'Недостаточно прав на файлы',EPERM:'Операция запрещена системой',ENOENT:'Отсутствует необходимый файл или программа',ECANCELLED:'Операция прервана или превышено время ожидания',EBACKUP:'Резервная копия не прошла сверку',EHEALTH:'Хаб или включённые модули не прошли проверку запуска'};
  const known=new Set(['Контрольная сумма архива не совпала','Неверный файл архива','Архив изменился','Версия внутри архива не совпадает с версией в Дедале','Версия lock-файла не совпала','Неполный выпуск NEXUS404','Недостаточно места для резервной копии и безопасного возврата данных','Установленная версия изменилась или хаб не запущен','Установленная версия изменилась','Проверенная копия недоступна','Проект или выпуск изменён в Дедале. Выбери архив заново','Можно устанавливать только более новый выпуск','Неверный или устаревший запрос обновления','Неверный или устаревший запрос возврата']);
  const hint=codes[error?.code]||(known.has(error?.message)?error.message:null)||({preparing:'Архив или запрос не прошёл проверку',building:'Не удалось собрать новую версию; действующий хаб не заменён',backup:'Не удалось создать проверенную резервную копию',installing:'Не удалось заменить или запустить новую версию',checking:codes.EHEALTH,'rolling-back':'Не удалось завершить возврат'}[phase]||'Ошибка операции');
  const command=['docker','cp','sync'].includes(error?.updateCommand)?` (${error.updateCommand}${Number.isInteger(error.exitCode)?', код '+error.exitCode:''})`:'';
  return hint+command+'. Подробности сохранены в журнале на сервере.';
}
export async function treeManifest(root){
  regularTree(root);const entries=[];
  async function walk(dir,prefix=''){
    for(const name of fs.readdirSync(dir).sort()){
      const file=inside(dir,name),relative=prefix+name,stat=fs.lstatSync(file);
      if(stat.isDirectory()){entries.push([relative+'/']);await walk(file,relative+'/');}
      else{
        const hash=createHash('sha256');for await(const chunk of fs.createReadStream(file))hash.update(chunk);
        entries.push([relative,stat.size,hash.digest('hex')]);
      }
    }
  }
  await walk(root);return entries;
}
export async function verifyBackup(root,expected){
  if(JSON.stringify(await treeManifest(root))!==JSON.stringify(expected))throw Object.assign(Error('Backup verification failed'),{code:'EBACKUP'});
}
export function updateEvents(previous,next){
  const events=Array.isArray(previous.events)?previous.events.slice(-40):[];
  if(phaseText[next.phase]&&(previous.phase!==next.phase||previous.error!==next.error||previous.requestId!==next.requestId)){
    events.push({time:Date.now(),phase:next.phase,level:['failed','recovery-required'].includes(next.phase)||next.phase==='rolling-back'&&next.error?'error':'info',message:phaseText[next.phase]+(next.error?' · '+next.error:'')});
  }
  return events.slice(-40);
}
export function initializeHubUpdates({control=UPDATE_CONTROL,write=atomic,ownership=true}={}){
  for(const [name,mode,uid]of [['',0o755,0],['requests',0o700,1000],['status',0o755,0],['private',0o700,0],['private/docker',0o700,0]]){
    const dir=path.join(control,name);fs.mkdirSync(dir,{recursive:true,mode});fs.chmodSync(dir,mode);if(ownership)fs.chownSync(dir,uid,uid);
  }
  write('/etc/systemd/system/nexus404-hub-update.service',`[Unit]\nDescription=NEXUS404 verified hub release update\nAfter=docker.service\n[Service]\nType=oneshot\nEnvironment=${JSON.stringify("DOCKER_CONFIG="+path.join(control,"private","docker"))}\nEnvironment=BUILDKIT_PROGRESS=plain\nExecStart=${NODE} ${HOST}/hub-update.mjs\nTimeoutStartSec=infinity\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\n`,0o644);
  write('/etc/systemd/system/nexus404-hub-update.timer','[Unit]\nDescription=NEXUS404 hub update requests\n[Timer]\nOnBootSec=45s\nOnUnitInactiveSec=15s\nAccuracySec=2s\n[Install]\nWantedBy=timers.target\n',0o644);
}
export function readUpdateRequest(file){
  let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size>4096)throw Error('Некорректный файл запроса');
    const bytes=Buffer.alloc(4097),length=fs.readSync(fd,bytes,0,bytes.length,0);
    if(length>4096)throw Error('Слишком большой запрос');
    return JSON.parse(bytes.subarray(0,length).toString('utf8'));
  }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export async function copyRelease(source,target,expected){
  const input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  let output;
  try{
    const stat=fs.fstatSync(input);if(!stat.isFile()||stat.nlink!==1||stat.size!==expected.size||stat.size>128*1024*1024)throw Error('Неверный файл архива');
    output=fs.openSync(target,'wx',0o600);
    const hash=createHash('sha256'),buffer=Buffer.alloc(1024*1024);let total=0,n;
    while((n=fs.readSync(input,buffer,0,buffer.length,null))){total+=n;if(total>expected.size)throw Error('Архив изменился');hash.update(buffer.subarray(0,n));fs.writeSync(output,buffer,0,n);}
    if(total!==expected.size||hash.digest('hex')!==expected.sha256)throw Error('Контрольная сумма архива не совпала');
    fs.fsyncSync(output);
  }finally{fs.closeSync(input);if(output!==undefined)fs.closeSync(output);}
}
export function checkHubRelease(root,release){
  const project=json(path.join(root,'package.json')),hub=json(path.join(root,'02-hub/package.json'));
  if(project?.name!=='nexus404-project'||hub?.name!=='nexus404-hub'||project.hubUpdateSchema!==1||project.version!==hub.version)
    throw Error('Нужен полный совместимый выпуск NEXUS404 (hubUpdateSchema: 1), файлы должны лежать в корне ZIP');
  if(versionParts(project.version).join('.')!==versionParts(release.version).join('.'))throw Error('Версия внутри архива не совпадает с версией в Дедале');
  for(const name of ['menu.sh','bootstrap.mjs','02-hub/Dockerfile','02-hub/package-lock.json','02-hub/src/server.mjs','02-hub/src/hub-update.mjs']){
    if(!fs.statSync(inside(root,name)).isFile())throw Error('Неполный выпуск NEXUS404');
  }
  if(json(path.join(root,'02-hub/package-lock.json'))?.version!==project.version)throw Error('Версия lock-файла не совпала');
  for(const id of moduleIDs){
    if(json(inside(root,'03-modules/'+id+'/manifest.json'))?.version!==project.version||!fs.statSync(inside(root,'03-modules/'+id+'/index.mjs')).isFile())
      throw Error('Неполный или смешанный выпуск модулей: '+id);
  }
  return project.version;
}
export async function applyHubRelease(request,{hub=HUB,state=STATE,control=UPDATE_CONTROL,run=exec,inspect=query,report=()=>{},snapshot,health}={}){
  const {moduleFiles,composeArgs}=await import('./platform.mjs');
  const compose=(...args)=>composeArgs('nexus404-shell',hub,args);
  const job=inside(path.join(control,'private'),request.id);
  fs.mkdirSync(job,{mode:0o700});
  const log=path.join(job,'update.log');
  const command=async(name,args)=>{try{return await run(name,args,{log,timeout:3600000});}catch(error){error.updateCommand=name;const code=/^\w+: код (\d+)$/.exec(error.message);if(code)error.exitCode=Number(code[1]);throw error;}};
  let journal={job,requestId:request.id,phase:'preparing',version:request.version,expectedVersion:request.expectedVersion};
  const mark=(phase,extra={})=>{journal={...journal,...extra,phase};report(journal);};
  const current=inspect('docker',compose('exec','-T','hub','node','-p',"require('/app/package.json').version"));
  if(!current.ok||current.text!==request.expectedVersion)throw Error('Установленная версия изменилась или хаб не запущен');
  regularTree(hub);
  const release=selectUpdate(path.join(hub,'data'),request);
  await copyRelease(path.join(hub,'data/projects/releases',request.release),path.join(job,'release.zip'),release);
  await validateZip(path.join(job,'release.zip'),{extractTo:path.join(job,'source')});
  const version=checkHubRelease(path.join(job,'source'),release),manifests=savedModules(hub);
  const staged=path.join(job,'stage');fs.mkdirSync(staged);
  fs.mkdirSync(path.join(staged,'modules'),{mode:0o755});
  for(const [id,manifest]of Object.entries(manifests)){
    atomic(path.join(staged,'modules',id,'manifest.json'),JSON.stringify(manifest),0o644);
    atomic(path.join(staged,'markers',id+'-installed'),'staged');
    moduleFiles(id,{root:path.join(job,'source'),hub:staged,state:path.join(staged,'markers')});
  }
  // Never execute the uploaded installer or Compose file. The existing fixed service definition stays authoritative.
  const container=inspect('docker',compose('ps','-q','hub'));
  if(!container.ok||! /^[a-f0-9]{12,64}$/.test(container.text))throw Error('Не найден контейнер хаба');
  const image=inspect('docker',['inspect','--format','{{.Image}}',container.text]);
  if(!image.ok||!/^sha256:[a-f0-9]{64}$/.test(image.text))throw Error('Не удалось сохранить предыдущий образ');
  const oldTag='nexus404-shell:rollback-'+request.id,newTag='nexus404-shell:update-'+request.id;
  await command('docker',['tag',image.text,oldTag]);
  mark('building',{oldTag,newTag,version});
  await command('docker',['build','--pull','-t',newTag,path.join(job,'source/02-hub')]);
  const required=regularTree(hub),disk=fs.statfsSync(job),hubDisk=fs.statfsSync(hub),sameDisk=fs.statSync(hub).dev===fs.statSync(job).dev;
  // Reserve room for both the snapshot and a rollback that keeps the failed run intact.
  if(Number(disk.bavail)*Number(disk.bsize)<required*(sameDisk?2:1)+512*1024*1024||Number(hubDisk.bavail)*Number(hubDisk.bsize)<required+512*1024*1024)
    throw Error('Недостаточно места для резервной копии и безопасного возврата данных');
  selectUpdate(path.join(hub,'data'),request);
  mark('backup',{modules:Object.entries(manifests).filter(([,m])=>m.enabled).map(([id])=>id)});
  try{
    await command('docker',compose('stop','-t','30','hub'));
    // The application is stopped: SQLite and uploaded files form one consistent snapshot.
    const expected=await treeManifest(hub);
    await (snapshot??((from,to)=>command('cp',['-a','--reflink=auto','--',from,to])))(hub,path.join(job,'backup'));
    await command('sync',['-f',path.join(job,'backup')]);
    await verifyBackup(path.join(job,'backup'),expected);
    atomic(path.join(job,'backup-manifest.json'),JSON.stringify(expected));
    await command('sync',['-f',job]);
    mark('installing',{backupReady:true,backupCreated:Date.now()});
    await command('cp',['-a','--',path.join(staged,'modules'),path.join(hub,'.update-next-modules')]);
    if(fs.existsSync(path.join(hub,'modules')))fs.renameSync(path.join(hub,'modules'),path.join(hub,'.update-old-modules'));
    fs.renameSync(path.join(hub,'.update-next-modules'),path.join(hub,'modules'));
    await command('docker',['tag',newTag,'nexus404-shell:local']);
    await command('docker',compose('up','-d','--no-build','--force-recreate','hub'));
    mark('checking');
    await (health??(()=>waitUpdatedHub(hub,version,Object.entries(manifests).filter(([,m])=>m.enabled).map(([id])=>id),inspect)))();
    mark('completed',{updated:Date.now(),error:null});
  }catch(error){
    const cause=publicFailure(error,journal.phase);fs.appendFileSync(log,'\n'+String(error.stack||error)+'\n',{mode:0o600});
    if(journal.backupReady){
      mark('rolling-back',{error:cause});
      try{await recoverHubUpdate(journal,{hub,run:command,inspect});mark('rolled-back',{error:'Новая версия не запустилась. Код и данные возвращены к состоянию перед обновлением'});}
      catch(recoveryError){fs.appendFileSync(log,'\n'+String(recoveryError.stack||recoveryError)+'\n');mark('recovery-required',{error:publicFailure(recoveryError,'rolling-back')});}
    }else{
      try{await command('docker',compose('up','-d','--no-build','hub'));await waitUpdatedHub(hub,request.expectedVersion,journal.modules,inspect);mark('failed',{error:cause+' Прежний хаб запущен.'});}
      catch{mark('recovery-required',{error:'Ошибка резервного копирования. Данные остались на месте; требуется запуск хаба на сервере'});}
    }
    return journal;
  }
  // Retain the full backup and rollback image; discard only this job's temporary unpacked source.
  try{
    for(const name of ['source','stage','release.zip'])fs.rmSync(inside(job,name),{recursive:true,force:true});
    fs.rmSync(inside(hub,'.update-old-modules'),{recursive:true,force:true});
    await command('docker',['image','rm',newTag]);
  }catch{ /* A cleanup error must never turn a committed installation into a failed update. */ }
  return journal;
}
export async function waitUpdatedHub(hub,version,modules,inspect=query,{pause=sleep,attempts=60,required=3}={}){
  const {composeArgs}=await import('./platform.mjs');
  let consecutive=0;
  const probe=`const fs=require('node:fs');const r=JSON.parse(fs.readFileSync('/app/data/hub-runtime.json'));if(require('/app/package.json').version!==${JSON.stringify(version)}||r.version!==${JSON.stringify(version)}||!Array.isArray(r.modules)||!Array.isArray(r.errors)||r.errors.length||!${JSON.stringify(modules)}.every(id=>r.modules.includes(id)))process.exit(1);Promise.all(['/login','/app.css','/workspace.js'].map(p=>fetch('http://127.0.0.1:3000'+p,{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)throw Error('HTTP')}))).then(()=>process.exit(0)).catch(()=>process.exit(1));`;
  for(let i=0;i<attempts;i++){
    const result=inspect('docker',composeArgs('nexus404-shell',hub,['exec','-T','hub','node','-e',probe]));
    if(result.ok){if(++consecutive>=required)return;}else consecutive=0;
    if(i+1<attempts)await pause(2000);
  }
  throw Object.assign(Error('Хаб или один из модулей не прошёл проверку запуска'),{code:'EHEALTH'});
}
export async function recoverHubUpdate(journal,{hub=HUB,run=exec,inspect=query}={}){
  const {composeArgs}=await import('./platform.mjs');
  const compose=(...args)=>composeArgs('nexus404-shell',hub,args);
  if(!journal.backupReady)throw Error('Нет полной резервной копии');
  const backup=path.join(journal.job,'backup'),required=regularTree(backup),manifest=path.join(journal.job,'backup-manifest.json');
  if(fs.existsSync(manifest))await verifyBackup(backup,JSON.parse(fs.readFileSync(manifest,'utf8')));
  const disk=fs.statfsSync(path.dirname(hub));
  if(Number(disk.bavail)*Number(disk.bsize)<required+512*1024*1024)throw Object.assign(Error('Недостаточно места для возврата'),{code:'ENOSPC'});
  if(!inspect('docker',['image','inspect',journal.oldTag]).ok)throw Error('Предыдущий образ недоступен');
  await run('docker',compose('stop','-t','30','hub'));
  // Preserve the failed run as well, including anything written during its health check.
  const failed=hub+'.failed-'+journal.requestId;
  if(!fs.existsSync(failed))fs.renameSync(hub,failed);
  else if(fs.existsSync(hub)){
    const partial=failed+'-partial-'+Date.now();fs.renameSync(hub,partial);
  }
  await run('cp',['-a','--reflink=auto','--',path.join(journal.job,'backup'),hub]);
  await run('docker',['tag',journal.oldTag,'nexus404-shell:local']);
  await run('docker',compose('up','-d','--no-build','--force-recreate','hub'));
  await waitUpdatedHub(hub,journal.expectedVersion,journal.modules??Object.entries(savedModules(hub)).filter(([,m])=>m.enabled).map(([id])=>id),inspect);
}
export async function processHubUpdate({hub=HUB,state=STATE,control=UPDATE_CONTROL,acquire=lock,apply=applyHubRelease,recover=recoverHubUpdate,inspect=query}={}){
  let unlock;try{unlock=await acquire('/run/lock/nexus404-setup.lock',true);}catch(e){if(e.code==='ELOCKED')return;throw e;}
  let heartbeat;
  try{
    const privateFile=path.join(control,'private/state.json');
    let status=json(privateFile,{phase:'idle'});
    const publish=()=>{
      const saved=json(path.join(control,'private/last-backup.json'));
      const backup=saved?.backupReady&&fs.existsSync(path.join(saved.job,'backup-manifest.json'))?{id:saved.requestId,version:saved.expectedVersion,created:saved.backupCreated}:null;
      atomic(path.join(control,'status/status.json'),JSON.stringify({protocol:2,phase:status.phase,version:status.version,requestId:status.requestId,error:status.error,events:status.events??[],backup,updated:status.updated,heartbeat:Date.now()}),0o644);
    };
    const report=value=>{
      const next={...status,...value};next.events=updateEvents(status,next);status=next;atomic(privateFile,JSON.stringify(status));
      if(status.phase==='installing'&&status.backupReady)atomic(path.join(control,'private/last-backup.json'),JSON.stringify(status));
      publish();
    };
    if(fs.existsSync(path.join(state,'hub-removed'))){report({phase:'removed'});return;}
    if(status.phase==='removed')report({phase:'idle',error:null});
    publish();heartbeat=setInterval(publish,10000);
    if(active.includes(status.phase)){
      try{
        if(status.backupReady)await recover(status,{hub});
        else if(status.phase==='backup'){
          const {composeArgs}=await import('./platform.mjs');await exec('docker',composeArgs('nexus404-shell',hub,['up','-d','--no-build','hub']));
        }
        report({phase:status.backupReady?'rolled-back':'failed',error:'Прерванное обновление отменено. Повтори после проверки сервера'});
      }catch{report({phase:'recovery-required',error:'Прерванное обновление требует восстановления из резервной копии на сервере'});}
      return;
    }
    if(status.phase==='recovery-required')return;
    let request;
    try{request=readUpdateRequest(path.join(control,'requests/request.json'));}
    catch{report({error:'Повреждённый запрос обновления'});return;}
    if(!request||request.id===status.requestId)return;
    try{
      if(request.action==='rollback'){
        rollbackRequest(request);
        const saved=json(path.join(control,'private/last-backup.json'));
        if(saved?.requestId!==request.backupId||!saved.backupReady||!fs.existsSync(path.join(saved.job,'backup-manifest.json')))throw Error('Проверенная копия недоступна');
        const {composeArgs}=await import('./platform.mjs');
        const current=inspect('docker',composeArgs('nexus404-shell',hub,['exec','-T','hub','node','-p',"require('/app/package.json').version"]));
        if(!current.ok||current.text!==request.expectedVersion||current.text===saved.expectedVersion)throw Error('Установленная версия изменилась');
        report({...saved,events:undefined,requestId:request.id,phase:'rolling-back',error:null});
        try{await recover({...saved,requestId:request.id},{hub});report({phase:'rolled-back',error:null});}
        catch(error){fs.appendFileSync(path.join(control,'private/worker.log'),String(error.stack||error)+'\n',{mode:0o600});report({phase:'recovery-required',error:publicFailure(error,'rolling-back')});}
        return;
      }
      updateRequest(request);
      // Each transaction has its own private journal; never inherit rollback flags from an older release.
      const previous=status;status={events:previous.events};report({phase:'preparing',requestId:request.id});
      await apply(request,{hub,state,control,report});
    }catch(error){fs.appendFileSync(path.join(control,'private/worker.log'),String(error.stack||error)+'\n',{mode:0o600});report({phase:'failed',requestId:typeof request.id==='string'?request.id.slice(0,36):null,error:publicFailure(error,status.phase)});}
  }finally{clearInterval(heartbeat);await unlock();}
}
export async function recoverHubFromBackup(ui,{hub=HUB,state=STATE,control=UPDATE_CONTROL,recover=recoverHubUpdate}={}){
  const file=path.join(control,'private/state.json'),current=json(file),journal=current?.backupReady?current:json(path.join(control,'private/last-backup.json'));
  if(!journal?.backupReady)throw Error('Полной резервной копии обновления нет. Данные остаются в data; используй восстановление из сохранённых данных');
  ui.line('Будет возвращено состояние хаба и данных перед обновлением до '+journal.version+'.');
  ui.line('Копия: '+path.join(journal.job,'backup')+'. Текущее состояние также останется рядом с каталогом хаба.');
  if((await ui.prompt('Для возврата введи NEXUS404; Enter — отмена')).trim()!=='NEXUS404')return;
  let progress={...journal,phase:current?.phase??journal.phase,requestId:current?.requestId??journal.requestId,events:current?.events??journal.events};
  const report=(phase,error=null)=>{
    const next={...progress,phase,error,updated:Date.now()};next.events=updateEvents(progress,next);progress=next;
    atomic(file,JSON.stringify(progress));
    atomic(path.join(control,'status/status.json'),JSON.stringify({protocol:2,phase,requestId:progress.requestId,error,events:progress.events,heartbeat:Date.now()}),0o644);
  };
  report('rolling-back');
  fs.rmSync(path.join(control,'requests/request.json'),{force:true});
  try{await recover(journal,{hub});}catch(error){report('recovery-required',publicFailure(error,'rolling-back'));throw error;}
  fs.rmSync(path.join(state,'hub-removed'),{force:true});
  fs.rmSync(path.join(control,'requests/request.json'),{force:true});
  report('rolled-back');
  await ui.run('Служба обновления хаба','systemctl',['enable','--now','nexus404-hub-update.timer']);
  ui.line('[✓] Предыдущая версия и данные восстановлены');
}
if(direct(import.meta.url))processHubUpdate().catch(()=>{console.error('Hub update worker failed; inspect private update log');process.exitCode=1;});
