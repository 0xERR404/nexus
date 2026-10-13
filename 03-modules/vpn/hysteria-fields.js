(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const field=(label,key,value=0,min=0,max=100000)=>`<label>${label}<input name="hy2_${key}" type="number" min="${min}" max="${max}" step="1" value="${esc(value)}"></label>`;
  const select=(label,key,items,value)=>`<label>${label}<select name="hy2_${key}">${items.map(([v,t])=>`<option value="${v}" ${value===v?'selected':''}>${t}</option>`).join('')}</select></label>`;
  function html(h={}){return `<div id="vpnHysteriaFields">
    <fieldset class="vpn-section"><legend>Hysteria 2 · скорость</legend><div class="vpn-actions"><button type="button" id="vpnHysteriaStable">Для устойчивого соединения</button><button type="button" id="vpnHysteriaRecovery">Быстрое восстановление</button></div><div class="vpn-fields">
      ${select('Управление скоростью','congestion',[['auto','Автоматически'],['bbr','BBR · по состоянию сети'],['brutal','Brutal · заданная скорость']],h.congestion??'bbr')}
      ${select('Профиль BBR','bbrProfile',[['conservative','Осторожный'],['standard','Обычный'],['aggressive','Агрессивный']],h.bbrProfile??'standard')}
      ${field('Отдача клиента, Мбит/с','upMbps',h.upMbps)}${field('Загрузка клиента, Мбит/с','downMbps',h.downMbps)}
    </div><p class="vpn-hint">Набор устойчивости: BBR, обычный профиль, KeepAlive 10 секунд и автоматический MTU. «Быстрое восстановление» меняет только тайм-аут QUIC на 15 секунд и KeepAlive на 5 секунд: обрыв обнаруживается раньше, но длительные перебои чаще приводят к переподключению. Маскировка и порты сохраняются. Для Brutal укажи реальные скорости канала; завышенные значения могут увеличить задержки. На ноде направления учитываются автоматически.</p></fieldset>
    <fieldset class="vpn-section"><legend>Маскировка</legend><div class="vpn-fields">
      ${select('Маскировка пакетов','obfs',[['none','Выключена'],['salamander','Salamander']],h.obfs??'none')}
      <label>Пароль Salamander<input name="hy2_obfsPassword" type="password" autocomplete="new-password" maxlength="128" value="${esc(h.obfsPassword)}"></label>
      ${select('Страница HTTP/3','masquerade',[['none','Обычный ответ 404'],['html','Своя HTML-страница']],h.masquerade??'none')}
    </div><label data-hy2-html>Содержимое страницы<textarea name="hy2_html" rows="5" spellcheck="false" placeholder="&lt;h1&gt;Добро пожаловать&lt;/h1&gt;">${esc(h.html)}</textarea></label>
    <p class="vpn-hint">Страница показывается посетителям без авторизации. Максимум 2048 байт. При Salamander обычная страница HTTP/3 недоступна.</p></fieldset>
    <fieldset class="vpn-section"><legend>Смена портов</legend><div class="vpn-fields">
      <label>UDP-порты · пусто — выключено<input name="hy2_hopPorts" value="${esc(h.hopPorts)}" maxlength="180" placeholder="20000-20100,21000"></label>
      ${field('Интервал, секунд','hopInterval',h.hopInterval??30,5,3600)}
      ${select('Совместимость с клиентом','hopFormat',[['xray','Happ / Xray 26.9.9 и новее'],['happ','Старое ядро Xray 26.7.28']],h.hopFormat??'xray')}
    </div><p class="vpn-hint">Проверь версию ядра в клиенте. Старый формат 26.7.28 не включает смену портов в новом Happ: после обновления клиента выбери 26.9.9 и новее, сохрани и обнови подписку. После изменения диапазона повтори деплой VPN-ноды для настройки переадресации. Эти UDP-порты также нужно открыть у провайдера. До этого нода сохранит прежнее подключение.</p></fieldset>
    <fieldset class="vpn-section"><legend>Соединение и QUIC</legend><div class="vpn-fields">
      ${field('Тайм-аут UDP, секунд','udpIdleTimeout',h.udpIdleTimeout??60,5,600)}
      ${field('Тайм-аут QUIC, секунд','maxIdleTimeout',h.maxIdleTimeout??30,4,120)}
      ${field('KeepAlive, секунд · 0 — выключен','keepAlivePeriod',h.keepAlivePeriod??Math.min(10,(h.maxIdleTimeout??30)-1),0,60)}
      ${field('Максимум входящих потоков','maxIncomingStreams',h.maxIncomingStreams??1024,8,8192)}
      <label class="vpn-check"><input type="checkbox" name="hy2_disablePathMTUDiscovery" ${h.disablePathMTUDiscovery?'checked':''}>Отключить определение MTU</label>
      ${field('Начальное окно потока, байт','initStreamReceiveWindow',h.initStreamReceiveWindow,0,67108864)}
      ${field('Максимальное окно потока, байт','maxStreamReceiveWindow',h.maxStreamReceiveWindow,0,67108864)}
      ${field('Начальное окно соединения, байт','initConnectionReceiveWindow',h.initConnectionReceiveWindow,0,167772160)}
      ${field('Максимальное окно соединения, байт','maxConnectionReceiveWindow',h.maxConnectionReceiveWindow,0,167772160)}
    </div><p class="vpn-hint">Окна QUIC: 0 — настройки ядра. KeepAlive: 0 или от 2 секунд, меньше тайм-аута QUIC. Все параметры клиента передаются через подписку Xray JSON; отдельные ссылки и Mihomo переносят только поддерживаемые ими поля.</p></fieldset>
  </div>`;}
  function update(form){
    const root=form.querySelector('#vpnHysteriaFields'),active=form.elements.profile.value==='hysteria2';root.hidden=!active;
    for(const control of root.querySelectorAll('input,select,textarea'))control.disabled=!active;
    if(!active)return;
    const f=key=>form.elements['hy2_'+key],enabled=(key,on)=>{f(key).disabled=!on;};
    const brutal=f('congestion').value==='brutal',obfs=f('obfs').value==='salamander';
    enabled('upMbps',brutal);enabled('downMbps',brutal);enabled('bbrProfile',!brutal);
    enabled('obfsPassword',obfs);f('obfsPassword').required=obfs;f('obfsPassword').minLength=8;
    enabled('masquerade',!obfs);if(obfs)f('masquerade').value='none';
    root.querySelector('[data-hy2-html]').hidden=f('masquerade').value!=='html';enabled('html',f('masquerade').value==='html');
    enabled('hopInterval',!!f('hopPorts').value.trim());enabled('hopFormat',!!f('hopPorts').value.trim());
  }
  function read(form,previous={}){
    const h={...previous};for(const e of form.querySelectorAll('#vpnHysteriaFields [name]')){
      const key=e.name.slice(4);h[key]=e.type==='checkbox'?e.checked:e.type==='number'?Number(e.value):e.value;
    }return h;
  }
  function stable(form){
    const values={congestion:'bbr',bbrProfile:'standard',upMbps:0,downMbps:0,keepAlivePeriod:10,maxIdleTimeout:30,udpIdleTimeout:60,initStreamReceiveWindow:0,maxStreamReceiveWindow:0,initConnectionReceiveWindow:0,maxConnectionReceiveWindow:0,maxIncomingStreams:1024};
    for(const [key,value] of Object.entries(values))form.elements['hy2_'+key].value=value;
    form.elements.hy2_disablePathMTUDiscovery.checked=false;update(form);
  }
  function recovery(form){form.elements.hy2_maxIdleTimeout.value=15;form.elements.hy2_keepAlivePeriod.value=5;update(form);}
  window.NexusVPNHysteria={html,update,read,stable,recovery};
})();
