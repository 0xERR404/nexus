import fs from 'node:fs';
import {BASE,HOST,NODE,atomic,read,json,lock,direct} from './common.mjs';
import {cronSchedule,installSchedules} from './maintenance.mjs';
import {maintenanceDefaults,maintenanceConfig,maintenanceCron} from '../02-hub/src/maintenance-schema.mjs';
const CONTROL='/var/lib/nexus404-control';
export function readManaged(base=BASE) {return json(base+'/maintenance-settings.json');}
export function initialSettings({readFile=read}={}) {
  const c=maintenanceDefaults();
  const r=cronSchedule('/etc/cron.d/deploy_kit_weekly_reboot',readFile),h=cronSchedule('/etc/cron.d/deploy_kit_healthcheck',readFile);
  if(r && /^\d$/.test(r.day) && +r.day<7)c.reboot={enabled:true,day:+r.day,time:r.time};
  if(!h && readFile('/etc/cron.d/deploy_kit_healthcheck').trim())c.health.enabled=false;
  if(h && h.day==='*')c.health={enabled:true,time:h.time};
  // Read the actual reboot row, not the warning five minutes earlier.
  const s=readFile('/etc/cron.d/nexus404_security_reboot').split('\n').find(x=>/\ssecurity-reboot\s*$/.test(x));
  if(s){const [m,h]=s.trim().split(/\s+/);if(/^\d+$/.test(m)&&+m<60&&/^\d+$/.test(h)&&+h<24)c.securityReboot={enabled:true,time:h.padStart(2,'0')+':'+m.padStart(2,'0')};}
  return maintenanceConfig(c);
}
export function hostBoot({readFile=read}={}) {
  const id=readFile('/proc/sys/kernel/random/boot_id').trim();
  const seconds=Number(/^btime (\d+)$/m.exec(readFile('/proc/stat'))?.[1]);
  return /^[a-f0-9-]{36}$/.test(id)&&Number.isSafeInteger(seconds)&&seconds>0
    ? {id,startedAt:seconds*1000} : null;
}
export function publish(state,{control=CONTROL,base=BASE,now=Date.now,boot=hostBoot}={}) {
  atomic(control+'/status/status.json',JSON.stringify({...state,heartbeat:now(),installed:fs.existsSync(base+'/installed.flag'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,boot:boot()}),0o644);
}
export function initializeControl({base=BASE,control=CONTROL,initial=initialSettings(),write=atomic,remove=fs.rmSync,ownership=true}={}) {
  for(const [dir,mode] of [[control,0o755],[control+'/requests',0o700],[control+'/status',0o755]]){
    fs.mkdirSync(dir,{recursive:true,mode});fs.chmodSync(dir,mode);
  }
  if(ownership){fs.chownSync(control,0,0);fs.chownSync(control+'/status',0,0);fs.chownSync(control+'/requests',1000,1000);}
  let state=readManaged(base);
  if(!state){state={version:0,config:maintenanceConfig(initial),requestId:null,result:'applied',updated:Date.now()};atomic(base+'/maintenance-settings.json',JSON.stringify(state));}
  state.config=maintenanceConfig(state.config);
  installSchedules(state.config.reboot.time,state.config.reboot.day,state.config.health.time,{write,remove,settings:state.config});
  publish(state,{control,base});
  write('/etc/systemd/system/nexus404-maintenance-control.service',`[Unit]\nDescription=NEXUS404 maintenance settings\n[Service]\nType=oneshot\nExecStart=${NODE} ${HOST}/maintenance-control.mjs\nTimeoutStartSec=30\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/etc/cron.d /var/lib/nexus404-base /var/lib/nexus404-control/status /run/lock\n`,0o644);
  write('/etc/systemd/system/nexus404-maintenance-control.timer','[Unit]\nDescription=NEXUS404 apply hub maintenance settings\n[Timer]\nOnBootSec=30s\nOnUnitInactiveSec=30s\nAccuracySec=5s\n[Install]\nWantedBy=timers.target\n',0o644);
  return state;
}
function readRequest(file){
  let fd;
  try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
    const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>8192||stat.nlink!==1)throw Error('Неверный файл запроса');
    const buffer=Buffer.alloc(8193),count=fs.readSync(fd,buffer,0,buffer.length,0);if(count>8192)throw Error('Слишком большой запрос');
    return JSON.parse(buffer.subarray(0,count).toString('utf8'));
  }catch(e){if(e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}
}
export async function applyPending({base=BASE,control=CONTROL,write=atomic,readFile=file=>{try{return fs.readFileSync(file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}},now=Date.now,acquire=lock}={}){
  let release;
  try{release=await acquire('/run/lock/nexus404-setup.lock',true);}catch(e){if(e.code==='ELOCKED')return;throw e;}
  try{
    let state=readManaged(base);if(!state)return;
    // Recover an interrupted multi-file update from the last committed private state.
    for(const [file,value] of Object.entries(maintenanceCron(state.config,NODE,HOST)))
      if(readFile(file)!==value)write(file,value,0o644);
    let request;
    try{request=readRequest(control+'/requests/request.json');}catch{publish({...state,error:'Повреждённый запрос настроек'},{control,base,now});return;}
    if(!request||request.id===state.requestId){publish(state,{control,base,now});return;}
    if(typeof request.id!=='string'||!/^[a-f0-9-]{36}$/.test(request.id)){publish({...state,error:'Некорректный идентификатор запроса'},{control,base,now});return;}
    let config;
    try{
      if(!fs.existsSync(base+'/installed.flag'))throw Error('Сначала заверши базовую настройку сервера');
      if(Object.keys(request).sort().join()!=='config,created,id,version')throw Error('Неверные поля запроса');
      if(request.version!==state.version)throw Error('Расписание уже изменилось. Обнови страницу');
      if(!Number.isSafeInteger(request.created)||now()-request.created>900000||request.created>now()+300000)throw Error('Запрос устарел. Сохрани настройки ещё раз');
      config=maintenanceConfig(request.config);
    }catch(e){state={...state,requestId:request.id,result:'rejected',error:e.message};atomic(base+'/maintenance-settings.json',JSON.stringify(state));publish(state,{control,base,now});return;}
    const before={};
    try{
      for(const [file,value] of Object.entries(maintenanceCron(config,NODE,HOST))){before[file]=readFile(file);write(file,value,0o644);}
      state={version:state.version+1,config,requestId:request.id,result:'applied',updated:now()};
      atomic(base+'/maintenance-settings.json',JSON.stringify(state));
    }catch(e){
      // The previous private state remains authoritative until every cron file is saved.
      for(const [file,value] of Object.entries(before))write(file,value,0o644);
      state={...readManaged(base),requestId:request.id,result:'rejected',error:'Не удалось применить расписание; прежние настройки восстановлены'};
      atomic(base+'/maintenance-settings.json',JSON.stringify(state));
    }
    publish(state,{control,base,now});
  }finally{await release();}
}
if(direct(import.meta.url))applyPending().catch(()=>{console.error('Не удалось применить настройки обслуживания');process.exitCode=1;});
