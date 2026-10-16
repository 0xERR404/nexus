(() => {
  const form=document.querySelector('#hubUpdateForm');if(!form)return;
  const select=document.querySelector('#hubUpdateRelease'),status=document.querySelector('#hubUpdateStatus'),submit=document.querySelector('#hubUpdateSubmit'),consent=document.querySelector('#hubUpdateConsent');
  const busy=['preparing','building','backup','installing','checking','rolling-back'];
  const rollbackConsent=document.querySelector('#hubRollbackConsent'),rollbackButton=document.querySelector('#hubRollbackSubmit');
  const labels={idle:'Готов к обновлению',preparing:'Проверяется архив',building:'Собирается новая версия',backup:'Сохраняется резервная копия',installing:'Устанавливается обновление',checking:'Проверяется запуск',completed:'Обновление установлено',failed:'Обновление не установлено', 'rolling-back':'Восстанавливается предыдущая версия','rolled-back':'Обновление отменено, предыдущая версия восстановлена','recovery-required':'Нужна проверка на сервере','removed':'Хаб удалён с сохранением данных'};
  let model,loading=false,waiting=false,timer,tick,closed=false,optionsKey='',logKey='',backupKey='',disconnected=false,receivedAt=Date.now();
  const steps=['preparing','building','backup','installing','checking'];
  const duration=ms=>{const seconds=Math.max(0,Math.floor(ms/1000));return seconds>=3600?`${Math.floor(seconds/3600)} ч ${Math.floor(seconds%3600/60)} мин`:`${Math.floor(seconds/60)} мин ${String(seconds%60).padStart(2,'0')} с`;};
  function progress(){
    const s=model?.status;if(!s)return;
    const box=document.querySelector('#hubUpdateProgress'),meter=document.querySelector('#hubUpdateMeter'),pending=waiting||s.pending;
    box.hidden=!pending&&!busy.includes(s.phase)&&!s.timing;
    if(box.hidden)return;
    const offline=disconnected||!s.available,idx=steps.indexOf(s.phase),done=s.phase==='completed'?5:Math.max(0,idx);
    const now=Number.isFinite(s.serverTime)?s.serverTime+Date.now()-receivedAt:Date.now();
    const timing=pending?null:s.timing;
    document.querySelector('#hubUpdateStep').textContent=pending?'Ожидание запуска':offline&&busy.includes(s.phase)?'Последний этап: '+labels[s.phase]:idx>=0?`Этап ${idx+1} из 5 · ${labels[s.phase]}`:labels[s.phase]||'Обновление';
    document.querySelector('#hubUpdateElapsed').textContent=Number.isFinite(timing?.started)?(timing.finished?'Время: ':'Прошло: ')+duration((timing.finished||now)-timing.started):'';
    const determinate=!pending&&idx>=0&&!offline||s.phase==='completed'&&!pending;
    if(determinate)meter.setAttribute('aria-valuenow',String(done));else meter.removeAttribute('aria-valuenow');
    meter.setAttribute('aria-valuetext',pending?'Ожидание запуска':offline?'Нет свежих данных':`Завершено этапов: ${done} из 5`);
    [...meter.children].forEach((part,i)=>{part.dataset.state=determinate?(i<done?'done':i===idx?'active':'next'):'next';});
    let remaining='',hint='';
    if(pending)remaining='Служба проверяет очередь примерно каждые 15 секунд.';
    else if(offline&&busy.includes(s.phase)){remaining='Ожидаем связь с сервером…';hint='Последний подтверждённый этап сохранён. Проверка продолжится автоматически.';}
    else if(idx>=0){
      const reference=s.baseline,elapsed=now-timing?.phaseStarted;
      if(timing&&steps.every(p=>Number.isFinite(reference?.[p])&&reference[p]>=0)&&Number.isFinite(elapsed)){
        const estimate=steps.slice(idx).reduce((sum,p)=>sum+reference[p],0)-Math.max(0,elapsed);
        remaining=elapsed>reference[s.phase]||estimate<=0?'Этап идёт дольше прошлого раза. Уточняем остаток…':estimate<60000?'Осталось примерно меньше минуты':`Осталось примерно ${Math.ceil(estimate/60000)} мин`;
        hint='Оценка по предыдущему успешному обновлению. Скорость сети и размер копии могут её изменить.';
      }else{remaining='Оставшееся время пока неизвестно';hint='После первого успешного обновления появится оценка времени. Полоса показывает этапы, а не процент времени.';}
    }else if(s.phase==='rolling-back'){remaining='Восстанавливается резервная копия';hint='Время возврата зависит от размера сохранённых данных.';}
    else if(s.phase==='completed')remaining='Все 5 этапов завершены';
    else remaining=labels[s.phase]||'';
    document.querySelector('#hubUpdateRemaining').textContent=remaining;
    document.querySelector('#hubUpdateProgressHint').textContent=hint;
  }
  function journal(){
    const events=Array.isArray(model.status.events)?model.status.events.slice(-40):[],key=JSON.stringify(events);
    document.querySelector('#hubUpdateLogHint').textContent=model.status.protocol!==2?'Для журнала и усиленной защиты один раз обнови сервер через установщик этого выпуска.':events.length?'Последние 40 событий. Во время перезапуска связь прерывается; журнал появится после запуска хаба.':'Обновлений пока не было.';
    if(key!==logKey){
      const nodes=events.map(e=>{const item=document.createElement('li'),time=document.createElement('time'),message=document.createElement('span');const date=new Date(e.time);time.textContent=Number.isFinite(date.getTime())?date.toLocaleString('ru-RU'):'';message.textContent=String(e.message||'').slice(0,600);item.dataset.level=e.level==='error'?'error':'info';item.append(time,message);return item;});
      document.querySelector('#hubUpdateLog').replaceChildren(...nodes);logKey=key;
    }
    const backup=model.status.backup;
    if(backupKey!==backup?.id){backupKey=backup?.id;rollbackConsent.checked=false;}
    document.querySelector('#hubRollbackSection').hidden=model.status.protocol!==2||!backup||backup.scope!=='system'||backup.version===model.current;
    document.querySelector('#hubRollbackInfo').textContent=backup?'Версия '+backup.version+(Number.isFinite(backup.created)?' · копия от '+new Date(backup.created).toLocaleString('ru-RU'):''):'';
  }
  function selection(){
    const release=model?.releases.find(r=>r.id===select.value);
    document.querySelector('#hubUpdateNotes').textContent=release?.notes||'';
    document.querySelector('#hubUpdateSize').textContent=release?`ZIP · ${(release.size/1024/1024).toFixed(1)} МБ · SHA-256 ${release.sha256}`:'';
    submit.disabled=!release||!consent.checked||!model?.status.available||busy.includes(model.status.phase)||!!model.status.pending||waiting;
    rollbackButton.disabled=!rollbackConsent.checked||model?.status.protocol!==2||!model?.status.backup||model.status.backup.scope!=='system'||model.status.backup.version===model.current||!model.status.available||busy.includes(model.status.phase)||!!model.status.pending||waiting;
  }
  async function refresh(){
    if(loading||closed)return;loading=true;
    try{
      const response=await fetch('/api/hub-update',{cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(response.status===401){disconnected=true;progress();status.textContent='Войди в хаб заново';submit.disabled=true;rollbackButton.disabled=true;select.disabled=true;return;}
      const value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось получить выпуски');
      model=value;waiting=false;disconnected=false;receivedAt=Date.now();
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
      else if(!model.releases.some(r=>r.compatible))status.textContent+=' · Более новых версий нет. Версия в Дедале должна иметь вид 0.35.266.';
      journal();selection();progress();
    }catch(error){disconnected=true;progress();status.textContent=waiting||busy.includes(model?.status.phase)?'Связь с хабом прервалась. Проверка продолжится автоматически.':error.message;submit.disabled=true;rollbackButton.disabled=true;}
    finally{loading=false;clearTimeout(timer);if(!closed)timer=setTimeout(refresh,5000);}
  }
  select.addEventListener('change',()=>{consent.checked=false;selection();});consent.addEventListener('change',selection);
  document.querySelector('#hubUpdateRefresh').addEventListener('click',refresh);
  rollbackConsent.addEventListener('change',selection);
  rollbackButton.addEventListener('click',async()=>{
    if(rollbackButton.disabled)return;waiting=true;selection();progress();
    try{
      const response=await fetch('/api/hub-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'rollback',backupId:model.status.backup.id,confirmation:'NEXUS404'})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось отправить запрос возврата');
      rollbackConsent.checked=false;status.textContent='Запрос возврата принят. Результат появится после перезапуска хаба.';
    }catch(error){waiting=false;status.textContent=error.message;selection();}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(submit.disabled)return;
    const release=model.releases.find(r=>r.id===select.value);submit.disabled=true;waiting=true;selection();progress();
    try{
      const response=await fetch('/api/hub-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({project:model.project.id,release:release.id,version:release.version,sha256:release.sha256,confirmation:'NEXUS404'})});
      const value=await response.json();if(!response.ok)throw Error(value.error||'Не удалось отправить запрос');
      status.textContent='Запрос принят. Оставь страницу открытой — результат появится автоматически.';consent.checked=false;
    }catch(error){waiting=false;status.textContent=error.message;selection();}
  });
  const startTick=()=>{clearInterval(tick);tick=setInterval(progress,1000);};
  window.addEventListener('pagehide',()=>{closed=true;clearTimeout(timer);clearInterval(tick);});
  window.addEventListener('pageshow',()=>{closed=false;startTick();refresh();});startTick();refresh();
})();
