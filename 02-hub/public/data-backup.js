(()=>{
 const $=id=>document.getElementById(id);if(!$('dataBackupForm'))return;
 const labels={idle:'Выбери состав копии',preparing:'Подготавливается снимок. Хаб скоро снова будет доступен.',ready:'Копия готова к скачиванию',deleted:'Временный снимок удалён с сервера',expired:'Срок хранения снимка истёк. Создай новую копию',failed:'Не удалось подготовить копию','recovery-required':'Нужна проверка на сервере'};
 let state,busy=false,closed=false,timer;
 async function api(value){const r=await fetch('/api/data-backup',{method:value?'POST':'GET',cache:'no-store',signal:AbortSignal.timeout(10000),...(value?{headers:{'Content-Type':'application/json'},body:JSON.stringify(value)}:{})});const s=await r.json();if(!r.ok)throw Error(s.error||'Не удалось выполнить запрос');return s;}
 async function load(){
  clearTimeout(timer);if(closed)return;
  try{
   state=await api();const waiting=state.pending||state.phase==='preparing',ready=state.available&&state.phase==='ready'&&!state.pending;
   $('dataBackupStatus').textContent=!state.available?'Для резервных копий примени полный выпуск через установщик.':state.pending?'Запрос принят, ожидается сервер':state.error||labels[state.phase]||'Проверка состояния';
   $('dataBackupCreate').disabled=busy||!state.available||waiting||state.phase==='ready'||state.phase==='recovery-required';$('dataBackupChoices').disabled=busy||waiting||state.phase==='ready';
   if(['ready','preparing'].includes(state.phase))for(const input of $('dataBackupChoices').querySelectorAll('input[name=mode]'))input.checked=input.value===state.mode;
   $('dataBackupReady').hidden=!ready;$('dataBackupID').value=ready?state.snapshotId:'';
   $('dataBackupDetails').textContent=ready?`${state.files} файлов · ${(state.bytes/1024/1024/1024).toFixed(2)} ГиБ до сжатия · доступно до ${new Date(state.expires).toLocaleTimeString('ru-RU')}`:'';
  }catch(e){$('dataBackupStatus').textContent=state?.pending||state?.phase==='preparing'?'Хаб временно недоступен. Проверка продолжится автоматически.':e.message;$('dataBackupCreate').disabled=true;$('dataBackupReady').hidden=true;}
  finally{if(!closed)timer=setTimeout(load,5000);}
 }
 async function action(value){if(busy)return;busy=true;$('dataBackupCreate').disabled=true;try{await api(value);}catch(e){$('dataBackupStatus').textContent=e.message;busy=false;return;}busy=false;await load();}
 $('dataBackupForm').onsubmit=e=>{e.preventDefault();if($('dataBackupCreate').disabled)return;action({action:'create',mode:new FormData(e.currentTarget).get('mode')});};
 $('dataBackupDelete').onclick=()=>action({action:'delete',snapshotId:state.snapshotId});
 $('dataBackupDownload').onsubmit=()=>{$('dataBackupStatus').textContent='Передача началась. Следи за загрузками браузера; при обрыве скачай ещё раз.';};
 addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);});addEventListener('pageshow',()=>{closed=false;load();});load();
})();
