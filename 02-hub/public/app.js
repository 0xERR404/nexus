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
function renderSummary(node, data) {
  node.dataset.state = data?.state ?? 'stale';
  if (!data || data.state === 'stale') {
    node.replaceChildren(element('span', 'Нет свежих данных', 'module-summary-note'));
    return;
  }
  const stats = document.createElement('div');
  stats.className = 'module-stats';
  for (const item of data.items) {
    const itemNode = document.createElement('div');
    itemNode.className = 'module-stat';
    itemNode.append(element('span', item.label), element('strong', item.value));
    stats.append(itemNode);
  }
  node.replaceChildren(stats);
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
