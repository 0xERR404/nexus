// NEXUS404 — модуль "Оповещения" (notifications).
//
// Показывает журнал событий сервера (вход в систему, обновления,
// перезагрузки, проверки, очистка мусора — всё, что уже пишет
// event_hook.sh + сам хаб, см. hub/src/index.ts и install-hub-platform.sh
// шаг 2b) и позволяет включить push-уведомления на телефон — каждое
// событие отдельным уведомлением, не сводкой (решение пользователя).
//
// Два источника событий:
//  - Локальные (этот же сервер, где стоит хаб) — через хаб,
//    GET /internal/chat-usage-подобная ручка /internal/recent-events
//    (хаб уже читает свой EVENTS_LOG напрямую, модулю сам файл не нужен).
//  - Удалённые (другие сервера) — через агента, тот же принцип, что и у
//    модуля мониторинга: агент на удалённом сервере шлёт сюда события
//    HTTP-запросом с тем же токеном, что и для метрик (см. agent/agent.py).
//    Хранятся в собственной постоянной папке модуля, не в общем журнале
//    хаба — тот сам про другие сервера ничего не знает и не должен.
//
// Сама отправка push (VAPID, подписки браузеров) — целиком на стороне
// хаба (hub/src/push.ts) — модуль просит "разошли вот это" через
// /internal/send-push, ключи и подписки модулю не видны и не нужны.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderPage } = require('./chrome.js');

const PORT = process.env.MODULE_PORT || 4003;
const HUB_HOST = process.env.HUB_HOST || 'hub';
const HUB_PORT = process.env.HUB_PORT || 3000;
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';
const DATA_DIR = process.env.MODULE_DATA_DIR || '/app/data';
const REMOTE_EVENTS_FILE = path.join(DATA_DIR, 'remote-events.jsonl');
const CLEARED_BEFORE_FILE = path.join(DATA_DIR, 'cleared-before.txt');
const MAX_REMOTE_EVENTS_KEPT = 2000; // обрезаем файл, чтобы не расти бесконечно на личном масштабе использования

