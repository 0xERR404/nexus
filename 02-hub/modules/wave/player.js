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
    volume: '<path d="M3 9h4l5-4v14l-5-4H3Zm13-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>'
  };
  const symbol = (name) =>
    `<svg class="wave-control-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name]}</svg>`;
  $('wavePrev').innerHTML = symbol('prev');
  $('waveNext').innerHTML = symbol('next');
  $('waveExpand').innerHTML = symbol('up');
  $('waveShuffle').innerHTML = symbol('shuffle');
  $('waveVolumeIcon').innerHTML = symbol('volume');
  const key = 'nexus-wave-v1';
  let library = {tracks: [], playlists: []},
    state = {queue: [], index: 0, position: 0, repeat: 'off', shuffle: false, volume: 1},
    loaded = null,
    lastSave = 0,
    restoring = 0,
    ready = false,
    signingOut = false;
  try {
    const saved = JSON.parse(localStorage.getItem(key));
    if (saved && Array.isArray(saved.queue)) {
      state.queue = saved.queue.filter((id) => typeof id === 'string').slice(0, 10000);
      state.index = Math.max(0, Math.min(Number(saved.index) || 0, state.queue.length - 1));
      state.position = Math.max(0, Number(saved.position) || 0);
      state.repeat = ['off', 'all', 'one'].includes(saved.repeat) ? saved.repeat : 'off';
      state.shuffle = Boolean(saved.shuffle);
      state.volume = Math.max(0, Math.min(1, Number(saved.volume) || 0));
    }
  } catch {}
  const track = () => library.tracks.find((t) => t.id === state.queue[state.index]);
  const clock = (n) =>
    Number.isFinite(n)
      ? Math.floor(n / 60) + ':' + String(Math.floor(n % 60)).padStart(2, '0')
      : '0:00';
  const note = (text) => ($('wavePlayerStatus').textContent = text);
  function save() {
    if (signingOut) return;
    state.position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      note('Не удалось сохранить очередь на этом устройстве.');
    }
  }
  function paint() {
    const t = track();
    frame.contentWindow?.postMessage({type: 'nexus:wave-state'}, location.origin);
    $('wavePlayer').hidden = !t;
    $('waveTrackTitle').textContent = t?.title || 'Волна';
    $('waveTrackArtist').textContent = t?.artist || '';
    $('waveToggle').innerHTML = symbol(audio.paused ? 'play' : 'pause');
    $('waveToggle').setAttribute('aria-label', audio.paused ? 'Воспроизвести' : 'Пауза');
    $('waveToggle').setAttribute('aria-pressed', String(!audio.paused));
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
    if (!t) {
      $('waveQueueDialog').close();
      if (player.classList.contains('expanded')) expanded(false);
    }
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = audio.paused ? 'paused' : 'playing';
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
  async function select(play = true, position = 0) {
    const t = track();
    if (!t) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      loaded = null;
      paint();
      return;
    }
    if (loaded !== t.id) {
      audio.pause();
      loaded = t.id;
      restoring = position;
      audio.src = '/modules/wave/audio/' + t.id;
      audio.load();
      $('waveSeek').disabled = true;
      metadata();
    } else if (position) audio.currentTime = Math.min(position, audio.duration || position);
    audio.loop = state.repeat === 'one';
    paint();
    if (play)
      try {
        try {
          frame.contentDocument.querySelectorAll('audio,video').forEach((media) => media.pause());
        } catch {}
        await audio.play();
        note('');
      } catch {
        note('Нажми ▶, чтобы продолжить воспроизведение.');
      }
    save();
    renderQueue();
  }
  async function next(direction = 1, automatic = false) {
    if (!state.queue.length) return;
    if (direction < 0 && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (automatic && state.repeat === 'one') {
      audio.currentTime = 0;
      await audio.play().catch(() => {});
      return;
    }
    let index = state.index + direction;
    if (state.shuffle && state.queue.length > 1 && direction > 0) {
      const offset = 1 + Math.floor(Math.random() * (state.queue.length - 1));
      index = (state.index + offset) % state.queue.length;
    }
    if (index >= state.queue.length || index < 0) {
      if (state.repeat === 'all') index = (index + state.queue.length) % state.queue.length;
      else {
        audio.pause();
        save();
        return;
      }
    }
    state.index = index;
    await select(true);
  }
  async function refresh() {
    const response = await fetch('/modules/wave/library');
    if (response.status === 401 || response.redirected) {
      audio.pause();
      location.replace('/login');
      return;
    }
    if (!response.ok) throw Error('Библиотека временно недоступна.');
    library = await response.json();
    const current = state.queue[state.index];
    state.queue = state.queue.filter((id) => library.tracks.some((t) => t.id === id));
    state.index = Math.max(0, state.queue.indexOf(current));
    if (loaded && !library.tracks.some((t) => t.id === loaded)) await select(false);
    if (loaded) metadata();
    paint();
    renderQueue();
    return library;
  }
  function renderQueue() {
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
        if (i === state.index) {
          state.index = Math.min(i, state.queue.length - 1);
          state.index = Math.max(0, state.index);
          void select(wasPlaying);
        } else state.index = Math.max(0, state.queue.indexOf(current));
        save();
        paint();
        renderQueue();
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
  $('waveTransferStop').onclick = () => {
    stopUpload = true;
    transfer.message = 'Остановка после текущего файла…';
    transferPaint();
  };
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
    upload,
    transfer: () => ({...transfer, ids: [...transfer.ids]}),

    refresh,
    state: () => ({id: loaded, playing: !audio.paused}),
    async playList(ids, id, {shuffle = false} = {}) {
      if (!ready) await initialize;
      await refresh();
      state.shuffle = shuffle;
      state.queue = [...new Set(ids)]
        .filter((id) => library.tracks.some((t) => t.id === id))
        .slice(0, 10000);
      state.index = Math.max(0, state.queue.indexOf(id));
      await select(true);
    },
    async enqueue(id) {
      if (!ready) await initialize;
      await refresh();
      if (!library.tracks.some((t) => t.id === id)) throw Error('Трек не найден.');
      if (!state.queue.includes(id)) state.queue.push(id);
      if (!loaded) await select(false);
      save();
      paint();
      renderQueue();
    },
    pause() {
      audio.pause();
    }
  };
  $('waveToggle').onclick = () => (audio.paused ? select(true, audio.currentTime) : audio.pause());
  $('waveNext').onclick = () => next();
  $('wavePrev').onclick = () => next(-1);
  $('waveShuffle').onclick = () => {
    state.shuffle = !state.shuffle;
    save();
    paint();
  };
  $('waveRepeat').onclick = () => {
    state.repeat = {off: 'all', all: 'one', one: 'off'}[state.repeat];
    audio.loop = state.repeat === 'one';
    save();
    paint();
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
    const modal = value && mobile.matches;
    frame.inert = $('waveTransfer').inert = modal;
    if (modal) {
      player.setAttribute('role', 'dialog');
      player.setAttribute('aria-modal', 'true');
    } else {
      player.removeAttribute('role');
      player.removeAttribute('aria-modal');
    }
    if (value && record && mobile.matches && !overlayHistory) {
      history.pushState({...history.state, nexusWavePlayer: true}, '');
      overlayHistory = true;
    }
    if (!value) $('waveQueueDialog').close();
    if (modal) $('waveExpand').focus();
    else if (!value && !player.hidden) $('waveExpand').focus();
  }
  $('waveExpand').onclick = () => expanded(!player.classList.contains('expanded'));
  $('waveArtworkToggle').onclick = $('waveOpenTrack').onclick = () => expanded(true);
  mobile.addEventListener('change', () => expanded(player.classList.contains('expanded'), false));
  $('waveQueueToggle').onclick = () => {
    $('waveQueueDialog').showModal();
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
  audio.addEventListener('timeupdate', position);
  audio.addEventListener('play', () => {
    try {
      frame.contentDocument.querySelectorAll('audio,video').forEach((media) => media.pause());
    } catch {}
    paint();
    save();
  });
  audio.addEventListener('pause', () => {
    paint();
    save();
  });
  audio.addEventListener('ended', () => next(1, true));
  audio.addEventListener('error', () => {
    note('Трек недоступен. Проверь соединение и повтори.');
    paint();
  });
  document.addEventListener('visibilitychange', () => save());
  addEventListener('pagehide', save);
  if (navigator.mediaSession) {
    for (const [name, fn] of Object.entries({
      play: () => select(),
      pause: () => audio.pause(),
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
      stop: () => {
        audio.pause();
        audio.currentTime = 0;
        save();
      }
    }))
      try {
        navigator.mediaSession.setActionHandler(name, fn);
      } catch {}
  }
  const initialize = (async () => {
    const savedPosition = state.position;
    await refresh();
    await select(false, savedPosition);
    ready = true;
  })().catch((e) => note(e.message));
  function safeURL(value) {
    try {
      const u = new URL(value, location.origin);
      if (
        u.origin !== location.origin ||
        !/^\/(?:$|settings\/?$|modules\/[a-z-]+\/?$)/.test(u.pathname)
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
  function navigate(href, push = true) {
    const u = safeURL(href);
    if (!u) return;
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
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const m = event.data;
    if (m?.type === 'nexus:navigate') navigate(m.url);
    if (m?.type === 'nexus:ready') {
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
    if (m?.type === 'nexus:logout') {
      signingOut = true;
      audio.pause();
      try {
        localStorage.removeItem(key);
      } catch {}
      fetch('/api/auth/logout', {method: 'POST'}).finally(() => location.replace('/login'));
    }
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
        audio.pause();
        location.replace('/login');
      }
    } catch {}
  }
  setInterval(checkSession, 60000);
  addEventListener('online', checkSession);
  frame.addEventListener('load', () => {
    requestAnimationFrame(() => requestAnimationFrame(revealPage));
    try {
      if (frame.contentWindow.location.pathname === '/login') {
        audio.pause();
        location.replace('/login');
        return;
      }
      document.title = frame.contentDocument.title;
    } catch {
      audio.pause();
      void checkSession();
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Backspace' && !e.target.closest('input,textarea,select,[contenteditable]')) {
      e.preventDefault();
      if (player.classList.contains('expanded')) expanded(false);
      else history.back();
    }
    if (
      e.key === 'Tab' &&
      mobile.matches &&
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
