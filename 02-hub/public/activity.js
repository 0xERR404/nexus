(() => {
  function recorder() {
    let identity = '',
      session = '',
      seq = 0,
      chain = Promise.resolve();
    return (value) => {
      if (!value) return;
      const key = value.source + ':' + value.item;
      if (identity !== key) {
        identity = key;
        session = crypto.randomUUID();
        seq = 0;
      }
      const body = JSON.stringify({
        ...value,
        title: String(value.title || 'Без названия').slice(0, 300),
        session,
        seq: ++seq
      });
      chain = chain
        .catch(() => {})
        .then(() =>
          fetch('/api/activity', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body,
            keepalive: true,
            signal: AbortSignal.timeout(10000)
          })
        )
        .catch(() => {});
    };
  }
  window.NexusActivity = {
    media(media, get) {
      const send = recorder();
      let last = 0;
      function sample(force = false) {
        const item = get();
        if (!item) return;
        if (!force && Date.now() - last < 10000) return;
        last = Date.now();
        send({
          ...item,
          position: Number.isFinite(media.currentTime) ? media.currentTime : 0,
          duration: Number.isFinite(media.duration) ? media.duration : 0,
          playing: !media.paused && !media.ended && !media.seeking
        });
      }
      media.addEventListener('timeupdate', () => sample());
      for (const event of ['playing', 'pause', 'ended', 'seeking', 'seeked'])
        media.addEventListener(event, () => sample(true));
      document.addEventListener('visibilitychange', () => sample(true));
      addEventListener('pagehide', () => sample(true));
    },
    reading(get) {
      const send = recorder();
      let position = 0,
        last = performance.now(),
        active = false;
      const tick = () => {
        const now = performance.now(),
          item = get();
        if (active) position += Math.min(15, (now - last) / 1000);
        last = now;
        active = Boolean(item) && !document.hidden;
        if (item)
          send({...item, source: 'reader', kind: 'book', position, duration: 0, playing: active});
      };
      setInterval(tick, 10000);
      document.addEventListener('visibilitychange', tick);
      addEventListener('pagehide', () => {
        tick();
        active = false;
      });
    }
  };
})();
