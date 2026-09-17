// NEXUS404 — системный модуль
// Ключ DeepSeek + ключ Gemini + привилегированные действия через хаб +
// автообновление сессии FlowMusic реальным браузером (см. раздел
// "FlowMusic keeper" ниже — не отдельный модуль, чтобы не плодить ещё
// один Docker-образ с Chromium только ради одной фичи).

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderPage } = require('./chrome.js');
const puppeteer = require('puppeteer-core');

const PORT = process.env.MODULE_PORT || 4001;
const HUB_HOST = process.env.HUB_HOST || 'hub';
const HUB_PORT = process.env.HUB_PORT || 3000;
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';

function requestHub(urlPath, method = 'GET', jsonBody) {
    return new Promise((resolve, reject) => {
        const payload = jsonBody ? JSON.stringify(jsonBody) : undefined;
        const req = http.request(
            {
                host: HUB_HOST,
                port: HUB_PORT,
                path: urlPath,
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
                    try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                    catch { resolve({ status: res.statusCode, body }); }
                });
            }
        );
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

// ---------- FlowMusic keeper ----------
// Держит реальный Chromium (не подмену TLS-отпечатка, как impit в
// chat/providers.ts, а настоящую вкладку) залогиненным на flowmusic.app.
// Пока вкладка открыта, собственный JS-клиент Supabase на странице сам
// продлевает access_token заранее — тот же механизм, что у обычного
// пользователя, который просто держит сайт открытым. Раз в 2 минуты
// читаем актуальную сессию и передаём её хабу тем же способом, что и
// ручная вставка чуть ниже на этой же странице (saveFlowmusicKeyBtn) —
// через POST /internal/flowmusic-session, providers.ts разбирает сам,
// декодинг там не дублируется (тут декодим ЛОКАЛЬНО отдельно, но только
// чтобы сравнить свежесть cookie vs localStorage — см. decodeExpiresAt).
//
// Supabase-клиент flowmusic.app может держать актуальную сессию в
// cookie, в localStorage, или обновлять их не синхронно между собой —
// не проверено живым запросом, какой вариант на самом деле. Поэтому
// читаем ОБА источника каждый цикл и берём тот, у кого expires_at
// реально больше (decodeExpiresAt/readLocalStorageAuthToken ниже) —
// слать хабу заведомо более старое значение, даже если формально
// "успешно записалось", бессмысленно и маскирует реальную проблему:
// keeper бодро репортит "жива", а хаб получает уже израсходованный
// refresh_token и падает с invalid_grant при первом же реальном чате.

const KEEPER_DATA_DIR = process.env.DATA_DIR || '/app/data';
const KEEPER_PROFILE_DIR = path.join(KEEPER_DATA_DIR, 'flowmusic-chrome-profile'); // персистентный, переживает docker rm -f
const KEEPER_CHROMIUM_CANDIDATES = process.env.CHROMIUM_PATH
    ? [process.env.CHROMIUM_PATH]
    : ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/lib/chromium/chromium'];
const FLOWMUSIC_URL = 'https://www.flowmusic.app/';
// Имя куки для затравки не проверено живым запросом — дефолт по
// аналогии с providers.ts (apikey = поддомен sb.producer.ai = "sb").
// Если не подойдёт — можно в поле затравки указать явно "имя=значение"
// на отдельной строке, seedSession() тогда возьмёт имя из ввода, не
// угадывает.
const KEEPER_DEFAULT_COOKIE_NAME = process.env.FLOWMUSIC_COOKIE_NAME || 'sb-sb-auth-token';
const KEEPER_SYNC_INTERVAL_MS = 2 * 60 * 1000;
const KEEPER_STALE_AFTER_MS = 20 * 60 * 1000;
const KEEPER_ALERT_AFTER_FAILURES = 3;

const keeperState = {
    status: 'starting', // starting | needs_seed | ok | stale | error | logged_out
    lastSyncAt: null,
    lastSource: null, // 'cookie' | 'localStorage' — откуда реально взяли последнее переданное значение
    lastError: null,
    consecutiveFailures: 0,
    alertSent: false,
    seeding: false,
    seedError: null,
};

let keeperBrowser = null;
let keeperPage = null;
let keeperLaunchingPromise = null; // мьютекс: таймер и ручная затравка могут дёрнуть ensureKeeperBrowser() одновременно

async function resolveChromiumPath() {
    for (const candidate of KEEPER_CHROMIUM_CANDIDATES) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // пробуем следующий
        }
    }
    throw new Error(`Chromium не найден ни по одному из путей: ${KEEPER_CHROMIUM_CANDIDATES.join(', ')} — проверь 'which chromium' внутри контейнера и задай CHROMIUM_PATH вручную`);
}

// SingletonLock/SingletonSocket/SingletonCookie — механизм Chromium
// "один процесс на профиль". Профиль персистентный, процесс — нет: при
// нечистом убийстве контейнера (OOM, docker kill) лок остаётся висеть,
// новый Chromium видит "профиль занят другим компьютером". Раз мы вообще
// дошли до попытки запуска — живого процесса с этим профилем в этом
// контейнере нет (см. мьютекс ниже), снос лока всегда безопасен.
async function clearStaleSingletonLocks() {
    const names = ['SingletonLock', 'SingletonSocket', 'SingletonCookie'];
    await Promise.all(names.map((name) => fs.rm(path.join(KEEPER_PROFILE_DIR, name), { force: true }).catch(() => {})));
}

