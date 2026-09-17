// NEXUS404 — flowmusic-keeper
//
// Зачем: chat/providers.ts в хабе умеет ТОЛЬКО дёргать Supabase
// refresh-эндпоинт руками (через impit — это просто подмена TLS/HTTP
// отпечатка на один запрос, не настоящий браузер). Если этот ручной
// refresh по какой-то причине не проходит (invalid_grant из-за уже
// использованного refresh_token, временный WAF-челлендж и т.п.) —
// сессия просто умирает, и это лечится только вставкой новой куки
// руками на flowmusic.app.
//
// Этот модуль держит НАСТОЯЩИЙ Chromium (через puppeteer-core, системный
// бинарник из Alpine) с одной открытой вкладкой на flowmusic.app.
// Пока вкладка жива, собственный JS-клиент Supabase на странице сам
// обновляет access_token заранее (со своим внутренним таймером, до
// истечения) — тот же механизм, что и у настоящего залогиненного
// пользователя в браузере. Мы просто читаем актуальную куку раз в
// SYNC_INTERVAL_MS и пересылаем её хабу — в том же сыром формате
// (JSON/base64, можно несколько строк для .0/.1 частей), который хаб
// уже умеет разбирать (parseFlowMusicSession в providers.ts), так что
// никакой декодинг тут не дублируется.
//
// НЕ ПРОВЕРЕНО ЖИВЫМ ЗАПУСКОМ (в песочнице нет сети до flowmusic.app) —
// главное узкое место: точное имя куки для затравки (COOKIE_NAME ниже).
// Хаб в комментариях к parseFlowMusicSession приводит как пример имя
// "sb-sb-auth-token" (apikey = поддомен sb.producer.ai = "sb"), отсюда
// и дефолт. Если у тебя в DevTools кука называется иначе — просто
// поставь FLOWMUSIC_COOKIE_NAME в docker-compose/окружении модуля,
// не редактируя код.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderPage } = require('./chrome.js');
const puppeteer = require('puppeteer-core');

const PORT = process.env.MODULE_PORT || 4007;
const HUB_HOST = process.env.HUB_HOST || 'hub';
const HUB_PORT = process.env.HUB_PORT || 3000;
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';

const DATA_DIR = process.env.DATA_DIR || '/app/data';
const PROFILE_DIR = path.join(DATA_DIR, 'chrome-profile'); // persistent bind-mount — переживает docker rm -f
const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser';
const FLOWMUSIC_URL = 'https://www.flowmusic.app/';
const COOKIE_NAME = process.env.FLOWMUSIC_COOKIE_NAME || 'sb-sb-auth-token';

const SYNC_INTERVAL_MS = 2 * 60 * 1000; // раз в 2 минуты — с запасом относительно часового TTL access_token
const STALE_AFTER_MS = 20 * 60 * 1000; // если 20 минут не было успешного sync — считаем сессию подвисшей
const ALERT_AFTER_FAILURES = 3; // 3 подряд неудачных sync (~6 минут) — тогда пуш, не раньше (не спамить на единичный сбой)

