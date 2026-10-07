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
  document.addEventListener('play', () => {try{(window.parent.NexusWave||window.parent.parent.NexusWave)?.pause();}catch{}}, true);
}
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
  if (!data || !Array.isArray(data.items) || (!data.items.length && data.state==='stale')) {
    node.dataset.state = 'stale';
    node.removeAttribute('title');
    if (!summarySnapshots.has(node)) node.replaceChildren(element('span','Сводка пока не загружена','module-summary-note'));
    return;
  }
  const snapshot = JSON.stringify(data);
  node.dataset.state = metadata.stale ? 'stale' : data.state;
  node.removeAttribute('title');
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
  const emptyTitles = {anime:'Нет сохранённых аниме',trophies:'Нет сохранённых игр',wave:'Пока нет треков',gallery:'Пока нет изображений',articles:'Пока нет статей',projects:'Пока нет проектов',cinema:'Видеотека пуста'};
  const empty = emptyTitles[node.dataset.summary] && data.items.length && Number(data.items[0].value) === 0;
  if (empty || !data.items.length) {
    node.replaceChildren(element('p', empty ? emptyTitles[node.dataset.summary] : node.dataset.summary === 'balance' ? 'Добавь первый счёт' : 'Пока нет записей', 'home-empty'));
    node.dataset.multiple = 'false';
    summarySnapshots.set(node, snapshot);
    return;
  }
  node.dataset.multiple = String((data?.items?.length ?? 0) > 1);
  const stats = document.createElement('div');
  stats.className = 'module-stats';
  for (const item of data.items) {
    if (['DeepSeek','FlowMusic'].includes(item.label) || /^(Обновлено|Синхронизация|Сводка|Ошибка|Дата|Время обновления)$/.test(item.label)) continue;
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
    itemNode.append(element('strong', /^(нет данных|нет ключа|нет сессии|нужен вход|ошибка|не обновлено|недоступно)$/i.test(item.value) ? '—' : item.value));
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
      window.Nexus?.notice?.('hub','connection');
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