async function launchKeeperBrowser() {
    await fs.mkdir(KEEPER_PROFILE_DIR, { recursive: true });
    await clearStaleSingletonLocks();
    const executablePath = await resolveChromiumPath();
    keeperBrowser = await puppeteer.launch({
        executablePath,
        headless: true,
        userDataDir: KEEPER_PROFILE_DIR,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    keeperPage = await keeperBrowser.newPage();
    keeperBrowser.on('disconnected', () => {
        console.error('[technical/flowmusic-keeper] браузер отключился неожиданно, перезапуск при следующем цикле sync');
        keeperBrowser = null;
        keeperPage = null;
    });
    await keeperPage.goto(FLOWMUSIC_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
        console.error('[technical/flowmusic-keeper] первичный переход на flowmusic.app не удался:', String(err));
    });
}

async function ensureKeeperBrowser() {
    if (keeperBrowser && keeperPage && !keeperPage.isClosed()) return;
    if (keeperLaunchingPromise) return keeperLaunchingPromise;
    keeperLaunchingPromise = launchKeeperBrowser().finally(() => {
        keeperLaunchingPromise = null;
    });
    return keeperLaunchingPromise;
}

// Затравка принимает то же самое, что уже принимает ручное поле ниже на
// этой странице (одна строка или несколько подряд — части .0/.1), ЛИБО,
// если угаданное имя куки не подошло, строки вида "имя=значение" — тогда
// имя берётся из ввода, а не из KEEPER_DEFAULT_COOKIE_NAME.
//
// ВАЖНО: нельзя определять "это имя=значение" простым line.includes('=') —
// base64 почти всегда заканчивается паддингом "=" или "==", так что
// обычное (неявное) значение куки почти гарантированно тоже содержит "="
// и наивная проверка ошибочно резала бы его по первому "=", портя и имя,
// и значение. Вместо этого проверяем, что часть ДО "=" реально похожа на
// имя куки (только буквы/цифры/точки/дефисы/подчёркивания, разумная
// длина) — base64/JSON перед своим "=" на это не похожи почти никогда.
function tryParseExplicitCookieLine(line) {
    const idx = line.indexOf('=');
    if (idx <= 0) return null;
    const name = line.slice(0, idx).trim();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(name)) return null;
    return { name, value: line.slice(idx + 1).trim() };
}

async function seedKeeperSession(rawSeed) {
    await ensureKeeperBrowser();
    const lines = rawSeed.split('\n').map((s) => s.trim()).filter(Boolean);
    if (lines.length === 0) throw new Error('пустое значение куки');

    const explicitParsed = lines.map(tryParseExplicitCookieLine);
    const cookies = explicitParsed.every(Boolean)
        ? explicitParsed.map(({ name, value }) => ({ name, value, domain: '.flowmusic.app', path: '/', httpOnly: false, secure: true }))
        : lines.length === 1
        ? [{ name: KEEPER_DEFAULT_COOKIE_NAME, value: lines[0], domain: '.flowmusic.app', path: '/', httpOnly: false, secure: true }]
        : lines.map((value, i) => ({ name: `${KEEPER_DEFAULT_COOKIE_NAME}.${i}`, value, domain: '.flowmusic.app', path: '/', httpOnly: false, secure: true }));

    await keeperPage.setCookie(...cookies);
    await keeperPage.goto(FLOWMUSIC_URL, { waitUntil: 'networkidle2', timeout: 30_000 });
}

function groupAuthCookies(cookies) {
    const sb = cookies.filter((c) => c.name.includes('auth-token'));
    if (sb.length === 0) return null;
    sb.sort((a, b) => a.name.localeCompare(b.name));
    return sb;
}

// Отдельный класс ошибки — чтобы keeperSyncLoop мог поставить точный
// статус 'logged_out' вместо общего 'error', не теряя, ЧТО именно
// случилось (интерфейс уже показывает этот статус отдельной подписью).
class KeeperLoggedOutError extends Error {}

// Раскодировать expires_at из сырого значения (та же логика, что
// parseFlowMusicSession в hub/providers.ts: либо готовый JSON, либо
// одна/несколько base64-строк с опциональным префиксом "base64-").
// Нужно ЛОКАЛЬНО (не только в хабе), чтобы сравнить свежесть cookie
// против localStorage перед отправкой — иначе передавать более старое
// значение, даже когда есть более свежее, никакого смысла нет.
function decodeExpiresAt(raw) {
    if (!raw) return 0;
    const tryJson = (text) => {
        try {
            const data = JSON.parse(text);
            return typeof data.expires_at === 'number' ? data.expires_at : 0;
        } catch {
            return null;
        }
    };
    const direct = tryJson(raw.trim());
    if (direct !== null) return direct;
    try {
        const parts = raw.split('\n').map((s) => s.trim()).filter(Boolean).map((s) => s.replace(/^base64-/, ''));
        const decoded = Buffer.from(parts.join(''), 'base64').toString('utf-8');
        return tryJson(decoded) ?? 0;
    } catch {
        return 0;
    }
}

