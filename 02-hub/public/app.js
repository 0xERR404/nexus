try {
  indexedDB.deleteDatabase('nexus-rhythm-sync');
} catch {}
if (window.parent !== window) {
  const send = (data) => window.parent.postMessage(data, location.origin);
  document.addEventListener(
    'DOMContentLoaded',
    () => send({type: 'nexus:ready', url: location.href}),
    {once: true}
  );
  const replace = history.replaceState.bind(history);
  const embeddedURL = (value) => {
    const url = new URL(value ?? location.href, location.href);
    if (url.origin === location.origin) url.searchParams.set('_view', '1');
    return url.href;
  };
  replace(history.state, '', embeddedURL());
  for (const method of ['pushState', 'replaceState'])
    history[method] = (state, title, url) => {
      replace(state, title, embeddedURL(url));
      send({type: 'nexus:location', url: location.href, replace: method === 'replaceState'});
    };
  document.addEventListener(
    'click',
    (event) => {
      const a = event.target.closest('a[href]');
      if (
        !a ||
        a.download ||
        a.hasAttribute('download') ||
        a.target === '_blank' ||
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      if (a.matches('[data-trophy-provider],[data-wave-nav]')) return;
      const url = new URL(a.href, location.href);
      if (
        url.origin === location.origin &&
        /^\/(?:$|(?:settings|status|search)\/?$|modules\/[a-z-]+\/?$)/.test(url.pathname)
      ) {
        event.preventDefault();
        send({type: 'nexus:navigate', url: url.href});
      }
    },
    true
  );
  document.addEventListener(
    'submit',
    (event) => {
      if (event.target.action?.endsWith('/api/auth/logout')) {
        event.preventDefault();
        send({type: 'nexus:logout'});
      }
    },
    true
  );
  document.addEventListener('play', () => window.parent.NexusWave?.pause(), true);
}
let installPrompt;
const standalone = matchMedia('(display-mode: standalone)');
const installButtons = document.querySelectorAll('[data-install]');
function updateInstall() {
  installButtons.forEach((button) => {
    button.hidden = standalone.matches;
  });
}
updateInstall();
standalone.addEventListener('change', updateInstall);
addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
  updateInstall();
});
addEventListener('appinstalled', () => {
  installPrompt = undefined;
  installButtons.forEach((button) => {
    button.hidden = true;
  });
});
installButtons.forEach((button) =>
  button.addEventListener('click', async () => {
    if (!installPrompt) {
      document.getElementById('installHelp')?.showModal();
      return;
    }
    const prompt = installPrompt;
    installPrompt = undefined;
    await prompt.prompt();
    await prompt.userChoice;
  })
);
const reveal = document.getElementById('revealPassword');
reveal?.addEventListener('click', () => {
  const input = document.getElementById('password');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  reveal.setAttribute('aria-pressed', String(show));
  reveal.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
});
addEventListener('pageshow', (event) => {
  if (event.persisted) location.reload();
});
const statusText = document.getElementById('statusText');
function connection(online) {
  if (!statusText) return;
  statusText.textContent = online ? 'online' : 'offline';
  document.getElementById('statusDot').classList.toggle('offline', !online);
}
async function checkConnection() {
  if (!statusText || document.hidden) return;
  try {
    const response = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5000)
    });
    if (response.status === 401) {
      location.replace('/login');
      return;
    }
    connection(response.ok);
  } catch {
    connection(false);
  }
}
addEventListener('offline', () => connection(false));
addEventListener('online', checkConnection);
addEventListener('focus', checkConnection);
if (statusText) setInterval(checkConnection, 60000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

const summaries = [...document.querySelectorAll('[data-summary]')];
let summaryTimer,
  summaryController,
  summaryFailures = 0,
  summaryStopped = false,
  summaryLoading = false;
const summarySnapshots = new WeakMap();
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
};
function balanceChart(data) {
  if (!data?.points?.length || !data.points.every(Number.isSafeInteger)) return null;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 280 70');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'balance-spark');
  svg.setAttribute('role', 'img');
  const format = (value) =>
    new Intl.NumberFormat('ru-RU', {maximumFractionDigits: 2}).format(value / 100);
  svg.setAttribute(
    'aria-label',
    `Остаток ${data.currency} по дням, ${data.month}: от ${format(data.points[0])} до ${format(data.points.at(-1))}`
  );
  const min = Math.min(...data.points),
    max = Math.max(...data.points);
  const values = data.points.length === 1 ? [data.points[0], data.points[0]] : data.points;
  const points = values.map(
    (v, i) =>
      `${(i * 280) / (values.length - 1)},${max === min ? 34 : 62 - ((v - min) / (max - min)) * 54}`
  );
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', `0,70 ${points.join(' ')} 280,70`);
  area.setAttribute('class', 'spark-area');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('class', 'spark-line');
  svg.append(area, line);
  return svg;
}
window.nexusBalanceChart = balanceChart;
function renderSummary(node, data, metadata = {}) {
  if (!data || data.state === 'stale') {
    node.dataset.state = 'stale';
    if (summarySnapshots.has(node))
      node.title = 'Данные не обновлены. Показаны последние полученные значения.';
    else {
      node.removeAttribute('title');
      if (node.textContent !== 'Нет свежих данных')
        node.replaceChildren(element('span', 'Нет свежих данных', 'module-summary-note'));
    }
    return;
  }
  const snapshot = JSON.stringify(data);
  node.dataset.state = metadata.stale ? 'stale' : data.state;
  if (metadata.updatedAt > 0)
    node.title = `${metadata.stale ? 'Данные не обновлены. ' : ''}Обновлено: ${new Date(metadata.updatedAt).toLocaleString('ru-RU')}`;
  else node.removeAttribute('title');
  if (summarySnapshots.get(node) === snapshot) return;

  if (node.dataset.summary === 'pulse' && summarySnapshots.has(node)) {
    const previous = JSON.parse(summarySnapshots.get(node));
    const rows = node.querySelectorAll('.module-stat');
    if (
      rows.length === data.items.length &&
      previous.items.every(
        (item, i) =>
          item.label === data.items[i].label &&
          /^\d+%$/.test(item.value) === /^\d+%$/.test(data.items[i].value)
      )
    ) {
      data.items.forEach((item, i) => {
        const value = rows[i].querySelector('strong');
        if (value && value.textContent !== item.value) value.textContent = item.value;
        const meter = rows[i].querySelector('meter');
        if (meter && meter.value !== Number.parseInt(item.value, 10))
          meter.value = Number.parseInt(item.value, 10);
      });
      summarySnapshots.set(node, snapshot);
      return;
    }
  }
  node.dataset.multiple = String((data?.items?.length ?? 0) > 1);
  const stats = document.createElement('div');
  stats.className = 'module-stats';
  for (const item of data.items) {
    const itemNode = document.createElement('div');
    itemNode.className = 'module-stat';
    itemNode.append(element('span', item.label));
    if (node.dataset.summary === 'pulse' && /^\d+%$/.test(item.value)) {
      const meter = document.createElement('meter');
      meter.className = 'resource-meter';
      meter.min = 0;
      meter.max = 100;
      meter.value = Math.min(100, Number.parseInt(item.value, 10));
      meter.setAttribute('aria-label', item.label);
      itemNode.append(meter);
    }
    if (node.dataset.summary === 'chat' && ['DeepSeek', 'FlowMusic'].includes(item.label)) {
      if (item.value === 'подключён') {
        const dot = element('span', '', 'provider-state');
        dot.dataset.connected = 'true';
        dot.append(element('span', 'Подключён', 'sr-only'));
        itemNode.append(dot);
      } else itemNode.append(element('span', item.value, 'provider-note'));
    } else itemNode.append(element('strong', item.value));
    stats.append(itemNode);
  }
  node.replaceChildren(stats);
  if (node.dataset.summary === 'anime' && data.covers?.length) {
    const covers = element('div', '', 'module-covers');
    for (const id of data.covers) {
      if (!Number.isSafeInteger(id) || id <= 0 || id > 9999999999) continue;
      const img = document.createElement('img');
      img.src = '/modules/anime/cover/' + id;
      img.alt = '';
      img.loading = 'lazy';
      img.addEventListener('error', () => img.remove());
      covers.append(img);
    }
    node.prepend(covers);
  }
  if (node.dataset.summary === 'balance') {
    const chart = balanceChart(data.chart);
    if (chart)
      node.append(
        chart,
        element('span', `${data.chart.currency} · ${data.chart.month}`, 'spark-caption')
      );
  }
  summarySnapshots.set(node, snapshot);
}
async function refreshSummaries() {
  clearTimeout(summaryTimer);
  if (
    summaryStopped ||
    document.hidden ||
    navigator.onLine === false ||
    summaryLoading ||
    !summaries.length
  )
    return;
  summaryLoading = true;
  summaryController = new AbortController();
  try {
    const response = await fetch('/api/modules', {
      cache: 'no-store',
      signal: AbortSignal.any([summaryController.signal, AbortSignal.timeout(8000)])
    });
    if (response.status === 401 || response.redirected) {
      location.replace('/login');
      return;
    }
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    if (!Array.isArray(data.modules)) throw new Error('Invalid modules');
    if (summaryController.signal.aborted) return;
    summaryFailures = 0;
    for (const node of summaries) {
      const module = data.modules.find((module) => module.id === node.dataset.summary);
      renderSummary(node, module?.summary, module);
    }
  } catch {
    if (!summaryController.signal.aborted) {
      summaryFailures++;
      for (const node of summaries) renderSummary(node, null);
    }
  } finally {
    summaryLoading = false;
    if (!summaryStopped && !document.hidden && navigator.onLine !== false)
      summaryTimer = setTimeout(
        refreshSummaries,
        Math.min(60000, 10000 * 2 ** Math.min(summaryFailures, 3))
      );
  }
}
if (summaries.length) {
  const pauseSummaries = () => {
    clearTimeout(summaryTimer);
    summaryController?.abort();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pauseSummaries();
    else refreshSummaries();
  });
  addEventListener('pagehide', () => {
    summaryStopped = true;
    pauseSummaries();
  });
  addEventListener('online', refreshSummaries);
  addEventListener('offline', () => {
    pauseSummaries();
    for (const node of summaries) renderSummary(node, null);
  });
  refreshSummaries();
}

