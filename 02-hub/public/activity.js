(() => {
  const prefix = 'nexus404-activity-v2:', memory = new Map();
  let sending = false, retry, retryUntil=0, lastError = '';
  const warn = message => {
    lastError = message;
    dispatchEvent(new CustomEvent('nexus:activity-status', {detail: message}));
  };
  function entries() {
    const rows = new Map();
    try { for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(prefix)) rows.set(key, localStorage.getItem(key));
    } } catch { /* The in-memory queue remains usable. */ }
    for (const [key,body] of memory) rows.set(key,body);
    return [...rows].map(([key, body]) => {
      try {
        const parsed=JSON.parse(body);
        if (parsed?.activityRejected === true) return {key,body,rejected:parsed};
        if (!parsed || typeof parsed.session !== 'string' || !Number.isSafeInteger(parsed.seq) || !Number.isSafeInteger(parsed.at))
          return {key,body,invalid:true};
        return {key,body,data:parsed};
      } catch { return {key,body,invalid:true}; }
    }).sort((a,b)=>(a.data?.at??0)-(b.data?.at??0) || (a.data?.session??'').localeCompare(b.data?.session??'') || (a.data?.seq??0)-(b.data?.seq??0));
  }
  function quarantine(row, reason) {
    const body=JSON.stringify({activityRejected:true,at:Date.now(),reason,body:row.body});
    memory.set(row.key,body);
    try {localStorage.setItem(row.key,body);} catch {warn('Отклонённое событие сохранено только в памяти: хранилище браузера недоступно');}
  }
  function queueState() {
    const rows=entries(), rejected=rows.filter(r=>r.rejected);
    return {pending:rows.length-rejected.length,rejected:rejected.length,
      reasons:[...new Set(rejected.map(r=>r.rejected.reason))],error:lastError};
  }
  async function flush() {
    if (sending) return;
    if(Date.now()<retryUntil) {
      if(!retry)retry=setTimeout(()=>{retry=null;void flush();},retryUntil-Date.now());
      return;
    }
    clearTimeout(retry); retry = null;
    if (navigator.onLine === false) {warn('Нет сети · статистика ожидает отправки');return;}
    sending = true;
    try {
      for (const row of entries()) {
        if(row.rejected)continue;
        if(row.invalid) {quarantine(row,'Повреждённое событие в очереди браузера');continue;}
        const response = await fetch('/api/activity', {method:'POST', headers:{'Content-Type':'application/json'}, body:row.body,
          keepalive:true, signal:AbortSignal.timeout(10000)});
        const result=await response.json().catch(()=>null);
        if (!response.ok) {
          if ([400,409,422].includes(response.status) && result?.rejected === true && typeof result.error === 'string') {
            quarantine(row,result.error.slice(0,300));continue;
          }
          if(response.status===429) {
            const value=response.headers?.get?.('retry-after'),seconds=Number(value);
            const delay=value ? (/^\d+$/.test(value)?seconds*1000:Date.parse(value)-Date.now()) : 30000;
            retryUntil=Date.now()+Math.max(1000,Math.min(86400000,Number.isFinite(delay)?delay:30000));
          }
          throw Error('Статистика ожидает отправки: HTTP ' + response.status);
        }
        if (typeof result?.accepted !== 'boolean') throw Error('Нет подтверждения статистики');
        try {localStorage.removeItem(row.key);} catch {}
        memory.delete(row.key);
      }
      warn('');
    } catch (e) {
      if(retryUntil<=Date.now())retryUntil=Date.now()+30000;
      warn(e.message);retry=setTimeout(()=>{retry=null;void flush();},Math.max(1,retryUntil-Date.now()));
    }
    finally { sending = false; if (!retry && entries().some(r=>!r.rejected)) retry = setTimeout(flush, 1000); }
  }
  function recorder() {
    let identity = '', session = '', seq = 0, previousPosition = 0;
    return value => {
      if (!value) return;
      const key = value.source + ':' + value.item;
      if (identity !== key || (value.source !== 'reader' && value.playing && value.position < previousPosition - 2)) {identity = key; session = crypto.randomUUID(); seq = 0;}
      previousPosition = value.position;
      const data = {...value, title:String(value.title || 'Без названия').slice(0,300), session, seq:++seq, at:Date.now()};
      const id = prefix + session + ':' + seq, body = JSON.stringify(data);
      memory.set(id, body);
      try {localStorage.setItem(id, body);} catch {warn('Очередь статистики временно в памяти: хранилище браузера недоступно');}
      void flush();
    };
  }
  addEventListener('online', flush);
  addEventListener('storage', e => {if(e.key?.startsWith(prefix)) void flush();});
  document.addEventListener('visibilitychange', () => {if (!document.hidden) void flush();});
  void flush();
  window.NexusActivity = {
    queueState,
    rejectedEvents: () => entries().filter(r=>r.rejected).map(r=>r.rejected),
    media(media, get) {
      const send = recorder();
      let last = 0;
      function sample(force = false) {
        const item = get();
        if (!item) return;
        if (!force && Date.now() - last < 10000) return;
        last = Date.now();
        send({
          ...item,
          position: Number.isFinite(media.currentTime) ? media.currentTime : 0,
          duration: Number.isFinite(media.duration) ? media.duration : 0,
          playing: !media.paused && !media.ended && !media.seeking
        });
      }
      media.addEventListener('timeupdate', () => sample());
      for (const event of ['playing', 'pause', 'ended', 'seeking', 'seeked'])
        media.addEventListener(event, () => sample(true));
      document.addEventListener('visibilitychange', () => sample(true));
      addEventListener('pagehide', () => sample(true));
    },
    reading(get) {
      const send = recorder();
      let position = 0,
        last = performance.now(),
        active = false;
      const tick = () => {
        const now = performance.now(),
          item = get();
        if (active) position += Math.min(15, (now - last) / 1000);
        last = now;
        active = Boolean(item) && !document.hidden;
        if (item)
          send({...item, source: 'reader', kind: 'book', position, duration: 0, playing: active});
      };
      setInterval(tick, 10000);
      document.addEventListener('visibilitychange', tick);
      addEventListener('pagehide', () => {
        tick();
        active = false;
      });
    }
  };
})();
