(()=>{
 const $=id=>document.getElementById(id);if(!$('maintenanceSettings'))return;
 let state,busy=false,dirty=false,timer;
 const setDisabled=value=>{$('maintenanceFields').disabled=value;$('maintenanceSave').disabled=value;};
 const status=text=>$('maintenanceStatus').textContent=text;
 const api=async data=>{const r=await fetch('/api/maintenance',{method:data?'POST':'GET',cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(15000),...(data?{headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}:{})});const v=await r.json();if(!r.ok)throw Error(v.error||'Не удалось сохранить расписание');return v;};
 function fill(c){
  $('maintReboot').checked=c.reboot.enabled;$('maintDay').value=c.reboot.day;$('maintRebootTime').value=c.reboot.time;
  $('maintCleanup').checked=c.cleanup.enabled;$('maintCleanupTime').value=c.cleanup.time;$('maintAfterReboot').checked=c.cleanup.afterReboot;
  $('maintHealth').checked=c.health.enabled;$('maintHealthTime').value=c.health.time;
  $('maintSecurity').checked=c.securityReboot.enabled;$('maintSecurityTime').value=c.securityReboot.time;
 }
 async function load(){
  clearTimeout(timer);
  try{const next=await api();state=next;
   $('maintenanceZone').textContent=next.timezone?'Часовой пояс сервера: '+next.timezone:'';
   if(!dirty&&next.config)fill(next.pending?.config||next.config);
   setDisabled(busy||!next.available||!!next.pending);
   status(!next.available?(next.error||'Служба обслуживания не отвечает. Сохранение недоступно'):next.pending?'Ожидается применение сервером…':next.result==='rejected'?'Не применено: '+next.error:'Расписание применено'+(next.updated?' · '+new Date(next.updated).toLocaleString('ru-RU',{timeZone:next.timezone}):''));
   if(next.pending&&next.available)timer=setTimeout(load,5000);
  }catch(e){status(e.message);setDisabled(true);}
 }
 $('maintenanceForm').addEventListener('input',()=>{dirty=true;});
 $('maintenanceRefresh').onclick=()=>load();
 $('maintenanceForm').onsubmit=async e=>{
  e.preventDefault();if(busy||!state?.available||state.pending)return;
  const config={reboot:{enabled:$('maintReboot').checked,day:Number($('maintDay').value),time:$('maintRebootTime').value},cleanup:{enabled:$('maintCleanup').checked,time:$('maintCleanupTime').value,afterReboot:$('maintAfterReboot').checked},health:{enabled:$('maintHealth').checked,time:$('maintHealthTime').value},securityReboot:{enabled:$('maintSecurity').checked,time:$('maintSecurityTime').value}};
  const lines=[config.reboot.enabled?'Перезагрузка: '+$('maintDay').selectedOptions[0].text+' '+config.reboot.time:'Еженедельная перезагрузка выключена',config.cleanup.enabled?'Очистка ежедневно: '+config.cleanup.time:'Ежедневная очистка выключена',config.cleanup.afterReboot?'Очистка после перезагрузки включена':'Очистка после перезагрузки выключена',config.health.enabled?'Проверка: '+config.health.time:'Ежедневная проверка выключена',config.securityReboot.enabled?'Перезагрузка при необходимости после обновлений: '+config.securityReboot.time:'Перезагрузка после обновлений выключена'];
  if(!await Nexus.confirm(lines.join('\n')+'\nЧасовой пояс: '+state.timezone,{title:'Применить расписание?'}))return;
  busy=true;setDisabled(true);
  try{await api({config,version:state.version});dirty=false;}catch(e){status(e.message);busy=false;setDisabled(false);return;}
  busy=false;await load();
 };
 addEventListener('pagehide',()=>clearTimeout(timer));load();
})();