// Supabase-клиент flowmusic.app может обновлять сессию через
// localStorage, а не через cookie (или наоборот) — не проверено живым
// запросом, какой именно. Читаем оба источника и берём тот, у кого
// expires_at реально больше — передавать хабу заведомо устаревшее
// значение (даже если формально "успешно записалось") бессмысленно и
// именно так выглядела бы ситуация "keeper пишет 'жива', а чат всё
// равно получает invalid_grant" — протухший refresh_token из немного
// отставшего источника.
async function readLocalStorageAuthToken() {
    try {
        const entries = await keeperPage.evaluate(() => {
            const out = {};
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                out[k] = localStorage.getItem(k);
            }
            return out;
        });
        const key = Object.keys(entries).find((k) => k.includes('auth-token'));
        return key ? entries[key] : null;
    } catch {
        return null;
    }
}

async function keeperSyncOnce() {
    await ensureKeeperBrowser();
    const cookies = await keeperPage.cookies(FLOWMUSIC_URL);
    const group = groupAuthCookies(cookies);
    const cookieRaw = group ? group.map((c) => c.value).join('\n') : null;
    const storageRaw = await readLocalStorageAuthToken();

    if (!cookieRaw && !storageRaw) {
        // Ни разу ещё не заводили сессию — это ожидаемое состояние, не
        // ошибка, алертить не о чем.
        if (keeperState.lastSyncAt === null) {
            keeperState.status = 'needs_seed';
            return;
        }
        // А вот если раньше всё работало (lastSyncAt уже был), а оба
        // источника вдруг опустели — это реальный сбой (разлогинило на
        // flowmusic.app явно или профиль стёрло), должен считаться в
        // consecutiveFailures и в итоге дойти до пуш-алерта.
        throw new KeeperLoggedOutError('и кука, и localStorage сессии пусты — похоже, разлогинило на flowmusic.app');
    }

    const cookieExpiresAt = decodeExpiresAt(cookieRaw);
    const storageExpiresAt = decodeExpiresAt(storageRaw);
    const useStorage = storageExpiresAt > cookieExpiresAt;
    const rawValue = useStorage ? storageRaw : (cookieRaw ?? storageRaw);
    keeperState.lastSource = useStorage ? 'localStorage' : 'cookie';

    const result = await requestHub('/internal/flowmusic-session', 'POST', { sessionRaw: rawValue });
    if (result.status !== 200) {
        throw new Error(`хаб отверг сессию (${result.status}): ${JSON.stringify(result.body)}`);
    }

    keeperState.status = 'ok';
    keeperState.lastSyncAt = new Date().toISOString();
    keeperState.lastError = null;
    keeperState.consecutiveFailures = 0;
    keeperState.alertSent = false;
}

async function keeperSyncLoop() {
    try {
        await keeperSyncOnce();
    } catch (err) {
        keeperState.consecutiveFailures += 1;
        keeperState.lastError = String(err instanceof Error ? err.message : err);
        keeperState.status = err instanceof KeeperLoggedOutError ? 'logged_out' : 'error';
        console.error('[technical/flowmusic-keeper] sync не удался:', keeperState.lastError);

        if (keeperState.consecutiveFailures >= KEEPER_ALERT_AFTER_FAILURES && !keeperState.alertSent) {
            keeperState.alertSent = true;
            await requestHub('/internal/send-push', 'POST', {
                title: 'FlowMusic keeper',
                body: `Не удаётся обновить сессию FlowMusic ${keeperState.consecutiveFailures} циклов подряд: ${keeperState.lastError}. Зайди в AI API → FlowMusic и проверь/обнови затравку.`,
                tag: 'flowmusic-keeper',
            }).catch(() => {});
        }

        if (!keeperBrowser || !keeperPage || keeperPage.isClosed()) {
            keeperBrowser = null;
            keeperPage = null;
        }
    }

    if (keeperState.lastSyncAt && Date.now() - new Date(keeperState.lastSyncAt).getTime() > KEEPER_STALE_AFTER_MS && keeperState.status === 'ok') {
        keeperState.status = 'stale';
    }
}


