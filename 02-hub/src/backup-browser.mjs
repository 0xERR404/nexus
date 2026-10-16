import http from 'node:http';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {backupFail} from './data-backup.mjs';
export class BackupBrowser{
 constructor(socket=process.env.DATA_BACKUP_DIRECTORY&&path.join(process.env.DATA_BACKUP_DIRECTORY,'bridge/browser.sock')){this.socket=socket;}
 async connect(action,id){
  if(!this.socket)throw backupFail('Для просмотра системных копий примени полный выпуск через установщик',503);
  if(action!=='list'&&(typeof id!=='string'||!/^(update|failed)-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id??'')))throw backupFail('Копия не найдена',404);
  return new Promise((resolve,reject)=>{
   const request=http.request({socketPath:this.socket,path:'/'+action,method:'POST',headers:{'Content-Type':'application/json'}},response=>{request.setTimeout(0);resolve(response);});
   request.setTimeout(45000,()=>request.destroy(Error('Timeout')));
   request.on('error',()=>reject(backupFail('Служба системных копий недоступна',503)));request.end(JSON.stringify(id?{id}:{}));
  });
 }
 async result(response){
  let bytes='';for await(const chunk of response){bytes+=chunk;if(Buffer.byteLength(bytes)>2*1024*1024){response.destroy();throw backupFail('Список копий слишком большой');}}
  let data;try{data=JSON.parse(bytes);}catch{throw backupFail('Не удалось прочитать ответ службы',503);}
  if(response.statusCode!==200)throw backupFail(data.error||'Ошибка службы копий',response.statusCode);return data;
 }
 async list(){return this.result(await this.connect('list'));}
 async remove(id){return this.result(await this.connect('delete',id));}
 async download(id,response,authorized=()=>true){
  const source=await this.connect('download',id);
  if(source.statusCode!==200)return this.result(source);
  if(!authorized()||response.destroyed){source.destroy();throw backupFail('Сессия завершена',401);}
  response.setHeader('Content-Type','application/gzip');response.setHeader('Content-Disposition',`attachment; filename="nexus404-${id}.tar.gz"`);response.setHeader('Cache-Control','no-store');response.setHeader('X-Accel-Buffering','no');
  const timer=setInterval(()=>{if(!authorized()){source.destroy();response.destroy();}},10000);
  try{await pipeline(source,response);}finally{clearInterval(timer);source.destroy();}
 }
}
