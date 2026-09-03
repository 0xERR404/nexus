// NEXUS404 — модуль "Расходы AI" (billing).
//
// Четыре карточки — по одной на провайдера (DeepSeek/Gemini/FlowMusic/
// Claude): баланс (только у DeepSeek есть публичный REST-эндпоинт баланса
// по тому же ключу, что и у чата — у остальных трёх такого нет, честно
// показываем "не поддерживается", не изображаем несуществующие данные) и
// токены за час/сутки/месяц/всё время (скользящие окна от текущего
// момента, не календарные — см. hub/src/chat/usage.ts). Сами ключи сюда
// никогда не попадают — только уже готовый результат от хаба, тот же
// принцип, что и у остального keys.ts.
//
// Точка у баланса — красная/зелёная строго по тому, задан ли ключ (не по
// тому, удалось ли реально получить баланс) — так решил пользователь:
// "если ключ не введён — красный, если всё ок — зелёный". Статус ключей
// хаб уже отдаёт браузеру напрямую через GET /api/settings/keys (та же
// сессионная кука, что и у всей остальной страницы, тот же приём, что
// использует модуль technical) — модулю не нужен для этого отдельный
// internal-эндпоинт, эту часть делает клиентский JS сам.

const http = require('node:http');
const { renderPage } = require('./chrome.js');

const PORT = process.env.MODULE_PORT || 4002;
const HUB_HOST = process.env.HUB_HOST || 'hub';
const HUB_PORT = process.env.HUB_PORT || 3000;
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';

const PROVIDERS = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'gemini', label: 'Gemini' },
  { id: 'flowmusic', label: 'FlowMusic' },
  { id: 'claude', label: 'Claude' },
];

function requestHub(path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HUB_HOST, port: HUB_PORT, path, method, headers: { 'x-internal-token': HUB_INTERNAL_TOKEN } },
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
    req.end();
  });
}

// Собирает всё, что показывает страница и мини-карточка на главной, одним
// запросом — три внутренних вызова к хабу (usage — всегда есть, баланс —
// только у DeepSeek, статус — только у Gemini) склеиваются в одну сводку.
// Статус ключей сюда намеренно НЕ входит — его читает браузер напрямую
// (см. врезку выше).
async function collectSummary() {
  const [usageRes, balanceRes, geminiStatusRes] = await Promise.all([
    requestHub('/internal/chat-usage'),
    requestHub('/internal/provider-balance/deepseek'),
    requestHub('/internal/provider-status/gemini'),
  ]);

  const usage = usageRes.status === 200 ? usageRes.body.usage : null;
  const empty = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  return {
    allTime: usage?.allTime || empty,
    lastHour: usage?.lastHour || empty,
    lastDay: usage?.lastDay || empty,
    lastMonth: usage?.lastMonth || empty,
    byProviderAllTime: usage?.byProviderAllTime || {},
    byProviderLastHour: usage?.byProviderLastHour || {},
    byProviderLastDay: usage?.byProviderLastDay || {},
    byProviderLastMonth: usage?.byProviderLastMonth || {},
    deepseekBalance: balanceRes.status === 200 ? balanceRes.body : { configured: false },
    geminiStatus: geminiStatusRes.status === 200 ? geminiStatusRes.body.status : null,
  };
}

// Общий "плиточный" вид: подпись сверху, число снизу — не в одну строку
// с подписью (см. правку "прыгающей" карточки billing раньше — короткое
// подряд "подпись + значение" на тесной ширине переносится непредсказуемо
// и меняет высоту). Одна и та же плитка используется и для "итого по
// чату" (в один ряд, 4 штуки), и для мини-карточки на главной
// (dashboard.ts) — там же копия этого же класса.
const TOTALS_ROW = `
  <div class="stat-tiles-row">
    <div class="stat-tile"><span class="stat-label">час</span><span class="stat-value" id="totalLastHour">—</span></div>
    <div class="stat-tile"><span class="stat-label">сутки</span><span class="stat-value" id="totalLastDay">—</span></div>
    <div class="stat-tile"><span class="stat-label">месяц</span><span class="stat-value" id="totalLastMonth">—</span></div>
    <div class="stat-tile"><span class="stat-label">всего</span><span class="stat-value" id="totalAllTime">—</span></div>
  </div>
`;

