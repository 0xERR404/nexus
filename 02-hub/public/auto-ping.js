(() => {
  const interval = 60000, key = 'nexus-vpn-auto-ping-v1';
  let connections = [], signature = '', timer, running = false, closed = false;
  const attempts = new Map();
  const visible = () => !closed && !document.hidden && navigator.onLine !== false;
  function recent(id) {
    let at = attempts.get(id) || 0;
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      if (Number.isFinite(saved[id])) at = Math.max(at, saved[id]);
    } catch {}
    // A clock adjustment must not suppress measurements indefinitely.
    return at > Date.now() ? 0 : at;
  }
  function remember(id) {
    const now = Date.now(); attempts.set(id, now);
    try {
      const saved = JSON.parse(localStorage.getItem(key) || '{}');
      const rows = Object.entries(saved).filter(([, at]) => Number.isFinite(at) && at > now - interval && at <= now);
      localStorage.setItem(key, JSON.stringify({...Object.fromEntries(rows), [id]: now}));
    } catch {}
  }
  function schedule(delay = 0) {
    clearTimeout(timer);
    if (visible() && connections.length && !running) timer = setTimeout(tick, delay);
  }
  async function measure() {
    const batch = [...connections];
    for (const connection of batch) {
      if (!visible() || window.NexusQuickPing.active) break;
      if (!connections.some(c => c.id === connection.id) || Date.now() - recent(connection.id) < interval) continue;
      remember(connection.id);
      try { await window.NexusQuickPing.run(connection); } catch { /* Retry on the next interval. */ }
    }
  }
  async function tick() {
    if (!visible() || running || !window.NexusQuickPing) return;
    if (window.NexusQuickPing.active) { schedule(15000); return; }
    running = true;
    try {
      // One automatic batch across tabs; manual diagnostics keep their existing server lock.
      if (navigator.locks?.request) {
        await navigator.locks.request('nexus-vpn-auto-ping', {ifAvailable: true}, async lock => {
          if (lock) await measure();
        });
      } else await measure();
    } catch { /* A denied browser lock must not break the dashboard. */
    } finally { running = false; schedule(interval); }
  }
  window.NexusAutoPing = {
    watch(items = []) {
      connections = items.filter(c => c && typeof c.id === 'string').slice(0, 3);
      const next = JSON.stringify(connections.map(c => c.id));
      if (next !== signature) { signature = next; schedule(); }
    }
  };
  document.addEventListener('visibilitychange', () => document.hidden ? clearTimeout(timer) : schedule());
  addEventListener('offline', () => { clearTimeout(timer); });
  addEventListener('online', () => schedule());
  addEventListener('pagehide', () => { closed = true; clearTimeout(timer); });
  addEventListener('pageshow', () => { closed = false; schedule(); });
})();
