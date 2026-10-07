import fs from 'node:fs';
import {BASE,lock,direct,event} from './common.mjs';
import {job} from './maintenance.mjs';
import {maintenanceDue} from '../02-hub/src/maintenance-schema.mjs';
import {durable,readState} from '../02-hub/src/agent-protocol.mjs';
// Cron starts only the current occurrence. No catch-up queue and no remotely supplied commands.
export async function agentJob(name,{base=BASE,now=()=>new Date(),acquire=lock,execute=job}={}) {
  const release=await acquire('/run/lock/nexus404-agent-job.lock',true);
  try{
    const setupRelease=await acquire('/run/lock/nexus404-setup.lock',true);
    try{
      const state=readState(base+'/agent-maintenance.json',null);
      if(!state||fs.existsSync(base+'/agent-maintenance-intent.json'))return;
      if(!['health','pre-reboot','reboot','scheduled-cleanup','pre-security-reboot','security-reboot'].includes(name))throw Error('Неизвестная задача');
      const date=now();if(!maintenanceDue(state.config.maintenance,name,date))return;
      const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:state.config.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).map(p=>[p.type,p.value]));
      const day=parts.year+'-'+parts.month+'-'+parts.day;
      const file=base+'/agent-occurrences.json',done=readState(file,{});
      // At-most-once per local date and job, including DST fallback and configuration redelivery.
      if(done[name]&&done[name]>=day)return;
      durable(file,{...done,[name]:day});
      return await execute(name,{base,now,acquire:async()=>()=>{}});
    }finally{await setupRelease();}
  }finally{await release();}
}
if(direct(import.meta.url))agentJob(process.argv[2]).catch(e=>{if(e.code!=='ELOCKED'){event('system.maintenance.failed','Ошибка выполнения расписания агента');process.exitCode=1;}});
