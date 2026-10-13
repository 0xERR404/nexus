(() => {
  const $ = (id) => document.getElementById(id);
  const settings = $('securitySettings'),
    factor = $('factorLogin'),
    passkey = $('passkeyLogin');
  if (!settings && !factor && !passkey) return;
  const status = (message) => {
    $('securityStatus').textContent = message;
  };
  const api = async (route, data) => {
    const response = await fetch(route, {
      method: data ? 'POST' : 'GET',
      cache: 'no-store',
      credentials: 'same-origin',
      signal: AbortSignal.timeout(15000),
      ...(data ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)} : {})
    });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || 'Не удалось выполнить запрос.');
    return value;
  };
  const decode = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const encode = (value) =>
    btoa(String.fromCharCode(...new Uint8Array(value)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  async function credential(options, create = false, signal) {
    if (!window.PublicKeyCredential || !navigator.credentials)
      throw Error('Этот браузер не поддерживает ключи доступа. Открой хаб в Chrome через HTTPS.');
    const publicKey = {...options, challenge: decode(options.challenge)};
    if (create) publicKey.user = {...options.user, id: decode(options.user.id)};
    for (const name of ['allowCredentials', 'excludeCredentials'])
      if (publicKey[name])
        publicKey[name] = publicKey[name].map((item) => ({...item, id: decode(item.id)}));
    let key;
    try {
      key = await navigator.credentials[create ? 'create' : 'get']({
        publicKey,
        ...(signal ? {signal} : {})
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw Error(
        e.name === 'NotAllowedError'
          ? 'Подтверждение отменено или истекло. Попробуй ещё раз.'
          : 'Ключ недоступен на этом устройстве. Используй другой ключ или код восстановления.'
      );
    }
    if (!key) throw Error('Ключ не получен.');
    const response = {};
    for (const name of [
      'clientDataJSON',
      'attestationObject',
      'authenticatorData',
      'signature',
      'userHandle'
    ])
      if (key.response[name]) response[name] = encode(key.response[name]);
    return {id: key.id, rawId: encode(key.rawId), type: key.type, response};
  }
  let busy = false;
  async function run(fn) {
    if (busy) return;
    busy = true;
    status('');
    const buttons = [...(settings || factor || passkey).querySelectorAll('button')].filter(
      (b) => !b.closest('dialog')
    );
    buttons.forEach((b) => (b.disabled = true));
    try {
      await fn();
    } catch (e) {
      if (e.name !== 'AbortError') status(e.message);
    } finally {
      busy = false;
      buttons.forEach((b) => (b.disabled = false));
    }
  }
  const enter = () => {
    try {
      sessionStorage.setItem('nexus-intro-pending', String(Date.now()));
    } catch {}
    window.top.location.href = '/';
  };
  if (passkey) {
    let controller;
    const fallback = $('passwordFallback');
    const start = () =>
      run(async () => {
        controller = new AbortController();
        const options = await api('/api/auth/passkey/options', {});
        if (controller.signal.aborted) return;
        const signed = await credential(options.publicKey, false, controller.signal);
        if (controller.signal.aborted) return;
        await api('/api/auth/passkey/verify', {id: options.id, credential: signed});
        enter();
      });
    $('passkeyEnter').onclick = () => {
      fallback.open = false;
      void start();
    };
    fallback.addEventListener('toggle', () => {
      if (fallback.open) controller?.abort();
    });
    window.addEventListener('pagehide', () => controller?.abort());
    const auto = () => {
      if (document.visibilityState === 'hidden') return;
      document.removeEventListener('visibilitychange', auto);
      if (!fallback.open) void start();
    };
    if (passkey.dataset.auto === '1' && window.PublicKeyCredential && navigator.credentials) {
      if (document.visibilityState === 'hidden')
        document.addEventListener('visibilitychange', auto);
      else auto();
    }
    return;
  }
  if (factor) {
    $('factorKey').onclick = () =>
      run(async () => {
        const options = await api('/api/auth/factor/options', {});
        await api('/api/auth/factor/verify', {
          id: options.id,
          credential: await credential(options.publicKey)
        });
        enter();
      });
    $('factorRecovery').onsubmit = (event) => {
      event.preventDefault();
      void run(async () => {
        await api('/api/auth/factor/recovery', {code: $('recoveryCode').value});
        $('recoveryCode').value = '';
        enter();
      });
    };
    return;
  }
  const node = (tag, text) => {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const date = (value) => (value ? new Date(value).toLocaleString('ru-RU') : 'Неизвестно');
  let snapshot;
  async function refresh() {
    snapshot = await api('/api/security');
    $('securityTTL').value = String(snapshot.ttl);
    $('securityFactorState').textContent = snapshot.enabled
      ? 'Вход по ключу · без пароля'
      : 'Не включён';
    $('securityRecoveryState').textContent = snapshot.enabled
      ? `Кодов восстановления: ${snapshot.recoveryLeft}`
      : '';
    $('securityRecovered').hidden = !snapshot.recovered;
    $('securityCodesNew').hidden = !snapshot.enabled;
    const keys = $('securityKeys');
    keys.replaceChildren();
    for (const key of snapshot.keys) {
      const row = node('div'),
        text = node('div');
      row.className = 'security-row';
      text.append(
        node('strong', key.label),
        node('small', 'Добавлен: ' + date(key.created) + ' · Вход: ' + date(key.used))
      );
      const button = node('button', 'Удалить');
      button.type = 'button';
      button.onclick = () =>
        run(async () => {
          const grant = await authorize(
            'remove-key',
            undefined,
            snapshot.keys.length === 1
              ? 'Удалить последний ключ и отключить второй фактор?'
              : 'Удалить ключ доступа?'
          );
          await api('/api/security/keys/remove', {id: key.id, grant});
          await refresh();
          status('Ключ удалён. Остальные сессии завершены.');
        });
      row.append(text, button);
      keys.append(row);
    }
    const sessions = $('securitySessions');
    sessions.replaceChildren();
    for (const item of snapshot.sessions) {
      const row = node('div'),
        text = node('div');
      row.className = 'security-row';
      text.append(
        node('strong', item.device + (item.current ? ' · сейчас' : '')),
        node('small', item.ip || ''),
        node('small', 'Вход: ' + date(item.created)),
        node('small', 'Активность: ' + date(item.seen)),
        node('small', 'До: ' + date(item.expires))
      );
      const button = node('button', 'Завершить');
      button.type = 'button';
      button.onclick = () =>
        run(async () => {
          const r = await api('/api/security/sessions/revoke', {id: item.id});
          if (r.logout) window.top.location.href = '/login';
          else await refresh();
        });
      row.append(text, button);
      sessions.append(row);
    }
  }
  function askPassword(title) {
    return new Promise((resolve, reject) => {
      const dialog = $('securityConfirm'),
        form = $('securityConfirmForm'),
        input = $('securityCurrent');
      $('securityConfirmTitle').textContent = title || 'Подтверди действие';
      input.value = '';
      let accepted = false;
      form.onsubmit = (event) => {
        event.preventDefault();
        accepted = true;
        const value = input.value;
        input.value = '';
        dialog.close();
        resolve(value);
      };
      dialog.addEventListener(
        'close',
        () => {
          input.value = '';
          if (!accepted) reject(Error('Действие отменено.'));
        },
        {once: true}
      );
      dialog.showModal();
      input.focus();
    });
  }
  async function authorize(action, password, title) {
    password ??= await askPassword(title);
    const options = await api('/api/security/authorize', {action, password});
    if (options.grant) return options.grant;
    return (
      await api('/api/security/authorize/verify', {
        id: options.id,
        credential: await credential(options.publicKey)
      })
    ).grant;
  }
  const showCodes = (codes) => {
    if (!codes) return;
    $('securityCodesText').textContent = codes
      .map((code) => code.match(/.{1,4}/g).join('-'))
      .join('\n');
    $('securityCodes').showModal();
  };
  $('securityCodesDownload').onclick = () => {
    const url = URL.createObjectURL(
      new Blob(
        [
          'NEXUS404 · коды восстановления\nКаждый код можно использовать один раз вместе с паролем.\n\n' +
            $('securityCodesText').textContent
        ],
        {type: 'text/plain;charset=utf-8'}
      )
    );
    const link = node('a');
    link.href = url;
    link.download = 'nexus404-recovery.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('securityCodes').addEventListener('close', () => ($('securityCodesText').textContent = ''));
  document
    .querySelectorAll('[data-security-close]')
    .forEach((button) => (button.onclick = () => button.closest('dialog').close()));
  $('securityPasswordForm').onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const password = $('securityNew').value;
      if (password !== $('securityRepeat').value) throw Error('Пароли не совпадают.');
      const grant = await authorize('password', $('securityOld').value);
      await api('/api/security/password', {grant, password});
      $('securityPasswordForm').reset();
      await refresh();
      status('Пароль изменён. Остальные сессии завершены.');
    });
  };
  $('securityTTLForm').onsubmit = (event) => {
    event.preventDefault();
    void run(async () => {
      const ttl = Number($('securityTTL').value),
        grant = await authorize('ttl');
      const result = await api('/api/security/ttl', {grant, ttl});
      if (result.logout) {
        window.top.location.href = '/login';
        return;
      }
      await refresh();
      status('Срок сессии сохранён.');
    });
  };
  $('securityKeyAdd').onclick = () =>
    run(async () => {
      const grant = await authorize('add-key'),
        options = await api('/api/security/keys/options', {grant});
      const result = await api('/api/security/keys/register', {
        id: options.id,
        credential: await credential(options.publicKey, true),
        label: $('securityKeyName').value
      });
      await refresh();
      showCodes(result.codes);
      status('Ключ добавлен.');
    });
  $('securityCodesNew').onclick = () =>
    run(async () => {
      const grant = await authorize(
        'recovery',
        undefined,
        'Заменить коды восстановления? Старые перестанут работать.'
      );
      const r = await api('/api/security/recovery', {grant});
      await refresh();
      showCodes(r.codes);
    });
  $('securityOthers').onclick = () =>
    run(async () => {
      await api('/api/security/sessions/others', {});
      await refresh();
      status('Остальные сессии завершены.');
    });
  $('securityRefresh').onclick = () => run(refresh);
  void run(refresh);
})();
