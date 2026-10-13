(() => {
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const supported=profile=>['trojan-xhttp','trojan-grpc'].includes(profile);
  const html=c=>`<fieldset class="vpn-section"><legend>Способ подключения</legend><label>Маршрут до ноды<select name="delivery"><option value="direct" ${c.delivery!=='cloudflare'?'selected':''}>Напрямую</option><option value="cloudflare" ${c.delivery==='cloudflare'?'selected':''}>☁ Через Cloudflare</option></select></label><div data-cloudflare-fields><label>Домен Cloudflare<input name="cloudflareDomain" value="${esc(c.cloudflareDomain)}" maxlength="253" autocomplete="off" placeholder="pl.example.com"></label><p>В Cloudflare создай A/AAAA-запись этого домена на настоящий IP ноды, включи оранжевое облако и Full (strict). Для gRPC включи Network → gRPC. Порт на ноде и в Happ одинаковый; отдельные правила изменения порта не используются.</p><p>На ноде нужен сертификат для этого домена. Нода 0.35.226 и новее сохраняет отдельные сертификаты IP и доменов и выбирает их по SNI. Перед добавлением сертификата обнови ноду; в старой версии сертификат общий для всех TLS-подключений. IP-сертификат сам по себе для домена не подходит.</p><p>В Happ домен и SNI передаются через подписку. Значок облака означает выбранный режим, а не успешную проверку Cloudflare. DNS и настройки Cloudflare здесь не меняются.</p></div><p data-cloudflare-note class="vpn-hint" role="status"></p></fieldset>`;
  function bind(form){
    const mode=form.elements.delivery,domain=form.elements.cloudflareDomain,sni=form.elements.sni,box=form.querySelector('[data-cloudflare-fields]'),note=form.querySelector('[data-cloudflare-note]');
    function update(){
      const cloud=mode.value==='cloudflare',allowed=supported(form.elements.profile.value);
      mode.querySelector('[value=cloudflare]').disabled=!allowed&&!cloud;
      box.hidden=!cloud;domain.disabled=!cloud;domain.required=cloud;sni.readOnly=cloud;
      mode.setCustomValidity(cloud&&!allowed?'Cloudflare поддерживает только Trojan XHTTP + TLS и Trojan gRPC + TLS. Выбери подходящий профиль или прямое подключение.':'');
      if(cloud)sni.value=domain.value.trim().toLowerCase();
      note.textContent=cloud?(allowed?(form.elements.profile.value==='trojan-grpc'?'gRPC: порт 443.':'XHTTP: режим packet-up; TLS-порты 443, 2053, 2083, 2087, 2096, 8443.')+' Если порт занят другим TCP-подключением, выбери свободный поддерживаемый порт или измени существующее подключение.':'Этот профиль не работает через обычный прокси Cloudflare. Выбери Trojan XHTTP/TLS или gRPC/TLS.'):'Cloudflare доступен для Trojan XHTTP/TLS и gRPC/TLS. Остальные профили подключаются напрямую.';
    }
    mode.addEventListener('change',update);domain.addEventListener('input',update);update();return {update};
  }
  window.NexusVPNCloudflare=Object.freeze({html,bind});
})();