function requestHub(pathName, method = 'GET', jsonBody) {
  return new Promise((resolve, reject) => {
    const payload = jsonBody ? JSON.stringify(jsonBody) : undefined;
    const req = http.request(
      {
        host: HUB_HOST,
        port: HUB_PORT,
        path: pathName,
        method,
        headers: {
          'x-internal-token': HUB_INTERNAL_TOKEN,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- Состояние ----------

const state = {
  status: 'starting', // starting | needs_seed | ok | stale | error | logged_out
  lastSyncAt: null,
  lastError: null,
  consecutiveFailures: 0,
  alertSent: false,
};

let browser = null;
let page = null;

async function ensureDataDir() {
  await fs.mkdir(PROFILE_DIR, { recursive: true });
}

// ---------- Браузер ----------

async function launchBrowser() {
  await ensureDataDir();
  browser = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    userDataDir: PROFILE_DIR,
    args: [
      '--no-sandbox', // обязателен в контейнере без CAP_SYS_ADMIN
      '--disable-dev-shm-usage', // /dev/shm в контейнере обычно маленький (64МБ по умолчанию) — падает без этого флага
      '--disable-gpu',
    ],
  });
  page = await browser.newPage();
  browser.on('disconnected', () => {
    console.error('[flowmusic-keeper] браузер отключился неожиданно, перезапуск при следующем цикле sync');
    browser = null;
    page = null;
  });
  await page.goto(FLOWMUSIC_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
    console.error('[flowmusic-keeper] первичный переход на flowmusic.app не удался:', String(err));
  });
}

async function ensureBrowser() {
  if (browser && page && !page.isClosed()) return;
  await launchBrowser();
}

// ---------- Затравка (первый логин / замена протухшего профиля) ----------

async function seedSession(rawSeed) {
  await ensureBrowser();
  const parts = rawSeed
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new Error('пустое значение куки');

  const cookies =
    parts.length === 1
      ? [{ name: COOKIE_NAME, value: parts[0], domain: '.flowmusic.app', path: '/', httpOnly: false, secure: true }]
      : parts.map((value, i) => ({ name: `${COOKIE_NAME}.${i}`, value, domain: '.flowmusic.app', path: '/', httpOnly: false, secure: true }));

  await page.setCookie(...cookies);
  await page.goto(FLOWMUSIC_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
  // Затравка — расходный материал (тот же refresh_token одноразовый,
  // что и у хаба), больше не нужна и не должна валяться на диске.
  await fs.rm(SEED_FILE, { force: true });
}

const SEED_FILE = path.join(DATA_DIR, 'seed-cookie.txt');

// ---------- Синхронизация с хабом ----------

function groupAuthCookies(cookies) {
  const sb = cookies.filter((c) => c.name.includes('auth-token'));
  if (sb.length === 0) return null;
  // .0/.1/... части одной большой куки — сортируем по имени, чтобы .0
  // шла раньше .1 (та же логика, что в hub/providers.ts и в
  // @justmpm/flowmusic, откуда взят исходный контракт).
  sb.sort((a, b) => a.name.localeCompare(b.name));
  return sb;
}

async function syncOnce() {
  await ensureBrowser();
  const cookies = await page.cookies(FLOWMUSIC_URL);
  const group = groupAuthCookies(cookies);

  if (!group) {
    // Ни одной auth-куки — либо ещё не затравлен, либо разлогинило
    // (например, пользователь вручную вышел на flowmusic.app явным
    // логаутом — единственный случай, когда refresh_token инвалидируется
    // не по нашей вине, см. комментарий в providers.ts).
    state.status = 'needs_seed';
    return;
  }

  // Сырое значение в ТОМ ЖЕ формате, что хаб уже принимает при ручной
  // вставке (несколько строк — по одной на часть куки), декодинг делает
  // сам хаб (parseFlowMusicSession), тут не дублируем.
  const rawValue = group.map((c) => c.value).join('\n');

  const result = await requestHub('/internal/flowmusic-session', 'POST', { sessionRaw: rawValue });
  if (result.status !== 200) {
    throw new Error(`хаб отверг сессию (${result.status}): ${JSON.stringify(result.body)}`);
  }

  state.status = 'ok';
  state.lastSyncAt = new Date().toISOString();
  state.lastError = null;
  state.consecutiveFailures = 0;
  state.alertSent = false;
}

async function syncLoop() {
  try {
    await syncOnce();
  } catch (err) {
    state.consecutiveFailures += 1;
    state.lastError = String(err instanceof Error ? err.message : err);
    state.status = 'error';
    console.error('[flowmusic-keeper] sync не удался:', state.lastError);

    if (state.consecutiveFailures >= ALERT_AFTER_FAILURES && !state.alertSent) {
      state.alertSent = true;
      await requestHub('/internal/send-push', 'POST', {
        title: 'FlowMusic keeper',
        body: `Не удаётся обновить сессию FlowMusic ${state.consecutiveFailures} циклов подряд: ${state.lastError}. Возможно, нужна свежая кука на /modules/flowmusic-keeper/.`,
        tag: 'flowmusic-keeper',
      }).catch(() => {});
    }

    // Похоже, что сам браузер умер или потерял страницу — пересоздаём
    // при следующем цикле, не держим мёртвый процесс молча.
    if (!browser || !page || page.isClosed()) {
      browser = null;
      page = null;
    }
  }

  if (state.lastSyncAt && Date.now() - new Date(state.lastSyncAt).getTime() > STALE_AFTER_MS && state.status === 'ok') {
    state.status = 'stale';
  }
}

// ---------- HTTP ----------

const BODY_CONTENT = `
  <div class="card">
    <h2>Статус сессии</h2>
    <div id="statusBox" class="muted">загрузка…</div>
  </div>
  <div class="card">
    <h2>Затравка / замена куки</h2>
    <p class="muted" style="margin-bottom:10px;">
      Нужно один раз (или когда профиль браузера протух целиком — например,
      пароль на flowmusic.app сменился). Значение куки
      <code>${COOKIE_NAME}</code> с flowmusic.app, как есть — DevTools →
      Application → Cookies. Если кука разбита на части .0/.1 — вставь все
      части подряд, каждую с новой строки.
    </p>
    <textarea id="seedInput" rows="4" style="width:100%;" placeholder="значение куки..."></textarea>
    <button id="seedBtn" class="btn" style="margin-top:8px;">Сохранить и залогинить браузер</button>
    <div id="seedResult" class="muted" style="margin-top:8px;"></div>
  </div>
`;

const EXTRA_SCRIPT = `
  async function loadState() {
    const res = await fetch('/state');
    const s = await res.json();
    const box = document.getElementById('statusBox');
    const labels = {
      starting: 'запускается…',
      needs_seed: 'нужна затравка — вставь куку ниже',
      ok: 'сессия жива, автообновление работает',
      stale: 'давно не было успешного sync — проверь браузер',
      error: 'ошибка sync',
      logged_out: 'разлогинен на flowmusic.app',
    };
    box.innerHTML =
      '<b>' + (labels[s.status] || s.status) + '</b><br>' +
      'последний успешный sync: ' + (s.lastSyncAt || '—') + '<br>' +
      (s.lastError ? 'последняя ошибка: ' + s.lastError : '');
  }
  loadState();
  setInterval(loadState, 15000);

  document.getElementById('seedBtn').addEventListener('click', async () => {
    const value = document.getElementById('seedInput').value.trim();
    const result = document.getElementById('seedResult');
    if (!value) return;
    result.textContent = 'применяю...';
    try {
      const res = await fetch('/api/seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: value }),
      });
      const data = await res.json();
      result.textContent = res.ok ? 'готово' : ('ошибка: ' + (data.error || res.status));
      document.getElementById('seedInput').value = '';
      loadState();
    } catch (err) {
      result.textContent = 'сетевая ошибка: ' + err;
    }
  });
`;

const PAGE = renderPage({
  title: 'FlowMusic Keeper',
  username: process.env.AUTH_USER || 'user',
  bodyContent: BODY_CONTENT,
  extraScript: EXTRA_SCRIPT,
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE);
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', module: 'flowmusic-keeper', browserStatus: state.status }));
    return;
  }

  if (req.method === 'GET' && pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ module: 'flowmusic-keeper', ...state }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/seed') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const raw = String(parsed.raw || '').trim();
        if (!raw) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'raw обязателен' }));
          return;
        }
        await seedSession(raw);
        await syncOnce(); // сразу подтвердить, что хаб принял, не ждать 2 минуты
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'не удалось применить куку', details: String(err) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/restart-browser') {
    try {
      if (browser) await browser.close().catch(() => {});
    } finally {
      browser = null;
      page = null;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[flowmusic-keeper] модуль слушает порт ${PORT}, хаб на ${HUB_HOST}:${HUB_PORT}`);
});

// Первый sync — почти сразу (даёт время браузеру подняться), дальше по расписанию.
setTimeout(syncLoop, 10_000);
setInterval(syncLoop, SYNC_INTERVAL_MS);

process.on('SIGTERM', async () => {
  if (browser) await browser.close().catch(() => {});
  server.close(() => process.exit(0));
});
