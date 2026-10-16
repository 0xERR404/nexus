import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
const ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const updateError=(text,status=409)=>Object.assign(new Error(text),{status});
export function versionParts(value) {
  if(typeof value!=='string'||!/^v?\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(value))throw updateError('Версия выпуска должна иметь вид 0.35.266');
  return value.replace(/^v/,'').split('.').map(Number);
}
export function newerVersion(next,current){
  const a=versionParts(next),b=versionParts(current);
  for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]>b[i];
  return false;
}
export function updateRequest(value,now=Date.now()) {
  if(!value||Object.keys(value).sort().join()!=='created,expectedVersion,id,project,release,sha256,version'||
    ![value.id,value.project,value.release].every(v=>typeof v==='string'&&ID.test(v))||
    typeof value.sha256!=='string'||! /^[a-f0-9]{64}$/.test(value.sha256)||
    !Number.isSafeInteger(value.created)||value.created>now+60000||now-value.created>900000)
    throw updateError('Неверный или устаревший запрос обновления');
  if(!newerVersion(value.version,value.expectedVersion))throw updateError('Можно устанавливать только более новый выпуск');
  return value;
}
export function rollbackRequest(value,now=Date.now()){
  if(!value||Object.keys(value).sort().join()!=='action,backupId,created,expectedVersion,id'||value.action!=='rollback'||
    ![value.id,value.backupId].every(v=>typeof v==='string'&&ID.test(v))||!Number.isSafeInteger(value.created)||value.created>now+60000||now-value.created>900000)
    throw updateError('Неверный или устаревший запрос возврата');
  versionParts(value.expectedVersion);return value;
}
export function updateCatalog(directory) {
  const file=path.join(directory,'projects','projects.sqlite');
  if(!fs.existsSync(file))return {project:null,releases:[]};
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('PRAGMA busy_timeout=3000');
    const matches=db.prepare('SELECT id,name FROM projects WHERE name = ? COLLATE BINARY').all('NEXUS404');
    if(matches.length>1)throw updateError('В Дедале несколько проектов NEXUS404. Оставь это имя только у одного проекта');
    if(!matches.length)return {project:null,releases:[]};
    const project=matches[0];
    return {project,releases:db.prepare('SELECT id,version,notes,sha256,size,created FROM releases WHERE project=? ORDER BY created DESC').all(project.id)};
  }finally{db.close();}
}
export function selectUpdate(directory,request){
  const catalog=updateCatalog(directory);
  const release=catalog.releases.find(r=>r.id===request.release);
  if(catalog.project?.id!==request.project||!release||release.sha256!==request.sha256||release.version!==request.version)
    throw updateError('Проект или выпуск изменён в Дедале. Выбери архив заново');
  return release;
}
export class HubUpdates {
  constructor(data,current,directory=process.env.HUB_UPDATE_DIRECTORY){Object.assign(this,{data,current,directory});}
  status(){
    let state={phase:'idle',available:false};
    try{
      state=JSON.parse(fs.readFileSync(path.join(this.directory,'status/status.json'),'utf8'));
      state.available=Number.isFinite(state.heartbeat)&&Date.now()-state.heartbeat<180000&&!['removed','recovery-required'].includes(state.phase);
    }catch{}
    let pending;
    try{pending=JSON.parse(fs.readFileSync(path.join(this.directory,'requests/request.json'),'utf8'));}catch{}
    if(pending&&pending.id!==state.requestId&&Date.now()-pending.created<900000)state.pending=true;
    state.serverTime=Date.now();
    return state;
  }
  list(){
    let catalog={project:null,releases:[]},catalogError;
    try{if(this.data)catalog=updateCatalog(this.data);}catch{catalogError='Не удалось прочитать выпуски Дедала. Проверь доступность модуля и единственность проекта NEXUS404.';}
    return {...catalog,catalogError,current:this.current,status:this.status(),releases:catalog.releases.map(r=>{
      let compatible=false;try{compatible=newerVersion(r.version,this.current);}catch{}
      return {...r,compatible};
    })};
  }
  queue(value){
    if(value?.confirmation!=='NEXUS404')throw updateError('Подтверди установку выпуска NEXUS404');
    const state=this.status();
    if(!state.available)throw updateError('Сначала обнови сервер этим выпуском через установщик: служба обновления недоступна',503);
    if(state.pending||['preparing','building','backup','installing','checking','rolling-back'].includes(state.phase))throw updateError('Обновление уже выполняется');
    let request;
    if(value.action==='rollback'){
      if(state.protocol!==2||!state.backup||state.backup.scope!=='system'||state.backup.id!==value.backupId||state.backup.version===this.current)throw updateError('Проверенная копия для возврата недоступна');
      request=rollbackRequest({action:'rollback',id:randomUUID(),created:Date.now(),backupId:value.backupId,expectedVersion:this.current});
    }else{
      if(value.action!==undefined)throw updateError('Неизвестная операция');
      request=updateRequest({id:randomUUID(),created:Date.now(),project:value.project,release:value.release,version:value.version,sha256:value.sha256,expectedVersion:this.current});
      selectUpdate(this.data,request);
    }
    const target=path.join(this.directory,'requests/request.json'),tmp=target+'.'+request.id;
    try{fs.writeFileSync(tmp,JSON.stringify(request),{flag:'wx',mode:0o600});fs.renameSync(tmp,target);}finally{fs.rmSync(tmp,{force:true});}
    return {queued:true,id:request.id};
  }
}
export const updateContent=`<script src="/updates.js" defer></script><link rel="stylesheet" href="/updates.css">
<section class="hub-updates"><p>Архивы только из проекта <strong>NEXUS404</strong> в Дедале. Имя должно совпадать полностью.</p>
<p id="hubUpdateCurrent"></p><p id="hubUpdateStatus" role="status">Загрузка выпусков…</p>
<section id="hubUpdateProgress" class="hub-update-progress" aria-label="Ход обновления" hidden>
<div class="hub-update-progress-heading"><strong id="hubUpdateStep"></strong><span id="hubUpdateElapsed" class="muted"></span></div>
<div id="hubUpdateMeter" class="hub-update-meter" role="progressbar" aria-label="Завершённые этапы обновления" aria-valuemin="0" aria-valuemax="5"><span></span><span></span><span></span><span></span><span></span></div>
<p id="hubUpdateRemaining"></p><p id="hubUpdateProgressHint" class="muted"></p></section>
<form id="hubUpdateForm"><label for="hubUpdateRelease">Новый выпуск</label><select id="hubUpdateRelease" required disabled><option value="">Выбери версию</option></select>
<p id="hubUpdateNotes" class="muted"></p><p id="hubUpdateSize" class="muted"></p>
<p>Обновятся хаб и установленные модули. Перед заменой сохраняется копия кода и образ для отката. Файлы, базы и настройки находятся в отдельном хранилище и не копируются. Во время запуска новой версии хаб и плеер будут недоступны.</p>
<label class="hub-update-consent"><input id="hubUpdateConsent" type="checkbox" required>Подтверждаю установку выбранного архива из Дедала</label>
<div class="hub-update-actions"><button id="hubUpdateSubmit" type="submit" disabled>Установить обновление</button><button id="hubUpdateRefresh" type="button">Обновить список</button></div></form>
<section class="hub-update-journal" aria-labelledby="hubUpdateLogTitle"><h3 id="hubUpdateLogTitle">Журнал обновлений</h3><p id="hubUpdateLogHint" class="muted">Загрузка журнала…</p><ol id="hubUpdateLog" aria-label="Этапы и ошибки обновления"></ol></section>
<section id="hubRollbackSection" hidden><h3>Вернуть предыдущую версию</h3><p id="hubRollbackInfo"></p><p>Вернётся только код хаба и модулей. Загруженные файлы, базы и настройки останутся текущими. Копия кода не заменяет резервное копирование данных. Во время возврата хаб будет недоступен.</p><label class="hub-update-consent"><input id="hubRollbackConsent" type="checkbox">Подтверждаю возврат кода из резервной копии</label><button id="hubRollbackSubmit" type="button" disabled>Вернуть предыдущую версию</button></section>
<p class="muted">Загружай только доверенные выпуски: архив содержит исполняемый код. Совпадение названия не подтверждает автора архива. ОС, установщик и удалённые VPN-ноды обновляются отдельно через меню сервера.</p>
<details><summary>Удаление и восстановление</summary><p>В установщике: «Хаб и модули → Удалить хаб и модули · сохранить данные». Файлы, базы и настройки останутся на сервере. Для восстановления распакуй новый полный выпуск и выбери «Восстановить хаб и модули из сохранённых данных».</p><p>Сохранение на том же диске не заменяет внешнюю резервную копию.</p></details></section>`;
