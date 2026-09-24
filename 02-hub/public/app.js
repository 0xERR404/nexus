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
  summaryLoading = false;
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
      `${4 + (i * 272) / (values.length - 1)},${max === min ? 34 : 62 - ((v - min) / (max - min)) * 54}`
  );
  const area = document.createElementNS(ns, 'polygon');
  area.setAttribute('points', `4,70 ${points.join(' ')} 276,70`);
  area.setAttribute('class', 'spark-area');
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('points', points.join(' '));
  line.setAttribute('class', 'spark-line');
  svg.append(area, line);
  return svg;
}
window.nexusBalanceChart = balanceChart;
function renderSummary(node, data) {
  node.dataset.state = data?.state ?? 'stale';
  node.dataset.multiple = String((data?.items?.length ?? 0) > 1);
  if (!data || data.state === 'stale') {
    node.replaceChildren(element('span', 'Нет свежих данных', 'module-summary-note'));
    return;
  }
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
  if (node.dataset.summary === 'balance') {
    const chart = balanceChart(data.chart);
    if (chart)
      node.append(
        chart,
        element('span', `${data.chart.currency} · ${data.chart.month}`, 'spark-caption')
      );
  }
}
async function refreshSummaries() {
  clearTimeout(summaryTimer);
  if (document.hidden || summaryLoading || !summaries.length) return;
  summaryLoading = true;
  try {
    const response = await fetch('/api/modules', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000)
    });
    if (response.status === 401 || response.redirected) {
      location.replace('/login');
      return;
    }
    if (!response.ok) throw new Error('Unavailable');
    const data = await response.json();
    for (const node of summaries)
      renderSummary(
        node,
        data.modules.find((module) => module.id === node.dataset.summary)?.summary
      );
  } catch {
    for (const node of summaries) renderSummary(node, null);
  } finally {
    summaryLoading = false;
    if (!document.hidden) summaryTimer = setTimeout(refreshSummaries, 10000);
  }
}
if (summaries.length) {
  document.addEventListener('visibilitychange', refreshSummaries);
  addEventListener('online', refreshSummaries);
  addEventListener('offline', () => {
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
  history.back();
});
