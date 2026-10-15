(() => {
  const base='/modules/vpn/api/diagnostics', key='nexus-vpn-diagnostics-v1';
  let active=null;
  const changed=()=>dispatchEvent(new Event('nexus:ping-change'));
  const fatal=message=>Object.assign(Error(message),{fatal:true});
  async function request(route,{body,token,signal,timeout=3000,keepalive=false}={}){
    const controller=new AbortController(),abort=()=>controller.abort();
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const timer=setTimeout(abort,timeout);
    try{
      const response=await fetch(base+route,{method:body?'POST':'GET',headers:{...(body?{'content-type':'application/json'}:{}),...(token?{'x-vpn-diagnostic':token}:{})},body:body?JSON.stringify(body):undefined,cache:'no-store',redirect:'error',credentials:'same-origin',signal:controller.signal,keepalive});
      if(!response.ok){
        if([401,403,409,410,429].includes(response.status))throw fatal(({401:'Вход истёк. Войди снова.',403:'Нет доступа к проверке.',409:'Другая проверка уже запущена. Останови её в Арго.',410:'Время проверки истекло.',429:'Слишком много проверок. Подожди минуту.'})[response.status]);
        throw Error('Хаб не ответил на пробу.');
      }
      try{return await response.json();}catch{throw fatal('Неожиданный ответ хаба.');}
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  const pause=signal=>new Promise(resolve=>{
    if(signal.aborted)return resolve();
    const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();},timer=setTimeout(done,250);
    signal.addEventListener('abort',done,{once:true});
  });
  async function release(job){
    if(!job.token||job.released)return;job.released=true;
    try{await request('/stop',{body:{id:job.token},timeout:2000,keepalive:true});}catch{}
  }
  function save(run){
    if(!run.samples.length)return;
    let rows=[];try{const old=JSON.parse(localStorage.getItem(key));if(Array.isArray(old))rows=old.filter(r=>r?.v===1&&Array.isArray(r.samples));}catch{}
    try{localStorage.setItem(key,JSON.stringify([run,...rows].sort((a,b)=>b.started-a.started).slice(0,30)));}
    catch{run.storageError='Результат виден до обновления страницы: браузер запретил сохранение.';}
  }
  async function run(connection){
    if(active)throw Error('Дождись текущего замера.');
    if(document.hidden)throw Error('Открой вкладку для замера.');
    const r={v:1,started:Date.now(),connection:connection.id,label:connection.title,mode:'ping',network:'',samples:[],bytes:0,duration:0,status:'Выполняется',loadNote:'Короткий HTTP-замер без скачивания. Это не ICMP-пинг.'};
    const job={connection:r.connection,controller:new AbortController(),token:null,progress:0,reason:''};active=job;changed();
    const started=performance.now(),signal=job.controller.signal;
    try{
      // Let start finish even after cancellation so its server-side slot can be released.
      const initial=await request('/start',{body:{connection:r.connection},timeout:8000});
      if(typeof initial.id!=='string'||!/^[a-zA-Z0-9_-]{10,64}$/.test(initial.id))throw fatal('Неожиданный ответ хаба.');
      job.token=initial.id;
      for(let i=0;i<5&&!signal.aborted;i++){
        job.progress=i+1;changed();const begin=performance.now(),nonce=crypto.randomUUID();
        try{
          const value=await request('/probe?nonce='+nonce,{token:job.token,signal});
          if(value.id!==job.token||value.nonce!==nonce||!['matched','different','unknown','baseline'].includes(value.path))throw fatal('Ответ пробы не соответствует запросу.');
          r.samples.push({at:begin-started,ms:performance.now()-begin,ok:true,path:value.path,phase:'idle'});
        }catch(e){
          if(signal.aborted||e.fatal)throw e;
          r.samples.push({at:begin-started,ms:performance.now()-begin,ok:false,path:'unknown',phase:'idle'});
        }
        if(i<4)await pause(signal);
      }
      r.status=signal.aborted?job.reason:r.samples.every(s=>s.ok)?'Завершено':r.samples.some(s=>s.ok)?'Завершено со сбоями':'Нет ответа';
    }catch(e){r.status=signal.aborted?job.reason:e.message||'Не удалось выполнить замер';}
    finally{
      r.duration=performance.now()-started;save(r);await release(job);active=null;
      window.NexusQuickPing.last=r;window.NexusQuickPing.results[r.connection]=r;changed();
    }
    return r;
  }
  function stop(reason='Замер остановлен'){if(active){active.reason=reason;active.controller.abort();void release(active);}}
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stop('Замер прерван: вкладка скрыта');});
  addEventListener('pagehide',()=>stop('Замер прерван: страница закрыта'));
  window.NexusQuickPing={run,stop,last:null,results:Object.create(null),get active(){return active?{connection:active.connection,progress:active.progress}:null;}};
})();
