(() => {
  const $=id=>document.getElementById(id), node=Nexus.node;
  if (!$('homeDashboard')) return;
  const symbol=name=>$('homeIcons').content.querySelector(`[data-icon="${name}"]`).cloneNode(true);
  const duration=m=>Number.isFinite(m)?`${Math.floor(m/60)} ч ${Math.round(m%60)} мин`:'—';
  const link=(text,href)=>{const a=node('a',text);a.href=href;return a;};
  const group=$('homeDashboard').dataset.group||'overview';
  const snapshots=new Map();
  function draw(id,value,fn){if(!$(id))return;const key=JSON.stringify(value);if(snapshots.get(id)===key)return;fn($(id),value);snapshots.set(id,key);}
  function render(data){
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
        ['Время работы',uptime,'С последнего запуска','uptime',null],
        ['Сеть'+(h.network?.length===1?' ('+h.network[0].name+')':''),h.network?.length?h.network.map(n=>n.name).join(', '):'—',h.network?.map(n=>{const rate=v=>Number.isFinite(v)?(v/1048576).toLocaleString('ru-RU',{maximumFractionDigits:2})+' МиБ/с':'—';return '↓ '+rate(n.rx_per_second)+' · ↑ '+rate(n.tx_per_second);}).join(' · ')||'—','signal',null]
      ]){const item=node('div','','home-metric'),label=node('span','','home-metric-label');label.append(symbol(kind),node('span',title));item.title=title+': '+value+' · '+detail;item.append(label,node('strong',value),node('small',detail));
        if(Number.isFinite(load)){const bar=node('meter');bar.min=0;bar.max=100;bar.low=70;bar.high=90;bar.optimum=30;bar.value=load;bar.setAttribute('aria-label',`${title}: ${value}`);item.append(bar);}box.append(item);}
      document.dispatchEvent(new Event('nexus:metrics'));
    });
    draw('homeTime',data.statistics,(box,s)=>{
      box.replaceChildren();if(!s){box.append(node('p','—','home-empty'));return;}
      const seconds=s.measured.reduce((n,r)=>n+r.seconds,0);
      if(!seconds){box.append(node('p','Пока нет активности','home-empty'));return;}
      box.append(node('strong',duration(Math.round(seconds/60)),'home-value'),node('p','Учтено в медиатеке','home-subtitle'));
    });
    draw('homeTasks',data.kanban,(box,k)=>{
      box.replaceChildren();if(!k){box.append(node('p','—','home-empty'));return;}
      if(!k.items.length)box.append(node('p',k.total ? 'Все задачи завершены' : 'Пока нет задач','home-empty'));
      for(const task of k.items.slice(0,3)){
        const row=node('div','','home-task'),check=node('input');check.type='checkbox';check.checked=!!task.done;check.setAttribute('aria-label','Завершено: '+task.title);
        check.onchange=async()=>{const done=check.checked;check.disabled=true;try{await Nexus.request('/modules/kanban/api/done',{id:task.id,version:task.version,done});snapshots.delete('homeTasks');await refresh();}catch(e){check.checked=!!task.done;Nexus.notice?.('kanban','task');}finally{check.disabled=false;}};
        const text=link(task.title,`/modules/kanban/?board=${encodeURIComponent(task.board)}&card=${encodeURIComponent(task.id)}`);text.className=task.done?'home-task-done':'';
        row.append(check,text);box.append(row);
      }
      $('homeTasksCount').textContent=k.total ? `${k.done} из ${k.total} завершено` : '';
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
    }catch(e){if(!controller.signal.aborted)Nexus.notice?.('hub','connection');}finally{busy=false;if(!stopped&&!document.hidden)timer=setTimeout(refresh,60000);}
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(timer);controller?.abort();}else void refresh();});
  addEventListener('online',refresh);addEventListener('pagehide',()=>{stopped=true;clearTimeout(timer);controller?.abort();});addEventListener('pageshow',()=>{stopped=false;void refresh();});
  void refresh();
})();
