const fail = message => { throw Object.assign(new Error(message), {status:400}); };
export const maintenanceDefaults = () => ({
  reboot:{enabled:false,day:0,time:'06:00'},
  cleanup:{enabled:false,time:'06:30',afterReboot:true},
  health:{enabled:true,time:'05:30'},
  securityReboot:{enabled:false,time:'02:00'}
});
export function maintenanceConfig(value) {
  const shape={reboot:['enabled','day','time'],cleanup:['enabled','time','afterReboot'],health:['enabled','time'],securityReboot:['enabled','time']};
  if(!value || Array.isArray(value) || Object.keys(value).sort().join()!==Object.keys(shape).sort().join())fail('Неверный состав настроек обслуживания');
  const result={};
  for(const [key,fields] of Object.entries(shape)) {
    const row=value[key];
    if(!row || Array.isArray(row) || Object.keys(row).sort().join()!==fields.slice().sort().join())fail('Неверные поля: '+key);
    if(typeof row.enabled!=='boolean' || typeof row.time!=='string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time))fail('Проверь время и переключатель: '+key);
    if(key==='reboot' && (!Number.isInteger(row.day)||row.day<0||row.day>6))fail('Выбери день недели');
    if(key==='cleanup' && typeof row.afterReboot!=='boolean')fail('Проверь очистку после перезагрузки');
    result[key]=Object.fromEntries(fields.map(field=>[field,row[field]]));
  }
  return result;
}
export function maintenanceCron(value, node, host) {
  const c=maintenanceConfig(value), disabled='# NEXUS404: disabled in hub settings\n';
  const line=(row,day,job,notice=false)=>{
    if(!row.enabled)return disabled;
    let [h,m]=row.time.split(':').map(Number), minutes=h*60+m-(notice?5:0);
    if(minutes<0){minutes+=1440;if(day!=='*')day=(day+6)%7;}
    return `${minutes%60} ${Math.floor(minutes/60)} * * ${day} root ${node} ${host}/maintenance.mjs ${job}\n`;
  };
  return {
    '/etc/cron.d/deploy_kit_weekly_reboot':line(c.reboot,c.reboot.day,'reboot'),
    '/etc/cron.d/nexus404_reboot_notice':line(c.reboot,c.reboot.day,'pre-reboot',true),
    '/etc/cron.d/deploy_kit_healthcheck':line(c.health,'*','health'),
    '/etc/cron.d/nexus404_security_reboot':c.securityReboot.enabled?line(c.securityReboot,'*','pre-security-reboot',true)+line(c.securityReboot,'*','security-reboot'):disabled,
    '/etc/cron.d/nexus404_scheduled_cleanup':line(c.cleanup,'*','scheduled-cleanup')
  };
}
export function maintenanceDue(config,job,date=new Date()) {
  const c=maintenanceConfig(config);
  if(job==='cleanup')return c.cleanup.afterReboot;
  const row=job.includes('security')?c.securityReboot:job.includes('reboot')?c.reboot:job==='health'?c.health:c.cleanup;
  if(!row.enabled)return false;
  let [h,m]=row.time.split(':').map(Number),minute=h*60+m,day=row===c.reboot?c.reboot.day:null;
  if(job.startsWith('pre-')){minute-=5;if(minute<0){minute+=1440;if(day!==null)day=(day+6)%7;}}
  return date.getHours()*60+date.getMinutes()===minute&&(day===null||date.getDay()===day);
}
