(() => {
  const form=document.querySelector('#hubUpdateForm');if(!form)return;
  const select=document.querySelector('#hubUpdateRelease'),status=document.querySelector('#hubUpdateStatus'),submit=document.querySelector('#hubUpdateSubmit'),consent=document.querySelector('#hubUpdateConsent');
  const busy=['preparing','building','backup','installing','checking','rolling-back'];
  const rollbackConsent=document.querySelector('#hubRollbackConsent'),rollbackButton=document.querySelector('#hubRollbackSubmit');
  const labels={idle:'Готов к обновлению',preparing:'Проверяется архив',building:'Собирается новая версия',backup:'Сохраняется резервная копия',installing:'Устанавливается обновление',checking:'Проверяется запуск',completed:'Обновление установлено',failed:'Обновление не установлено', 'rolling-back':'Восстанавливается предыдущая версия','rolled-back':'Обновление отменено, предыдущая версия восстановлена','recovery-required':'Нужна проверка на сервере','removed':'Хаб удалён с сохранением данных'};
  let model,loading=false,waiting=false,timer,closed=false,optionsKey='',logKey='',backupKey='';
  function journal(){
    const events=Array.isArray(model.status.events)?model.status.events.slice(-40):[],key=JSON.stringify(events);
    document.querySelector('#hubUpdateLogHint').textContent=model.status.protocol!==2?'Для журнала и усиленной защиты один раз обнови сервер через установщик этого выпуска.':events.length?'Последние 40 событий. Во время перезапуска связь прерывается; журнал появится после запуска хаба.':'Обновлений пока не было.';
    if(key!==logKey){
      const nodes=events.map(e=>{const item=document.createElement('li'),time=document.createElement('time'),message=document.createElement('span');const date=new Date(e.time);time.textContent=Number.isFinite(date.getTime())?date.toLocaleString('ru-RU'):'';message.textContent=String(e.message||'').slice(0,600);item.dataset.level=e.level==='error'?'error':'info';item.append(time,message);return item;});
      document.querySelector('#hubUpdateLog').replaceChildren(...nodes);logKey=key;
    }
    const backup=model.status.backup;
    if(backupKey!==backup?.id){backupKey=backup?.id;rollbackConsent.checked=false;}
    document.querySelector('#hubRollbackSection').hidden=model.status.protocol!==2||!backup||backup.version===model.current;
    document.querySelector('#hubRollbackInfo').textContent=backup?'Версия '+backup.version+(Number.isFinite(backup.created)?' · копия от '+new Date(backup.created).toLocaleString('ru-RU'):''):'';
  }
  function selection(){
    const release=model?.releases.find(r=>r.id===select.value);
    document.querySelector('#hubUpdateNotes').textContent=release?.notes||'';
    document.querySelector('#hubUpdateSize').textContent=release?`ZIP · ${(release.size/1024/1024).toFixed(1)} МБ · SHA-256 ${release.sha256}`:'';
    submit.disabled=!release||!consent.checked||!model?.status.available||busy.includes(model.status.phase)||!!model.status.pending||waiting;
    rollbackButton.disabled=!rollbackConsent.checked||model?.status.protocol!==2||!model?.status.backup||model.status.backup.version===model.current||!model.status.available||busy.includes(model.status.phase)||!!model.status.pending||waiting;
  }
  async function refresh(){
    if(loading||closed)return;loading=true;
    try{
      const response=await fetch('/api/hub-update',{cache:'no-store'});
      if(response.status===401){status.textContent='Войди в хаб заново';submit.disabled=true;rollbackButton.disabled=true;select.disabled=true;return;}
      const value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось получить выпуски');
      model=value;waiting=false;
      document.querySelector('#hubUpdateCurrent').textContent='Текущая версия: '+model.current;
      const key=JSON.stringify(model.releases.map(r=>[r.id,r.version,r.sha256,r.compatible]));
      if(key!==optionsKey){
        const previous=select.value;select.replaceChildren(new Option('Выбери версию',''));
        for(const r of model.releases.filter(r=>r.compatible))select.add(new Option(r.version,r.id));
        if([...select.options].some(o=>o.value===previous))select.value=previous;
        consent.checked=false;optionsKey=key;
      }
      select.disabled=!model.status.available||busy.includes(model.status.phase)||!!model.status.pending;
      status.textContent=model.status.phase==='recovery-required'?labels[model.status.phase]:!model.status.available?'Служба недоступна. Для первого включения обнови сервер через установщик.':model.status.pending?'Запрос принят, ожидается запуск':labels[model.status.phase]||'Проверка состояния';
      if(model.status.error)status.textContent+=' · '+model.status.error;
      if(model.catalogError)status.textContent+=' · '+model.catalogError;
      else if(!model.project)status.textContent+=' · Создай в Дедале проект с точным именем NEXUS404 и загрузи полный ZIP выпуска.';
      else if(!model.releases.some(r=>r.compatible))status.textContent+=' · Более новых версий нет. Версия в Дедале должна иметь вид 0.35.262.';
      journal();selection();
    }catch(error){status.textContent=waiting||busy.includes(model?.status.phase)?'Хаб перезапускается. Проверка продолжится автоматически.':error.message;submit.disabled=true;rollbackButton.disabled=true;}
    finally{loading=false;clearTimeout(timer);if(!closed)timer=setTimeout(refresh,5000);}
  }
  select.addEventListener('change',()=>{consent.checked=false;selection();});consent.addEventListener('change',selection);
  document.querySelector('#hubUpdateRefresh').addEventListener('click',refresh);
  rollbackConsent.addEventListener('change',selection);
  rollbackButton.addEventListener('click',async()=>{
    if(rollbackButton.disabled)return;waiting=true;selection();
    try{
      const response=await fetch('/api/hub-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rollback',backupId:model.status.backup.id,confirmation:'NEXUS404'})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось отправить запрос возврата');
      rollbackConsent.checked=false;status.textContent='Запрос возврата принят. Результат появится после перезапуска хаба.';
    }catch(error){waiting=false;status.textContent=error.message;selection();}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(submit.disabled)return;
    const release=model.releases.find(r=>r.id===select.value);submit.disabled=true;waiting=true;
    try{
      const response=await fetch('/api/hub-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:model.project.id,release:release.id,version:release.version,sha256:release.sha256,confirmation:'NEXUS404'})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось отправить запрос');
      status.textContent='Запрос принят. Оставь страницу открытой — результат появится автоматически.';consent.checked=false;
    }catch(error){waiting=false;status.textContent=error.message;selection();}
  });
  window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);});
  window.addEventListener('pageshow',()=>{closed=false;refresh();});refresh();
})();