// Модалка входа через Steam (пароль или QR) — тот же визуальный
// принцип, что overlay-модалки в CheevoScope (не переиспользуется
// напрямую, у этого модуля своя копия chrome.js/своя страница, но
// минимальный набор классов ради консистентности стиля).
const EXTRA_HEAD = `
  .steam-login-overlay { display: none; position: fixed; inset: 0; background: rgba(3,5,9,0.72); align-items: center; justify-content: center; z-index: 100; padding: 20px 16px; }
  .steam-login-overlay.show { display: flex; }
  .steam-login-box { background: var(--bg); border: 1px solid rgba(179,136,255,0.3); border-radius: 14px; width: 100%; max-width: 380px; padding: 20px 22px 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.6); text-align: center; }
  .steam-login-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .steam-login-head h3 { font-family: var(--font-sans); font-size: 16px; font-weight: 700; color: var(--text); margin: 0; }
  .steam-login-close { background: rgba(179,136,255,0.08); border: 1px solid rgba(179,136,255,0.3); color: var(--text); border-radius: 8px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
  .steam-login-close:hover { border-color: var(--accent); }
  .steam-login-tabs { display: flex; gap: 8px; margin-bottom: 14px; }
  .steam-login-tab { flex: 1; background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 6px; padding: 7px; cursor: pointer; font-family: var(--font-mono); font-size: 0.82rem; }
  .steam-login-tab.active { border-color: var(--accent); color: var(--accent); background: rgba(179,136,255,0.08); }
  .steam-login-field { width: 100%; box-sizing: border-box; background: rgba(255,255,255,0.03); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; color: var(--text); font-family: var(--font-mono); font-size: 0.85rem; margin-bottom: 10px; }
  .steam-login-field:focus { outline: none; border-color: var(--accent); }
  .steam-login-submit { width: 100%; background: rgba(179,136,255,0.15); border: 1px solid var(--accent); color: var(--accent); border-radius: 6px; padding: 8px; cursor: pointer; font-family: var(--font-mono); font-size: 0.85rem; }
  .steam-login-submit:hover { background: rgba(179,136,255,0.25); }
  .steam-login-status-line { font-size: 0.8rem; color: var(--accent); margin-top: 10px; font-family: var(--font-mono); }
  .steam-login-error { font-size: 0.8rem; color: var(--red); margin-top: 10px; font-family: var(--font-mono); }
  .steam-login-success { font-size: 0.85rem; color: var(--green); font-family: var(--font-mono); }
  .steam-login-qr-img { width: 200px; height: 200px; border-radius: 10px; margin: 4px auto 12px; display: block; background: #fff; padding: 8px; }
`;

