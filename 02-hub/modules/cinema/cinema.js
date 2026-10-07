(() => {
  const $ = (id) => document.getElementById(id),
    node = Nexus.node,
    video = $('cinemaVideo');
  if (!video) return;
  let items = [],
    current = null,
    playingItem = null,
    busy = false,
    history = [];
  const api = (route, data) =>
    Nexus.request('/modules/cinema' + route, data, {signal: AbortSignal.timeout(100000)});
  async function action(fn) {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      Nexus.problem($('cinemaStatus'), 'cinema', e);
    } finally {
      busy = false;
    }
  }
  function transfer(t) {
    const stages = {
      stopped: 'Раздача остановлена',
      metadata: 'Получение метаданных',
      ready: 'Готово к выбору файла',
      downloading: 'Загрузка фрагментов',
      waiting: 'Ожидание нужных фрагментов',
      peers: 'Поиск пиров',
      error: 'Ошибка'
    };
    if (t.error || t.warning) Nexus.notice('cinema', 'request');
    $('cinemaTransfer').textContent = t.error ? 'Раздача приостановлена' :
      `${stages[t.stage] || 'Подключение'} · ${(t.speed / 1048576).toFixed(2)} МиБ/с · ${(t.downloaded / 1048576).toFixed(1)} МиБ`;
    $('cinemaProgress').value = t.progress || 0;
    if (t.error) Nexus.problem($('cinemaPlayback'), 'cinema');
    else if (t.stage === 'peers' && t.elapsed > 30)
      $('cinemaPlayback').textContent = 'Ожидаем подключение раздающих.';
  }
  async function openItem(item) {
    current = item;
    $('cinemaTitle').textContent = item.title;
    $('cinemaPlay').disabled = true;
    $('cinemaStatus').textContent = 'Получаем метаданные раздачи…';
    const state = await api('/open', {id: item.id});
    transfer(state);
    $('cinemaFiles').replaceChildren(
      ...state.files
        .filter((f) => f.playable)
        .map((f) => new Option(`${f.name} · ${(f.length / 1048576).toFixed(0)} МиБ`, f.index))
    );
    $('cinemaPlay').disabled = !state.files.some((f) => f.playable);
    $('cinemaStatus').textContent = state.files.some((f) => f.playable)
      ? ''
      : 'В этой раздаче нет поддерживаемого видеоконтейнера.';
    $('cinemaPlayback').textContent = 'Выбери файл и нажми «Смотреть»';
    const target = new URLSearchParams(location.search).get('file');
    if (target !== null && [...$('cinemaFiles').options].some((o) => o.value === target))
      $('cinemaFiles').value = target;
  }
  function draw() {
    $('cinemaEmpty').hidden = items.length > 0;
    if (!items.length) $('cinemaEmpty').replaceChildren(Nexus.empty('Видеотека пуста', 'Добавь torrent-файл или magnet-ссылку.', 'Добавить фильм', () => $('cinemaAdd').click()));
    $('cinemaList').replaceChildren(
      ...items.map((item) => {
        const card = node('a', undefined, 'cinema-card');
        card.href = '/modules/cinema/?id=' + encodeURIComponent(item.id);
        const art = node('span', undefined, 'cinema-cover'),
          mark = node('span', item.title.trim().slice(0, 1).toLocaleUpperCase(), 'cinema-monogram');
        art.setAttribute('aria-hidden', 'true');
        if (item.coverVersion) {
          const img = node('img');
          img.src = '/modules/cinema/cover/' + item.id + '?v=' + item.coverVersion;
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.onerror = () => img.replaceWith(mark);
          art.append(img);
        } else art.append(mark);
        art.append(node('span', '▶', 'cinema-cover-play'));
        card.append(
          art,
          node('strong', item.title),
          node('span', item.kind === 'anime' ? 'Аниме' : 'Кино', 'cinema-kind')
        );
        return card;
      })
    );
  }
  $('cinemaEdit').onclick = () => {
    if (!current) return;
    $('cinemaEditName').value = current.title;
    $('cinemaCover').value = '';
    $('cinemaCoverRemove').checked = false;
    $('cinemaEditError').textContent = '';
    $('cinemaEditDialog').showModal();
  };
  $('cinemaEditCancel').onclick = () => $('cinemaEditDialog').close();
  $('cinemaEditForm').onsubmit = (event) => {
    event.preventDefault();
    void action(async () => {
      const id = current?.id;
      if (!id) return;
      const file = $('cinemaCover').files[0];
      $('cinemaEditSave').disabled = true;
      try {
        if (file && file.size > 2 * 1024 ** 2) throw Error('Обложка до 2 МиБ');
        await api('/edit', {
          id,
          title: $('cinemaEditName').value,
          removeCover: $('cinemaCoverRemove').checked && !file
        });
        if (file) {
          const r = await fetch('/modules/cinema/cover?id=' + encodeURIComponent(id), {
            method: 'POST',
            body: file
          });
          if (!r.ok) throw Error((await r.json()).error || 'Не удалось сохранить обложку');
        }
        await load();
        current = items.find((item) => item.id === id);
        if (current) $('cinemaTitle').textContent = current.title;
        if (playingItem && current)
          playingItem.title =
            current.title + ' · ' + $('cinemaFiles').selectedOptions[0].textContent.split(' · ')[0];
        $('cinemaEditDialog').close();
      } catch (e) {
        $('cinemaEditError').textContent = e.message;
      } finally {
        $('cinemaEditSave').disabled = false;
      }
    });
  };
  $('cinemaRemove').onclick = () =>
    void action(async () => {
      if (
        !current ||
        !(await Nexus.confirm('Удалить фильм и его кеш? История просмотров сохранится.'))
      )
        return;
      video.pause();
      video.removeAttribute('src');
      video.load();
      playingItem = null;
      await api('/remove', {id: current.id});
      location.href = '/modules/cinema/';
    });
  const view = Nexus.rememberView?.();
  async function load() {
    const data = await api('/api');
    items = data.items;
    draw();
    view?.restore();
    transfer(data.transfer);
    history = (await Nexus.request('/api/activity?source=cinema')).items;
  }
  $('cinemaPlay').onclick = () =>
    void action(async () => {
      if (!current || !$('cinemaFiles').value) throw Error('Сначала выбери раздачу и файл');
      if ($('cinemaPlay').dataset.stopped) {
        await openItem(current);
        delete $('cinemaPlay').dataset.stopped;
      }
      video.pause();
      const index = Number($('cinemaFiles').value),
        key = current.id + ':' + index;
      playingItem = {
        source: 'cinema',
        item: key,
        title:
          current.title + ' · ' + $('cinemaFiles').selectedOptions[0].textContent.split(' · ')[0],
        kind: current.kind
      };
      const saved = history.find((i) => i.item === key),
        mkv = /\.mkv/i.test(playingItem.title);
      video.src = '/modules/cinema/stream/' + current.id + '/' + index;
      video.onloadedmetadata = () => {
        if (!mkv && saved && !saved.completed && saved.position < video.duration - 5)
          video.currentTime = saved.position;
      };
      try {
        window.parent.NexusWave?.pause();
      } catch {}
      $('cinemaPlayback').textContent = mkv
        ? 'Подготовка MKV и преобразование на сервере…'
        : 'Ожидание первых фрагментов…';
      void video.play().catch((e) => {
        if (e.name !== 'AbortError')
          $('cinemaPlayback').textContent =
            'Не удалось начать воспроизведение. Проверь статус загрузки и формат видео.';
      });
      $('cinemaStatus').textContent = '';
    });
  for (const [event, label] of [
    ['playing', 'Воспроизведение'],
    ['waiting', 'Буферизация — ожидаем данные'],
    ['stalled', 'Ожидаем данные от раздающих'],
    ['ended', 'Просмотр завершён']
  ])
    video.addEventListener(event, () => {
      $('cinemaPlayback').textContent = label;
    });
  NexusActivity.media(video, () => playingItem);
  video.addEventListener('error', () => {
    $('cinemaStatus').textContent =
      'Видео не удалось воспроизвести: проверь пиры и совместимость кодека с браузером.';
  });
  $('cinemaStop').onclick = () =>
    void action(async () => {
      video.pause();
      video.removeAttribute('src');
      video.load();
      playingItem = null;
      await api('/stop', {});
      $('cinemaPlay').dataset.stopped = 'true';
      $('cinemaPlayback').textContent =
        'Остановлено. Нажми «Смотреть», чтобы открыть раздачу снова.';
      await load();
    });
  $('cinemaAdd').onclick = () => $('cinemaDialog').showModal();
  $('cinemaCancel').onclick = () => $('cinemaDialog').close();
  $('cinemaForm').onsubmit = (event) => {
    event.preventDefault();
    void action(async () => {
      try {
        const title = $('cinemaName').value,
          kind = $('cinemaKind').value,
          file = $('cinemaTorrent').files[0];
        if (file) {
          if (file.size > 4 * 1024 ** 2) throw Error('Torrent-файл до 4 МиБ');
          const r = await fetch('/modules/cinema/upload?' + new URLSearchParams({title, kind}), {
            method: 'POST',
            body: file
          });
          if (!r.ok) throw Error((await r.json()).error);
        } else await api('/add', {title, kind, magnet: $('cinemaMagnet').value});
        $('cinemaDialog').close();
        $('cinemaForm').reset();
        await load();
      } catch (e) {
        $('cinemaError').textContent = e.message;
        throw e;
      }
    });
  };
  let pollTimer,
    pollController,
    polling = false,
    leaving = false;
  async function poll() {
    clearTimeout(pollTimer);
    if (polling || leaving || document.hidden || $('cinemaDetail').hidden) return;
    polling = true;
    pollController = new AbortController();
    try {
      const data = await Nexus.request('/modules/cinema/api', undefined, {
        signal: AbortSignal.any([pollController.signal, AbortSignal.timeout(8000)])
      });
      if (!document.hidden && !leaving) transfer(data.transfer);
    } catch {
      if (!pollController.signal.aborted)
        $('cinemaTransfer').textContent = 'Нет связи с сервером. Повторяем запрос…';
    } finally {
      polling = false;
      if (!leaving && !document.hidden) pollTimer = setTimeout(poll, 2000);
    }
  }
  document.addEventListener('visibilitychange', () => {
    clearTimeout(pollTimer);
    if (document.hidden) pollController?.abort();
    else void poll();
  });
  addEventListener('pagehide', () => {
    leaving = true;
    clearTimeout(pollTimer);
    pollController?.abort();
  });
  addEventListener('pageshow', () => {
    leaving = false;
    void poll();
  });
  pollTimer = setTimeout(poll, 2000);
  void load()
    .then(() => {
      const id = new URLSearchParams(location.search).get('id');
      if (id) {
        const item = items.find((x) => x.id === id);
        if (!item) throw Error('Фильм не найден. Вернись в каталог.');
        return action(() => openItem(item));
      }
    })
    .catch((e) => (Nexus.problem($('cinemaStatus'), 'cinema', e)));
})();
