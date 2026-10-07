(() => {
 const hosts=[...document.querySelectorAll('[data-pulse-history]')];if(!hosts.length)return;
 const ns='http://www.w3.org/2000/svg',node=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n;};
 for(const host of hosts){
  const compact = !!host.closest('.home-card');
  const toolbar=node('div');toolbar.className='pulse-history-tools';const label=node('label','История '),select=node('select');select.setAttribute('aria-label','Период истории Атланта');label.className='sr-only';
  const periods=node('div');periods.className='pulse-periods';periods.setAttribute('aria-label','Период графика');
  for(const [value,text] of [[1,'1 ч'],[6,'6 ч'],[24,'24 ч'],[168,'7 д']]){const o=node('option',text);o.value=value;o.selected=value===24;select.append(o);const b=node('button',text);b.type='button';b.dataset.hours=value;b.setAttribute('aria-pressed',String(value===24));b.onclick=()=>{select.value=value;select.dispatchEvent(new Event('change'));};periods.append(b);}label.append(select);toolbar.append(label,periods);
  const svg=document.createElementNS(ns,'svg');svg.classList.add('pulse-history-chart');svg.setAttribute('viewBox','0 0 900 160');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('role','img');svg.setAttribute('aria-label','История CPU, памяти и диска, проценты от 0 до 100');
  const grid=document.createElementNS(ns,'path');grid.setAttribute('d','M0 1H900M0 40H900M0 80H900M0 120H900M0 159H900M150 0V160M300 0V160M450 0V160M600 0V160M750 0V160');grid.setAttribute('class','pulse-history-grid');svg.append(grid);
  const paths=['cpu','memory','disk'].map(key=>{const p=document.createElementNS(ns,'path');p.setAttribute('class','pulse-history-line '+key);svg.append(p);return p;});
  const legend=node('div');legend.className='pulse-history-legend';for(const [i,title]of ['CPU','RAM','Диск'].entries()){const b=node('button',title);b.type='button';b.setAttribute('aria-pressed','true');b.className=['cpu','memory','disk'][i];b.onclick=()=>{const active=b.getAttribute('aria-pressed')==='true';b.setAttribute('aria-pressed',String(!active));paths[i].style.display=active?'none':'';};legend.append(b);}
  const axis=node('div');axis.className='pulse-history-axis';const ticks=Array.from({length:7},()=>node('span'));axis.append(...ticks);
  const plot=node('div');plot.className='pulse-history-plot';const yAxis=node('div');yAxis.className='pulse-y-axis';for(const v of ['100','75','50','25','0'])yAxis.append(node('span',v));plot.append(yAxis,svg);
  const info=node('details');info.className='pulse-history-info';const caption=node('summary','Получаем историю…'),status=node('p');status.className='home-meta';status.setAttribute('role','status');info.append(caption,status);
  if (!compact) host.append(toolbar);
  host.append(plot);if(!compact)host.append(axis);host.append(legend);if(!compact)host.append(info);
  let lastData;
  function sparklines(){if(!lastData)return;for(const [i,key]of ['cpu','memory','disk'].entries()){const metric=host.closest('.home-card')?.querySelectorAll('.home-metric')[i];if(!metric)continue;let spark=metric.querySelector('.metric-spark');if(!spark){spark=document.createElementNS(ns,'svg');spark.setAttribute('class','metric-spark');spark.setAttribute('viewBox','0 0 100 26');spark.setAttribute('preserveAspectRatio','none');spark.setAttribute('aria-hidden','true');spark.append(document.createElementNS(ns,'path'));metric.append(spark);}let d='',prev;for(const p of lastData.points){if(!Number.isFinite(p[key])){prev=null;continue;}const x=(p.time-lastData.from)/(lastData.to-lastData.from)*100,y=25-p[key]/100*24;d+=(prev&&p.bucket-prev.bucket<=1?'L':'M')+x.toFixed(1)+','+y.toFixed(1)+' ';prev=p;}spark.firstChild.setAttribute('d',d);if(d.includes('L'))spark.dataset.ready='1';else delete spark.dataset.ready;}}
  document.addEventListener('nexus:metrics',sparklines);
  let timer,controller,generation=0,stopped=false;
  async function update(){clearTimeout(timer);controller?.abort();if(document.hidden||stopped)return;const n=++generation;controller=new AbortController();
   try{
    const r=await fetch(window.NexusServers?.history(select.value)||('/modules/pulse/api/history?hours='+select.value),{cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)])});if(r.status===401){location.replace('/login');return;}if(!r.ok)throw Error('История сейчас недоступна.');const data=await r.json();if(n!==generation)return;lastData=data;sparklines();
    for(const [j,key]of ['cpu','memory','disk'].entries()){let d='',prev;for(const p of data.points){if(!Number.isFinite(p[key])){prev=null;continue;}const x=(p.time-data.from)/(data.to-data.from)*900,y=159-p[key]/100*158;const join=prev&&p.bucket-prev.bucket<=1&&p.time-prev.time<=data.interval*2+60000&&!(Number.isFinite(prev.uptime)&&Number.isFinite(p.uptime)&&p.uptime<prev.uptime);d+=(join?'L':'M')+x.toFixed(1)+','+y.toFixed(1)+' ';prev=p;}paths[j].setAttribute('d',d);}
    ticks.forEach((tick,i)=>{const when=new Date(data.from+(data.to-data.from)*i/6);tick.textContent=when.toLocaleString('ru-RU',Number(select.value)>24?{day:'2-digit',month:'2-digit'}:{hour:'2-digit',minute:'2-digit'});tick.title=when.toLocaleString('ru-RU');});
    window.Nexus?.notice?.('pulse','history',!data.available || !!data.stale);
    caption.textContent=!data.available?'—':!data.samples?'Нет измерений за период':`${data.samples} замеров · ${data.stale?'устарели · ':''}подробнее`;
    status.textContent=!data.available?'История ещё не поступила. Она начнёт накапливаться после обновления сборщика Атланта.':!data.samples?'В выбранном периоде нет измерений.':`${data.samples} замеров · с ${new Date(data.first).toLocaleString('ru-RU')} · ${data.interval>60000?'усреднение по интервалам':'замер раз в минуту'}${data.stale?' · последние данные устарели':''}. Пропуски не заполняются.`;
   }catch(e){if(n===generation&&e.name!=='AbortError'){window.Nexus?.notice?.('pulse','history');status.textContent='';}}finally{if(n===generation&&!document.hidden&&!stopped)timer=setTimeout(update,60000);}
  }
  document.addEventListener('nexus:server',()=>{lastData=null;for(const p of paths)p.setAttribute('d','');update();});
  select.onchange=()=>{for(const b of periods.children)b.setAttribute('aria-pressed',String(b.dataset.hours===select.value));update();};document.addEventListener('visibilitychange',()=>{if(document.hidden){generation++;controller?.abort();clearTimeout(timer);}else update();});addEventListener('pagehide',()=>{stopped=true;generation++;controller?.abort();clearTimeout(timer);});addEventListener('pageshow',()=>{stopped=false;update();});update();
 }
})();