const BODY_CONTENT = `
  <section>
    <div class="section-title">deepseek — ключ api</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="deepseekDot"></span>
        <input type="password" id="deepseekKeyInput" placeholder="DeepSeek API-ключ" autocomplete="off" />
        <button class="icon-btn" id="saveDeepseekKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
    </div>
  </section>

  <section>
    <div class="section-title">gemini — ключ api (текстовый чат)</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="geminiDot"></span>
        <input type="password" id="geminiKeyInput" placeholder="Gemini API-ключ" autocomplete="off" />
        <button class="icon-btn" id="saveGeminiKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="geminiBaseUrlDot"></span>
        <input type="text" id="geminiBaseUrlInput" placeholder="Свой адрес вместо Google (необязательно) — например https://your-worker.workers.dev/v1beta" autocomplete="off" />
        <button class="icon-btn" id="saveGeminiBaseUrlBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">
        выбирается прямо над чатом, отдельно на каждое сообщение. Второе поле —
        не ключ, а базовый адрес запроса: пусто — идём напрямую в Google,
        задано — идём туда (например, свой Cloudflare Worker-прокси, если
        напрямую до Google сеть не достаёт). Обязательно с "/v1beta" на
        конце — так же, как выглядел бы прямой адрес без прокси.
      </div>
    </div>
  </section>

  <section>
    <div class="section-title">flowmusic — токен сессии (генерация музыки)</div>
    <div class="box">
      <div class="row" style="align-items:flex-start;">
        <span class="dot unset" id="flowmusicDot" style="margin-top:9px;"></span>
        <textarea id="flowmusicKeyInput" rows="3" style="flex:1; min-width:0; margin-top:0;"
          placeholder="Токен сессии FlowMusic — одна строка (одна кука) или несколько строк подряд, если Supabase разбил её на части (.0, .1, ... — по одной части на строку, по порядку)"
          autocomplete="off"></textarea>
        <button class="icon-btn" id="saveFlowmusicKeyBtn" title="сохранить" style="margin-top:9px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="flowmusicBaseUrlDot"></span>
        <input type="text" id="flowmusicBaseUrlInput" placeholder="Свой адрес вместо flowmusic.app (необязательно)" autocomplete="off" />
        <button class="icon-btn" id="saveFlowmusicBaseUrlBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">
        У FlowMusic нет официального API — вместо ключа нужен токен браузерной
        сессии. На flowmusic.app, залогинившись, открой DevTools → Application →
        Cookies, найди куку "sb-...-auth-token" и вставь её значение как есть
        (можно с префиксом "base64-" — обрежется сам). <strong>Если значение
        длинное, Supabase может разбить его на несколько кук подряд — "sb-...
        -auth-token.0", ".1" и так далее</strong> (у браузера есть предел
        размера одной куки, обычный размер сессии его превышает) — в этом
        случае вставь ВСЕ части, по одной на строку, в порядке .0, .1, ... —
        поле ниже принимает и то, и другое. Внутри —
        access_token/refresh_token/expires_at: access_token живёт около часа,
        но обновляется автоматически по refresh_token, пока не разлогинишься
        на самом flowmusic.app. Выбирается прямо над чатом, отдельно на каждое
        сообщение — отвечает аудио, не текстом. Второе поле — не ключ, а
        базовый адрес запроса, пусто = адрес по умолчанию.
      </div>
    </div>
  </section>

  <section>
    <div class="section-title">flowmusic — автообновление сессии (браузер)</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="keeperDot"></span>
        <span id="keeperStatusText" style="flex:1;color:var(--muted);font-size:13px;">загрузка…</span>
      </div>
      <div class="row" style="align-items:flex-start;margin-top:8px;">
        <textarea id="keeperSeedInput" rows="3" style="flex:1; min-width:0;"
          placeholder="Затравка (нужно один раз) — то же значение куки, что и в поле выше. Если после сохранения статус не переходит в 'жива' — впиши явно 'имя=значение' на строке"
          autocomplete="off"></textarea>
        <button class="icon-btn" id="keeperSeedBtn" title="запустить браузер с этой сессией" style="margin-top:9px;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">
        Держит настоящий Chromium залогиненным на flowmusic.app — пока вкладка
        открыта, сайт сам продлевает access_token, модуль раз в 2 минуты сам
        обновляет тот же ключ, что и поле «flowmusic — токен сессии» выше
        (точка у того поля станет зелёной, само поле не заполняется — оно
        write-only и не показывает сохранённое значение повторно). Ручной ввод
        там остаётся рабочим как есть — фолбэк на случай, если браузерный
        путь не завёлся.
      </div>
    </div>
  </section>

  <section>
    <div class="section-title">claude — ключ api (anthropic)</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="claudeDot"></span>
        <input type="password" id="claudeKeyInput" placeholder="Claude API-ключ" autocomplete="off" />
        <button class="icon-btn" id="saveClaudeKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="claudeBaseUrlDot"></span>
        <input type="text" id="claudeBaseUrlInput" placeholder="Свой адрес вместо api.anthropic.com (необязательно)" autocomplete="off" />
        <button class="icon-btn" id="saveClaudeBaseUrlBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">выбирается прямо над чатом, отдельно на каждое сообщение — модель задаётся переменной CHAT_CLAUDE_MODEL на сервере, баланс через API не отдаётся (только токены). Второе поле — не ключ, а базовый адрес запроса, пусто = адрес по умолчанию</div>
    </div>
  </section>

  <section>
    <div class="section-title">мониторинг — общий токен агентов</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="monitoringDot"></span>
        <button class="icon-btn" id="generateMonitoringTokenBtn" title="сгенерировать">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2v6h-6"></path><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M3 22v-6h6"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path></svg>
        </button>
        <input type="text" id="monitoringKeyInput" placeholder="сгенерируй или вставь свой" autocomplete="off" />
        <button class="icon-btn" id="saveMonitoringKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">этим же токеном должен представляться агент на каждом удалённом сервере — скопируй сразу после сохранения, второй раз хаб его не покажет</div>
    </div>
  </section>

  <section>
    <div class="section-title">cheevoscope — steam / retroachievements</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="steamApiKeyDot"></span>
        <input type="password" id="steamApiKeyInput" placeholder="Steam API-ключ (steamcommunity.com/dev/apikey)" autocomplete="off" />
        <button class="icon-btn" id="saveSteamApiKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="steamLoginDot"></span>
        <span id="steamLoginText" style="flex:1;color:var(--muted);font-size:13px;">Вход через Steam: не выполнен</span>
        <button class="icon-btn" id="openSteamLoginBtn" title="войти через Steam">Войти</button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="raUsernameDot"></span>
        <input type="text" id="raUsernameInput" placeholder="Логин на retroachievements.org (необязательно)" autocomplete="off" />
        <button class="icon-btn" id="saveRaUsernameBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="raApiKeyDot"></span>
        <input type="password" id="raApiKeyInput" placeholder="RA API-ключ (Settings → Keys, необязательно)" autocomplete="off" />
        <button class="icon-btn" id="saveRaApiKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">Steam API-ключ обязателен для вкладки Steam — без него дашборд работает, та вкладка просто пустая. SteamID отдельно вводить не нужно — берётся автоматически из входа через Steam (кнопка «Войти» выше).</div>
    </div>
  </section>

  <div class="steam-login-overlay" id="steamLoginOverlay">
    <div class="steam-login-box">
      <div class="steam-login-head">
        <h3>Вход через Steam</h3>
        <button class="steam-login-close" id="steamLoginCloseBtn" aria-label="Закрыть">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div class="steam-login-tabs">
        <button class="steam-login-tab active" id="steamLoginTabPassword">Пароль</button>
        <button class="steam-login-tab" id="steamLoginTabQr">QR-код</button>
      </div>
      <div id="steamLoginBody"></div>
    </div>
  </div>
`;

