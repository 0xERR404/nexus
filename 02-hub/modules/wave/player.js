(() => {
  const $ = (id) => document.getElementById(id),
    audio = $('waveAudio'),
    frame = $('hubFrame');
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
    $('wavePlayer').hidden = !t;
    $('waveTrackTitle').textContent = t?.title || 'Волна';
    $('waveTrackArtist').textContent = t?.artist || '';
    $('waveToggle').textContent = audio.paused ? '▶' : 'Ⅱ';
    $('waveToggle').setAttribute('aria-label', audio.paused ? 'Воспроизвести' : 'Пауза');
    $('waveToggle').setAttribute('aria-pressed', String(!audio.paused));
    $('waveRepeat').textContent = state.repeat === 'one' ? '↻ 1' : '↻';
    $('waveRepeat').setAttribute('aria-pressed', String(state.repeat !== 'off'));
    $('waveRepeat').title =
      'Повтор: ' + {off: 'выключен', all: 'очередь', one: 'трек'}[state.repeat];
    $('waveShuffle').setAttribute('aria-pressed', String(state.shuffle));
    $('waveVolume').value = String(state.volume);
    $('waveQueueCount').textContent = state.queue.length + ' в очереди';
    const cover = $('wavePlayerCover');
    cover.hidden = !t?.cover;
    if (t?.cover) cover.src = '/modules/wave/cover/' + t.id;
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
    $('waveTime').textContent = clock(audio.currentTime) + ' / ' + clock(duration);
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
  window.NexusWave = {
    refresh,
    async playList(ids, id) {
      if (!ready) await initialize;
      await refresh();
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
  $('waveExpand').onclick = () => {
    $('wavePlayer').classList.toggle('expanded');
    $('waveExpand').setAttribute(
      'aria-expanded',
      String($('wavePlayer').classList.contains('expanded'))
    );
    $('waveExpand').textContent = $('wavePlayer').classList.contains('expanded') ? '⌄' : '⌃';
  };
  $('waveQueueToggle').onclick = () => {
    $('waveQueue').hidden = !$('waveQueue').hidden;
    $('waveQueueToggle').setAttribute('aria-expanded', String(!$('waveQueue').hidden));
  };
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
  function navigate(href, push = true) {
    const u = safeURL(href);
    if (!u) return;
    if (push && u.href !== location.href) history.pushState({}, '', u.pathname + u.search + u.hash);
    u.searchParams.set('_view', '1');
    frame.contentWindow.location.replace(u.href);
  }
  addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const m = event.data;
    if (m?.type === 'nexus:navigate') navigate(m.url);
    if (m?.type === 'nexus:location') {
      const url = safeURL(m.url);
      if (url && url.href !== location.href)
        history[m.replace ? 'replaceState' : 'pushState'](
          {},
          '',
          url.pathname + url.search + url.hash
        );
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
  addEventListener('popstate', () => navigate(location.href, false));
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
      history.back();
    }
    if (e.key === 'Escape' && $('wavePlayer').classList.contains('expanded'))
      $('waveExpand').click();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
