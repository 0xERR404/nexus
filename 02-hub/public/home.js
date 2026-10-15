(() => {
  const $=id=>document.getElementById(id), node=Nexus.node;
  if (!$('homeDashboard')) return;
  const symbol=name=>$('homeIcons').content.querySelector(`[data-icon="${name}"]`).cloneNode(true);
  const duration=m=>Number.isFinite(m)?`${Math.floor(m/60)} ч ${Math.round(m%60)} мин`:'—';
  const link=(text,href)=>{const a=node('a',text);a.href=href;return a;};
  const group=$('homeDashboard').dataset.group||'overview';
  if($('homeDate'))$('homeDate').textContent=new Date().toLocaleDateString('ru-RU',{weekday:'long',day:'numeric',month:'long'});
  function artwork(cover,kind){const art=node('span','','home-media-art');art.append(symbol(kind));if(cover){const img=node('img');img.alt='';img.loading='lazy';img.src=cover;img.addEventListener('error',()=>img.remove());img.addEventListener('load',()=>{art.querySelector('svg')?.remove();});art.append(img);}return art;}
  const snapshots=new Map();
  function draw(id,value,fn){if(!$(id))return;const key=JSON.stringify(value);if(snapshots.has(id)&&snapshots.get(id)===key)return;fn($(id),value);snapshots.set(id,key);}
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
        ['Сеть',h.network?.length?(h.network.reduce((sum,n)=>sum+(Number.isFinite(n.rx_per_second)?n.rx_per_second:0),0)/1000000).toLocaleString('ru-RU',{maximumFractionDigits:2})+' МБ/с':'—','Входящий трафик · время работы '+uptime,'signal',null]
      ]){const item=node('div','','home-metric'),label=node('span','','home-metric-label');label.append(symbol(kind),node('span',title));item.title=title+': '+value+' · '+detail;item.append(label,node('strong',value),node('small',detail));
        if(Number.isFinite(load)){const bar=node('meter');bar.min=0;bar.max=100;bar.low=70;bar.high=90;bar.optimum=30;bar.value=load;bar.setAttribute('aria-label',`${title}: ${value}`);item.append(bar);}box.append(item);}
      document.dispatchEvent(new Event('nexus:metrics'));
    });
    draw('homeMedia',[data.reader,data.cinema,data.wave],(box,[reader,cinema,wave])=>{
      box.replaceChildren();const books=Array.isArray(reader)?reader:reader?.items;
      const rows=(books||[]).slice(0,1).map(b=>({title:b.title,detail:'Книга · '+(b.author||'Продолжить чтение'),href:'/modules/reader/?book='+encodeURIComponent(b.id),cover:b.cover?'/modules/reader/cover/'+encodeURIComponent(b.id):null,progress:b.progress,kind:'reader'}));
      if(cinema?.items?.length)rows.push({...cinema.items[0],kind:'cinema'});
      if(wave?.items?.length)rows.push({...wave.items[0],detail:'Музыка · '+wave.items[0].detail,kind:'wave'});
      for(const b of (books||[]).slice(1,3))if(rows.length<3)rows.push({title:b.title,detail:'Книга · '+(b.author||''),href:'/modules/reader/?book='+encodeURIComponent(b.id),cover:b.cover?'/modules/reader/cover/'+encodeURIComponent(b.id):null,progress:b.progress,kind:'reader'});
      for(const t of (wave?.items||[]).slice(1,3))if(rows.length<3)rows.push({...t,detail:'Музыка · '+t.detail,kind:'wave'});
      if(!rows.length){box.append(node('p','Добавь книгу, фильм или музыку — они появятся здесь.','home-empty'));return;}
      for(const r of rows){const a=link('',r.href);a.className='home-media-item';a.append(artwork(r.cover,r.kind),node('strong',r.title),node('small',r.detail));if(Number.isFinite(r.progress)){const p=node('progress');p.max=100;p.value=r.progress;p.setAttribute('aria-label','Прочитано '+Math.round(r.progress)+'%');a.append(p);}box.append(a);}
    });
    draw('homeMusic',data.wave,(box,w)=>{box.replaceChildren();if(!w?.items?.length){box.append(node('p',w?'Пока нет треков':'Музыка временно недоступна','home-empty'));return;}for(const t of w.items.slice(0,3)){const a=link('',t.href);a.className='home-track';const text=node('div');text.append(node('strong',t.title),node('small',t.detail));a.append(artwork(t.cover,'wave'),text);if(Number.isFinite(t.duration))a.append(node('span',Math.floor(t.duration/60)+':'+String(Math.floor(t.duration%60)).padStart(2,'0')));box.append(a);}});
    draw('homeVPN',data.vpn,(box,v)=>{box.replaceChildren();if(!v?.items?.length){box.append(node('p',v?'Нет включённых подключений':'Сводка VPN временно недоступна','home-empty'));return;}for(const c of v.items){const a=link('',c.href);a.className='home-vpn-row';const text=node('div');text.append(node('strong',c.title),node('small',c.cloud?'Через Cloudflare':'Напрямую'));a.append(node('span',c.cloud?'☁':'⇄','home-vpn-symbol'),text,node('span','Включено'));box.append(a);}box.append(node('p','Показаны настройки подключений. Проверка доступности — в диагностике Арго.','home-vpn-note'));});
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