function requestHub(reqPath, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: HUB_HOST,
        port: HUB_PORT,
        path: reqPath,
        method,
        headers: {
          'x-internal-token': HUB_INTERNAL_TOKEN,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readRemoteEvents() {
  try {
    const raw = await fs.readFile(REMOTE_EVENTS_FILE, 'utf-8');
    return raw.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

async function appendRemoteEvent(entry) {
  await ensureDir();
  await fs.appendFile(REMOTE_EVENTS_FILE, JSON.stringify(entry) + '\n');
  // Раз в файл добавили — заодно проверим, не пора ли обрезать (не на
  // каждой записи считать длину всего файла ради экономии I/O было бы
  // излишне для личного масштаба использования — читаем всё равно каждый
  // раз при показе журнала, лишний проход тут не заметен).
  const all = await readRemoteEvents();
  if (all.length > MAX_REMOTE_EVENTS_KEPT) {
    const trimmed = all.slice(all.length - MAX_REMOTE_EVENTS_KEPT);
    await fs.writeFile(REMOTE_EVENTS_FILE, trimmed.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
}

// "Очистить журнал" — НЕ трогает сам events.jsonl хаба физическим
// удалением строк. Тот файл не только источник для этого модуля: по нему
// же считает позицию eventWatcher.ts (чекпоинт по числу строк — удаление
// строк задним числом сдвинуло бы всё и как минимум сбило бы push для
// ещё не отправленных событий), его же архивирует logrotate. Вместо
// этого — своя "точка отсечения": всё СТАРШЕ отметки времени просто не
// показываем в списке этого модуля. Честно и просто, ничего в общем
// журнале хаба не портит.
async function getClearedBefore() {
  try {
    const raw = await fs.readFile(CLEARED_BEFORE_FILE, 'utf-8');
    return raw.trim() || null;
  } catch {
    return null;
  }
}

async function setClearedBefore(iso) {
  await ensureDir();
  await fs.writeFile(CLEARED_BEFORE_FILE, iso);
}

// Категория/цвет по типу события — тот же список, что и у push-фильтра
// в hub/src/eventWatcher.ts (не буквально общий код — модуль на чистом
// JS, хаб на TypeScript, разные рантаймы — но один и тот же смысл,
// специально держим списки в согласии между собой при правках).
function classify(type) {
  if (type.startsWith('auth.login_failed')) return { label: 'вход', color: '#ef5350' };
  if (type.startsWith('auth.')) return { label: 'вход', color: '#b388ff' };
  // SSH — до общей проверки security.* ниже: успешный вход по SSH — это
  // нормальное, не тревожное событие (кто-то просто зашёл), красным
  // цветом общей категории "безопасность" выглядело бы как будто что-то
  // не так, хотя всё в порядке. Неудачная попытка — наоборот, ровно та
  // же тревожность, что и у остальной "безопасности".
  if (type === 'security.ssh.login_failed') return { label: 'вход по SSH', color: '#ef5350' };
  if (type === 'security.ssh.login_succeeded') return { label: 'вход по SSH', color: '#b388ff' };
  if (type.startsWith('security.')) return { label: 'безопасность', color: '#ef5350' };
  if (type.startsWith('deploy.update.failed')) return { label: 'обновление', color: '#ef5350' };
  if (type.startsWith('deploy.update.') || type.startsWith('system.update.')) return { label: 'обновление', color: '#b388ff' };
  if (type.startsWith('system.reboot.')) return { label: 'перезагрузка', color: '#ffcc66' };
  if (type.startsWith('system.healthcheck.')) return { label: 'проверка', color: '#66bb6a' };
  if (type.startsWith('system.cleanup.')) return { label: 'очистка', color: '#66bb6a' };
  if (type.startsWith('module.') || type.startsWith('hub.')) return { label: 'система', color: '#7a72a0' };
  return { label: 'прочее', color: '#7a72a0' };
}

// type — нужен, чтобы для конкретных типов событий (вход, fail2ban)
// собрать более понятный текст, чем просто перечисление полей из
// details "как есть" — та же логика, что и в hub/src/eventWatcher.ts для
// текста push-уведомлений (два разных рантайма, специально держим
// форматирование в согласии между собой при правках).
function detailsText(details, type) {
  if (type && type.startsWith('auth.')) {
    const username = (details && details.username) || 'не указан';
    const ip = (details && details.ip) || 'не определён';
    return 'Логин: ' + username + '. Адрес: ' + ip;
  }
  if (type === 'security.fail2ban.ban' || type === 'security.fail2ban.unban') {
    const text = typeof details === 'string' ? details : '';
    const ipMatch = text.match(/IP=(\S+)/);
    const jailMatch = text.match(/jail=(\S+)/);
    const ip = ipMatch ? ipMatch[1] : 'неизвестен';
    const jail = jailMatch ? jailMatch[1] : '';
    const service = jail === 'sshd' ? 'SSH' : (jail || 'неизвестный сервис');
    return type === 'security.fail2ban.ban'
      ? 'Слишком много неудачных попыток входа по ' + service + ', адрес: ' + ip
      : 'Блокировка снята, адрес: ' + ip + ' (' + service + ')';
  }
  if (type === 'security.ssh.login_succeeded' || type === 'security.ssh.login_failed') {
    // Bash-хук (deploy_kit_ssh_events.sh) пишет details строкой вида
    // "user=root ip=1.2.3.4 method=password" — тот же формат, что и у
    // fail2ban выше, свой парсер под свои поля.
    const text = typeof details === 'string' ? details : '';
    const userMatch = text.match(/user=(\S+)/);
    const ipMatch = text.match(/ip=(\S+)/);
    const user = userMatch ? userMatch[1] : 'не указан';
    const ip = ipMatch ? ipMatch[1] : 'не определён';
    return 'Логин: ' + user + '. Адрес: ' + ip;
  }
  if (typeof details === 'string') return details;
  if (details && typeof details === 'object') {
    const parts = [];
    if (details.username) parts.push('логин: ' + details.username);
    if (details.ip) parts.push('IP: ' + details.ip);
    for (const [k, v] of Object.entries(details)) {
      if (k === 'username' || k === 'ip') continue;
      parts.push(k + '=' + v);
    }
    return parts.join(', ');
  }
  return '';
}

// Собирает объединённый список: локальные события хаба (этот сервер) +
// удалённые (от агентов). Сортировка по времени, самые новые первыми.
// Точка отсечения (см. getClearedBefore) применяется здесь же — единое
// место фильтрации что для журнала, что для сводки на главной.
async function collectEvents(limit) {
  const [localRes, remote, clearedBefore] = await Promise.all([
    requestHub('/internal/recent-events?limit=' + limit),
    readRemoteEvents(),
    getClearedBefore(),
  ]);
  const local = (localRes.status === 200 ? localRes.body.events : []) || [];
  const localTagged = local.map((e) => ({ ...e, server: null }));
  const remoteTagged = remote.map((e) => ({ ...e, server: e.server || 'удалённый сервер' }));
  let merged = [...localTagged, ...remoteTagged];
  if (clearedBefore) {
    merged = merged.filter((e) => new Date(e.time).getTime() > new Date(clearedBefore).getTime());
  }
  merged.sort((a, b) => new Date(b.time) - new Date(a.time));
  return merged.slice(0, limit);
}

function isToday(iso) {
  try {
    const d = new Date(iso);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  } catch {
    return false;
  }
}

function isWarning(type, details) {
  if (type === 'security.ssh.login_succeeded') return false; // успешный вход — не тревога, несмотря на префикс security.
  if (type.includes('failed') || type.startsWith('security.')) return true;
  if (type === 'system.healthcheck.completed') {
    const text = detailsText(details, type);
    return /внимание|warning|failed_units=[1-9]/i.test(text);
  }
  return false;
}

async function collectSummary() {
  const events = await collectEvents(500);
  const today = events.filter((e) => isToday(e.time));
  const warnings = today.filter((e) => isWarning(e.type, e.details));
  const last = events[0] || null;
  const subRes = await requestHub('/internal/push-subscription-count');
  const subscriptions = subRes.status === 200 ? subRes.body.count : 0;
  return {
    eventsToday: today.length,
    warningsToday: warnings.length,
    subscriptions,
    lastEvent: last ? { type: last.type, time: last.time, label: classify(last.type).label } : null,
  };
}

const BODY_CONTENT = `
  <section>
    <div class="section-title">push-уведомления на этом устройстве</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="subDot"></span>
        <span id="subStatus">проверяю...</span>
        <button id="subToggleBtn" style="margin-left:auto;" disabled>...</button>
      </div>
      <div class="empty-note" style="margin-top:8px;">
        Каждое новое событие приходит отдельным уведомлением — вход в систему,
        обновления, перезагрузки, проверки сервера, очистка мусора. Включается
        отдельно на каждом устройстве/браузере.
      </div>
    </div>
  </section>

  <section>
    <div class="section-title">сегодня</div>
    <div class="box">
      <div class="stat-tiles-grid" style="border-top:none; padding-top:0;">
        <div class="stat-tile"><span class="stat-label">событий</span><span class="stat-value" id="sumEventsToday">—</span></div>
        <div class="stat-tile"><span class="stat-label">предупреждений</span><span class="stat-value" id="sumWarningsToday">—</span></div>
        <div class="stat-tile"><span class="stat-label">устройств подписано</span><span class="stat-value" id="sumSubscriptions">—</span></div>
        <div class="stat-tile"><span class="stat-label">последнее событие</span><span class="stat-value" id="sumLastEvent">—</span></div>
      </div>
    </div>
  </section>

  <section>
    <div class="events-header">
      <div class="section-title" style="margin-bottom:0;">журнал событий</div>
      <button class="icon-btn" id="clearEventsBtn" title="очистить журнал (скрыть все текущие записи)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        очистить
      </button>
    </div>
    <div class="box" id="eventsList">
      <div class="empty-note">загружаю...</div>
    </div>
  </section>
`;

const EXTRA_HEAD = `
  .events-header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
  .events-header .icon-btn { font-size: 0.75rem; gap: 6px; }
  .event-row { display: flex; align-items: baseline; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--line); font-family: var(--font-mono); font-size: 0.8rem; }
  .event-row:last-child { border-bottom: none; }
  .event-bar { width: 3px; align-self: stretch; border-radius: 2px; flex-shrink: 0; }
  .event-main { flex: 1; min-width: 0; }
  .event-type { font-weight: 700; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.4px; }
  .event-details { color: var(--muted); margin-top: 2px; word-break: break-word; }
  .event-server { color: var(--accent); }
  .event-time { color: var(--muted); font-size: 0.7rem; white-space: nowrap; flex-shrink: 0; }
  .stat-tiles-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
  .stat-tile { display: flex; flex-direction: column; gap: 2px; }
  .stat-tile .stat-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); font-family: var(--font-mono); }
  .stat-tile .stat-value { font-size: 0.95rem; font-weight: 700; color: var(--text); font-family: var(--font-mono); }
`;

const EXTRA_SCRIPT = `
  // urlBase64ToUint8Array — VAPID publicKey приходит base64url-строкой,
  // pushManager.subscribe() ждёт Uint8Array. Стандартное преобразование,
  // без него applicationServerKey просто не примется.
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function formatRelative(iso) {
    try {
      var diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
      if (diffSec < 60) return diffSec + 'с назад';
      if (diffSec < 3600) return Math.floor(diffSec / 60) + 'м назад';
      if (diffSec < 86400) return Math.floor(diffSec / 3600) + 'ч назад';
      return Math.floor(diffSec / 86400) + 'д назад';
    } catch { return ''; }
  }

  async function refreshSubscriptionStatus() {
    var dot = document.getElementById('subDot');
    var status = document.getElementById('subStatus');
    var btn = document.getElementById('subToggleBtn');

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      status.textContent = 'браузер не поддерживает push-уведомления';
      btn.style.display = 'none';
      return;
    }
    if (Notification.permission === 'denied') {
      dot.className = 'dot unset';
      status.textContent = 'уведомления запрещены в настройках браузера/телефона';
      btn.style.display = 'none';
      return;
    }

    try {
      var reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var existing = await reg.pushManager.getSubscription();
      btn.disabled = false;
      if (existing) {
        dot.className = 'dot set';
        status.textContent = 'включены на этом устройстве';
        btn.textContent = 'отключить';
        btn.onclick = async function () {
          btn.disabled = true;
          await fetch('/api/notifications/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: existing.endpoint }),
          });
          await existing.unsubscribe();
          refreshSubscriptionStatus();
        };
      } else {
        dot.className = 'dot unset';
        status.textContent = 'выключены на этом устройстве';
        btn.textContent = 'включить';
        btn.onclick = async function () {
          btn.disabled = true;
          try {
            var permission = await Notification.requestPermission();
            if (permission !== 'granted') {
              status.textContent = 'разрешение не выдано';
              btn.disabled = false;
              return;
            }
            var keyRes = await fetch('/api/notifications/vapid-public-key');
            var keyData = await keyRes.json();
            var sub = await reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
            });
            var subJson = sub.toJSON();
            await fetch('/api/notifications/subscribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(subJson),
            });
          } catch (err) {
            status.textContent = 'не удалось включить: ' + (err && err.message ? err.message : 'ошибка');
          }
          refreshSubscriptionStatus();
        };
      }
    } catch (err) {
      status.textContent = 'ошибка: ' + (err && err.message ? err.message : 'не удалось проверить статус');
    }
  }

  var TYPE_LABELS = {
    'auth.login_succeeded': 'вход выполнен', 'auth.login_failed': 'вход не удался',
    'deploy.update.completed': 'сервер обновился', 'deploy.update.failed': 'ошибка обновления',
    'system.update.completed': 'обновления безопасности', 'system.reboot.scheduled': 'перезагрузка запланирована',
    'system.reboot.completed': 'сервер перезагрузился', 'system.cleanup.completed': 'очистка мусора',
    'system.healthcheck.completed': 'проверка сервера', 'security.fail2ban.ban': 'IP заблокирован',
    'security.fail2ban.unban': 'IP разблокирован', 'hub.started': 'хаб запущен', 'hub.stopping': 'хаб остановлен',
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  async function refreshEvents() {
    try {
      var res = await fetch('api/events');
      var data = await res.json();
      var events = data.events || [];
      var list = document.getElementById('eventsList');
      if (events.length === 0) {
        list.innerHTML = '<div class="empty-note">событий пока нет</div>';
        return;
      }
      list.innerHTML = events.map(function (e) {
        var label = TYPE_LABELS[e.type] || e.type;
        var color = e.color || '#7a72a0';
        var details = e.detailsText || '';
        return '<div class="event-row">' +
          '<div class="event-bar" style="background:' + color + ';"></div>' +
          '<div class="event-main">' +
            '<div class="event-type" style="color:' + color + ';">' + escapeHtml(label) + (e.server ? ' <span class="event-server">· ' + escapeHtml(e.server) + '</span>' : '') + '</div>' +
            (details ? '<div class="event-details">' + escapeHtml(details) + '</div>' : '') +
          '</div>' +
          '<div class="event-time">' + formatRelative(e.time) + '</div>' +
        '</div>';
      }).join('');
    } catch {
      document.getElementById('eventsList').innerHTML = '<div class="empty-note">не удалось загрузить</div>';
    }
  }

  async function refreshSummary() {
    try {
      var res = await fetch('api/summary');
      var s = await res.json();
      document.getElementById('sumEventsToday').textContent = String(s.eventsToday);
      document.getElementById('sumWarningsToday').textContent = String(s.warningsToday);
      document.getElementById('sumSubscriptions').textContent = String(s.subscriptions);
      document.getElementById('sumLastEvent').textContent = s.lastEvent ? (TYPE_LABELS[s.lastEvent.type] || s.lastEvent.label) : '—';
    } catch {}
  }

  document.getElementById('clearEventsBtn').addEventListener('click', async function () {
    if (!confirm('Очистить журнал? Текущие записи скроются из списка здесь — сам системный журнал на сервере не трогается и не удаляется, посмотреть его целиком по-прежнему можно напрямую на сервере.')) return;
    var btn = document.getElementById('clearEventsBtn');
    btn.disabled = true;
    try {
      await fetch('api/clear-events', { method: 'POST' });
      await refreshEvents();
      await refreshSummary();
    } catch {}
    btn.disabled = false;
  });

  refreshSubscriptionStatus();
  refreshEvents();
  refreshSummary();
  setInterval(refreshEvents, 15000);
  setInterval(refreshSummary, 15000);
`;

const PAGE = renderPage({
  title: 'Оповещения',
  username: process.env.AUTH_USER || 'user',
  bodyContent: BODY_CONTENT,
  extraHead: EXTRA_HEAD,
  extraScript: EXTRA_SCRIPT,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', module: 'notifications' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ module: 'notifications' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/events') {
    try {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
      const events = (await collectEvents(limit)).map((e) => {
        const c = classify(e.type);
        return { type: e.type, time: e.time, server: e.server, label: c.label, color: c.color, detailsText: detailsText(e.details, e.type) };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ events }));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось получить события', details: String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/summary') {
    try {
      const summary = await collectSummary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось получить сводку', details: String(err) }));
    }
    return;
  }

  // POST /api/clear-events — "очистить журнал" в интерфейсе. Не трогает
  // events.jsonl хаба (см. врезку у getClearedBefore выше) — просто
  // отмечает точку отсечения, всё старше неё больше не попадает в
  // объединённый список. Обычная сессионная ручка (проходит через прокси
  // хаба с браузерной кукой) — токен агента тут ни при чём, это не про
  // удалённые сервера.
  if (req.method === 'POST' && pathname === '/api/clear-events') {
    try {
      await setClearedBefore(new Date().toISOString());
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось очистить', details: String(err) }));
    }
    return;
  }

  // POST /api/agent/report-event — то же, чем для метрик служит
  // /modules/monitoring/api/agent/report: удалённый сервер (через
  // расширенного agent.py) шлёт СВОЁ событие сюда. Тот же формат
  // авторизации, что и у мониторинга (Authorization: Bearer <токен>,
  // спрашиваем у хаба заново на каждый запрос, не кэшируем) — один и тот
  // же общий токен агента, что и у мониторинга, один агент репортит и
  // метрики, и события.
  if (req.method === 'POST' && pathname === '/api/agent/report-event') {
    const auth = req.headers['authorization'] || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';

    let expected;
    try {
      const tokenRes = await requestHub('/internal/monitoring-token');
      expected = tokenRes.body && tokenRes.body.token;
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось проверить токен через хаб' }));
      return;
    }
    if (!expected || !presented || presented !== expected) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'неверный или не заданный токен агента' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.server || !parsed.type) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'server и type обязательны' }));
          return;
        }
        const entry = {
          type: String(parsed.type),
          time: new Date().toISOString(),
          details: parsed.details ?? {},
          server: String(parsed.server).trim().slice(0, 64),
        };
        await appendRemoteEvent(entry);

        // Push шлём отсюда же (не ждём следующего опроса хаба — тот
        // читает только СВОЙ локальный журнал, о событиях с других
        // серверов в принципе не узнает никаким другим путём).
        const c = classify(entry.type);
        // Без tag — та же правка, что и в eventWatcher.ts на стороне хаба:
        // общий tag по типу события схлопывал бы несколько уведомлений
        // ОДНОГО типа подряд в одно, а нужно каждое отдельно.
        await requestHub('/internal/send-push', 'POST', {
          title: entry.server + ' — ' + c.label,
          body: detailsText(entry.details, entry.type) || entry.type,
        }).catch(() => {});

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'некорректное тело запроса', details: String(err) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[notifications] модуль слушает порт ${PORT}, хаб на ${HUB_HOST}:${HUB_PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
