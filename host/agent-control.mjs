import fs from 'node:fs';
import {BASE,HOST,NODE,atomic,json,query,lock,direct} from './common.mjs';
import {installCleanup} from './maintenance.mjs';
import {maintenanceCron} from '../02-hub/src/maintenance-schema.mjs';
import {agentConfig,agentDefaults,durable,readState,uuid} from '../02-hub/src/agent-protocol.mjs';
import {initialSettings} from './maintenance-control.mjs';
export function writeCron(file,text,mode=0o644){atomic(file,text,mode);const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const dir=fs.openSync('/etc/cron.d','r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
export const AGENT_CONTROL='/var/lib/nexus404-agent-control';
export function agentCron(config) {
  return Object.fromEntries(Object.entries(maintenanceCron(config.maintenance,NODE,HOST)).map(([file,value])=>[file,value.replaceAll('/maintenance.mjs','/agent-jobs.mjs')]));
}
export function installAgentControl({base=BASE,control=AGENT_CONTROL,write=atomic,inspect=query}={}) {
  fs.mkdirSync(control+'/requests',{recursive:true});fs.mkdirSync(control+'/status',{recursive:true});
  let state=readState(base+'/agent-maintenance.json',null);
  if(!state){
    const config=agentDefaults();config.timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
    if(fs.existsSync(base+'/installed.flag'))config.maintenance=json(base+'/maintenance-settings.json')?.config??initialSettings();
    else {for(const row of Object.values(config.maintenance))row.enabled=false;config.maintenance.cleanup.afterReboot=false;}
    config.services=config.services.filter(name=>name==='nexus404-agent.service'||inspect('systemctl',['show','-p','LoadState','--value',name]).text==='loaded');
    state={version:0,requestId:null,result:'applied',config};durable(base+'/agent-maintenance.json',state);
  }
  for(const [file,value]of Object.entries(agentCron(state.config)))write(file,value,0o644);
  durable(control+'/status/status.json',state,0o644);
  write('/etc/systemd/system/nexus404-maintenance-control.service',`[Unit]
Description=NEXUS404 agent maintenance settings
[Service]
Type=oneshot
ExecStart=${NODE} ${HOST}/agent-control.mjs
TimeoutStartSec=60
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=/etc/cron.d /var/lib/nexus404-base /var/lib/nexus404-agent-control/status /run/lock
`,0o644);
  write('/etc/systemd/system/nexus404-maintenance-control.timer',`[Unit]
Description=NEXUS404 apply agent maintenance settings
[Timer]
OnBootSec=30s
OnUnitInactiveSec=30s
AccuracySec=5s
[Install]
WantedBy=timers.target
`,0o644);
  installCleanup({write});
  return state;
}
function requestFile(file){let fd;try{fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const s=fs.fstatSync(fd);if(!s.isFile()||s.size>8192||s.nlink!==1)throw Error();return JSON.parse(fs.readFileSync(fd,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}finally{if(fd!==undefined)fs.closeSync(fd);}}
export async function applyAgentPending({base=BASE,control=AGENT_CONTROL,write=writeCron,now=Date.now,acquire=lock,setTimezone=zone=>{if(!query('timedatectl',['set-timezone',zone]).ok)throw Error('timezone');atomic(base+'/timezone',zone+'\n');}}={}) {
  const release=await acquire('/run/lock/nexus404-setup.lock',true);
  try{
    const file=base+'/agent-maintenance.json';let state=readState(file,null);if(!state)return;
    const apply=config=>{setTimezone(config.timezone);for(const [f,v]of Object.entries(agentCron(config)))write(f,v,0o644);durable(base+'/maintenance-settings.json',{version:state.version,config:config.maintenance});};
    // On an interrupted update, restore the last committed schedule before accepting anything.
    if(readState(base+'/agent-maintenance-intent.json',null)){apply(state.config);fs.rmSync(base+'/agent-maintenance-intent.json');}
    let request;try{request=requestFile(control+'/requests/request.json');}catch{durable(control+'/status/status.json',{...state,error:'Повреждённый запрос'},0o644);return;}
    if(!request||request.id===state.requestId){durable(control+'/status/status.json',state,0o644);return;}
    if(Number.isSafeInteger(request.version)&&request.version<=state.version){durable(control+'/status/status.json',state,0o644);return;}
    const reject=()=>{state={...state,requestId:uuid(request.id)?request.id:null,result:'rejected'};durable(file,state);durable(control+'/status/status.json',state,0o644);};
    let config;
    try{
      if(!uuid(request.id)||Object.keys(request).sort().join()!=='config,created,expires,id,version'||!Number.isSafeInteger(request.version)||request.version<=state.version||!Number.isSafeInteger(request.created)||!Number.isSafeInteger(request.expires)||request.created>now()+300000||request.expires<=now()||request.expires-request.created>900000||request.expires<=request.created)throw Error();
      config=agentConfig(request.config);
    }catch{reject();return;}
    durable(base+'/agent-maintenance-intent.json',{id:request.id});
    try{
      apply(config);
      if(now()>=request.expires)throw Error('expired');
      const next={version:request.version,requestId:request.id,result:'applied',config};durable(file,next);state=next;
      fs.rmSync(base+'/agent-maintenance-intent.json');
    }catch{
      apply(state.config);fs.rmSync(base+'/agent-maintenance-intent.json');reject();return;
    }
    durable(control+'/status/status.json',state,0o644);
  }finally{await release();}
}
if(direct(import.meta.url))applyAgentPending().catch(e=>{if(e.code!=='ELOCKED'){console.error('Не удалось применить расписание агента');process.exitCode=1;}});