const BODY_CONTENT = `
  <section>
    <div class="section-title">итого по чату</div>
    <div class="box">${TOTALS_ROW}</div>
  </section>

  <div class="provider-grid" id="providerGrid">
    ${PROVIDERS.map((p) => `
    <div class="box provider-card">
      <div class="provider-name">
        <span class="dot unset" id="${p.id}Dot"></span>
        <span>${p.label}</span>
      </div>
      <div class="row">
        <span id="${p.id}Balance">баланс — проверяю...</span>
      </div>
      <div class="provider-stats">
        <div class="row"><span>час</span><span id="${p.id}Hour" style="margin-left:auto;">—</span></div>
        <div class="row"><span>сутки</span><span id="${p.id}Day" style="margin-left:auto;">—</span></div>
        <div class="row"><span>месяц</span><span id="${p.id}Month" style="margin-left:auto;">—</span></div>
        <div class="row"><span>всего</span><span id="${p.id}All" style="margin-left:auto;">—</span></div>
      </div>
    </div>`).join('')}
  </div>
`;

const EXTRA_HEAD = `
  /* 4 в ряд на десктопе (было auto-fit — при типичной ширине страницы
     помещалось только 3, четвёртая карточка переносилась одна на новую
     строку). На узких экранах — меньше колонок, не меньше ~150px на
     карточку. */
  .provider-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
  @media (max-width: 720px) { .provider-grid { grid-template-columns: repeat(2, 1fr); } }
  .provider-card { display: flex; flex-direction: column; gap: 8px; }
  .provider-name { font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; font-family: var(--font-sans); display: flex; align-items: center; gap: 8px; }
  .provider-stats { display: flex; flex-direction: column; gap: 4px; font-family: var(--font-mono); font-size: 0.8rem; border-top: 1px solid var(--line); padding-top: 8px; }
  .provider-stats .row span:first-child { color: var(--muted); }

  /* Плитки "итого по чату" — 4 штуки в один ряд (не список строк, как
     раньше). Подпись сверху, значение снизу — стабильная высота при
     любой длине числа, тот же принцип, что уже применён у карточки
     billing на главной (список строк вместо 2-колоночной сетки). */
  .stat-tiles-row { display: flex; gap: 10px; }
  .stat-tile { flex: 1; display: flex; flex-direction: column; gap: 4px; align-items: center; text-align: center; }
  .stat-label { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-family: var(--font-mono); }
  .stat-value { font-size: 1.1rem; font-weight: 700; color: var(--text); font-family: var(--font-mono); }
`;

