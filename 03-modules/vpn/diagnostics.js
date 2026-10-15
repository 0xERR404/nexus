(() => {
  const S=window.NexusVPNDiagnosticStats,key='nexus-vpn-diagnostics-v1',base='/modules/vpn/api/diagnostics';
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const ms=n=>Number.isFinite(n)?Math.round(n)+' мс':'—';
  const seconds=n=>(n/1000).toFixed(1)+' с';
  let host,state,active=null,history=[],storageError='';
  try{const data=JSON.parse(localStorage.getItem(key)||'[]');if(Array.isArray(data))history=data.filter(r=>r?.v===1&&typeof r.label==='string'&&Array.isArray(r.samples)&&r.samples.length<=400&&r.samples.every(s=>Number.isFinite(s.at)&&Number.isFinite(s.ms)&&typeof s.ok==='boolean')).slice(0,30);}catch{storageError='История браузера недоступна. Результат можно скачать.';}
  function persist(){try{localStorage.setItem(key,JSON.stringify(history));}catch{storageError='Не удалось сохранить историю в браузере. Скачай результат.';}}
  function saveRun(job){if(job.saved||!job.r.samples.length)return;job.saved=true;history.unshift(job.r);history=history.slice(0,30);persist();}
  function release(job){if(job.id)return fetch(base+'/stop',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:job.id}),keepalive:true,signal:AbortSignal.timeout(3000)}).catch(()=>{});}
  function download(rows){const a=document.createElement('a'),url=URL.createObjectURL(new Blob([JSON.stringify({format:'nexus-vpn-http-diagnostics-v1',notice:'HTTP-задержка до хаба; не ICMP и не потери UDP. Профиль выбран вручную. IP-адреса и ключи не записываются.',runs:rows},null,2)],{type:'application/json'}));a.href=url;a.download='argo-diagnostics.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  const pathText=r=>{
    const paths=S.summarize(r).paths;
    if(!r.connection)return 'Без VPN · выбранный вручную режим';
    if(paths.length===1&&paths[0]==='matched')return 'Адрес выхода совпадает с нодой · протокол выбран вручную';
    if(paths.length>1)return 'Адрес выхода менялся или не подтверждён · не сравнивай как чистый VPN-тест';
    return paths[0]==='different'?'Адрес выхода не совпадает с нодой · возможен прямой маршрут':'Маршрут через ноду не подтверждён';
  };
  function resultHTML(r){
    const s=S.summarize(r),points=r.samples.map(p=>p.ok?`<circle cx="${10+p.at/Math.max(1,r.duration)*580}" cy="${70-Math.min(p.ms,Math.max(100,s.all.p95??100))/Math.max(100,s.all.p95??100)*60}" r="2"/>`:`<path d="M${10+p.at/Math.max(1,r.duration)*580} 65v10"/>`).join('');
    return `<p class="vpn-hint">${esc(pathText(r))}</p><div class="vpn-diagnostic-metrics">${[['Без нагрузки',ms(s.baseline.median)],['Под нагрузкой',ms(s.loaded.median)],['Рост задержки',s.increase===null?'—':(s.increase>0?'+':'')+ms(s.increase)],['Разброс соседних проб',ms(s.all.jitter)],['95% проб быстрее',ms(s.all.p95)],['Сбои HTTP-проб',s.all.sent?`${s.all.failed} / ${s.all.sent} · ${s.all.failurePercent.toFixed(1)}%`:'—']].map(([a,b])=>`<div><span>${a}</span><strong>${b}</strong></div>`).join('')}</div><svg class="vpn-diagnostic-chart" viewBox="0 0 600 80" role="img" aria-label="HTTP-задержка по времени; штрихи внизу — неудачные пробы">${points}</svg><p>Загружено ${(r.bytes/1048576).toFixed(1)} МиБ. ${r.loadNote?esc(r.loadNote):''}</p>${s.outages.length?`<p>Периоды недоступности · оценка по пробам:</p><ul>${s.outages.map(o=>`<li>На ${seconds(o.at)}: ${o.recovered?'восстановление через '+seconds(o.duration):'нет восстановления до конца теста · '+seconds(o.duration)}</li>`).join('')}</ul>`:'<p>За время наблюдения сбоев запросов не обнаружено.</p>'}`;
  }
  function drawHistory(){
    if(!host?.isConnected)return;
    host.querySelector('[data-history]').innerHTML=`<div class="vpn-actions"><h3>Сравнение и история</h3><button type="button" data-export ${history.length?'':'disabled'}>Скачать отчёт</button><button type="button" data-clear ${history.length?'':'disabled'}>Очистить</button></div><p>Последние 30 запусков хранятся только в этом браузере. Сравнивай одну сеть и одинаковые режимы; прерванные тесты и неподтверждённые маршруты не равнозначны полным проверкам.</p>${storageError?`<p role="status">${esc(storageError)}</p>`:''}<div class="vpn-diagnostic-history">${history.map((r,i)=>{const s=S.summarize(r);return `<article class="vpn-card"><h3>${esc(r.label)}</h3><p>${esc(new Date(r.started).toLocaleString('ru-RU'))} · ${esc(r.network||'Сеть не указана')} · ${esc(r.mode==='long'?'Наблюдение 3 минуты':'Быстрая проверка')} · ${esc(r.status)}</p><p>${esc(pathText(r))}</p><p>Без нагрузки: <strong>${ms(s.baseline.median)}</strong> · под нагрузкой: <strong>${ms(s.loaded.median)}</strong> · сбои: ${s.all.failed}/${s.all.sent}</p><div class="vpn-actions"><button type="button" data-detail="${i}">Подробнее</button><button type="button" data-download="${i}">Скачать</button></div><div data-result="${i}" hidden>${resultHTML(r)}</div></article>`;}).join('')||'<p>Запусти прямое соединение, затем повтори проверку с нужными профилями Happ.</p>'}</div>`;
  }
  function mount(container,snapshot){
    state=snapshot;if(container.querySelector('#vpnDiagnostics'))return;
    container.innerHTML=`<section id="vpnDiagnostics"><article class="vpn-card"><h2>Качество соединения с этого устройства</h2><p>Тест идёт из браузера до хаба <strong>${esc(location.hostname)}</strong>. Это HTTP-задержка с учётом VPN, HTTPS и ответа хаба, а не ICMP-пинг. Сбои запросов не равны потерям UDP-пакетов.</p><ol><li>Для исходного замера отключи VPN и выбери «Без VPN».</li><li>Для сравнения включи нужный профиль в Happ и выбери его здесь. При выборочной маршрутизации направь <strong>full:${esc(location.hostname)}</strong> через выбранное VPN-подключение, обнови подписку и переподключись.</li><li>Оставь вкладку открытой. Повтори тест для других серверов и протоколов в той же сети.</li></ol><p>Арго не переключает Happ. Совпадение адреса выхода с нодой подтверждает адрес, но не выбранный протокол. CDN, NAT и отдельный адрес выхода могут помешать проверке маршрута.</p><form data-diagnostic-form><div class="vpn-fields"><label>Подключение<select name="connection"><option value="">Без VPN · исходный замер</option>${state.connections.filter(c=>c.enabled).map(c=>`<option value="${esc(c.id)}">${esc((c.delivery==='cloudflare'?'☁ ':'')+c.name+' · '+(state.profiles[c.profile]||c.profile))}</option>`).join('')}</select></label><label>Проверка<select name="mode"><option value="quick">Быстрая · около 30 секунд</option><option value="long">Наблюдение · 3 минуты</option></select></label><label>Сеть · для сравнения<input name="network" maxlength="60" placeholder="Домашний Wi-Fi / мобильная сеть"></label><label class="vpn-check"><input name="load" type="checkbox" checked>Проверить при скачивании · до 32 МиБ</label></div><p>Загрузка длится до 12 секунд и может закончиться раньше по лимиту трафика. Насыщение быстрого канала не гарантируется. При сворачивании вкладки проверка остановится.</p><div class="vpn-actions"><button type="submit">Начать проверку</button><button type="button" data-stop disabled>Остановить</button></div></form><p data-progress role="status" aria-live="polite">Готово к проверке</p><div data-live></div></article><section data-history></section></section>`;
    host=container.querySelector('#vpnDiagnostics');const requested=new URLSearchParams(location.search).get('connection');if(state.connections.some(c=>c.id===requested&&c.enabled))host.querySelector('[name=connection]').value=requested;drawHistory();
    host.querySelector('form').onsubmit=e=>{e.preventDefault();void run(new FormData(e.currentTarget));};
    host.onclick=async e=>{const b=e.target.closest('button');if(!b)return;if(b.hasAttribute('data-stop'))stop('Остановлено пользователем');if(b.hasAttribute('data-export'))download(history);if(b.hasAttribute('data-clear')&&!active&&await Nexus.confirm('Удалить историю проверок из этого браузера?')){history=[];persist();drawHistory();}if(b.dataset.download!==undefined)download([history[Number(b.dataset.download)]]);if(b.dataset.detail!==undefined){const el=host.querySelector(`[data-result="${b.dataset.detail}"]`);el.hidden=!el.hidden;b.textContent=el.hidden?'Подробнее':'Свернуть';}};
  }
  function progress(text){if(host?.isConnected)host.querySelector('[data-progress]').textContent=text;}
  function live(r){if(host?.isConnected)host.querySelector('[data-live]').innerHTML=resultHTML(r);}
  const fatal=message=>Object.assign(Error(message),{fatal:true});
  async function request(url,{signal,token,method='GET',body,timeout=4000}={}){
    const controller=new AbortController(),abort=()=>controller.abort();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(abort,timeout);
    try{
      const response=await fetch(url,{method,headers:{...(token?{'x-vpn-diagnostic':token}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'error',signal:controller.signal});
      if([401,403,410,429].includes(response.status))throw fatal(response.status===401?'Вход истёк. Войди снова.':'Проверка остановлена сервером ('+response.status+').');
      if(!response.ok)throw Error('HTTP '+response.status);
      const data=await response.arrayBuffer();return {response,data};
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  const json=data=>{try{return JSON.parse(new TextDecoder().decode(data));}catch{throw fatal('Получен неожиданный ответ. Проверка остановлена.');}};
  const pause=(ms,signal)=>new Promise(resolve=>{if(signal.aborted)return resolve();const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});});
  async function run(values){
    if(active)return;
    const connection=state.connections.find(c=>c.id===values.get('connection')),r={v:1,started:Date.now(),connection:connection?.id||'',label:connection?(connection.delivery==='cloudflare'?'☁ ':'')+connection.name+' · '+state.profiles[connection.profile]:'Без VPN',mode:values.get('mode'),network:values.get('network').trim(),samples:[],bytes:0,duration:0,status:'Выполняется',loadNote:values.has('load')?'':'Проверка под нагрузкой отключена.'};
    const job={controller:new AbortController(),reason:'',id:null,r};active=job;
    const signal=job.controller.signal,form=host.querySelector('form');for(const e of form.elements)e.disabled=true;host.querySelector('[data-stop]').disabled=false;
    let started=performance.now();
    try{
      progress('Подготовка проверки…');
      const initial=json((await request(base+'/start',{method:'POST',body:{connection:r.connection},timeout:8000})).data);job.id=initial.id;
      if(signal.aborted)return;
      started=performance.now();job.started=started;
      const probe=async phase=>{
        const begin=performance.now(),nonce=crypto.randomUUID();let sample;
        try{const value=json((await request(base+'/probe?nonce='+nonce,{signal,token:job.id})).data);if(value.id!==job.id||value.nonce!==nonce||!['baseline','matched','different','unknown'].includes(value.path))throw fatal('Ответ пробы не соответствует запросу.');sample={at:begin-started,ms:performance.now()-begin,ok:true,path:value.path,phase};}
        catch(e){if(signal.aborted||e.fatal)throw e;sample={at:begin-started,ms:performance.now()-begin,ok:false,path:'unknown',phase};}
        r.samples.push(sample);r.duration=performance.now()-started;live(r);
      };
      progress('Задержка без нагрузки · 10 проб');
      for(let i=0;i<10&&!signal.aborted;i++){await probe('idle');await pause(500,signal);}
      if(values.has('load')&&!signal.aborted){
        progress('Задержка при скачивании · до 12 секунд');
        const loadController=new AbortController(),loadAbort=()=>loadController.abort();signal.addEventListener('abort',loadAbort,{once:true});
        let workers=2,loadErrors=0,loadFatal=null,limited=false;const loadBegin=performance.now(),deadline=loadBegin+12000,loadTimer=setTimeout(loadAbort,12000);
        const worker=async()=>{try{while(!loadController.signal.aborted&&performance.now()<deadline){const {response,data}=await request(base+'/load',{signal:loadController.signal,token:job.id});if(response.status===204){limited=true;break;}if(response.headers.get('x-vpn-diagnostic')!==job.id)throw fatal('Неожиданный ответ загрузки');r.bytes+=data.byteLength;}}catch(e){if(e.fatal)loadFatal=e;else if(!loadController.signal.aborted)loadErrors++;}finally{workers--;}};
        const downloads=[worker(),worker()];
        try{while(workers&&!signal.aborted&&performance.now()<deadline){await probe('load');await pause(500,signal);}}
        finally{loadAbort();await Promise.all(downloads);clearTimeout(loadTimer);signal.removeEventListener('abort',loadAbort);}
        r.loadNote=`Загрузка: ${seconds(performance.now()-loadBegin)}.${limited?' Достигнут лимит трафика.':''}${loadErrors?' Скачивание прервалось из-за ошибки.':''} Результат зависит от того, удалось ли нагрузить канал.`;
        if(loadFatal)throw loadFatal;
      }
      const until=started+(r.mode==='long'?180000:30000);progress(r.mode==='long'?'Наблюдение за обрывами · 3 минуты':'Наблюдение за восстановлением соединения');
      while(!signal.aborted&&performance.now()<until){await probe('monitor');await pause(1000,signal);}
      r.status=signal.aborted?(job.reason||'Остановлено'):'Завершено';
    }catch(e){r.status=signal.aborted?(job.reason||'Остановлено'):e.fatal?e.message:'Не удалось запустить проверку';}
    finally{
      r.duration=performance.now()-started;if(signal.aborted)r.status=job.reason||'Остановлено';
      saveRun(job);await release(job);
      active=null;if(host?.isConnected){for(const e of form.elements)e.disabled=false;host.querySelector('[data-stop]').disabled=true;progress(r.status);live(r);drawHistory();}
    }
  }
  function stop(reason='Остановлено'){if(active){active.reason=reason;active.controller.abort();}}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('Прервано: вкладка скрыта');});
  window.addEventListener('pagehide',()=>{stop('Прервано: страница закрыта');if(active){active.r.status=active.reason;active.r.duration=performance.now()-(active.started??performance.now());saveRun(active);release(active);}});
  window.NexusVPNDiagnostics=Object.freeze({mount,stop,get active(){return !!active;}});
})();
