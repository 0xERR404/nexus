import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
export const backupModes=['settings','media','all'];
export const backupID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const backupFail=(message,status=409)=>Object.assign(Error(message),{status});
export function backupPath(root,name){
 if(typeof name!=='string'||!name||name.includes('\\')||name.split('/').some(p=>!p||p==='.'||p==='..')||path.isAbsolute(name))throw backupFail('Неверный путь копии');
 const base=path.resolve(root),file=path.resolve(base,name);if(!file.startsWith(base+path.sep))throw backupFail('Неверный путь копии');return file;
}
export function backupKind(name){
 const parts=name.split('/');
 if(parts.some(p=>p.startsWith('.')||['tmp','cache','node_modules','modules'].includes(p))||/\.(?:tmp|log|jsonl)$/.test(name))return null;
 if(parts[0]==='config')return /\.json$/.test(name)?'settings':null;
 if(parts[0]!=='data'||['sessions.json','hub-runtime.json','hub-notices.json','signal.json','dashboard.json','diagnostics'].includes(parts[1]))return null;
 const module=parts[1],media=['wave','reader','content','storage','projects','cinema'].includes(module);
 if(!media)return 'settings';
 if((['wave','reader'].includes(module)&&parts.length>3)||(['content','storage','projects'].includes(module)&&['files','blobs','releases'].includes(parts[2]))||/\.(?:jpg|jpeg|png|webp|mp3|mp4|nbk)$/i.test(name))return 'media';
 return 'catalog';
}
export function selectedBackup(mode,name){const kind=backupKind(name);return !!kind&&(mode==='all'||kind==='catalog'||kind===mode);}
export function readBackupJSON(file,fallback=null){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function atomic(file,value){const tmp=file+'.'+randomUUID();try{fs.writeFileSync(tmp,JSON.stringify(value),{mode:0o600,flag:'wx'});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}}
export class DataBackups{
 constructor(directory=process.env.DATA_BACKUP_DIRECTORY){this.directory=directory;}
 file(name){if(!this.directory)throw backupFail('Для резервных копий примени полный выпуск через установщик',503);return backupPath(this.directory,name);}
 status(){
  try{const s=readBackupJSON(this.file('status/status.json'),{}),r=readBackupJSON(this.file('requests/request.json'));return {...s,available:Number.isFinite(s.heartbeat)&&Date.now()-s.heartbeat<180000,pending:!!(r&&r.id!==s.requestId&&Date.now()-r.created<900000)};}
  catch{return {available:false,phase:'unavailable'};}
 }
 queue(value){
  const s=this.status();if(!s.available)throw backupFail('Служба копирования недоступна. Примени выпуск через установщик',503);
  if(s.pending||s.phase==='preparing')throw backupFail('Копирование уже выполняется');
  if(value?.action==='delete'){if(!backupID.test(value.snapshotId)||value.snapshotId!==s.snapshotId||s.phase!=='ready')throw backupFail('Копия уже недоступна');}
  else if(value?.action!=='create'||!backupModes.includes(value.mode)||s.phase==='ready')throw backupFail('Выбери состав копии; предыдущую копию сначала скачай или удали');
  const request={id:randomUUID(),created:Date.now(),action:value.action,...(value.action==='create'?{mode:value.mode}:{snapshotId:value.snapshotId})};atomic(this.file('requests/request.json'),request);return {queued:true};
 }
 async download(id,response,authorized=()=>true){
  const s=this.status();if(!backupID.test(id)||s.phase!=='ready'||s.snapshotId!==id||s.pending||!s.available||s.expires<Date.now())throw backupFail('Копия уже недоступна');
  const lease=this.file('requests/lease.json'),old=readBackupJSON(lease);
  if(old&&Date.now()-old.updated<45000)throw backupFail('Копия уже скачивается');
  if(old)fs.rmSync(lease,{force:true});
  fs.writeFileSync(lease,JSON.stringify({id,updated:Date.now()}),{flag:'wx',mode:0o600});
  let timer,success=false;
  try{
   const directory=this.file('files/'+id),index=readBackupJSON(path.join(directory,'index.json'));
   if(index?.id!==id||!backupModes.includes(index.mode))throw backupFail('Снимок повреждён');
   timer=setInterval(()=>{try{if(!authorized())return response.destroy();atomic(lease,{id,updated:Date.now()});}catch{response.destroy();}},10000);
   response.setHeader('Content-Type','application/gzip');response.setHeader('Content-Disposition',`attachment; filename="nexus404-${index.mode}-${new Date(index.created).toISOString().slice(0,10)}.tar.gz"`);
   response.setHeader('Cache-Control','no-store');response.setHeader('X-Accel-Buffering','no');
   await pipeline(Readable.from(backupTar(directory,index)),createGzip({level:1}),response);success=true;
  }finally{
   clearInterval(timer);fs.rmSync(lease,{force:true});
   if(success){try{this.queue({action:'delete',snapshotId:id});}catch{/* The worker also expires unused snapshots. */}}
  }
 }
}
function header(name,size,type='0'){
 const b=Buffer.alloc(512);b.write(name,0,100,'utf8');
 const oct=(value,start,len)=>b.write(Math.floor(value).toString(8).padStart(len-1,'0')+'\0',start,len,'ascii');
 oct(0o600,100,8);oct(0,108,8);oct(0,116,8);oct(size,124,12);oct(0,136,12);b.fill(32,148,156);b.write(type,156);b.write('ustar\0',257,6,'ascii');b.write('00',263,2,'ascii');
 const sum=b.reduce((n,v)=>n+v,0);b.write(sum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');return b;
}
function pax(key,value){const text=` ${key}=${value}\n`;let size=Buffer.byteLength(text)+1;while(String(size).length+Buffer.byteLength(text)!==size)size=String(size).length+Buffer.byteLength(text);return `${size}${text}`;}
function* prefix(name,size){
 let extended='';if(Buffer.byteLength(name)>100||/[^\x20-\x7e]/.test(name))extended+=pax('path',name);if(size>8589934591)extended+=pax('size',size);
 if(extended){const bytes=Buffer.from(extended);yield header('PaxHeader',bytes.length,'x');yield bytes;yield Buffer.alloc((512-bytes.length%512)%512);}
 yield header(extended?'entry':name,size>8589934591?0:size);
}
function* textEntry(name,text){const bytes=Buffer.from(text);yield* prefix(name,bytes.length);yield bytes;yield Buffer.alloc((512-bytes.length%512)%512);}
export async function* backupTar(directory,index){
 if(!Array.isArray(index.entries))throw backupFail('Снимок повреждён');
 yield* textEntry('BACKUP.json',JSON.stringify({format:'NEXUS404-DATA-1',mode:index.mode,version:index.version,created:index.created,files:index.entries.length,excluded:['Код хаба и модулей','Выпуски NEXUS404 в Дедале','Кэш и временные файлы']},null,2));
 yield* textEntry('RESTORE.txt','Пользовательские данные NEXUS404. Код не включён.\nРаспакуй в отдельный каталог. Сначала установи совместимый полный выпуск хаба.\nДля восстановления останови хаб и сборщик событий, сохрани текущие данные отдельно, затем восстанови выбранные data/config в /var/lib/nexus404-hub с прежними владельцами (data: UID 1000, config: root/GID 1000). Запусти хаб через установщик.\nЧастичная копия не содержит всех файлов: settings — записи и настройки без медиа; media — медиатеки, файлы и проекты с их каталогами, без остальных настроек. Не заменяй всю библиотеку частичной копией.\nCHECKSUMS.json содержит SHA-256 каждого файла. Обрыв загрузки делает архив неполным; скачай повторно. Архив содержит личные данные и настройки доступа.\n');
 for(const entry of index.entries)if(!entry.name.startsWith('data/')&&!entry.name.startsWith('config/'))throw backupFail('Неверный состав копии');
 yield* archiveFiles(path.join(directory,'snapshot'),index.entries);
}
export async function* archiveFiles(root,entries){
 const hashes=[];
 for(const entry of entries){
  const file=backupPath(root,entry.name);if(fs.lstatSync(file).isSymbolicLink())throw backupFail('Ссылки в копии запрещены');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),stat=fs.fstatSync(fd);
  const valid=s=>s.isFile()&&s.size===entry.size&&s.mtimeMs===entry.mtimeMs;
  try{
   if(!valid(stat))throw backupFail('Файл изменился. Создай копию заново');
   yield* prefix(entry.name,stat.size);const hash=createHash('sha256');let size=0;
   for await(const chunk of fs.createReadStream(file,{fd,autoClose:false})){size+=chunk.length;hash.update(chunk);yield chunk;}
   if(size!==entry.size||!valid(fs.fstatSync(fd)))throw backupFail('Файл изменился во время скачивания');
   hashes.push({name:entry.name,size,sha256:hash.digest('hex')});yield Buffer.alloc((512-size%512)%512);
  }finally{fs.closeSync(fd);}
 }
 yield* textEntry('CHECKSUMS.json',JSON.stringify(hashes,null,2));yield Buffer.alloc(1024);
}
export const dataBackupContent=`<link rel="stylesheet" href="/data-backup.css"><script src="/data-backup.js" defer></script>
<section class="data-backup"><p>Сохрани добавленную информацию на своём устройстве. Код хаба, модулей и выпуски NEXUS404 из Дедала в копию не входят.</p>
<form id="dataBackupForm"><fieldset id="dataBackupChoices"><legend>Что сохранить</legend>
<label><input type="radio" name="mode" value="settings"><span><strong>Настройки и записи</strong><small>Настройки доступа, задачи, заметки, базы, каталоги и прогресс. Без медиафайлов и ZIP проектов.</small></span></label>
<label><input type="radio" name="mode" value="media"><span><strong>Медиа и проекты</strong><small>Музыка, книги, изображения, загруженные файлы и архивы проектов вместе с их каталогами. Временный кэш видео не включается.</small></span></label>
<label><input type="radio" name="mode" value="all" checked><span><strong>Все данные</strong><small>Настройки, записи и все добавленные файлы вместе.</small></span></label></fieldset>
<p>Для подготовки хаб и плеер ненадолго остановятся. Архив собирается при скачивании и не сохраняется на сервере.</p><button id="dataBackupCreate" type="submit" disabled>Подготовить копию</button></form>
<p id="dataBackupStatus" role="status">Проверка службы…</p><p id="dataBackupDetails" class="muted"></p>
<div id="dataBackupReady" hidden><form action="/api/data-backup/download" method="post" id="dataBackupDownload"><input type="hidden" name="id" id="dataBackupID"><button type="submit">Скачать копию</button></form><button type="button" id="dataBackupDelete">Удалить временный снимок</button></div>
<p class="muted">После передачи временный снимок удаляется автоматически. При обрыве можно повторить скачивание; невостребованный снимок удаляется через час. Браузер не сообщает серверу, сохранился ли файл на устройстве — проверь загрузку. Архив содержит личные данные и настройки доступа.</p></section>`;
