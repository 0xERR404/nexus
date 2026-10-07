(() => {
  const key = 'nexus-performance',
    effectKey = 'nexus-performance-effect';
  const read = () => {
    try {
      return JSON.parse(sessionStorage.getItem(key) || 'null');
    } catch {
      return null;
    }
  };
  const write = (value) => {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {}
  };
  let run = read();
  const active = () => run && Date.now() < run.until;
  if (active()) document.documentElement.dataset.perfEffect = run.effect;
  const panel = document.getElementById('performancePanel');
  if (panel) {
    const select = document.getElementById('performanceEffect');
    try {
      const saved = sessionStorage.getItem(effectKey);
      select.value = [...select.options].some(o=>o.value===saved) ? saved : 'normal';
    } catch {}
    document.getElementById('performanceStart').onclick = () => {
      const now = Date.now();
      write({
        started: now,
        until: now + 120000,
        effect: select.value,
        display: matchMedia('(display-mode: standalone)').matches ? 'PWA' : 'browser',
        viewport: [innerWidth, innerHeight],
        pixelRatio: devicePixelRatio,
        pages: []
      });
      try {
        sessionStorage.setItem(effectKey, select.value);
      } catch {}
      location.reload();
    };
    document.getElementById('performanceStop').onclick = () => {
      flush?.();
      const report = read();
      if (report) {
        report.until = Date.now();
        write(report);
      }
      location.reload();
    };
    document.getElementById('performanceExport').onclick = () => {
      flush?.();
      const report = read();
      if (!report) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(report, null, 2)], {type: 'application/json'})
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = 'nexus-performance.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    const reports = document.getElementById('performanceResults');
    if (run) reports.textContent = JSON.stringify(run, null, 2);
  }
  let flush;
  // No observers, timers or animation frames when diagnostics are off.
  if (!active() || document.body.classList.contains('wave-shell')) return;
  const id = crypto.randomUUID();
  const sample = {
    id,
    page: location.pathname,
    visibleMs: 0,
    frames: 0,
    frameGapMaxMs: 0,
    frameGapsOver34ms: 0,
    frameGapsOver50ms: 0,
    longTasks: 0,
    longTaskMs: 0,
    interactionEvents: 0,
    interactionMaxMs: 0,
    domMutations: 0,
    requests: 0,
    heapPeakMiB: null
  };
  const observers = [];
  function observe(type, callback, options = {}) {
    if (!window.PerformanceObserver?.supportedEntryTypes?.includes(type)) return false;
    const observer = new PerformanceObserver((list) => callback(list.getEntries()));
    observer.observe({type, ...options});
    observers.push(observer);
    return true;
  }
  sample.longTasksSupported = observe('longtask', (entries) => {
    for (const entry of entries) {
      sample.longTasks++;
      sample.longTaskMs += entry.duration;
    }
  });
  sample.eventTimingSupported = observe(
    'event',
    (entries) => {
      for (const entry of entries) {
        if (!entry.interactionId) continue;
        sample.interactionEvents++;
        sample.interactionMaxMs = Math.max(sample.interactionMaxMs, entry.duration);
      }
    },
    {durationThreshold: 16}
  );
  observe('resource', (entries) => {
    sample.requests += entries.filter((entry) =>
      ['fetch', 'xmlhttprequest'].includes(entry.initiatorType)
    ).length;
  });
  const mutations = new MutationObserver((records) => {
    sample.domMutations += records.length;
  });
  mutations.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true
  });
  let frame = 0,
    last = 0,
    stopped = false,
    timer;
  flush = () => {
    const report = read();
    if (!report || report.started !== run.started) return;
    const heap = performance.memory?.usedJSHeapSize;
    if (Number.isFinite(heap))
      sample.heapPeakMiB = Math.max(sample.heapPeakMiB || 0, Math.round(heap / 1048576));
    const pages = report.pages.filter((page) => page.id !== id);
    pages.push({
      ...sample,
      visibleMs: Math.round(sample.visibleMs),
      frameGapMaxMs: Math.round(sample.frameGapMaxMs),
      longTaskMs: Math.round(sample.longTaskMs)
    });
    report.pages = pages.slice(-100);
    write(report);
  };
  function stop() {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    clearInterval(timer);
    observers.forEach((observer) => observer.disconnect());
    mutations.disconnect();
    flush();
    delete document.documentElement.dataset.perfEffect;
  }
  function tick(now) {
    if (!active()) {
      stop();
      return;
    }
    if (document.hidden) {
      last = 0;
      return;
    }
    if (last) {
      const gap = now - last;
      sample.frames++;
      sample.visibleMs += gap;
      sample.frameGapMaxMs = Math.max(sample.frameGapMaxMs, gap);
      if (gap > 34) sample.frameGapsOver34ms++;
      if (gap > 50) sample.frameGapsOver50ms++;
    }
    last = now;
    frame = requestAnimationFrame(tick);
  }
  document.addEventListener('visibilitychange', () => {
    cancelAnimationFrame(frame);
    last = 0;
    flush();
    if (!document.hidden && !stopped) frame = requestAnimationFrame(tick);
  });
  addEventListener('pagehide', stop);
  timer = setInterval(() => {
    if (!active()) stop();
    else flush();
  }, 5000);
  frame = requestAnimationFrame(tick);
})();
