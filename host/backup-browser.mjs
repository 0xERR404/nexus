import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip} from 'node:zlib';
import {HUB,HOST,NODE,atomic,lock,direct} from './common.mjs';
import {archiveFiles,backupID,backupFail} from '../02-hub/src/data-backup.mjs';
const CONTROL='/var/lib/nexus404-data-backup';
const UPDATES='/var/lib/nexus404-updates';
const active=new Set(['preparing','building','backup','installing','checking','rolling-back','recovery-required']);
const parseID=value=>{if(typeof value!=='string')throw backupFail('Копия не найдена',404);const m=/^(update|failed)-([a-f0-9-]+)$/.exec(value??'');if(!m||!backupID.test(m[2]))throw backupFail('Копия не найдена',404);return m;};
function record(file){
 try{const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>2*1024*1024)throw Error('Invalid metadata');return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return {};throw e;}
}
function realDirectory(dir){const s=fs.lstatSync(dir);if(!s.isDirectory()||s.isSymbolicLink()||path.resolve(dir)!==fs.realpathSync(dir))throw backupFail('Каталог копии требует проверки на сервере');return s;}
export function backupTarget(id,{hub=HUB,updates=UPDATES}={}){
 const [,kind,key]=parseID(id),parent=kind==='update'?path.join(updates,'private'):path.dirname(hub);
 realDirectory(parent);const target=path.join(parent,kind==='update'?key:path.basename(hub)+'.failed-'+key);realDirectory(target);return target;
}
export function backupInventory(root){
 realDirectory(root);const entries=[];let bytes=0;
 function walk(dir,prefix=''){
  for(const name of fs.readdirSync(dir).sort()){
   if(entries.length>200000)throw backupFail('В копии слишком много файлов для просмотра');
   const file=path.join(dir,name),s=fs.lstatSync(file);
   if(s.isSymbolicLink()||!s.isFile()&&!s.isDirectory())throw backupFail('Копия содержит ссылки или специальные файлы; нужна проверка на сервере');
   if(s.isDirectory())walk(file,prefix+name+'/');else{entries.push({name:prefix+name,size:s.size,mtimeMs:s.mtimeMs});bytes+=s.size;}
  }
 }
 walk(root);return {entries,bytes};
}
function protection(updates){
 const state=record(path.join(updates,'private/state.json')),last=record(path.join(updates,'private/last-backup.json')),request=record(path.join(updates,'requests/request.json'));
 return {last:last.backupReady&&backupID.test(last.requestId)?last.requestId:null,busy:active.has(state.phase)||!!(request.id&&request.id!==state.requestId&&Date.now()-request.created<900000)};
}
export function listSystemBackups(options={}){
 const {hub=HUB,updates=UPDATES}=options,items=[],guard=protection(updates),roots=[['update',path.join(updates,'private')],['failed',path.dirname(hub)]];
 for(const [kind,parent]of roots){
  if(!fs.existsSync(parent))continue;realDirectory(parent);
  for(const name of fs.readdirSync(parent)){
   const key=kind==='update'?name:name.startsWith(path.basename(hub)+'.failed-')?name.slice((path.basename(hub)+'.failed-').length):'';
   if(!backupID.test(key))continue;
   const id=kind+'-'+key;
   try{
    const dir=backupTarget(id,options),{entries,bytes}=backupInventory(dir),s=fs.statSync(dir),meta=record(path.join(dir,'system-backup.json'));
    const packageFile=path.join(dir,kind==='update'?'backup/package.json':'package.json'),pkg=record(packageFile);
    const reason=guard.busy?'Обновление или восстановление ещё не завершено':guard.last===key?'Последняя резервная копия для восстановления':null;
    items.push({id,kind,title:kind==='failed'?'Каталог после неудачного обновления':fs.existsSync(path.join(dir,'backup'))?'Резервная копия обновления':'Остатки подготовки обновления',version:typeof pkg.version==='string'?pkg.version.slice(0,40):null,created:Number.isFinite(meta.backupCreated)?meta.backupCreated:s.mtimeMs,bytes,files:entries.length,hasData:entries.some(e=>/^(?:backup\/)?(?:data|config)\//.test(e.name)),protected:!!reason,reason});
   }catch{items.push({id,kind,title:'Копия требует проверки',protected:true,unavailable:true,reason:'Неподдерживаемый состав или повреждённые метаданные'});}
  }
 }
 return {available:true,items:items.sort((a,b)=>(b.created||0)-(a.created||0))};
}
export async function removeSystemBackup(id,options={}){
 const {updates=UPDATES}=options,[,,key]=parseID(id),guard=protection(updates);
 if(guard.busy||guard.last===key)throw backupFail(guard.busy?'Дождись завершения обновления или восстановления':'Последняя резервная копия защищена от удаления');
 const dir=backupTarget(id,options);backupInventory(dir);fs.rmSync(dir,{recursive:true});return {removed:true};
}
export function createBackupBrowser({acquire=lock,...options}={}){
 let occupied=false;
 return http.createServer(async(req,res)=>{
  let release,claimed=false;
  const reply=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
   if(occupied)throw backupFail('Другая операция с копиями ещё выполняется');
   if(req.method!=='POST'||!['/list','/download','/delete'].includes(req.url))throw backupFail('Не найдено',404);
   let text='';for await(const chunk of req){text+=chunk;if(Buffer.byteLength(text)>1024)throw backupFail('Слишком большой запрос',413);}
   let value;try{value=JSON.parse(text||'{}');}catch{throw backupFail('Неверный запрос',400);}
   if(!value||typeof value!=='object'||Array.isArray(value))throw backupFail('Неверный запрос',400);
   if(Object.keys(value).some(k=>k!=='id'))throw backupFail('Неверный запрос',400);
   if(occupied)throw backupFail('Другая операция с копиями ещё выполняется');occupied=true;claimed=true;
   try{release=await acquire('/run/lock/nexus404-setup.lock',true);}catch{throw backupFail('Установка или другая операция с копиями ещё выполняется');}
   if(req.url==='/list')return reply(listSystemBackups(options));
   if(req.url==='/delete')return reply(await removeSystemBackup(value.id,options));
   const dir=backupTarget(value.id,options),{entries}=backupInventory(dir);
   res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="nexus404-${value.id}.tar.gz"`,'Cache-Control':'no-store','X-Accel-Buffering':'no'});
   await pipeline(Readable.from(archiveFiles(dir,entries)),createGzip({level:1}),res);
  }catch(e){if(!res.headersSent&&!res.destroyed)reply({error:e.status?e.message:'Служба копий не смогла выполнить запрос'},e.status||500);else res.destroy();}
  finally{try{if(release)await release();}finally{if(claimed)occupied=false;}}
 });
}
export function initializeBackupBrowser({control=CONTROL,ownership=true,write=atomic}={}){
 const bridge=path.join(control,'bridge');fs.mkdirSync(bridge,{recursive:true,mode:0o750});fs.chmodSync(bridge,0o750);if(ownership)fs.chownSync(bridge,0,1000);
 write('/etc/systemd/system/nexus404-backup-browser.service',`[Unit]\nDescription=NEXUS404 restricted backup browser\nAfter=docker.service\n[Service]\nExecStart=${NODE} ${HOST}/backup-browser.mjs\nRestart=on-failure\nRestartSec=5s\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nRestrictAddressFamilies=AF_UNIX\n[Install]\nWantedBy=multi-user.target\n`,0o644);
}
if(direct(import.meta.url)){
 const socket=path.join(CONTROL,'bridge/browser.sock');
 if(fs.existsSync(socket)){if(!fs.lstatSync(socket).isSocket())throw Error('Invalid socket path');fs.unlinkSync(socket);}
 const server=createBackupBrowser();server.listen(socket,()=>{fs.chownSync(socket,0,1000);fs.chmodSync(socket,0o660);});
}
