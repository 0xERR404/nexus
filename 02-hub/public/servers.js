(() => {
  const host=document.querySelector('[data-servers]');if(!host)return;
  const pulse=host.dataset.servers==='pulse',params=new URLSearchParams(location.search);
  const node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
  let selected=params.get('server')||(pulse?'hub':'all'),servers=[],dirty=false,acting=false,timer,loaded='',formRevision=0,catalogLoaded=false,switching=false;
  const states={online:'На связи',offline:'Нет связи',waiting:'Ожидаем агент',revoked:'Доступ отозван'};
  const panel=pulse?document.getElementById('pulseServerPanel'):null;let tabOrder='';
  const tools=node('div');tools.className='server-tools';const label=node('label','Сервер'),select=node('select');select.id='serverSelect';select.setAttribute('aria-label','Сервер');label.append(select);
  const link=node('p');link.className='server-link';link.setAttribute('role','status');if(pulse){select.hidden=true;tools.classList.add('server-tabs-tools');}else tools.append(label);
  const tabs=pulse?node('div'):null;
  if(tabs){tabs.className='server-tabs';tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','Серверы Атланта');tools.append(tabs);}
  tools.append(link);host.append(tools);
  const api=async(route,data)=>{const r=await fetch('/api/servers'+route,{method:data===undefined?'GET':'POST',headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data),cache:'no-store',signal:AbortSignal.timeout(12000)});if(r.status===401){location.replace('/login');throw Error('Требуется вход');}const v=await r.json();if(!r.ok)throw Error(v.error||'Запрос не выполнен');return v;};
  window.NexusServers={selected:()=>selected,metrics:()=>selected==='hub'?'/modules/pulse/api':'/api/servers/metrics?server='+encodeURIComponent(selected),history:hours=>selected==='hub'?'/modules/pulse/api/history?hours='+hours:'/api/servers/history?server='+encodeURIComponent(selected)+'&hours='+hours};
  if(pulse){
    const report=node('details');report.className='server-report';report.append(node('summary','Журнал и отчёт для ИИ'));
    const help=node('p','Автосбор раз в минуту. Хранение — до 30 дней. В одном TXT-файле: история состояний и их длительность, нагрузка, события и оповещения. Скачай файл и приложи его к сообщению ИИ.');help.className='server-report-help';report.append(help);
    const controls=node('div');controls.className='server-report-controls';
    const scopeLabel=node('label','Серверы отчёта'),scope=node('select');scope.id='serverReportScope';scope.add(new Option('Выбранный сервер','selected'));scope.add(new Option('Все серверы','all'));scopeLabel.append(scope);
    const periodLabel=node('label','Период отчёта'),period=node('select');period.id='serverReportPeriod';for(const [value,title]of [[1,'Последний час'],[24,'Сутки'],[168,'Неделя'],[720,'Месяц']])period.add(new Option(title,value,false,value===24));periodLabel.append(period);
    const download=node('a','Скачать отчёт для ИИ');download.className='server-report-download';download.download='nexus404-server-report.txt';
    const progress=node('p');progress.className='server-report-status';progress.setAttribute('role','status');
    const journal=node('ol');journal.className='server-report-events';journal.setAttribute('aria-label','Последние события отчёта');
    const history=node('div');history.className='server-report-history';history.setAttribute('aria-label','История состояний за период');
    controls.append(scopeLabel,periodLabel,download);report.append(controls,progress,history,journal);panel.prepend(report);
    let reportGeneration=0,reportTimer;
    function reportURL(){return '?server='+encodeURIComponent(scope.value==='all'?'all':selected)+'&hours='+period.value;}
    async function refreshReport(){clearTimeout(reportTimer);const generation=++reportGeneration;download.href='/api/servers/report'+reportURL();if(!report.open||document.hidden)return;
      progress.textContent='Читаем журнал…';journal.replaceChildren();history.replaceChildren();
      try{const data=await api('/diagnostics'+reportURL());if(generation!==reportGeneration)return;
        const last=data.last?new Date(data.last).toLocaleString('ru-RU'):'ещё не выполнен';
        progress.textContent=(data.error?data.error+' ':'')+`Последний сбор: ${last}. За период: критических ${data.counts.critical}, предупреждений ${data.counts.warning}, информационных ${data.counts.info}.`;
        const unavailable=data.sources.filter(s=>!s.available||s.fresh===false||s.backlog).map(s=>s.name);if(unavailable.length)progress.textContent+=' Неполные источники: '+unavailable.join(', ')+'.';
        const elapsed=ms=>{const seconds=Math.floor(ms/1000);return `${Math.floor(seconds/3600)} ч ${Math.floor(seconds/60)%60} мин ${seconds%60} с`;};
        for(const t of data.timelines??[]){const section=node('section');section.append(node('strong',t.name+' · История за период'),node('p','Есть наблюдения: '+elapsed(t.observedMs)+'. Нет данных: '+elapsed(t.unknownMs)+'.'));
          const totals=node('p',t.totals.map(v=>v.label+': '+elapsed(v.durationMs)).join(' · '));section.append(totals);
          const list=node('ol');for(const v of t.intervals){const item=node('li',new Date(v.from).toLocaleString('ru-RU')+' — '+new Date(v.to).toLocaleString('ru-RU')+' · '+v.label+' · '+elapsed(v.durationMs));list.append(item);}section.append(list);
          if(t.intervalCount>t.intervals.length)section.append(node('small','Показаны последние 6 интервалов; полная шкала — в TXT.'));history.append(section);
        }
        history.append(node('p','Длительности оценены по минутным опросам. Нет связи с агентом не означает, что VPS или VPN недоступен. Пропуски сбора и время после последнего наблюдения отмечены как отсутствие данных.'));
        for(const e of data.recent){const item=node('li');item.dataset.level=e.level;item.append(node('strong',e.server+' · '+e.title),node('small',new Date(e.time).toLocaleString('ru-RU')+' · '+({critical:'Критическое',warning:'Предупреждение',info:'Информация'}[e.level])));if(e.body)item.append(node('p',e.body));journal.append(item);}
        if(!data.recent.length)journal.append(node('li','За выбранный период событий в журнале нет.'));
      }catch(e){if(generation===reportGeneration)progress.textContent='Журнал недоступен: '+e.message;}
      finally{if(generation===reportGeneration&&report.open&&!document.hidden)reportTimer=setTimeout(refreshReport,60000);}
    }
    scope.onchange=period.onchange=refreshReport;report.addEventListener('toggle',refreshReport);
    document.addEventListener('nexus:server',refreshReport);document.addEventListener('visibilitychange',refreshReport);
    addEventListener('pagehide',()=>{reportGeneration++;clearTimeout(reportTimer);});refreshReport();
  }
  let manager,form,feedback,ack,codeBox;
  const defaults={timezone:'UTC',services:['ssh.service','fail2ban.service','nexus404-agent.service'],maintenance:{reboot:{enabled:false,day:0,time:'06:00'},cleanup:{enabled:false,time:'06:30',afterReboot:true},health:{enabled:true,time:'05:30'},securityReboot:{enabled:false,time:'02:00'}}};
  if(pulse){
    manager=node('details');manager.className='server-manager';manager.append(node('summary','Настройки сервера'));
    const registrationPanel=node('details');registrationPanel.className='server-registration';registrationPanel.append(node('summary','Добавить сервер'));host.append(registrationPanel);
    const registration=node('form');registration.className='server-form';registration.innerHTML='<label>Имя нового сервера<input name="name" required maxlength="60" autocomplete="off" placeholder="VPS · Москва"></label><div class="server-actions"><button type="submit">Создать код подключения</button></div>';
    codeBox=node('p');codeBox.className='server-code server-wide';codeBox.setAttribute('role','status');registration.append(codeBox);registrationPanel.append(registration);
    form=node('form');form.className='server-form';form.innerHTML='<label>Часовой пояс<input name="timezone" required placeholder="Europe/Moscow"></label><label>Службы<textarea name="services" rows="3" placeholder="ssh.service"></textarea></label>';
    for(const [key,title]of [['reboot','Перезагрузка'],['cleanup','Очистка'],['health','Проверка безопасности'],['securityReboot','Перезагрузка после обновлений']]){const row=node('div');row.className='server-job';row.innerHTML=`<label><input type="checkbox" name="${key}Enabled">${title}</label><input type="time" name="${key}Time" required aria-label="${title}: время">`;if(key==='reboot'){const days=node('select');days.name='rebootDay';days.setAttribute('aria-label','День перезагрузки');['Вс','Пн','Вт','Ср','Чт','Пт','Сб'].forEach((d,i)=>days.add(new Option(d,i)));row.append(days);}form.append(row);}
    const after=node('label');after.className='server-wide';after.innerHTML='<span><input type="checkbox" name="afterReboot"> Очистка после плановой перезагрузки</span>';form.append(after);
    ack=node('p');ack.className='server-wide';ack.setAttribute('role','status');form.append(ack);
    const actions=node('div');actions.className='server-actions server-wide';const save=node('button','Отправить настройки');save.type='submit';const revoke=node('button','Отозвать доступ');revoke.type='button';const events=node('a','События в Гермесе');events.id='serverEventsLink';actions.append(save,revoke,events);form.append(actions);
    feedback=node('p');feedback.className='server-wide';feedback.setAttribute('role','status');manager.append(form,feedback);document.querySelector('[data-server-settings]').append(manager);
    form.addEventListener('input',()=>dirty=true);
    registration.onsubmit=e=>{e.preventDefault();act(async()=>{const v=await api('/registration',{name:registration.elements.name.value});codeBox.textContent=`${v.code} · действует до ${new Date(v.expires).toLocaleTimeString('ru-RU')}. На VPS запусти sudo sh menu.sh --agent и введи адрес хаба и этот код.`;},codeBox);};
    form.onsubmit=e=>{e.preventDefault();act(async()=>{const s=servers.find(s=>s.id===selected);if(!s)return;const f=form.elements,c=structuredClone(defaults);c.timezone=f.timezone.value.trim();c.services=f.services.value.trim().split(/\s+/).filter(Boolean);for(const key of Object.keys(c.maintenance)){c.maintenance[key].enabled=f[key+'Enabled'].checked;c.maintenance[key].time=f[key+'Time'].value;}c.maintenance.reboot.day=+f.rebootDay.value;c.maintenance.cleanup.afterReboot=f.afterReboot.checked;await api('/settings',{id:s.id,version:formRevision,config:c});dirty=false;loaded='';feedback.textContent='Отправлено. Ожидаем подтверждение записи расписания на VPS.';await refresh();});};
    revoke.onclick=()=>act(async()=>{const s=servers.find(s=>s.id===selected);if(!s||!await Nexus.confirm(`Отозвать доступ «${s.name}»? Сохранённое расписание останется на VPS.`))return;await api('/revoke',{id:s.id});dirty=false;await refresh();});
  }
  async function act(fn,errorTarget=feedback||link){if(acting)return;acting=true;[host,manager].filter(Boolean).forEach(el=>el.querySelectorAll('button').forEach(b=>b.disabled=true));try{await fn();}catch(e){errorTarget.textContent=e.message;}finally{acting=false;[host,manager].filter(Boolean).forEach(el=>el.querySelectorAll('button').forEach(b=>b.disabled=false));render();}}
  function notifySelection(){
    const url=new URL(location.href);if(selected==='hub'||selected==='all')url.searchParams.delete('server');else url.searchParams.set('server',selected);history.replaceState(history.state,'',url);
    document.dispatchEvent(new Event('nexus:server'));
  }
  function renderTabs(){
    const entries=[{id:'hub',name:'Хаб'},...servers];
    if(!entries.some(s=>s.id===selected))entries.push({id:selected,name:'Загрузка сервера…'});
    const ids=new Set(entries.map(s=>s.id));for(const b of [...tabs.children])if(!ids.has(b.dataset.server))b.remove();
    for(const [index,s] of entries.entries()){
      let b=[...tabs.children].find(b=>b.dataset.server===s.id);
      if(!b){b=node('button');b.type='button';b.dataset.server=s.id;b.id='serverTab-'+s.id;b.setAttribute('role','tab');b.setAttribute('aria-controls','pulseServerPanel');const dot=node('span');dot.className='server-tab-dot';dot.setAttribute('aria-hidden','true');const name=node('span');name.className='server-tab-name';b.append(dot,name);tabs.append(b);}
      if(tabs.children[index]!==b)tabs.insertBefore(b,tabs.children[index]||null);
      b.querySelector('.server-tab-name').textContent=s.name;
      b.dataset.state=s.state||'hub';b.title=s.name+(s.state?' · '+states[s.state]:'');b.setAttribute('aria-label',b.title);
      b.setAttribute('aria-selected',String(s.id===selected));b.tabIndex=s.id===selected?0:-1;b.disabled=acting;
    }
    const order=entries.map(s=>s.id).join(',');if(order!==tabOrder){tabOrder=order;const active=tabs.querySelector('[aria-selected=true]');if(active)tabs.scrollLeft=Math.max(0,active.offsetLeft-tabs.offsetLeft-8);}
    panel.setAttribute('aria-labelledby','serverTab-'+selected);
  }
  function render(){
    const old=selected;select.replaceChildren();if(!pulse)select.add(new Option('Все серверы','all'));select.add(new Option('Хаб','hub'));for(const s of servers)select.add(new Option(s.name+' · '+states[s.state],s.id));
    if(![...select.options].some(o=>o.value===old)){if(catalogLoaded||!params.has('server'))selected=pulse?'hub':'all';else select.add(new Option('Загрузка сервера…',old));}select.value=selected;
    if(tabs)renderTabs();
    const s=servers.find(s=>s.id===selected);link.dataset.state=s?.state||'online';
    link.textContent=s&&(!pulse||s.state!=='online')?({online:'На связи',offline:'Нет связи · показаны последние данные',waiting:'Ожидаем первый замер',revoked:'Доступ отозван'}[s.state])+(s.seen?' · '+new Date(s.seen).toLocaleString('ru-RU'):''):'';
    if(manager)manager.hidden=!s;
    if(old!==selected){dirty=false;loaded='';notifySelection();}
    if(form){form.hidden=!s;if(!s)return;form.querySelector('button[type=submit]').disabled=acting||s.revoked;form.querySelector('button[type=button]').disabled=acting||s.revoked;document.getElementById('serverEventsLink').href='/modules/signal/?server='+encodeURIComponent(s.id);
      const request=s.desired,accepted=s.applied;ack.textContent=request&&accepted?.requestId!==request.id?(Date.now()>request.expires?'Запрос истёк без подтверждения. Отправь настройки заново.':'Ожидаем подтверждение агента.'):accepted?.result==='rejected'?'Агент отклонил настройки. Прежнее расписание сохранено.':accepted?'Расписание подтверждено агентом · версия '+accepted.version:'Настройки VPS ещё не получены.';
      const key=s.id+':'+s.revision+':'+(accepted?.version??'');if(!dirty&&loaded!==key){loaded=key;formRevision=s.revision;const c=request?.config||accepted?.config||defaults,f=form.elements;f.timezone.value=c.timezone;f.services.value=c.services.join('\n');for(const [k,v]of Object.entries(c.maintenance)){f[k+'Enabled'].checked=v.enabled;f[k+'Time'].value=v.time;}f.rebootDay.value=c.maintenance.reboot.day;f.afterReboot.checked=c.maintenance.cleanup.afterReboot;}
    }
  }
  async function choose(value){
    if(acting||switching||value===selected)return;
    switching=true;
    try{
      if(dirty&&!await Nexus.confirm('Отменить несохранённые настройки?')){select.value=selected;tabs?.querySelector('[aria-selected="true"]')?.focus();return;}
      selected=value;dirty=false;loaded='';if(feedback)feedback.textContent='';render();notifySelection();
      tabs?.querySelector('[aria-selected="true"]')?.scrollIntoView({block:'nearest',inline:'nearest'});
    }finally{switching=false;}
  }
  select.onchange=()=>choose(select.value);
  if(tabs){
    tabs.addEventListener('click',e=>{const b=e.target.closest('[role=tab]');if(b&&!b.disabled)void choose(b.dataset.server);});
    // Manual activation: arrows move focus, Enter/Space selects the focused server.
    tabs.addEventListener('keydown',e=>{const buttons=[...tabs.querySelectorAll('[role=tab]')],i=buttons.indexOf(e.target);if(i<0||!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?buttons.length-1:(i+(e.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length;buttons[next].focus();buttons[next].scrollIntoView({block:'nearest',inline:'nearest'});});
  }
  async function refresh(){clearTimeout(timer);try{servers=(await api('')).servers;catalogLoaded=true;render();}catch(e){link.textContent=e.message;}finally{if(!document.hidden)timer=setTimeout(refresh,15000);}}
  window.Nexus?.beforeLeave?.(async()=>!acting&&(!dirty||await Nexus.confirm('Отменить несохранённые настройки сервера?')));
  document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(!document.hidden)refresh();});addEventListener('pagehide',()=>clearTimeout(timer));render();refresh();
})();
