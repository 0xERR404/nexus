(() => {
  const TIMING = Object.freeze({
    loading: 1500,
    welcomeAt: 1877,
    voiceDuration: 2952,
    hold: 400,
    reveal: 500
  });
  const preference = 'nexus-intro-enabled',
    pending = 'nexus-intro-pending',
    soundPreference = 'nexus-intro-sound';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const enabled = (key = preference) => {
    try {
      return localStorage.getItem(key) !== 'false';
    } catch {
      return true;
    }
  };
  const setting = document.getElementById('introEnabled'),
    soundSetting = document.getElementById('introSound'),
    preview = document.getElementById('introPreview'),
    status = document.getElementById('introSettingStatus');
  for (const [input, key] of [
    [setting, preference],
    [soundSetting, soundPreference]
  ]) {
    if (!input) continue;
    input.checked = enabled(key);
    input.onchange = () => {
      try {
        localStorage.setItem(key, String(input.checked));
        status.textContent = 'Сохранено для этого устройства.';
      } catch {
        status.textContent = 'Браузер не разрешает сохранить настройку.';
      }
    };
  }
  if (preview)
    preview.onclick = () => {
      if (reduced.matches) {
        status.textContent = 'В системе включено уменьшение анимации.';
        return;
      }
      (window.parent.NexusIntro ?? window.NexusIntro)?.play();
    };
  if (window.parent !== window) return;
  const login = document.querySelector('.login-form');
  if (login) {
    addEventListener('pageswap', (event) => event.viewTransition?.skipTransition());
    try {
      sessionStorage.removeItem(pending);
    } catch {}
    login.addEventListener('submit', () => {
      try {
        sessionStorage.setItem(pending, String(Date.now()));
      } catch {}
    });
    return;
  }
  if (!document.querySelector('.page, .wave-shell')) return;
  let active;
  window.NexusIntro = {play: () => run()};
  let stamp = 0;
  try {
    stamp = Number(sessionStorage.getItem(pending));
    sessionStorage.removeItem(pending);
  } catch {}
  if (
    stamp > 0 &&
    Date.now() - stamp >= 0 &&
    Date.now() - stamp < 120000 &&
    enabled() &&
    !reduced.matches
  )
    void run();

  function backdrop(canvas) {
    const ctx = canvas.getContext('2d');
    if (!ctx) return () => {};
    let width = 0,
      height = 0,
      stars = [],
      frame = 0,
      last = 0;
    function resize() {
      width = innerWidth;
      height = innerHeight;
      const scale = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      stars = Array.from(
        {length: Math.min(38, Math.max(13, Math.round((width * height) / 54000)))},
        () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 5,
          vy: (Math.random() - 0.5) * 5
        })
      );
    }
    function tick(time) {
      if (time - last >= 1000 / 30) {
        const dt = last ? Math.min((time - last) / 1000, 0.1) : 0;
        last = time;
        ctx.clearRect(0, 0, width, height);
        for (let i = 0; i < stars.length; i++) {
          const a = stars[i];
          a.x = (a.x + a.vx * dt + width) % width;
          a.y = (a.y + a.vy * dt + height) % height;
          let connections = 0;
          for (let j = i + 1; j < stars.length && connections < 2; j++) {
            const b = stars[j],
              distance = Math.hypot(a.x - b.x, a.y - b.y),
              reach = width < 600 ? 135 : 200;
            if (distance < reach) {
              connections++;
              ctx.strokeStyle = `rgba(183,204,231,${0.18 * (1 - distance / reach)})`;
              ctx.lineWidth = 0.7;
              ctx.beginPath();
              ctx.moveTo(a.x, a.y);
              ctx.lineTo(b.x, b.y);
              ctx.stroke();
            }
          }
          ctx.fillStyle = 'rgba(212,231,247,.5)';
          ctx.beginPath();
          ctx.arc(a.x, a.y, 0.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      frame = requestAnimationFrame(tick);
    }
    resize();
    addEventListener('resize', resize);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      removeEventListener('resize', resize);
    };
  }
  async function run() {
    if (active || reduced.matches || document.hidden) return;
    const overlay = document.createElement('section');
    overlay.id = 'nexusIntro';
    overlay.className = 'nexus-intro';
    overlay.dataset.phase = 'loading';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Приветствие NEXUS404');
    overlay.innerHTML =
      '<canvas class="intro-stars" aria-hidden="true"></canvas><div class="intro-center"><img class="intro-emblem" src="/mark.svg" alt=""><div class="intro-headline"><span class="intro-brand">NEXUS404</span><span class="intro-online">NEXUS ONLINE</span></div><div class="intro-welcome">WELCOME BACK</div><div class="intro-progress" aria-hidden="true"><div class="intro-track"><span></span></div><span class="intro-percent">0%</span></div></div><span class="sr-only intro-announcement" role="status" aria-live="polite">Приветствие</span><div class="intro-controls"><button class="intro-sound" type="button">Включить звук</button><button class="intro-skip" type="button">Пропустить</button></div>';
    const previous = document.activeElement,
      siblings = [...document.body.children]
        .filter((e) => !['SCRIPT', 'LINK', 'STYLE'].includes(e.tagName))
        .map((e) => [e, e.inert]);
    siblings.forEach(([e]) => (e.inert = true));
    document.documentElement.classList.add('intro-active');
    document.body.append(overlay);
    const controller = new AbortController(),
      stopBackdrop = backdrop(overlay.querySelector('canvas'));
    const skip = overlay.querySelector('.intro-skip'),
      sound = overlay.querySelector('.intro-sound'),
      bar = overlay.querySelector('.intro-track span'),
      percent = overlay.querySelector('.intro-percent'),
      announcement = overlay.querySelector('.intro-announcement');
    let frame = 0,
      closed = false;
    const voice = document.createElement('audio');
    voice.src = '/intro-voice.mp3';
    voice.preload = 'auto';
    voice.hidden = true;
    overlay.append(voice);
    let wantsSound = enabled(soundPreference),
      ready = false,
      playing = false,
      attempt = 0,
      clock = 0,
      deadline = 0;
    function soundLabel() {
      sound.textContent = wantsSound ? 'Выключить звук' : 'Включить звук';
      sound.setAttribute('aria-pressed', String(wantsSound));
    }
    function silentClock() {
      playing = false;
      clock = performance.now() - voice.currentTime * 1000;
    }
    function startVoice() {
      const id = ++attempt;
      voice.currentTime = 0;
      clock = performance.now();
      deadline = clock + 10000;
      playing = false;
      voice
        .play()
        .then(() => {
          if (closed) {
            voice.pause();
            return;
          }
          if (id !== attempt) return;
          playing = true;
          soundLabel();
        })
        .catch(() => {
          if (closed || id !== attempt) return;
          wantsSound = false;
          silentClock();
          soundLabel();
        });
    }
    voice.addEventListener('error', () => {
      if (closed) return;
      ++attempt;
      wantsSound = false;
      silentClock();
      soundLabel();
    });
    voice.addEventListener('ended', silentClock);
    soundLabel();
    sound.addEventListener('click', (event) => {
      event.stopPropagation();
      wantsSound = !wantsSound;
      try {
        localStorage.setItem(soundPreference, String(wantsSound));
      } catch {}
      if (!wantsSound) {
        ++attempt;
        silentClock();
        voice.pause();
      } else if (ready) startVoice();
      soundLabel();
    });
    active = overlay;
    overlay.tabIndex = -1;
    overlay.focus({preventScroll: true});
    const wait = (ms) =>
      new Promise((resolve) => {
        if (controller.signal.aborted) {
          resolve(false);
          return;
        }
        const abort = () => {
          clearTimeout(timer);
          resolve(false);
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener('abort', abort);
          resolve(true);
        }, ms);
        controller.signal.addEventListener('abort', abort, {once: true});
      });
    function finish(immediate = false) {
      if (closed) return;
      closed = true;
      ++attempt;
      voice.pause();
      voice.removeAttribute('src');
      voice.load();
      controller.abort();
      cancelAnimationFrame(frame);
      stopBackdrop();
      overlay.dataset.phase = 'exit';
      overlay.style.setProperty('--intro-reveal', TIMING.reveal + 'ms');
      setTimeout(
        () => {
          overlay.remove();
          siblings.forEach(([e, inert]) => {
            if (e.isConnected) e.inert = inert;
          });
          document.documentElement.classList.remove('intro-active');
          if (previous?.isConnected && previous !== document.body)
            previous.focus({preventScroll: true});
          active = null;
          document.removeEventListener('keydown', keys, true);
          document.removeEventListener('visibilitychange', visibility);
          removeEventListener('pagehide', hide);
        },
        immediate ? 0 : TIMING.reveal
      );
    }
    function keys(event) {
      if (event.key === 'Tab') {
        event.preventDefault();
        const buttons = [sound, skip];
        const index = buttons.indexOf(document.activeElement);
        buttons[index === 0 ? 1 : index === 1 ? 0 : event.shiftKey ? 1 : 0].focus();
      } else if (
        event.key === 'Escape' ||
        (['Enter', ' '].includes(event.key) && !event.target.closest('button'))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish();
      }
    }
    function visibility() {
      if (document.hidden) finish(true);
    }
    const hide = () => finish(true);
    addEventListener('pagehide', hide);
    document.addEventListener('keydown', keys, true);
    document.addEventListener('visibilitychange', visibility);
    overlay.addEventListener('click', () => finish());
    const started = performance.now();
    function fill(now) {
      const ratio = Math.min(1, (now - started) / TIMING.loading),
        value = Math.floor((1 - Math.pow(1 - ratio, 1.6)) * 100);
      bar.style.transform = `scaleX(${value / 100})`;
      percent.textContent = value + '%';
      if (ratio < 1 && !closed) frame = requestAnimationFrame(fill);
    }
    frame = requestAnimationFrame(fill);
    try {
      const [response] = await Promise.all([
        fetch('/api/health', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])
        }),
        wait(TIMING.loading)
      ]);
      if (closed) return;
      const healthy = response.ok && (await response.json()).status === 'ok';
      if (closed) return;
      if (!healthy) {
        finish(true);
        return;
      }
      bar.style.transform = 'scaleX(1)';
      percent.textContent = '100%';
      ready = true;
      clock = performance.now();
      deadline = clock + 10000;
      if (wantsSound) startVoice();
      function timeline(now) {
        if (closed) return;
        const elapsed = playing ? voice.currentTime * 1000 : now - clock;
        const phase = elapsed >= TIMING.welcomeAt ? 'welcome' : 'online';
        if (overlay.dataset.phase !== phase) {
          overlay.dataset.phase = phase;
          announcement.textContent = phase === 'welcome' ? 'WELCOME BACK' : 'NEXUS ONLINE';
        }
        const duration = Number.isFinite(voice.duration)
          ? voice.duration * 1000
          : TIMING.voiceDuration;
        if (elapsed >= duration + TIMING.hold || now >= deadline) finish();
        else frame = requestAnimationFrame(timeline);
      }
      frame = requestAnimationFrame(timeline);
    } catch {
      finish(true);
    }
  }
})();
