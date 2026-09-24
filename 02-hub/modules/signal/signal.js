(() => {
  const $ = (id) => document.getElementById(id),
    make = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
  let current = null,
    deviceId = null,
    subscription = null,
    timer,
    loading = false,
    acting = false,
    dirty = false,
    visibleEvents = 20;
  const settingsPage = Boolean($('signalSettings'));
  const highlighted = new URLSearchParams(location.search).get('event');
  const supported = () =>
    window.isSecureContext &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;
  const status = (text, error = false) => {
    $('signalStatus').textContent = text;
    $('signalStatus').classList.toggle('error', error);
  };
  const idOf = async (endpoint) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)))
    )
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);
  const ready = () =>
    Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('PWA не готова. Обнови страницу и проверь подключение.')),
          10000
        )
      )
    ]);
  const bytes = (value) =>
    Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  async function api(route, data) {
    const r = await fetch('/modules/signal' + route, {
      method: data === undefined ? 'GET' : 'POST',
      cache: 'no-store',
      headers: data === undefined ? {} : {'Content-Type': 'application/json'},
      body: data === undefined ? undefined : JSON.stringify(data),
      signal: AbortSignal.timeout(10000)
    });
    if (r.status === 401 || r.redirected) {
      location.replace('/login');
      throw new Error('Требуется вход');
    }
    const result = await r.json();
    if (!r.ok) throw new Error(result.error ?? 'Запрос не выполнен');
    return result;
  }
  function events() {
    if (!current || !$('eventFilter')) return;
    const filter = $('eventFilter').value,
      items = current.events.filter((e) => filter === 'all' || e.level === filter);
    if (highlighted)
      visibleEvents = Math.max(visibleEvents, items.findIndex((e) => e.id === highlighted) + 1);
    const expanded = new Set(
      [...document.querySelectorAll('.signal-event[open]')].map((node) => node.dataset.event)
    );
    $('moreEvents').hidden = items.length <= visibleEvents;
    $('signalEvents').replaceChildren(
      ...(items.length
        ? items.slice(0, visibleEvents).map((e) => {
            const el = make('details', undefined, 'signal-event'),
              summary = make('summary'),
              top = make('div', undefined, 'signal-event-top');
            top.append(
              make(
                'span',
                e.level === 'critical'
                  ? 'КРИТИЧЕСКОЕ'
                  : e.level === 'warning'
                    ? 'ПРЕДУПРЕЖДЕНИЕ'
                    : 'ИНФОРМАЦИЯ',
                'signal-level ' + e.level
              ),
              make('time', new Date(e.time).toLocaleString('ru-RU'))
            );
            el.dataset.event = e.id;
            el.open = e.id === highlighted || expanded.has(e.id);
            summary.append(top, make('h3', e.title));
            el.append(summary, make('p', e.body));
            return el;
          })
        : [make('p', 'Пока нет событий в этой категории.', 'signal-help')])
    );
  }
  async function localState() {
    if (!settingsPage) return;
    if (!supported()) {
      $('pushState').textContent = 'не поддерживается';
      $('pushHelp').textContent =
        'Открой хаб по HTTPS в браузере с поддержкой Web Push, например Chrome для Android.';
      $('enablePush').disabled = true;
      return;
    }
    const registration = await ready();
    subscription = await registration.pushManager.getSubscription();
    deviceId = subscription ? await idOf(subscription.endpoint) : null;
    const saved = current?.devices.find((d) => d.id === deviceId),
      active = subscription && saved && !saved.expired;
    $('pushState').textContent = active
      ? 'подключено'
      : Notification.permission === 'denied'
        ? 'запрещено'
        : 'не подключено';
    $('enablePush').textContent = active ? 'Переподключить' : 'Подключить уведомления';
    $('enablePush').disabled = !current?.publicKey;
    $('testPush').disabled = !active;
    $('disablePush').disabled = !subscription;
    if (Notification.permission === 'denied')
      $('pushHelp').textContent =
        'Разреши уведомления для этого сайта в настройках браузера и Android.';
    else
      $('pushHelp').textContent = active
        ? 'Уведомления включены. Нажми «Проверить», чтобы проверить доставку.'
        : 'Нажми «Подключить» и разреши показ уведомлений.';
  }
  function devices() {
    if (!settingsPage) return;
    $('deviceCount').textContent = String(current.devices.length);
    $('signalDevices').replaceChildren(
      ...(current.devices.length
        ? current.devices.map((d) => {
            const row = make('div', undefined, 'signal-device'),
              text = make('div');
            text.append(
              make('strong', d.name),
              make(
                'p',
                d.lastError ||
                  (d.acceptedAt
                    ? 'Передано Push-службе: ' + new Date(d.acceptedAt).toLocaleString('ru-RU')
                    : 'Проверка доставки ещё не выполнялась') +
                    (d.pending ? ` · в очереди ${d.pending}` : '')
              )
            );
            const remove = make('button', 'Удалить');
            remove.type = 'button';
            remove.addEventListener('click', () =>
              act(async () => {
                await api('/unsubscribe', {id: d.id});
                if (d.id === deviceId && subscription) await subscription.unsubscribe();
                await load();
                status('Устройство отключено.');
              })
            );
            row.append(text, remove);
            return row;
          })
        : [make('p', 'Устройства ещё не подключены.', 'signal-help')])
    );
  }
  async function load() {
    clearTimeout(timer);
    if (document.hidden || loading) return;
    loading = true;
    try {
      current = await api('/api');
      if (settingsPage && !dirty) {
        for (const [key, value] of Object.entries(current.settings.categories))
          document.querySelector(`[name="${key}"]`).checked = value;
        $('dailyTime').value = current.settings.dailyTime;
        $('pushDetails').checked = current.settings.detailOnLockScreen;
      }
      if ($('activeCount'))
        $('activeCount').textContent = current.stale
          ? 'Сводка устарела'
          : `Активных предупреждений: ${current.active.length}`;
      devices();
      events();
      await localState();
      status(
        current.stale
          ? 'Сборщик не передаёт свежие данные. Проверь службу «Сигнал».'
          : 'Сигнал работает · ' + new Date(current.updatedAt).toLocaleTimeString('ru-RU'),
        current.stale
      );
    } catch (e) {
      status(navigator.onLine ? e.message : 'Нет соединения. Показаны последние события.', true);
    } finally {
      loading = false;
      if (!document.hidden) timer = setTimeout(load, 10000);
    }
  }
  async function act(fn) {
    if (acting) return;
    acting = true;
    try {
      await fn();
    } catch (e) {
      status(e.message, true);
    } finally {
      acting = false;
    }
  }
  $('enablePush')?.addEventListener('click', () =>
    act(async () => {
      if (!supported() || !current?.publicKey) throw new Error('Сборщик Push ещё не готов');
      if ((await Notification.requestPermission()) !== 'granted')
        throw new Error('Разрешение не получено. Проверь настройки браузера.');
      const registration = await ready();
      await registration.update();
      const old = await registration.pushManager.getSubscription();
      if (old) {
        await api('/unsubscribe', {id: await idOf(old.endpoint)});
        await old.unsubscribe();
      }
      const sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes(current.publicKey)
      });
      try {
        await api('/subscribe', {name: $('deviceName').value, subscription: sub.toJSON()});
      } catch (e) {
        await sub.unsubscribe();
        throw e;
      }
      await load();
      status('Уведомления подключены. Теперь нажми «Проверить».');
    })
  );
  $('disablePush')?.addEventListener('click', () =>
    act(async () => {
      if (deviceId) await api('/unsubscribe', {id: deviceId});
      await subscription?.unsubscribe();
      await load();
      status('Уведомления на этом устройстве отключены.');
    })
  );
  $('testPush')?.addEventListener('click', () =>
    act(async () => {
      await api('/test', {id: deviceId});
      status('Проверка поставлена в очередь. Подожди уведомление на телефоне.');
    })
  );
  $('signalSettings')?.addEventListener('input', () => {
    dirty = true;
  });
  $('signalSettings')?.addEventListener('submit', (event) => {
    event.preventDefault();
    act(async () => {
      const categories = Object.fromEntries(
        [...document.querySelectorAll('.signal-options input')].map((e) => [e.name, e.checked])
      );
      await api('/settings', {
        categories,
        dailyTime: $('dailyTime').value,
        detailOnLockScreen: $('pushDetails').checked
      });
      dirty = false;
      status('Настройки сохранены.');
    });
  });
  $('eventFilter')?.addEventListener('change', () => {
    visibleEvents = 20;
    events();
  });
  $('moreEvents')?.addEventListener('click', () => {
    visibleEvents += 20;
    events();
  });
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden) load();
  });
  window.addEventListener('online', load);
  load();
})();