const EXTRA_SCRIPT = `
  async function loadKeyStatus() {
    try {
      const res = await fetch('/api/settings/keys');
      const data = await res.json();
      document.getElementById('deepseekDot').className = 'dot ' + (data.deepseek ? 'set' : 'unset');
      document.getElementById('geminiDot').className = 'dot ' + (data.gemini ? 'set' : 'unset');
      document.getElementById('geminiBaseUrlDot').className = 'dot ' + (data.geminiBaseUrl ? 'set' : 'unset');
      document.getElementById('flowmusicDot').className = 'dot ' + (data.flowmusic ? 'set' : 'unset');
      document.getElementById('flowmusicBaseUrlDot').className = 'dot ' + (data.flowmusicBaseUrl ? 'set' : 'unset');
      document.getElementById('claudeDot').className = 'dot ' + (data.claude ? 'set' : 'unset');
      document.getElementById('claudeBaseUrlDot').className = 'dot ' + (data.claudeBaseUrl ? 'set' : 'unset');
      document.getElementById('monitoringDot').className = 'dot ' + (data.monitoringAgentToken ? 'set' : 'unset');
      document.getElementById('steamApiKeyDot').className = 'dot ' + (data.steamApiKey ? 'set' : 'unset');
      document.getElementById('raUsernameDot').className = 'dot ' + (data.raUsername ? 'set' : 'unset');
      document.getElementById('raApiKeyDot').className = 'dot ' + (data.raApiKey ? 'set' : 'unset');
    } catch {}
  }
  loadKeyStatus();

  // FlowMusic keeper — статус браузерной сессии + затравка.
  async function loadKeeperState() {
    try {
      const res = await fetch('keeper-state');
      const s = await res.json();
      const labels = {
        starting: 'запускается…',
        needs_seed: 'нужна затравка — вставь куку ниже',
        ok: 'жива, автообновление работает',
        stale: 'давно не было успешного sync — проверь браузер',
        error: 'ошибка sync',
        logged_out: 'разлогинен на flowmusic.app',
      };
      const dot = document.getElementById('keeperDot');
      dot.className = 'dot ' + (s.status === 'ok' ? 'set' : 'unset');
      const text = document.getElementById('keeperStatusText');
      text.textContent =
        (s.seeding ? 'затравка выполняется… ' : '') +
        (labels[s.status] || s.status) +
        (s.lastSyncAt ? ' · последний sync: ' + s.lastSyncAt : '') +
        (s.lastSource ? ' · источник: ' + s.lastSource : '') +
        (s.lastError ? ' · ошибка sync: ' + s.lastError : '') +
        (s.seedError ? ' · ошибка затравки: ' + s.seedError : '');
    } catch {}
  }
  loadKeeperState();
  setInterval(loadKeeperState, 15000);

  document.getElementById('keeperSeedBtn').addEventListener('click', async () => {
    const input = document.getElementById('keeperSeedInput');
    const value = input.value.trim();
    if (!value) return;
    document.getElementById('keeperStatusText').textContent = 'запускаю браузер...';
    try {
      const res = await fetch('keeper-seed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: value }),
      });
      if (res.status === 202) {
        input.value = '';
      }
      loadKeeperState();
    } catch {}
  });

  // Вход через Steam дёргает уже готовый бэкенд в cheevoscope (там живут
  // steam-user/steam-session) — хаб реверс-проксирует одинаково с любой
  // страницы. Пароль/логин здесь не сохраняются, уходят одним POST.
  function escapeHtml(str){
    return String(str).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  const CHEEVO_BASE = '/modules/cheevoscope';
  let steamLoginActiveTab = 'password';
  let steamQrPollTimer = null;
  let steamPendingCodeId = null;

  async function loadSteamLoginStatus(){
    try{
      const res = await fetch(CHEEVO_BASE + '/api/steam-login-status');
      const data = await res.json();
      const dot = document.getElementById('steamLoginDot');
      const text = document.getElementById('steamLoginText');
      if(data.loggedIn){
        dot.className = 'dot set';
        text.textContent = 'Вход через Steam: выполнен (SteamID ' + data.steamID + ')';
      } else {
        dot.className = 'dot unset';
        text.textContent = 'Вход через Steam: не выполнен';
      }
    }catch{
      // Модуль cheevoscope временно недоступен (перезапускается и т.п.)
      // — не считаем это ошибкой входа, просто молчим до следующего
      // обновления статуса.
    }
  }
  loadSteamLoginStatus();

  function renderPasswordTab(){
    document.getElementById('steamLoginBody').innerHTML = \`
      <input type="text" class="steam-login-field" id="steamLoginAccountName" placeholder="Steam-логин (accountName)" autocomplete="off" />
      <input type="password" class="steam-login-field" id="steamLoginPassword" placeholder="Пароль" autocomplete="off" />
      <button class="steam-login-submit" id="steamLoginPasswordSubmit">Войти</button>
      <div id="steamLoginPasswordMsg"></div>
    \`;
    document.getElementById('steamLoginPasswordSubmit').addEventListener('click', submitPasswordLogin);
  }

  async function submitPasswordLogin(){
    const accountName = document.getElementById('steamLoginAccountName').value.trim();
    const password = document.getElementById('steamLoginPassword').value;
    const msg = document.getElementById('steamLoginPasswordMsg');
    if(!accountName || !password){
      msg.innerHTML = '<div class="steam-login-error">Заполни логин и пароль</div>';
      return;
    }
    msg.innerHTML = '<div class="steam-login-status-line">Проверяю…</div>';
    let result;
    try{
      const res = await fetch(CHEEVO_BASE + '/api/steam-password-login/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountName, password }),
      });
      result = await res.json();
    }catch(e){
      msg.innerHTML = '<div class="steam-login-error">Сеть: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    handlePasswordLoginResult(result);
  }

  function handlePasswordLoginResult(result){
    const msg = document.getElementById('steamLoginPasswordMsg');
    if(result.status === 'authenticated'){
      document.getElementById('steamLoginBody').innerHTML = '<div class="steam-login-success">✅ Вход выполнен (SteamID ' + escapeHtml(result.steamID) + ')</div>';
      loadSteamLoginStatus();
      return;
    }
    if(result.status === 'needs_code'){
      steamPendingCodeId = result.id;
      const where = result.codeType === 'email' ? 'на почту' : 'в приложении Steam Guard/по SMS';
      document.getElementById('steamLoginBody').innerHTML = \`
        <div style="font-size:0.82rem;color:var(--muted);margin-bottom:10px;">Код подтверждения отправлен \${where}\${result.wrongCode ? ' (предыдущий код не подошёл, попробуй ещё раз)' : ''}.</div>
        <input type="text" class="steam-login-field" id="steamLoginCode" placeholder="Код Steam Guard" autocomplete="off" />
        <button class="steam-login-submit" id="steamLoginCodeSubmit">Подтвердить</button>
        <div id="steamLoginCodeMsg"></div>
      \`;
      document.getElementById('steamLoginCodeSubmit').addEventListener('click', submitLoginCode);
      return;
    }
    msg.innerHTML = '<div class="steam-login-error">⚠ ' + escapeHtml(result.error || 'Не удалось войти') + '</div>';
  }

  async function submitLoginCode(){
    const code = document.getElementById('steamLoginCode').value.trim();
    const msg = document.getElementById('steamLoginCodeMsg');
    if(!code){ msg.innerHTML = '<div class="steam-login-error">Введи код</div>'; return; }
    msg.innerHTML = '<div class="steam-login-status-line">Проверяю…</div>';
    let result;
    try{
      const res = await fetch(CHEEVO_BASE + '/api/steam-password-login/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: steamPendingCodeId, code }),
      });
      result = await res.json();
    }catch(e){
      msg.innerHTML = '<div class="steam-login-error">Сеть: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    handlePasswordLoginResult(result);
  }

  function renderQrTab(){
    document.getElementById('steamLoginBody').innerHTML = '<button class="steam-login-submit" id="steamQrStartBtn">Получить QR-код</button>';
    document.getElementById('steamQrStartBtn').addEventListener('click', startQrLogin);
  }

  async function startQrLogin(){
    const body = document.getElementById('steamLoginBody');
    body.innerHTML = '<div class="steam-login-status-line">Запрашиваю QR-код…</div>';
    let startResult;
    try{
      const res = await fetch(CHEEVO_BASE + '/api/steam-qr-login/start', { method: 'POST' });
      startResult = await res.json();
      if(!res.ok || startResult.error) throw new Error(startResult.error || ('HTTP ' + res.status));
    }catch(e){
      body.innerHTML = '<div class="steam-login-error">Не удалось получить QR-код: ' + escapeHtml(e.message) + '</div>';
      return;
    }
    body.innerHTML = \`
      <img src="\${startResult.qrCodeDataUrl}" alt="QR-код входа в Steam" class="steam-login-qr-img">
      <div style="font-size:0.8rem;color:var(--muted);margin-bottom:8px;">Отсканируй мобильным приложением Steam и подтверди вход там же.</div>
      <div class="steam-login-status-line" id="steamQrStatusLine">Ожидаю сканирование…</div>
    \`;
    const statusLine = document.getElementById('steamQrStatusLine');
    const id = startResult.id;
    clearInterval(steamQrPollTimer);
    steamQrPollTimer = setInterval(async () => {
      let statusResult;
      try{
        const res = await fetch(CHEEVO_BASE + '/api/steam-qr-login/status?id=' + encodeURIComponent(id));
        statusResult = await res.json();
      }catch{
        return;
      }
      if(statusResult.status === 'scanned'){
        statusLine.textContent = 'QR отсканирован — подтверди вход в приложении на телефоне…';
      } else if(statusResult.status === 'authenticated'){
        clearInterval(steamQrPollTimer);
        body.innerHTML = '<div class="steam-login-success">✅ Вход выполнен (SteamID ' + escapeHtml(statusResult.steamID) + ')</div>';
        loadSteamLoginStatus();
      } else if(statusResult.status === 'error'){
        clearInterval(steamQrPollTimer);
        body.innerHTML = '<div class="steam-login-error">⚠ ' + escapeHtml(statusResult.error || 'Не удалось войти') + '</div>';
      }
    }, 2000);
  }

  function switchSteamLoginTab(tab){
    steamLoginActiveTab = tab;
    document.getElementById('steamLoginTabPassword').classList.toggle('active', tab === 'password');
    document.getElementById('steamLoginTabQr').classList.toggle('active', tab === 'qr');
    clearInterval(steamQrPollTimer);
    if(tab === 'password') renderPasswordTab(); else renderQrTab();
  }

  function openSteamLoginModal(){
    document.getElementById('steamLoginOverlay').classList.add('show');
    switchSteamLoginTab('password');
  }
  function closeSteamLoginModal(){
    clearInterval(steamQrPollTimer);
    document.getElementById('steamLoginOverlay').classList.remove('show');
  }

  document.getElementById('openSteamLoginBtn').addEventListener('click', openSteamLoginModal);
  document.getElementById('steamLoginCloseBtn').addEventListener('click', closeSteamLoginModal);
  document.getElementById('steamLoginOverlay').addEventListener('click', (e) => { if(e.target === e.currentTarget) closeSteamLoginModal(); });
  document.getElementById('steamLoginTabPassword').addEventListener('click', () => switchSteamLoginTab('password'));
  document.getElementById('steamLoginTabQr').addEventListener('click', () => switchSteamLoginTab('qr'));

  document.getElementById('saveDeepseekKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('deepseekKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deepseek: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  document.getElementById('saveGeminiKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('geminiKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gemini: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  // Пустое поле сохраняется как есть — единственный способ вернуться к
  // адресу по умолчанию после того, как воркер стал не нужен.
  document.getElementById('saveGeminiBaseUrlBtn').addEventListener('click', async () => {
    const input = document.getElementById('geminiBaseUrlInput');
    const value = input.value.trim();
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geminiBaseUrl: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  document.getElementById('saveFlowmusicKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('flowmusicKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowmusic: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  document.getElementById('saveFlowmusicBaseUrlBtn').addEventListener('click', async () => {
    const input = document.getElementById('flowmusicBaseUrlInput');
    const value = input.value.trim();
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flowmusicBaseUrl: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  document.getElementById('saveClaudeKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('claudeKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claude: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  document.getElementById('saveClaudeBaseUrlBtn').addEventListener('click', async () => {
    const input = document.getElementById('claudeBaseUrlInput');
    const value = input.value.trim();
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claudeBaseUrl: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  // Токен придумывает сам браузер — свой секрет для конфига агента на
  // удалённых серверах, не внешний ключ. Текстовое поле, не очищается
  // после сохранения (единственный шанс его увидеть).
  document.getElementById('generateMonitoringTokenBtn').addEventListener('click', () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    document.getElementById('monitoringKeyInput').value = token;
  });

  document.getElementById('saveMonitoringKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('monitoringKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitoringAgentToken: value }),
    });
    loadKeyStatus();
  });

  document.getElementById('saveSteamApiKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('steamApiKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamApiKey: value }),
    });
    input.value = '';
    loadKeyStatus();
  });

  document.getElementById('saveRaUsernameBtn').addEventListener('click', async () => {
    const input = document.getElementById('raUsernameInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raUsername: value }),
    });
    loadKeyStatus();
  });

  document.getElementById('saveRaApiKeyBtn').addEventListener('click', async () => {
    const input = document.getElementById('raApiKeyInput');
    const value = input.value.trim();
    if (!value) return;
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raApiKey: value }),
    });
    input.value = '';
    loadKeyStatus();
  });
`;