addEventListener('keydown', (event) => {
  if (
    event.key !== 'Backspace' ||
    event.defaultPrevented ||
    event.repeat ||
    event.isComposing ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey ||
    !matchMedia('(hover: hover) and (pointer: fine)').matches ||
    document.querySelector('dialog[open]') ||
    history.length < 2
  )
    return;
  if (
    event
      .composedPath()
      .some(
        (node) =>
          node instanceof HTMLElement &&
          (node.isContentEditable ||
            node.matches('input, textarea, select, [role="textbox"], [role="combobox"]'))
      )
  )
    return;
  event.preventDefault();
  if (window.parent !== window) window.parent.postMessage({type: 'nexus:back'}, location.origin);
  else history.back();
});

(() => {
  const canvas = document.createElement('canvas');
  canvas.className = 'constellation';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    canvas.remove();
    return;
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let width = 0,
    height = 0,
    stars = [],
    frame = 0,
    timer = 0,
    resizeTimer = 0,
    scrollTimer = 0,
    last = 0,
    scrolling = false,
    leaving = false;
  function resize() {
    if (width === innerWidth && height === innerHeight) return;
    const oldWidth = width || innerWidth,
      oldHeight = height || innerHeight;
    width = innerWidth;
    height = innerHeight;
    const mobile = width <= 768,
      scale = mobile ? 1 : Math.min(devicePixelRatio || 1, 1.25);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    const count = Math.min(mobile ? 28 : 48, Math.max(16, Math.round((width * height) / 30000)));
    stars = stars
      .slice(0, count)
      .map((a) => ({...a, x: (a.x * width) / oldWidth, y: (a.y * height) / oldHeight}));
    while (stars.length < count)
      stars.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 5,
        vy: (Math.random() - 0.5) * 5,
        r: 0.7 + Math.random() * 0.8
      });
    draw(0);
  }
  function draw(dt) {
    ctx.clearRect(0, 0, width, height);
    const reach = width < 600 ? 150 : 200;
    for (const a of stars) {
      a.x = (a.x + a.vx * dt + width) % width;
      a.y = (a.y + a.vy * dt + height) % height;
    }
    for (let i = 0; i < stars.length; i++) {
      const a = stars[i];
      let links = 0;
      for (let j = i + 1; j < stars.length && links < 3; j++) {
        const b = stars[j],
          dx = a.x - b.x,
          dy = a.y - b.y,
          squared = dx * dx + dy * dy;
        if (squared >= reach * reach) continue;
        links++;
        ctx.strokeStyle = `rgba(156,187,226,${0.22 * (1 - Math.sqrt(squared) / reach)})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.fillStyle = '#b7cce7';
      ctx.beginPath();
      ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  function stop() {
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    last = 0;
  }
  function paused() {
    return (
      leaving ||
      document.hidden ||
      reduced.matches ||
      document.documentElement.dataset.perfEffect === 'background' ||
      scrolling ||
      document.querySelector('dialog[open]')
    );
  }
  function tick(time) {
    if (paused()) {
      stop();
      return;
    }
    const began = performance.now();
    draw(last ? Math.min((time - last) / 1000, 0.1) : 0);
    last = time;
    timer = setTimeout(
      () => {
        frame = requestAnimationFrame(tick);
      },
      Math.max(0, 1000 / (width <= 768 ? 20 : 24) - (performance.now() - began))
    );
  }
  function start() {
    stop();
    if (!paused()) frame = requestAnimationFrame(tick);
  }
  addEventListener(
    'resize',
    () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(resize, 150);
    },
    {passive: true}
  );
  addEventListener(
    'scroll',
    () => {
      scrolling = true;
      stop();
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrolling = false;
        start();
      }, 160);
    },
    {passive: true, capture: true}
  );
  const dialogs = new MutationObserver(start);
  dialogs.observe(document.body, {subtree: true, attributes: true, attributeFilter: ['open']});
  document.addEventListener('visibilitychange', start);
  reduced.addEventListener('change', start);
  addEventListener('pagehide', () => {
    leaving = true;
    stop();
    clearTimeout(resizeTimer);
    clearTimeout(scrollTimer);
    dialogs.disconnect();
  });
  addEventListener('pageshow', () => {
    leaving = scrolling = false;
    dialogs.observe(document.body, {subtree: true, attributes: true, attributeFilter: ['open']});
    start();
  });
  resize();
  start();
})();
