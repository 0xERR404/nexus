import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {maintenanceConfig} from './maintenance-schema.mjs';
const fail=(message,status=503)=>{throw Object.assign(new Error(message),{status});};
export class Maintenance {
  constructor(directory=process.env.MAINTENANCE_DIRECTORY){this.directory=directory;}
  file(name){if(!this.directory)fail('Обнови сервер штатным установщиком, чтобы подключить обслуживание');return path.join(this.directory,name);}
  status(){
    try{
      const state=JSON.parse(fs.readFileSync(this.file('status/status.json'),'utf8'));
      state.available=Number.isFinite(state.heartbeat)&&Date.now()-state.heartbeat<180000&&state.installed===true;
      const request=this.pending();
      state.pending=request&&request.id!==state.requestId?{id:request.id,created:request.created,config:request.config}:null;
      return state;
    }catch{return {available:false,pending:null,error:'Служба обслуживания недоступна. Обнови сервер штатным установщиком'};}
  }
  pending(){try{return JSON.parse(fs.readFileSync(this.file('requests/request.json'),'utf8'));}catch{return null;}}
  save(value){
    const config=maintenanceConfig(value?.config), state=this.status();
    if(!state.available)fail(state.error||'Служба обслуживания не отвечает или базовая настройка не завершена');
    if(value.version!==state.version)fail('Расписание изменилось. Обнови страницу',409);
    if(state.pending)fail('Предыдущие настройки ещё применяются',409);
    const request={id:randomUUID(),version:state.version,created:Date.now(),config};
    const file=this.file('requests/request.json'),temp=file+'.'+request.id;
    try{fs.writeFileSync(temp,JSON.stringify(request),{flag:'wx',mode:0o600});fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
    return {queued:true,id:request.id};
  }
}
export const maintenanceContent=`<link rel="stylesheet" href="/maintenance.css"><script src="/maintenance.js" defer></script>
<section id="maintenanceSettings"><h2>Обслуживание сервера</h2><p id="maintenanceZone"></p><p id="maintenanceStatus" role="status">Чтение расписания…</p>
<form id="maintenanceForm"><fieldset id="maintenanceFields" disabled><div class="maintenance-grid">
<section><h3>Перезагрузка</h3><label><input type="checkbox" id="maintReboot">Раз в неделю</label><div class="maintenance-row"><label>День<select id="maintDay">${['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'].map((x,i)=>`<option value="${i}">${x}</option>`).join('')}</select></label><label>Время<input id="maintRebootTime" type="time" required></label></div><p>Предупреждение за 5 минут. Во время установки обновлений перезагрузка пропускается.</p></section>
<section><h3>Автоочистка</h3><label><input type="checkbox" id="maintCleanup">Каждый день</label><label>Время<input id="maintCleanupTime" type="time" required></label><label><input type="checkbox" id="maintAfterReboot">После плановой перезагрузки</label><p>Ненужные пакеты, устаревший кэш APT и системный журнал старше 7 дней. Файлы и данные хаба сохраняются.</p></section>
<section><h3>Проверка сервера</h3><label><input type="checkbox" id="maintHealth">Каждый день</label><label>Время<input id="maintHealthTime" type="time" required></label><p>Проверка служб и безопасности. Проверка после загрузки сервера остаётся включённой.</p></section>
<section><h3>После обновлений</h3><label><input type="checkbox" id="maintSecurity">Разрешить автоматическую перезагрузку</label><label>Время<input id="maintSecurityTime" type="time" required></label><p>Только если система сообщает, что нужна перезагрузка. Предупреждение за 5 минут.</p></section>
</div><button type="submit">Сохранить расписание</button></fieldset></form><button id="maintenanceRefresh" type="button">Обновить статус</button><p>Изменения применяются обычно в течение минуты. Часовой пояс и состояние службы показаны выше.</p></section>`;