const PAGE = renderPage({
    title: 'AI API',
    username: process.env.AUTH_USER || 'user',
    extraHead: EXTRA_HEAD,
    bodyContent: BODY_CONTENT,
    extraScript: EXTRA_SCRIPT,
});

const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE);
        return;
    }
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', module: 'technical' }));
        return;
    }
    if (req.method === 'GET' && req.url === '/state') {
        // Механизм запроса состояния между модулями (план, раздел 1) —
        // любой модуль может спросить это через хаб (GET
        // /internal/module-state/technical). Формат — что решит сам
        // модуль, хаб просто проксирует. flowmusicKeeper — чтобы другим
        // модулям не нужно было знать про отдельный /keeper-state.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ module: 'technical', flowmusicKeeper: keeperState.status }));
        return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/request-action/')) {
        const action = req.url.split('/request-action/')[1];
        try {
            const result = await requestHub(`/internal/privileged/${action}`, 'POST');
            res.writeHead(result.status === 200 ? 200 : 403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.body));
        } catch (err) {
            res.writeHead(502, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'не удалось достучаться до хаба', details: String(err) }));
        }
        return;
    }
    if (req.method === 'GET' && req.url === '/keeper-state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(keeperState));
        return;
    }
    if (req.method === 'POST' && req.url === '/keeper-seed') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            let raw;
            try {
                const parsed = JSON.parse(body);
                raw = String(parsed.raw || '').trim();
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'некорректный JSON' }));
                return;
            }
            if (!raw) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'raw обязателен' }));
                return;
            }
            if (keeperState.seeding) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'затравка уже выполняется' }));
                return;
            }
            // ВАЖНО: не await — прокси хаба (/modules/:name/*) обрывает
            // запрос по фиксированному таймауту 10с (hub/src/index.ts),
            // холодный запуск Chromium легко дольше. Отвечаем сразу,
            // реальную работу гоняем в фоне, прогресс — через /keeper-state.
            keeperState.seeding = true;
            keeperState.seedError = null;
            (async () => {
                try {
                    await seedKeeperSession(raw);
                    await keeperSyncOnce();
                } catch (err) {
                    keeperState.seedError = String(err instanceof Error ? err.message : err);
                    console.error('[technical/flowmusic-keeper] затравка не удалась:', keeperState.seedError);
                } finally {
                    keeperState.seeding = false;
                }
            })();
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, status: 'started' }));
        });
        return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
    console.log(`[technical] модуль слушает порт ${PORT}, хаб на ${HUB_HOST}:${HUB_PORT}`);
});

// Первый sync — почти сразу (даёт время браузеру подняться), дальше по расписанию.
setTimeout(keeperSyncLoop, 10_000);
setInterval(keeperSyncLoop, KEEPER_SYNC_INTERVAL_MS);

process.on('SIGTERM', async () => {
    if (keeperBrowser) await keeperBrowser.close().catch(() => {});
    server.close(() => process.exit(0));
});
