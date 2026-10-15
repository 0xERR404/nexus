(() => {
  const $=id=>document.getElementById(id), node=Nexus.node;
  if (!$('homeDashboard')) return;
  const symbol=name=>$('homeIcons').content.querySelector(`[data-icon="${name}"]`).cloneNode(true);
  const duration=m=>Number.isFinite(m)?`${Math.floor(m/60)} ч ${Math.round(m%60)} мин`:'—';
  const link=(text,href)=>{const a=node('a',text);a.href=href;return a;};
  const group=$('homeDashboard').dataset.group||'overview';
  if($('homeDate'))$('homeDate').textContent=new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'});
  function artwork(cover,kind){const art=node('span','','home-media-art');art.append(symbol(kind));if(cover){const img=node('img');img.alt='';img.loading='lazy';img.src=cover;img.addEventListener('error',()=>img.remove());img.addEventListener('load',()=>{art.querySelector('svg')?.remove();});art.append(img);}return art;}
  let latest;
  const player=()=>{const host=parent!==window?parent.NexusWave:window.NexusWave;if(!host)throw Error('Открой музыку в Орфее');return host;};
  const playerState=()=>{try{return player().state();}catch{return {};}};
  const clock=n=>Number.isFinite(n)?Math.floor(n/60)+':'+String(Math.floor(n%60)).padStart(2,'0'):'—';
  async function perform(fn){const status=$('homeActionStatus');try{if(status)status.textContent='';await fn();if(latest)render(latest);}catch(e){if(status)status.textContent=e.message||'Действие не выполнено';}}
  function actionButton(label,fn,text=label){const b=node('button',text);b.type='button';b.setAttribute('aria-label',label);b.title=label;b.onclick=e=>{e.stopPropagation();b.closest('details')?.removeAttribute('open');b.disabled=true;void perform(fn).finally(()=>b.disabled=false);};return b;}
  function menu(label,items){const d=node('details','','home-actions-menu'),summary=node('summary','⋯');summary.setAttribute('aria-label',label);summary.title=label;const body=node('div','','home-actions-popover');body.append(...items);d.append(summary,body);d.addEventListener('toggle',()=>{if(d.open)document.querySelectorAll('.home-actions-menu[open]').forEach(other=>{if(other!==d)other.open=false;});});return d;}
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){const d=document.querySelector('.home-actions-menu[open]');if(d){e.preventDefault();d.open=false;d.querySelector('summary').focus();}}});
  document.addEventListener('click',e=>{if(!e.target.closest('.home-actions-menu'))document.querySelectorAll('.home-actions-menu[open]').forEach(d=>d.open=false);});
  function diagnosticHistory(){try{const v=JSON.parse(localStorage.getItem('nexus-vpn-diagnostics-v1'));return Array.isArray(v)?v.filter(r=>r?.v===1&&Array.isArray(r.samples)&&Number.isFinite(r.started)).sort((a,b)=>b.started-a.started).slice(0,30):[];}catch{return [];}}
  function resumeRows(data){const rows=[...(data.resume||[])],s=playerState();if(s.id&&s.position>0&&s.duration>s.position+1&&s.title){const r={id:s.id,kind:'wave',title:s.title,detail:'Музыка · '+s.artist,position:s.position,duration:s.duration,progress:s.position/s.duration*100,cover:s.cover,href:'/modules/wave/?view=tracks&track='+encodeURIComponent(s.id)};const i=rows.findIndex(r=>r.kind==='wave');if(i<0)rows.push(r);else rows[i]=r;}return rows;}
  addEventListener('message',e=>{if(e.origin!==location.origin||e.source!==parent)return;if(e.data?.type==='nexus:wave-state'&&latest)render(latest);if(e.data?.type==='nexus:wave-library')void refresh();});
  addEventListener('storage',e=>{if(e.key==='nexus-vpn-diagnostics-v1'&&latest)render(latest);});
  const snapshots=new Map();
  function draw(id,value,fn){if(!$(id))return;const key=JSON.stringify(value);if(snapshots.has(id)&&snapshots.get(id)===key)return;fn($(id),value);snapshots.set(id,key);}
  function render(data){
    latest=data;
    draw('homeServer',data.pulse,(box,h)=>{
      box.replaceChildren();
      if(!h?.available){box.append(node('p','—','home-empty')); Nexus.notice?.('pulse','home');return;}
      const percent=n=>Number.isFinite(n)?`${n.toLocaleString('ru-RU',{maximumFractionDigits:1})}%`:'—';
      const bytes=n=>Number.isFinite(n)?`${(n/1073741824).toLocaleString('ru-RU',{maximumFractionDigits:1})} ГиБ`:'—';
      const used=v=>v?`${bytes(v.used)} / ${bytes(v.total)}`:'—';
      const uptime=Number.isFinite(h.uptime)?h.uptime>=86400?`${Math.floor(h.uptime/86400)} д ${Math.floor(h.uptime%86400/3600)} ч`:`${Math.floor(h.uptime/3600)} ч ${Math.floor(h.uptime%3600/60)} мин`:'—';
      for(const [title,value,detail,kind,load] of [
        ['CPU',percent(h.cpu),'Загрузка CPU','cpu',h.cpu],
        ['RAM',percent(h.memory?.percent),used(h.memory),'memory',h.memory?.percent],
        ['Диск',percent(h.disk?.percent),used(h.disk),'disk',h.disk?.percent],
        ['Сеть',h.network?.length?(h.network.reduce((sum,n)=>sum+(Number.isFinite(n.rx_per_second)?n.rx_per_second:0),0)/1000000).toLocaleString('ru-RU',{maximumFractionDigits:2})+' МБ/с':'—','Входящий трафик · время работы '+uptime,'signal',null]
      ]){const item=node('div','','home-metric'),label=node('span','','home-metric-label');label.append(symbol(kind),node('span',title));item.title=title+': '+value+' · '+detail;item.append(label,node('strong',value),node('small',detail));
        if(Number.isFinite(load)){const bar=node('meter');bar.min=0;bar.max=100;bar.low=70;bar.high=90;bar.optimum=30;bar.value=load;bar.setAttribute('aria-label',`${title}: ${value}`);item.append(bar);}box.append(item);}
      document.dispatchEvent(new Event('nexus:metrics'));
    });
    draw('homeMedia',resumeRows(data),(box,rows)=>{
      box.replaceChildren();
      if(!rows.length){const empty=node('div','','home-resume-empty');empty.append(node('strong','Продолжим с места остановки'),node('p','Здесь появятся начатые книги, фильмы и музыка.'),link('Открыть медиатеку →','/?group=media'));box.append(empty);return;}
      for(const r of rows){
        const a=link('',r.href);a.className='home-media-item';a.title=r.title+' · '+r.detail;a.dataset.kind=r.kind;
        a.append(artwork(r.cover,r.kind),node('strong',r.title),node('small',r.detail));
        const wrap=node('div','','home-media-progress'),bar=node('progress');bar.max=100;bar.value=r.progress;bar.setAttribute('aria-label','Прогресс: '+Math.round(r.progress)+'%');wrap.append(bar,node('span',Math.round(r.progress)+'%'));a.append(wrap);
        if(r.kind==='wave'){a.dataset.waveResume='';a.onclick=e=>{if(e.button||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;e.preventDefault();void perform(()=>player().resume(r.id,r.position));};}
        box.append(a);
      }
    });
    draw('homeMusic',[data.wave,playerState().id,playerState().playing],(box,[w,current,playing])=>{
      box.replaceChildren();if(!w?.items?.length){box.append(node('p',w?'Пока нет треков':'Музыка временно недоступна','home-empty'));return;}
      for(const t of w.items.slice(0,3)){
        const row=node('div','','home-track'),play=actionButton((current===t.id&&playing?'Пауза: ':'Слушать: ')+t.title,()=>current===t.id&&playing?player().pause():player().resume(t.id,0),'');play.className='home-track-play';play.append(artwork(t.cover,'wave'),node('span',current===t.id&&playing?'Ⅱ':'▶','home-play-glyph'));
        const text=link('',t.href);text.className='home-track-info';text.append(node('strong',t.title),node('small',t.detail));
        row.append(play,text,node('span',clock(t.duration)));
        row.append(menu('Действия с треком '+t.title,[actionButton('Добавить в очередь',()=>player().enqueue(t.id)),actionButton(t.favorite?'Убрать из избранного':'В избранное',async()=>{await Nexus.request('/modules/wave/change',{action:'favorite',id:t.id,favorite:!t.favorite});await player().refresh();snapshots.delete('homeMusic');await refresh();}),link('Открыть в Орфее',t.href)]));box.append(row);
      }
    });
    draw('homeVPN',[data.vpn,diagnosticHistory()],(box,[v,history])=>{
      box.replaceChildren();if(!v?.items?.length){box.append(node('p',v?'Нет включённых подключений':'Сводка VPN временно недоступна','home-empty'));return;}
      const labels={applied:'Нода работает',pending:'Ожидает настройки',rejected:'Настройки отклонены',expired:'Разрешение истекло',stopped:'Ядро остановлено',offline:'Нет свежих данных',revoked:'Доступ отозван'};
      for(const c of v.items){
        const row=node('div','','home-vpn-row'),a=link('',c.href);a.className='home-vpn-info';a.append(node('strong',c.title),node('small',c.cloud?'Через Cloudflare':'Напрямую'));
        const status=node('div','','home-vpn-state'),label=node('span',labels[c.state]||'Статус неизвестен');label.dataset.state=c.state;status.append(label);
        if(c.seen)label.title='Отчёт ноды: '+new Date(c.seen).toLocaleString('ru-RU');
        const run=history.find(r=>r.connection===c.id);if(run){const samples=run.samples.filter(p=>p?.phase==='idle'&&p.ok&&Number.isFinite(p.ms)&&p.ms>=0).map(p=>p.ms).sort((a,b)=>a-b),i=Math.floor(samples.length/2);const ms=samples.length?(samples.length%2?samples[i]:(samples[i-1]+samples[i])/2):null;
          const result=link(ms===null?'Проверка без результата':Math.round(ms)+' мс · HTTP',c.diagnostics);result.title='Браузер → хаб · '+new Date(run.started).toLocaleString('ru-RU')+' · '+run.status;status.append(result,node('small',new Date(run.started).toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})));
        }else status.append(node('small','Задержка не измерена'));
        row.append(node('span',c.cloud?'☁':'⇄','home-vpn-symbol'),a,status,menu('Действия с подключением '+c.title,[link('Проверить канал',c.diagnostics),link('Открыть серверы',c.href),actionButton('Обновить статус',async()=>{snapshots.delete('homeVPN');await refresh();})]));box.append(row);
      }
      box.append(node('p','Статус — по отчёту ноды. Замер HTTP — из этого браузера до хаба. Подключение Happ автоматически не определяется.','home-vpn-note'));
    });
    draw('homeTime',data.statistics,(box,s)=>{
      box.replaceChildren();if(!s){box.append(node('p','—','home-empty'));return;}
      const seconds=s.measured.reduce((n,r)=>n+r.seconds,0);
      if(!seconds){box.append(node('p','Пока нет активности','home-empty'));return;}
      box.append(node('strong',duration(Math.round(seconds/60)),'home-value'),node('p','Учтено в медиатеке','home-subtitle'));
    });
    draw('homeTasks',data.kanban,(box,k)=>{
      box.replaceChildren();if(!k){box.append(node('p','—','home-empty'));return;}
      box.closest('.home-card').classList.toggle('is-empty',!k.items.length);
      if(!k.items.length){const empty=node('div','','home-task-empty');empty.append(symbol('kanban'),node('strong',k.zone?'На сегодня всё свободно':k.total?'Всё сделано':'Пока без задач'),node('p',k.zone?'Нет незавершённых задач со сроком до конца дня.':'Здесь будет твой план на день.'),link('Открыть задачи →','/modules/kanban/'));box.append(empty);}
      for(const task of k.items.slice(0,3)){
        const row=node('div','','home-task'),check=node('input');check.type='checkbox';check.checked=!!task.done;check.setAttribute('aria-label','Завершено: '+task.title);
        check.onchange=async()=>{const done=check.checked;check.disabled=true;try{await Nexus.request('/modules/kanban/api/done',{id:task.id,version:task.version,done});snapshots.delete('homeTasks');await refresh();}catch(e){check.checked=!!task.done;Nexus.notice?.('kanban','task');}finally{check.disabled=false;}};
        const text=link(task.title,`/modules/kanban/?board=${encodeURIComponent(task.board)}&card=${encodeURIComponent(task.id)}`);text.className=task.done?'home-task-done':'';
        row.append(check,text);if(task.overdue){row.classList.add('is-overdue');const due=node('small','Просрочено');due.title=new Date(task.due).toLocaleString('ru-RU');row.append(due);}box.append(row);
      }
      $('homeTasksCount').textContent=k.zone?`${k.done} из ${k.total} на сегодня завершено · МСК`:(k.total?`${k.done} из ${k.total} завершено`:'');
    });
    draw('homeContinue',data.reader,(box,value)=>{
      const books=Array.isArray(value)?value:value?.items;
      box.replaceChildren();if(!books?.length){box.append(node('p','Нет начатых книг','home-empty'));return;}
      for(const book of books.slice(0,1)){const a=link('',`/modules/reader/?book=${encodeURIComponent(book.id)}`);a.className='home-recent';
        if(book.cover){const img=node('img');img.src='/modules/reader/cover/'+encodeURIComponent(book.id);img.alt='';img.loading='lazy';a.append(img);}
        const text=node('div'),progress=node('progress');progress.max=100;progress.value=book.progress;progress.setAttribute('aria-label','Прочитано');
        text.append(node('strong',book.title),node('small',[book.author,book.progress<1?'<1%':`${Math.round(book.progress)}%`].filter(Boolean).join(' · ')),progress);a.append(text);box.append(a);}
    });
    draw('homeChat',data.chat,(box,c)=>{
      const card=box.closest('[data-card-link]'),href=c?`/modules/chat/?provider=${encodeURIComponent(c.provider)}&topic=${encodeURIComponent(c.id)}`:'/modules/chat/';
      card.dataset.cardLink=href;card.querySelector('.home-card-title a').href=href;
      box.replaceChildren();if(!c){box.append(node('p','Начни новый разговор','home-empty'));return;}
      const message=node('div','','home-chat-message'),avatar=node('img');avatar.src='/mark.svg';avatar.alt='';avatar.className='home-chat-avatar';message.append(avatar,node('p',c.text||'Открой сохранённый разговор.','home-chat-preview'));box.append(node('strong',c.title),message);
    });
    draw('homeFiles',data.storage,(box,value)=>{
      const files=Array.isArray(value)?value:value?.items;
      if($('homeFilesCount'))$('homeFilesCount').textContent=value?.items?`${Math.min(files.length,3)} из ${value.total}`:'';
      box.replaceChildren();if(!files?.length){box.append(node('p','Пока нет файлов','home-empty'));return;}
      for(const file of files.slice(0,3)){const a=link('',`/modules/storage/?file=${encodeURIComponent(file.id)}`);a.className='home-file';
        const text=node('div');text.append(node('strong',file.name),node('small',`${Math.max(1,Math.round(file.size/1024))} КБ`));a.append(symbol('file'),text,node('span','›'));box.append(a);}
    });

  }
  let timer,controller,busy=false,stopped=false;
  async function refresh(){
    clearTimeout(timer);if(busy||stopped||document.hidden||navigator.onLine===false)return;
    busy=true;controller=new AbortController();
    try{const response=await fetch('/api/home/overview?group='+encodeURIComponent(group),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
      if(response.status===401||response.redirected){location.replace('/login');return;}if(!response.ok)throw Error('Сводка не обновлена. Повторим автоматически.');const data=await response.json();if(!controller.signal.aborted)render(data);
    }catch(e){if(!controller.signal.aborted)Nexus.notice?.('hub','connection');}finally{busy=false;if(!stopped&&!document.hidden)timer=setTimeout(refresh,15000);}
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);controller?.abort();}else void refresh();});
  addEventListener('online',refresh);addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);controller?.abort();});addEventListener('pageshow',()=>{stopped=false;void refresh();});
  void refresh();
})();