const EXTRA_SCRIPT = `
  function formatTokens(n) {
    if (n === undefined || n === null) return '—';
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  async function refresh() {
    try {
      // Токены/баланс DeepSeek — через свою же сводку модуля (относительный
      // путь БЕЗ ведущего слэша — страница открыта на /modules/billing/,
      // с ведущим слэшем запрос улетел бы в корень хаба, где такого
      // маршрута нет, и вообще ничего не грузилось бы — так и было до
      // исправления этой правкой). Статус ключей (для точек) — напрямую у
      // хаба, той же сессией браузера, что и вся страница, тем и с
      // ведущим слэшем — этот путь как раз и живёт в корне хаба.
      const [summaryRes, keysRes] = await Promise.all([
        fetch('api/summary'),
        fetch('/api/settings/keys'),
      ]);
      const s = await summaryRes.json();
      const keys = await keysRes.json();

      document.getElementById('totalLastHour').textContent = formatTokens(s.lastHour.totalTokens);
      document.getElementById('totalLastDay').textContent = formatTokens(s.lastDay.totalTokens);
      document.getElementById('totalLastMonth').textContent = formatTokens(s.lastMonth.totalTokens);
      document.getElementById('totalAllTime').textContent = formatTokens(s.allTime.totalTokens);

      const providers = ['deepseek', 'gemini', 'flowmusic', 'claude'];
      providers.forEach(function (id) {
        document.getElementById(id + 'Hour').textContent = formatTokens((s.byProviderLastHour[id] || {}).totalTokens || 0);
        document.getElementById(id + 'Day').textContent = formatTokens((s.byProviderLastDay[id] || {}).totalTokens || 0);
        document.getElementById(id + 'Month').textContent = formatTokens((s.byProviderLastMonth[id] || {}).totalTokens || 0);
        document.getElementById(id + 'All').textContent = formatTokens((s.byProviderAllTime[id] || {}).totalTokens || 0);

        const dot = document.getElementById(id + 'Dot');
        const line = document.getElementById(id + 'Balance');
        const hasKey = Boolean(keys[id]);
        // У Gemini точка отражает не просто "ключ задан", а последний
        // реально увиденный статус — красная, если известно про лимит
        // или проблему с биллингом, даже когда ключ формально на месте.
        // Остальные провайдеры такой информации не дают, для них точка
        // как и раньше — просто "задан/не задан".
        const geminiUnhealthy = id === 'gemini' && s.geminiStatus && s.geminiStatus.status !== 'ok';
        dot.className = 'dot ' + (hasKey && !geminiUnhealthy ? 'set' : 'unset');

        if (!hasKey) {
          line.textContent = 'ключ не задан';
          return;
        }
        if (id === 'deepseek') {
          const b = s.deepseekBalance;
          if (b.ok === false) {
            line.textContent = 'не удалось получить баланс: ' + (b.error || 'неизвестная ошибка');
          } else if (b.ok === true) {
            const first = (b.balances || [])[0];
            line.textContent = first ? 'баланс: ' + first.totalBalance + ' ' + first.currency : 'баланс: нет данных в ответе API';
          } else {
            line.textContent = 'баланс: проверяю...';
          }
        } else if (id === 'gemini') {
          // Не баланс (у Gemini его через обычный API-ключ не получить —
          // нужен Google Cloud Billing API с OAuth, см. честную оговорку
          // в gemini.ts). Раньше здесь был подробный текст статуса
          // ("лимит запросов исчерпан, обычно бесплатный тариф (8м
          // назад)") — по просьбе упрощено: тариф всегда бесплатный,
          // это и так факт, а не то, что нужно объяснять каждый раз.
          // Единственное, что реально важно увидеть с одного взгляда —
          // есть ли сейчас проблема, а это уже показывает точка рядом
          // (красная — лимит исчерпан или биллинг не включён, зелёная —
          // всё в порядке). Текст — просто "Бесплатно" во всех случаях,
          // пока ключ задан.
          line.textContent = 'Бесплатно';
        } else {
          // FlowMusic/Claude — публичного REST-эндпоинта баланса по
          // API-ключу нет (см. честные оговорки в flowmusic.ts/claude.ts)
          // — ключ задан, но саму цифру баланса показать нечем.
          line.textContent = 'ключ задан — баланс через API не поддерживается';
        }
      });
    } catch {
      // тихо — это информационная страница, не критичный поток
    }
  }
  refresh();
  setInterval(refresh, 15000);
`;

const PAGE = renderPage({
  title: 'Расходы AI',
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
    res.end(JSON.stringify({ status: 'ok', module: 'billing' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ module: 'billing' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/summary') {
    try {
      const summary = await collectSummary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(summary));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось получить сводку от хаба', details: String(err) }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[billing] модуль слушает порт ${PORT}, хаб на ${HUB_HOST}:${HUB_PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
