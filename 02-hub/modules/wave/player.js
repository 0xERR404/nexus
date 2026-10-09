(() => {
  if (window.parent !== window) {
    const url = new URL(location.href);
    url.searchParams.set('_view', '1');
    location.replace(url.href);
    return;
  }
  const $ = (id) => document.getElementById(id),
    audio = $('waveAudio'),
    frame = $('hubFrame');
  const player = $('wavePlayer'),
    mobile = matchMedia('(max-width:600px), (max-height:500px) and (max-width:1000px)');
  const shapes = {
    play: '<path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-width="4"/>',
    prev: '<path d="M5 5v14M19 5 8 12l11 7Z"/>',
    next: '<path d="M19 5v14M5 5l11 7-11 7Z"/>',
    shuffle:
      '<path d="M3 6h3c5 0 7 12 12 12h3m-4-4 4 4-4 4M3 18h3c2 0 4-2 5-5m2-3c1-2 3-4 5-4h3m-4-4 4 4-4 4"/>',
    repeat:
      '<path d="m16 2 4 4-4 4M4 11V9a3 3 0 0 1 3-3h13M8 22l-4-4 4-4m12-1v2a3 3 0 0 1-3 3H4"/>',
    up: '<path d="m6 15 6-6 6 6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    music: '<path d="M9 18V5l11-2v13M9 8l11-2"/><ellipse cx="6" cy="18" rx="3" ry="2"/><ellipse cx="17" cy="16" rx="3" ry="2"/>',
    minimize: '<path d="m6 7 6 6 6-6M5 19h14"/>',
    volume: '<path d="M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
  };
  const symbol = (name) =>
    `<svg class="wave-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
  $('wavePrev').innerHTML = symbol('prev');
  $('waveNext').innerHTML = symbol('next');
  $('waveExpand').innerHTML = symbol('up');
  $('waveMinimize').innerHTML = symbol('minimize');
  $('waveRestore').innerHTML = symbol('music');
  $('waveShuffle').innerHTML = symbol('shuffle');
  $('waveVolumeIcon').innerHTML = symbol('volume');
  const key = 'nexus-wave-v1';
  let library = {tracks: [], playlists: []},
    state = {
      queue: [],
      order: [],
      shuffleVersion: 1,
      index: 0,
      position: 0,
      repeat: 'off',
      shuffle: false,
      closed: false,
      minimized: false,
      volume: 1
    },
    loaded = null,
    lastSave = 0,
    restoring = 0,
    ready = false,
    signingOut = false,
    playRequest = 0,
    queueRequest = 0,
    intentPlaying = false,
    switching = false,
    retries = 0,
    recoveryTimer,
    startTimer,
    failureCheck = -1,
    resumeOnReturn = false,
    stablePosition = 0;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Array.isArray(saved.queue)) {
      state.queue = [...new Set(saved.queue.filter((id) => typeof id === 'string'))].slice(
        0,
        10000
      );
      state.order = [
        ...new Set([...(Array.isArray(saved.order) ? saved.order : []), ...state.queue])
      ].filter((id) => state.queue.includes(id));
      state.index = Math.max(
        0,
        Math.min(Math.trunc(Number(saved.index)) || 0, state.queue.length - 1)
      );
      state.position = Math.max(0, Number(saved.position) || 0);
      state.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
      state.shuffle = Boolean(saved.shuffle);
      state.closed = saved.closed === true;
      state.minimized = saved.minimized === true;
      if (state.shuffle && saved.shuffleVersion !== 1) {
        state.queue = shuffleTracks(state.queue, state.queue[state.index]);
        state.index = 0;
      }
      state.volume = Math.max(0, Math.min(1, Number(saved.volume) || 0));
    }
  } catch {}
  function shuffleTracks(ids, first, avoid) {
    const remaining = [...new Set(ids)].filter((id) => id !== first);
    for (let i = remaining.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
    }
    if (first && ids.includes(first)) return [first, ...remaining];
    if (remaining.length > 1 && remaining[0] === avoid) {
      const j = 1 + Math.floor(Math.random() * (remaining.length - 1));
      [remaining[0], remaining[j]] = [remaining[j], remaining[0]];
    }
    return remaining;
  }
  const track = () => library.tracks.find((t) => t.id === state.queue[state.index]);
  window.NexusActivity?.media(audio, () => {
    const t = track();
    return t && {source: 'wave', item: t.id, title: t.title, kind: 'music'};
  });
  const clock = (n) =>
    Number.isFinite(n)
      ? Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0')
      : '0:00';
  const note = (text) => ($('wavePlayerStatus').textContent = text);
  function save() {
    if (signingOut) return;
    if (restoring > 0) state.position = restoring;
    else if (loaded && audio.readyState >= 1 && Number.isFinite(audio.currentTime))
      state.position = audio.currentTime;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      note('Не удалось сохранить очередь на этом устройстве.');
    }
  }
  function paint() {
    const t = track();
    frame.contentWindow?.postMessage({type: 'nexus:wave-state'}, location.origin);
    $('wavePlayer').hidden = !t || state.closed || state.minimized;
    $('waveRestore').hidden = !t || state.closed || !state.minimized;
    $('waveRestore').title = ['Показать плеер', t?.title, t?.artist].filter(Boolean).join(' · ');
    $('waveRestore').setAttribute('aria-label', $('waveRestore').title);
    $('waveTrackTitle').textContent = t?.title || 'Орфей';
    $('waveTrackArtist').textContent = t?.artist || '';
    $('waveToggle').innerHTML = symbol(intentPlaying || !audio.paused ? 'pause' : 'play');
    $('waveToggle').setAttribute(
      'aria-label',
      intentPlaying || !audio.paused ? 'Пауза' : 'Воспроизвести'
    );
    $('waveToggle').setAttribute('aria-pressed', String(intentPlaying || !audio.paused));
    $('waveRepeat').innerHTML =
      symbol('repeat') + (state.repeat === 'one' ? '<span class="wave-repeat-one">1</span>' : '');
    $('waveRepeat').setAttribute('aria-pressed', String(state.repeat !== 'off'));
    $('waveRepeat').title =
      'Повтор: ' + {off: 'выключен', all: 'очередь', one: 'трек'}[state.repeat];
    $('waveShuffle').setAttribute('aria-pressed', String(state.shuffle));
    $('waveVolume').value = String(state.volume);
    $('waveQueueCount').textContent = state.queue.length + ' в очереди';
    const cover = $('wavePlayerCover');
    cover.hidden = !t?.cover;
    $('waveCoverFallback').hidden = Boolean(t?.cover);
    if (t?.cover) cover.src = '/modules/wave/cover/' + t.id;
    if (!t || state.closed) {
      $('waveQueueDialog').close();
      if (player.classList.contains('expanded')) expanded(false);
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = !t || state.closed ? 'none' : intentPlaying || !audio.paused ? 'playing' : 'paused';
    }
  }
  function position() {
    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      $('waveSeek').disabled = false;
      $('waveSeek').max = String(duration);
      $('waveSeek').value = String(audio.currentTime);
      $('waveSeek').style.setProperty('--played', (audio.currentTime / duration) * 100 + '%');
      $('waveSeek').setAttribute(
        'aria-valuetext',
        clock(audio.currentTime) + ' из ' + clock(duration)
      );
      try {
        navigator.mediaSession?.setPositionState({
          duration,
          playbackRate: audio.playbackRate,
          position: Math.min(audio.currentTime, duration)
        });
      } catch {}
    }
    $('waveElapsed').textContent = clock(audio.currentTime);
    $('waveDuration').textContent = clock(duration);
    if (Date.now() - lastSave > 5000) {
      save();
      lastSave = Date.now();
    }
  }
  function metadata() {
    const t = track();
    if (t && 'MediaMetadata' in window && navigator.mediaSession)
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: t.album,
        artwork: [
          {
            src: t.cover ? '/modules/wave/cover/' + t.id : '/icon-512.png',
            sizes: t.cover ? '' : '512x512',
            type: t.cover ? 'image/jpeg' : 'image/png'
          }
        ]
      });
  }
  const audioCache = new Map(),
    cacheFailures = new Set();
  const cacheLimit = 20 * 1024 * 1024;
  let cacheJob = null,
    cycleKey = '',
    cycle = [];
  function nextCycle() {
    const key = JSON.stringify(state.queue);
    if (cycleKey !== key) {
      cycleKey = key;
      cycle = shuffleTracks(state.queue, undefined, state.queue[state.index]);
    }
    return cycle;
  }
  function cacheQueue() {
    if (!loaded || signingOut) return [];
    let next = state.queue[state.index + 1];
    if (state.repeat === 'one') next = loaded;
    else if (!next && state.repeat === 'all')
      next = state.shuffle ? nextCycle()[0] : state.queue[0];
    return [...new Set([loaded, next].filter(Boolean))];
  }
  function clearAudioCache() {
    cacheJob?.controller.abort();
    cacheJob = null;
    for (const url of audioCache.values()) URL.revokeObjectURL(url);
    audioCache.clear();
    cacheFailures.clear();
  }
  async function cacheTrack(id, signal) {
    const response = await fetch('/modules/wave/audio/' + id, {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      signal,
      priority: 'low'
    });
    if (
      response.status !== 200 ||
      !response.headers.get('content-type')?.startsWith('audio/') ||
      Number(response.headers.get('content-length')) > cacheLimit
    ) {
      await response.body?.cancel();
      throw Error('Audio not cacheable');
    }
    const reader = response.body.getReader(),
      chunks = [];
    let size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > cacheLimit) throw Error('Audio cache limit');
        chunks.push(value);
      }
      const expected = response.headers.get('content-length');
      if (!size || (expected && size !== Number(expected))) throw Error('Incomplete audio');
      return new Blob(chunks, {type: response.headers.get('content-type')});
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  function preloadQueue() {
    if (
      typeof fetch !== 'function' ||
      typeof URL.createObjectURL !== 'function' ||
      typeof AbortSignal.any !== 'function'
    )
      return;
    const wanted = cacheQueue();
    for (const [id, url] of audioCache)
      if (!wanted.includes(id)) {
        URL.revokeObjectURL(url);
        audioCache.delete(id);
      }
    for (const id of cacheFailures) if (!wanted.includes(id)) cacheFailures.delete(id);
    if (cacheJob && !wanted.includes(cacheJob.id)) {
      cacheJob.controller.abort();
      cacheJob = null;
    }
    if (cacheJob || navigator.onLine === false) return;
    const id = wanted.find((id) => !audioCache.has(id) && !cacheFailures.has(id));
    if (!id) return;
    const job = {id, controller: new AbortController()};
    cacheJob = job;
    const signal = AbortSignal.any([job.controller.signal, AbortSignal.timeout(90000)]);
    void cacheTrack(id, signal)
      .then((blob) => {
        if (cacheJob === job && !signal.aborted && cacheQueue().includes(id))
          audioCache.set(id, URL.createObjectURL(blob));
      })
      .catch(() => {
        if (cacheJob === job) cacheFailures.add(id);
      })
      .finally(() => {
        if (cacheJob === job) {
          cacheJob = null;
          preloadQueue();
        }
      });
  }
  function pausePlayback() {
    intentPlaying = switching = resumeOnReturn = false;
    ++playRequest;
    clearTimeout(recoveryTimer);
    clearTimeout(startTimer);
    audio.pause();
    paint();
    save();
  }
  function closePlayback() {
    ++queueRequest;
    pausePlayback();
    state.closed = true;
    loaded = null;
    restoring = 0;
    audio.removeAttribute('src');
    audio.load();
    clearAudioCache();
    if (navigator.mediaSession) {
      navigator.mediaSession.metadata = null;
      try { navigator.mediaSession.setPositionState(); } catch {}
    }
    paint();
    save();
  }
  function recoverPlayback(delay = 700) {
    clearTimeout(recoveryTimer);
    if (!intentPlaying || !loaded || state.closed || signingOut) return;
    clearTimeout(startTimer);
    if (navigator.onLine === false && !audioCache.has(loaded)) {
      note('Нет соединения. Ожидаем сеть…');
      return;
    }
    const request = playRequest,
      position = restoring || audio.currentTime || state.position;
    recoveryTimer = setTimeout(() => {
      if (request !== playRequest || !intentPlaying) return;
      retries = Math.min(retries + 1, 6);
      void select(true, position, true);
    }, delay === 0 ? 0 : Math.min(30000, delay * 2 ** retries));
  }
  async function mediaFailure() {
    const request = playRequest, id = loaded;
    if (!intentPlaying || !id || failureCheck === request) return;
    failureCheck = request;
    clearTimeout(startTimer);
    note('Проверяем доступность трека…');
    let temporary = true, unauthorized = false;
    try {
      const response = await fetch('/modules/wave/audio/' + id, {
        credentials: 'same-origin', cache: 'no-store',
        headers: {Range: 'bytes=0-0'}, signal: AbortSignal.timeout(10000)
      });
      unauthorized = response.status === 401 || response.redirected;
      temporary = response.status >= 500 || [408, 425, 429].includes(response.status);
      await response.body?.cancel();
    } catch {} finally {
      if (failureCheck === request) failureCheck = -1;
    }
    if (request !== playRequest || !intentPlaying) return;
    if (unauthorized) {
      signingOut = true;
      closePlayback();
      location.replace('/login');
    } else if (temporary) {
      note('Связь с сервером недоступна. Повторяем подключение…');
      recoverPlayback();
    } else {
      pausePlayback();
      note('Файл удалён, недоступен или его формат не поддерживается. Выбери другой трек.');
    }
  }
  async function select(play = true, position = 0, retry = false) {
    const request = ++playRequest,
      t = track();
    clearTimeout(recoveryTimer);
    clearTimeout(startTimer);
    intentPlaying = play;
    resumeOnReturn = false;
    switching = play;
    if (!retry) retries = 0;
    if (!t) {
      pausePlayback();
      audio.removeAttribute('src');
      audio.load();
      loaded = null;
      clearAudioCache();
      return;
    }
    state.closed = false;
    if (!play) audio.pause();
    if (loaded !== t.id || retry || audio.error) {
      loaded = t.id;
      restoring = position;
      state.position = position;
      audio.preload = 'auto';
      audio.src = audioCache.get(t.id) || '/modules/wave/audio/' + t.id;
      stablePosition = position;
      $('waveSeek').disabled = true;
    } else if (position || audio.ended)
      audio.currentTime = Math.min(position, audio.duration || position);
    audio.loop = state.repeat === 'one';
    try {
      if (play) startTimer = setTimeout(() => {
        if (request !== playRequest || !intentPlaying) return;
        note('Запуск задержался. Восстанавливаем воспроизведение…');
        recoverPlayback();
      }, 20000);
      const started = play ? audio.play() : undefined;
      metadata();
      paint();
      save();
      renderQueue();
      preloadQueue();
      await started;
      if (request !== playRequest) return;
      clearTimeout(startTimer);
      switching = false;
      note('');
      paint();
    } catch (error) {
      if (request !== playRequest || !intentPlaying) return;
      clearTimeout(startTimer);
      switching = false;
      if (error.name === 'NotAllowedError') {
        pausePlayback();
        note('Браузер остановил фоновое воспроизведение. Нажми ▶.');
      } else if (
        error.name === 'AbortError' ||
        error.name === 'NetworkError' ||
        audio.error?.code === 2
      ) {
        note('Восстанавливаем воспроизведение…');
        recoverPlayback();
      } else {
        void mediaFailure();
      }
    }
  }
  function resumeFromControl() {
    const position = restoring || audio.currentTime || state.position;
    if (!library.tracks.length && state.queue.length) {
      return refresh()
        .then(() => select(true, position, Boolean(audio.error)))
        .catch((error) => note(error.message));
    }
    return select(true, position, Boolean(audio.error));
  }
  async function next(direction = 1, automatic = false) {
    if (!state.queue.length) return;
    if (direction < 0 && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (automatic && state.repeat === 'one') {
      audio.currentTime = 0;
      await select(true);
      return;
    }
    let index = state.index + direction;
    if (index >= state.queue.length || index < 0) {
      if (state.repeat === 'all') {
        if (state.shuffle && direction > 0) {
          state.queue = [...nextCycle()];
          cycleKey = '';
        }
        index = direction > 0 ? 0 : state.queue.length - 1;
      } else {
        pausePlayback();
        return;
      }
    }
    state.index = index;
    await select(true);
  }
  async function refresh() {
    const response = await fetch('/modules/wave/library', {signal: AbortSignal.timeout(15000)});
    if (response.status === 401 || response.redirected) {
      signingOut = true;
      pausePlayback();
      clearAudioCache();
      location.replace('/login');
      return;
    }
    if (!response.ok) throw Error('Библиотека временно недоступна.');
    library = await response.json();
    const current = state.queue[state.index];
    state.queue = state.queue.filter((id) => library.tracks.some((t) => t.id === id));
    state.index = Math.max(0, state.queue.indexOf(current));
    state.order = state.order.filter((id) => state.queue.includes(id));
    if (loaded && !library.tracks.some((t) => t.id === loaded)) await select(false);
    if (loaded) metadata();
    paint();
    renderQueue();
    preloadQueue();
    return library;
  }
  function renderQueue() {
    if (!$('waveQueueDialog').open) return;
    const container = $('waveQueue');
    container.replaceChildren();
    state.queue.forEach((id, i) => {
      const t = library.tracks.find((t) => t.id === id);
      if (!t) return;
      const row = document.createElement('div');
      row.className = 'wave-queue-row';
      const choose = document.createElement('button');
      choose.textContent = (i === state.index ? '▶ ' : '') + t.title;
      choose.onclick = () => {
        state.index = i;
        void select();
      };
      const remove = document.createElement('button');
      remove.textContent = '×';
      remove.setAttribute('aria-label', 'Убрать ' + t.title + ' из очереди');
      remove.onclick = () => {
        const current = state.queue[state.index],
          wasPlaying = !audio.paused;
        state.queue.splice(i, 1);
        state.order = state.order.filter((value) => value !== id);
        if (i === state.index) {
          state.index = Math.min(i, state.queue.length - 1);
          state.index = Math.max(0, state.index);
          void select(wasPlaying);
        } else state.index = Math.max(0, state.queue.indexOf(current));
        save();
        paint();
        renderQueue();
        preloadQueue();
      };
      row.append(choose, remove);
      container.append(row);
    });
  }
  let transfer = {
      running: false,
      total: 0,
      done: 0,
      added: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      percent: 0,
      name: '',
      message: '',
      ids: []
    },
    stopUpload = false;
  function transferPaint() {
    $('waveTransfer').hidden = !transfer.running;
    $('waveTransferText').textContent = transfer.message;
    $('waveTransferStop').disabled = stopUpload;
    frame.contentWindow?.postMessage({type: 'nexus:wave-upload'}, location.origin);
  }
  function cancelUpload() {
    if (!transfer.running) return;
    stopUpload = true;
    transfer.message = 'Остановка после текущего файла…';
    transferPaint();
  }
  $('waveTransferStop').onclick = cancelUpload;
  async function upload(files) {
    if (transfer.running) throw Error('Дождись текущей загрузки.');
    const all = Array.from(files),
      accepted = all.filter((f) => /\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i.test(f.name));
    if (!accepted.length) throw Error('В выбранном наборе нет аудиофайлов.');
    transfer = {
      running: true,
      total: accepted.length,
      done: 0,
      added: 0,
      duplicates: 0,
      failed: 0,
      skipped: all.length - accepted.length,
      percent: 0,
      name: '',
      message: 'Подготовка загрузки…',
      ids: []
    };
    stopUpload = false;
    transferPaint();
    const errors = [];
    for (const file of accepted) {
      if (stopUpload || signingOut) break;
      transfer.name = file.name;
      transfer.percent = 0;
      transfer.message = `Загрузка ${transfer.done + 1}/${transfer.total} · ${file.name}`;
      transferPaint();
      try {
        if (file.size > 256 * 1024 * 1024) throw Error('Больше 256 МБ.');
        const result = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/modules/wave/upload?name=' + encodeURIComponent(file.name));
          xhr.timeout = 240000;
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              transfer.percent = Math.round((e.loaded / e.total) * 100);
              transfer.message = `Загрузка ${transfer.done + 1}/${transfer.total} · ${transfer.percent}% · ${file.name}`;
              transferPaint();
            }
          };
          xhr.upload.onload = () => {
            transfer.message = `Подготовка ${transfer.done + 1}/${transfer.total} · ${file.name}`;
            transferPaint();
          };
          xhr.onload = () => {
            try {
              const value = JSON.parse(xhr.responseText);
              if (xhr.status !== 200) throw Error(value.error || 'Ошибка загрузки.');
              resolve(value);
            } catch (e) {
              reject(e);
            }
          };
          xhr.onerror = () => reject(Error('Нет соединения.'));
          xhr.ontimeout = () => reject(Error('Превышено время ожидания.'));
          xhr.send(file);
        });
        if (result.duplicate) transfer.duplicates++;
        else {
          transfer.added++;
          transfer.ids.push(result.track.id);
        }
      } catch (e) {
        transfer.failed++;
        if (errors.length < 3) errors.push(file.name + ': ' + e.message);
      }
      transfer.done++;
      transferPaint();
    }
    transfer.running = false;
    transfer.message =
      `Добавлено: ${transfer.added} · уже есть: ${transfer.duplicates} · ошибок: ${transfer.failed}` +
      (transfer.skipped ? ' · пропущено: ' + transfer.skipped : '') +
      (transfer.done < transfer.total ? ' · осталось: ' + (transfer.total - transfer.done) : '') +
      (errors.length ? ' · ' + errors.join('; ') : '');
    transferPaint();
    if (!signingOut) await refresh().catch(() => {});
  }
  window.NexusWave = {
    navigate,
    upload,
    cancelUpload,
    transfer: () => ({...transfer, ids: [...transfer.ids]}),

    refresh,
    state: () => ({id: loaded, playing: intentPlaying || !audio.paused}),
    async playList(ids, id, {shuffle = false} = {}) {
      const request = ++queueRequest;
      if (!ready) await initialize;
      if (ids.some((id) => !library.tracks.some((t) => t.id === id))) await refresh();
      if (request !== queueRequest) return;
      state.shuffle = shuffle;
      state.queue = [...new Set(ids)]
        .filter((id) => library.tracks.some((t) => t.id === id))
        .slice(0, 10000);
      state.order = [...state.queue];
      if (shuffle) state.queue = shuffleTracks(state.queue, id);
      state.index = Math.max(0, state.queue.indexOf(id));
      await select(true);
    },
    async enqueue(id) {
      if (!ready) await initialize;
      await refresh();
      if (!library.tracks.some((t) => t.id === id)) throw Error('Трек не найден.');
      if (!state.queue.includes(id)) {
        state.queue.push(id);
        state.order.push(id);
      }
      if (!loaded) await select(false);
      save();
      paint();
      renderQueue();
      preloadQueue();
    },
    pause: pausePlayback,
    close: closePlayback
  };
  $('waveMinimize').onclick = () => {
    if (player.classList.contains('expanded')) return;
    state.minimized = true;
    paint();
    save();
    $('waveRestore').focus();
  };
  $('waveRestore').onclick = () => {
    state.minimized = false;
    paint();
    save();
    $('waveMinimize').focus();
  };
  $('waveClose').onclick = closePlayback;
  $('waveToggle').onclick = () =>
    intentPlaying || !audio.paused ? pausePlayback() : resumeFromControl();
  $('waveNext').onclick = () => next();
  $('wavePrev').onclick = () => next(-1);
  $('waveShuffle').onclick = () => {
    const current = state.queue[state.index];
    state.shuffle = !state.shuffle;
    if (state.shuffle) {
      state.order = [...state.queue];
      state.queue = shuffleTracks(state.queue, current);
    } else
      state.queue = [...new Set([...state.order, ...state.queue])].filter((id) =>
        state.queue.includes(id)
      );
    state.index = Math.max(0, state.queue.indexOf(current));
    save();
    paint();
    renderQueue();
    preloadQueue();
  };
  $('waveRepeat').onclick = () => {
    state.repeat = {off: 'all', all: 'one', one: 'off'}[state.repeat];
    audio.loop = state.repeat === 'one';
    save();
    paint();
    preloadQueue();
  };
  $('waveSeek').oninput = () => {
    if (Number.isFinite(audio.duration)) {
      audio.currentTime = Number($('waveSeek').value);
      position();
      save();
    }
  };
  $('waveVolume').oninput = () => {
    state.volume = Number($('waveVolume').value);
    audio.volume = state.volume;
    save();
  };
  audio.volume = state.volume;
  let overlayHistory = false;
  if (history.state?.nexusWavePlayer) {
    const {nexusWavePlayer, ...rest} = history.state;
    history.replaceState(rest, '');
  }
  let viewportHeight = 0,
    viewportTop = -1;
  let viewportFrame = 0,
    viewportTimer = 0;
  function fitViewport() {
    cancelAnimationFrame(viewportFrame);
    viewportFrame = requestAnimationFrame(() => {
      const viewport = window.visualViewport;
      if (viewport && Math.abs(viewport.scale - 1) > 0.01) return;
      const height = viewport?.height || innerHeight,
        top = viewport?.offsetTop || 0;
      if (height > 0 && (height !== viewportHeight || top !== viewportTop)) {
        viewportHeight = height;
        viewportTop = top;
        document.documentElement.style.setProperty('--wave-viewport-height', `${height}px`);
        document.documentElement.style.setProperty('--wave-viewport-top', `${top}px`);
      }
    });
  }
  function resumeViewport() {
    if (document.hidden) return;
    fitViewport();
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(fitViewport, 250);
  }
  window.visualViewport?.addEventListener('resize', fitViewport);
  window.visualViewport?.addEventListener('scroll', fitViewport);
  addEventListener('resize', fitViewport);
  addEventListener('pageshow', resumeViewport);
  document.addEventListener('visibilitychange', resumeViewport);
  addEventListener('pagehide', () => {
    cancelAnimationFrame(viewportFrame);
    clearTimeout(viewportTimer);
  });
  fitViewport();
  function expanded(value, record = true) {
    if (value && player.hidden) return;
    if (!value && record && overlayHistory) {
      history.back();
      return;
    }
    player.classList.toggle('expanded', value);
    $('waveExpand').innerHTML = symbol(value ? 'down' : 'up');
    $('waveExpand').setAttribute('aria-expanded', String(value));
    $('waveExpand').setAttribute('aria-label', value ? 'Свернуть плеер' : 'Раскрыть плеер');
    $('waveArtworkToggle').disabled = $('waveOpenTrack').disabled = value;
    const modal = value;
    document.body.classList.toggle('wave-focus', modal);
    frame.inert = $('waveTransfer').inert = modal;
    document.querySelectorAll('.workspace-header,.workspace-mobile').forEach(el=>el.inert=modal);
    if (modal) {
      player.setAttribute('role', 'dialog');
      player.setAttribute('aria-modal', 'true');
    } else {
      player.removeAttribute('role');
      player.removeAttribute('aria-modal');
    }
    if (value && record && !overlayHistory) {
      history.pushState({...history.state, nexusWavePlayer: true}, '');
      overlayHistory = true;
    }
    if (!value) $('waveQueueDialog').close();
    if (modal) $('waveExpand').focus();
    else if (!value && !player.hidden) $('waveArtworkToggle').focus({preventScroll:true});
  }
  $('waveExpand').onclick = () => expanded(!player.classList.contains('expanded'));
  $('waveArtworkToggle').onclick = $('waveOpenTrack').onclick = () => expanded(true);
  mobile.addEventListener('change', () => expanded(player.classList.contains('expanded'), false));
  $('waveQueueToggle').onclick = () => {
    $('waveQueueDialog').showModal();
    renderQueue();
    $('waveQueueToggle').setAttribute('aria-expanded', 'true');
  };
  $('waveQueueClose').onclick = () => $('waveQueueDialog').close();
  $('waveQueueDialog').addEventListener('close', () => {
    $('waveQueueToggle').setAttribute('aria-expanded', 'false');
    $('waveQueueToggle').focus();
  });
  audio.addEventListener('loadedmetadata', () => {
    if (restoring) {
      audio.currentTime = Math.min(restoring, Math.max(0, audio.duration - 0.1));
      restoring = 0;
    }
    position();
  });
  audio.addEventListener('timeupdate', () => {
    if (audio.currentTime > stablePosition + 1) {
      retries = 0;
      stablePosition = audio.currentTime;
    }
    position();
  });
  audio.addEventListener('play', () => {
    if (!audio.paused) intentPlaying = true;
    try {
      frame.contentDocument.querySelectorAll('audio,video').forEach((media) => media.pause());
    } catch {}
    paint();
    save();
  });
  audio.addEventListener('pause', () => {
    if (!switching && audio.paused && !audio.ended && !audio.error) {
      resumeOnReturn = intentPlaying && document.hidden;
      intentPlaying = false;
      ++playRequest;
      clearTimeout(recoveryTimer);
    }
    paint();
    save();
  });
  audio.addEventListener('ended', () => {
    if (intentPlaying) void next(1, true);
  });
  audio.addEventListener('error', () => {
    if (!audio.error) return;
    if (audioCache.get(loaded) === audio.src && [3, 4].includes(audio.error.code)) {
      URL.revokeObjectURL(audioCache.get(loaded));
      audioCache.delete(loaded);
      cacheFailures.add(loaded);
      if (intentPlaying) {
        recoverPlayback(0);
        return;
      }
    }
    if (audio.error.code === 2 && intentPlaying) {
      note('Восстанавливаем соединение…');
      recoverPlayback();
    } else {
      void mediaFailure();
    }
  });
  for (const name of ['waiting', 'stalled'])
    audio.addEventListener(name, () => {
      if (!intentPlaying) return;
      cacheJob?.controller.abort();
      cacheJob = null;
      clearTimeout(recoveryTimer);
      const request = playRequest,
        at = audio.currentTime;
      recoveryTimer = setTimeout(() => {
        if (request === playRequest && intentPlaying && audio.currentTime <= at + 0.1)
          recoverPlayback(0);
      }, 15000);
    });
  audio.addEventListener('playing', () => {
    clearTimeout(startTimer);
    clearTimeout(recoveryTimer);
    preloadQueue();
    note('');
  });
  addEventListener('online', () => {
    cacheFailures.clear();
    preloadQueue();
    if (intentPlaying && (audio.error || audio.paused || audio.readyState < 3)) recoverPlayback(0);
  });
  function resumePlayback() {
    if (document.hidden || signingOut || state.closed) return;
    save();
    metadata();
    paint();
    position();
    if ((resumeOnReturn || intentPlaying) && audio.paused && !audio.ended)
      void select(true, restoring || state.position, Boolean(audio.error));
    else if (intentPlaying && audio.ended) void next(1, true);
    preloadQueue();
  }
  document.addEventListener('visibilitychange', () => {
    save();
    resumePlayback();
  });
  addEventListener('pageshow', resumePlayback);
  document.addEventListener('freeze', save);
  document.addEventListener('resume', resumePlayback);
  addEventListener('pagehide', () => {
    save();
    closePlayback();
  });
  if (navigator.mediaSession) {
    for (const [name, fn] of Object.entries({
      play: resumeFromControl,
      pause: pausePlayback,
      previoustrack: () => next(-1),
      nexttrack: () => next(),
      seekto: (e) => {
        audio.currentTime = e.seekTime;
        position();
        save();
      },
      seekbackward: (e) => {
        audio.currentTime = Math.max(0, audio.currentTime - (e.seekOffset || 10));
      },
      seekforward: (e) => {
        audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (e.seekOffset || 10));
      },
      stop: closePlayback
    }))
      try {
        navigator.mediaSession.setActionHandler(name, fn);
      } catch {}
  }
  const initialize = (async () => {
    const savedPosition = state.position;
    await refresh();
    if (!state.closed) await select(false, savedPosition);
    ready = true;
  })().catch((e) => note(e.message));
  function safeURL(value) {
    try {
      const u = new URL(value, location.origin);
      if (
        u.origin !== location.origin ||
        !/^\/(?:$|(?:settings|status|search)\/?$|modules\/[a-z-]+\/?$)/.test(u.pathname)
      )
        return null;
      u.searchParams.delete('_view');
      return u;
    } catch {
      return null;
    }
  }
  let navigationTimer,
    revealTimer,
    navigationId = 0;
  const reducedNavigation = matchMedia('(prefers-reduced-motion: reduce)');
  function showFrame() {
    clearTimeout(revealTimer);
    frame.classList.remove('hub-navigating');
    frame.removeAttribute('aria-busy');
  }
  function revealPage() {
    try {
      if (safeURL(frame.contentWindow.location.href)?.href !== safeURL(location.href)?.href) return;
    } catch {
      return;
    }
    showFrame();
  }
  let checkingNavigation = false;
  async function navigate(href, push = true) {
    let u = safeURL(href);
    if (!u || checkingNavigation) return;
    let previous;
    try { previous = safeURL(frame.contentWindow.location.href); } catch {}
    checkingNavigation = true;
    try {
      if (await frame.contentWindow.Nexus?.prepareLeave?.() === false) {
        if (!push && previous) history.pushState({}, '', previous.pathname + previous.search + previous.hash);
        return;
      }
    } catch { return; }
    finally { checkingNavigation = false; }
    const id = ++navigationId;
    clearTimeout(navigationTimer);
    clearTimeout(revealTimer);
    if (push && u.href !== location.href) history.pushState({}, '', u.pathname + u.search + u.hash);
    frame.classList.add('hub-navigating');
    frame.setAttribute('aria-busy', 'true');
    u.searchParams.set('_view', '1');
    navigationTimer = setTimeout(
      () => {
        if (id !== navigationId) return;
        frame.contentWindow.location.replace(u.href);
        revealTimer = setTimeout(showFrame, 8000);
      },
      reducedNavigation.matches ? 0 : 120
    );
  }
  function syncChatLayout() {
    try { document.body.classList.toggle('chat-focus', !!frame.contentDocument?.getElementById('chatPage')); }
    catch { document.body.classList.remove('chat-focus'); }
  }
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const m = event.data;
    if (m?.type === 'nexus:dialog-focus')
      document.body.classList.toggle('dialog-focus', m.active === true);
    if (m?.type === 'nexus:reader-focus')
      document.body.classList.toggle('reader-focus', m.active === true);
    if (m?.type === 'nexus:navigate') navigate(m.url);
    if (m?.type === 'nexus:ready') {
      syncChatLayout();
      document.title = frame.contentDocument.title;
      requestAnimationFrame(() => requestAnimationFrame(revealPage));
    }
    if (m?.type === 'nexus:location') {
      window.NexusUI.afterDialogs(() => {
        const url = safeURL(m.url);
        if (url && url.href !== location.href)
          history[m.replace ? 'replaceState' : 'pushState'](
            {},
            '',
            url.pathname + url.search + url.hash
          );
      });
    }
    if (m?.type === 'nexus:back') history.back();

  });
  addEventListener('popstate', () => {
    if ($('waveQueueDialog').open) $('waveQueueDialog').close();
    if (overlayHistory || history.state?.nexusWavePlayer) {
      overlayHistory = Boolean(history.state?.nexusWavePlayer);
      expanded(overlayHistory, false);
      return;
    }
    navigate(location.href, false);
  });
  async function checkSession() {
    try {
      const response = await fetch('/api/health', {signal: AbortSignal.timeout(5000)});
      if (response.status === 401) {
        signingOut = true;
        pausePlayback();
        clearAudioCache();
        location.replace('/login');
      }
    } catch {}
  }
  setInterval(checkSession, 60000);
  addEventListener('online', checkSession);
  frame.addEventListener('load', () => {
    syncChatLayout();
    document.body.classList.remove('reader-focus');
    document.body.classList.toggle('dialog-focus', !!frame.contentDocument?.querySelector('dialog[open]'));
    requestAnimationFrame(() => requestAnimationFrame(revealPage));
    try {
      if (frame.contentWindow.location.pathname === '/login') {
        signingOut = true;
        pausePlayback();
        clearAudioCache();
        location.replace('/login');
        return;
      }
      document.title = frame.contentDocument.title;
    } catch {
      void checkSession();
    }
  });
  addEventListener('keydown', (e) => {
    if (
      e.key === 'Backspace' &&
      !e.defaultPrevented &&
      !e.repeat &&
      !e.isComposing &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.target.closest('input,textarea,select,[contenteditable]')
    ) {
      e.preventDefault();
      if (player.classList.contains('expanded')) expanded(false);
      else history.back();
    }
    if (
      e.key === 'Tab' &&
      player.classList.contains('expanded') &&
      !$('waveQueueDialog').open
    ) {
      const nodes = [
          ...player.querySelectorAll('button:not(:disabled),input:not(:disabled)')
        ].filter((el) => el.getClientRects().length),
        first = nodes[0],
        last = nodes.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      }
      if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
    if (
      e.key === 'Escape' &&
      !$('waveQueueDialog').open &&
      $('wavePlayer').classList.contains('expanded')
    )
      $('waveExpand').click();
  });
  $('wavePlayerCover').onerror = () => {
    $('wavePlayerCover').hidden = true;
    $('waveCoverFallback').hidden = false;
  };
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
