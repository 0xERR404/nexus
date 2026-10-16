(() => {
  const form=document.querySelector('#hubUpdateForm');if(!form)return;
  const select=document.querySelector('#hubUpdateRelease'),status=document.querySelector('#hubUpdateStatus'),submit=document.querySelector('#hubUpdateSubmit'),consent=document.querySelector('#hubUpdateConsent');
  const busy=['preparing','building','backup','installing','checking','rolling-back'];
  const labels={idle:'Готов к обновлению',preparing:'Проверяется архив',building:'Собирается новая версия',backup:'Сохраняется резервная копия',installing:'Устанавливается обновление',checking:'Проверяется запуск',completed:'Обновление установлено',failed:'Обновление не установлено', 'rolling-back':'Восстанавливается предыдущая версия','rolled-back':'Обновление отменено, предыдущая версия восстановлена','recovery-required':'Нужна проверка на сервере','removed':'Хаб удалён с сохранением данных'};
  let model,loading=false,waiting=false,timer,closed=false,optionsKey='';
  function selection(){
    const release=model?.releases.find(r=>r.id===select.value);
    document.querySelector('#hubUpdateNotes').textContent=release?.notes||'';
    document.querySelector('#hubUpdateSize').textContent=release?`ZIP · ${(release.size/1024/1024).toFixed(1)} МБ · SHA-256 ${release.sha256}`:'';
    submit.disabled=!release||!consent.checked||!model?.status.available||busy.includes(model.status.phase)||!!model.status.pending||waiting;
  }
  async function refresh(){
    if(loading||closed)return;loading=true;
    try{
      const response=await fetch('/api/hub-update',{cache:'no-store'});
      if(response.status===401){status.textContent='Войди в хаб заново';return;}
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
      if(!model.project)status.textContent+=' · Создай в Дедале проект с точным именем NEXUS404 и загрузи полный ZIP выпуска.';
      else if(!model.releases.some(r=>r.compatible))status.textContent+=' · Более новых версий нет. Версия в Дедале должна иметь вид 0.35.258.';
      selection();
    }catch(error){status.textContent=waiting||busy.includes(model?.status.phase)?'Хаб перезапускается. Проверка продолжится автоматически.':error.message;submit.disabled=true;}
    finally{loading=false;clearTimeout(timer);if(!closed)timer=setTimeout(refresh,5000);}
  }
  select.addEventListener('change',()=>{consent.checked=false;selection();});consent.addEventListener('change',selection);
  document.querySelector('#hubUpdateRefresh').addEventListener('click',refresh);
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
