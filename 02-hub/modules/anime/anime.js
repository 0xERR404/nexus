(() => {
  const $ = (id) => document.getElementById(id);
  const page = $('animePage'),
    settings = $('animeSettings');
  if (!page && !settings) return;
  const statuses = {
    watching: 'Смотрю',
    completed: 'Посмотрел',
    planned: 'Запланировано',
    on_hold: 'Отложено',
    dropped: 'Бросил',
    rewatching: 'Пересматриваю'
  };
  let snapshot,
    current = 1,
    loading = false,
    mutation = false,
    timer;
  function status(text, error = false) {
    $('animeStatus').textContent = text;
    $('animeStatus').classList.toggle('anime-error', error);
  }
  async function api(route, data) {
    const res = await fetch('/modules/anime' + route, {
      method: data ? 'POST' : 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(data ? 45000 : 10000),
      ...(data ? {headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)} : {})
    });
    if (
      res.redirected ||
      (res.status === 401 && !res.headers.get('content-type')?.includes('application/json'))
    )
      throw new Error('Войди в хаб заново.');
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error('Сервер недоступен. Попробуй позже.');
    }
    if (!res.ok) throw new Error(json.error || 'Запрос не выполнен.');
    return json;
  }
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  function renderList() {
    if (!snapshot) return;
    const query = $('animeSearch').value.trim().toLocaleLowerCase('ru'),
      filter = $('animeFilter').value;
    const items = snapshot.items
      .filter(
        (x) =>
          (!filter || x.status === filter) &&
          (!query || (x.title + ' ' + x.name).toLocaleLowerCase('ru').includes(query))
      )
      .sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    const total = Math.max(1, Math.ceil(items.length / 30));
    current = Math.min(current, total);
    $('animeCount').textContent = items.length + ' из ' + snapshot.items.length;
    $('animePageNumber').textContent = current + ' / ' + total;
    $('animePrev').disabled = current <= 1;
    $('animeNext').disabled = current >= total;
    document.querySelector('.anime-pagination').hidden = total === 1;
    const fragment = document.createDocumentFragment();
    for (const item of items.slice((current - 1) * 30, current * 30)) {
      const card = node('article', undefined, 'anime-card');
      const cover = node('div', undefined, 'anime-cover');
      cover.setAttribute('aria-hidden', 'true');
      cover.append(node('span', '◇'));
      if (item.cover) {
        const img = node('img');
        img.src = item.cover;
        img.alt = '';
        img.loading = 'lazy';
        img.width = 60;
        img.height = 84;
        img.addEventListener('error', () => img.remove(), {once: true});
        cover.append(img);
      }
      const details = node('div', undefined, 'anime-details'),
        heading = node('h2');
      const link = node('a', item.title);
      link.href = 'https://shikimori.io/animes/' + item.id;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      heading.append(link);
      details.append(heading);
      const meta = node('div', undefined, 'anime-card-meta'),
        state = node('span', statuses[item.status], 'anime-state');
      state.dataset.status = item.status;
      const score = node('span', item.score ? '★ ' + item.score : '☆ —');
      score.setAttribute(
        'aria-label',
        item.score ? 'Оценка ' + item.score + ' из 10' : 'Без оценки'
      );
      meta.append(state, score);
      details.append(meta);
      const progress = node('div', undefined, 'anime-progress');
      const bar = node('progress');
      bar.max = item.episodes || 1;
      bar.value = item.episodes ? item.watched : 0;
      bar.setAttribute('aria-label', 'Просмотрено серий');
      progress.append(bar, node('span', item.watched + ' / ' + (item.episodes || '?')));
      details.append(progress);
      card.append(cover, details);
      fragment.append(card);
    }
    if (!items.length)
      fragment.append(
        node(
          'p',
          snapshot.items.length
            ? 'Ничего не найдено.'
            : snapshot.connected
              ? 'Список пока пуст.'
              : 'Подключи Shikimori в общих настройках.',
          'anime-empty'
        )
      );
    $('animeList').replaceChildren(fragment);
  }
  function renderConfig(data) {
    $('animeAccount').textContent = data.connected
      ? data.user.nickname +
        (data.needsReconnect ? ' · требуется повторное подключение' : ' · подключён')
      : 'Аккаунт не подключён';
    $('animeDisconnect').hidden = !data.connected && !data.pending;
    $('animeDisconnect').disabled = data.busy;
    $('animeAuthorization').hidden = !data.pending;
    if (data.authorize) $('animeAuthorize').href = data.authorize;
    else $('animeAuthorize').removeAttribute('href');
    if (!data.connected || data.needsReconnect || data.pending)
      $('animeConnectDetails').open = true;
  }
  async function load() {
    if (loading || mutation || document.hidden) return;
    loading = true;
    try {
      if (page) {
        snapshot = await api('/api');
        renderList();
        const last = snapshot.syncedAt
          ? new Date(snapshot.syncedAt).toLocaleString('ru-RU', {
              dateStyle: 'short',
              timeStyle: 'short'
            })
          : 'ещё не было';
        $('animeTime').textContent = 'Обновлено: ' + last;
        $('animeSync').disabled =
          snapshot.syncing || !snapshot.connected || Date.now() < snapshot.nextAttempt;
        $('animeSync').textContent = snapshot.syncing ? 'Обновляется…' : 'Обновить';
        status(
          snapshot.error
            ? 'Данные не обновлены. ' + snapshot.error
            : snapshot.syncing
              ? 'Загружаем список…'
              : snapshot.needsReconnect
                ? 'Подключи Shikimori заново в настройках.'
                : snapshot.stale && snapshot.syncedAt
                  ? 'Данные устарели. Ожидается синхронизация.'
                  : snapshot.connected
                    ? snapshot.user.nickname
                    : 'Shikimori не подключён.',
          !!snapshot.error || snapshot.needsReconnect
        );
      } else {
        const data = await api('/config');
        renderConfig(data);
        status(data.busy ? 'Синхронизация…' : 'Токены хранятся только на сервере.');
      }
    } catch (error) {
      status(
        'Данные не обновлены. ' +
          (error.name === 'TimeoutError' ? 'Сервер не ответил вовремя.' : error.message),
        true
      );
    } finally {
      loading = false;
      clearTimeout(timer);
      timer = setTimeout(load, snapshot?.syncing ? 2000 : 15000);
    }
  }
  async function mutate(route, data = {}) {
    if (mutation) return;
    mutation = true;
    status('Выполняется…');
    const buttons = [...document.querySelectorAll('#animeSettings button, #animeSync')];
    buttons.forEach((b) => (b.disabled = true));
    try {
      await api(route, data);
      if (settings) {
        $('animeClientSecret').value = '';
        $('animeCode').value = '';
      }
    } catch (error) {
      status(
        error.name === 'TimeoutError'
          ? 'Операция ещё может выполняться. Проверь состояние через несколько секунд.'
          : error.message,
        true
      );
      return;
    } finally {
      mutation = false;
      buttons.forEach((b) => (b.disabled = false));
    }
    await load();
  }
  if (page) {
    $('animeSearch').addEventListener('input', () => {
      current = 1;
      renderList();
    });
    $('animeFilter').addEventListener('change', () => {
      current = 1;
      renderList();
    });
    $('animePrev').addEventListener('click', () => {
      current--;
      renderList();
    });
    $('animeNext').addEventListener('click', () => {
      current++;
      renderList();
    });
    $('animeSync').addEventListener('click', () => mutate('/sync'));
  } else {
    $('animeSetupForm').addEventListener('submit', (event) => {
      event.preventDefault();
      void mutate('/setup', {
        appName: $('animeAppName').value.trim(),
        clientId: $('animeClientId').value.trim(),
        clientSecret: $('animeClientSecret').value.trim()
      });
    });
    $('animeCodeForm').addEventListener('submit', (event) => {
      event.preventDefault();
      void mutate('/connect', {code: $('animeCode').value.trim()});
    });
    const dialog = $('animeDisconnectDialog');
    $('animeDisconnect').addEventListener('click', () => dialog.showModal());
    for (const id of ['animeCloseDialog', 'animeCancelDialog'])
      $(id).addEventListener('click', () => dialog.close());
    $('animeDisconnectForm').addEventListener('submit', (event) => {
      event.preventDefault();
      dialog.close();
      void mutate('/disconnect');
    });
    $('animeRedirect').addEventListener('click', (event) => event.target.select());
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void load();
  });
  window.addEventListener('online', () => void load());
  window.addEventListener('pagehide', () => clearTimeout(timer));
  void load();
})();
