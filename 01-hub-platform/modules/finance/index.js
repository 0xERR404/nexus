// NEXUS404 — модуль "Финансы" (finance).
//
// Четыре карточки в ряд:
//  - "Карта" — текущий баланс + кнопки "+"/"-" (пополнение/списание,
//    ОБЕ требуют описание — это реальные приход/расход денег)
//  - "Курс валют" — доллар/евро/тенге/юань относительно рубля (ЦБ РФ,
//    публичный JSON без ключа: cbr-xml-daily.ru)
//  - "Крипта" — биткоин/эфир/монеро/TON (Toncoin — "которая телеграм",
//    официальная монета сети TON, тесно связанной с Telegram) в долларах
//    (CoinGecko, публичный эндпоинт без ключа)
//  - "Депозит" — тоже "+"/"-", НО это не отдельные деньги из ниоткуда, а
//    ПЕРЕВОД между своими же счетами: "+" на депозите списывает ровно
//    столько же с карты, "-" на депозите возвращает деньги на карту.
//    Поэтому у депозита НЕТ поля описания (это не трата и не приход, а
//    просто перекладывание из одного своего кармана в другой) и такие
//    операции НЕ считаются в "потрачено за месяц" — решение пользователя:
//    "траты это списание с карты, а если на депозит — то это не траты".
//
// Ниже — единая лента ВСЕХ операций (карта + депозит вместе), новые
// сверху, каждую можно отредактировать (сумму/описание) или удалить —
// оба действия аккуратно откатывают/переприменяют эффект операции на
// балансы (см. applyEffect), а не просто правят цифру в истории саму по
// себе, иначе баланс разошёлся бы с историей.
//
// Кнопки "+"/"-" открывают НАСТОЯЩИЙ <iframe> (не просто JS-модалку —
// именно так и просили) с маленькой отдельной формой (см. GET /entry
// ниже). Тот же iframe используется и для редактирования — просто
// приходит с параметром edit=<id> и уже заполненными полями.
//
// Курсы валют/крипты — единственные внешние HTTP-запросы, которые модуль
// делает НАПРЯМУЮ (не через хаб, в отличие от остального проекта, где
// все внешние вызовы централизованы в хабе). Это осознанно: смысл
// централизации там — держать API-ключи провайдеров в одном месте
// (hub/src/keys.ts), не светить их модулям. Здесь секрета нет вообще —
// оба источника курсов публичные и не требуют ключа. Кэшируются в
// памяти на RATES_CACHE_MS, чтобы не дёргать внешние сервисы на каждое
// открытие страницы.

const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { renderPage } = require('./chrome.js');

const PORT = process.env.MODULE_PORT || 4005;
const DATA_DIR = process.env.MODULE_DATA_DIR || '/app/data';
const BALANCES_FILE = path.join(DATA_DIR, 'balances.json');
const TRANSACTIONS_FILE = path.join(DATA_DIR, 'transactions.jsonl');
const MAX_TRANSACTIONS_KEPT = 2000; // обрезаем ИСТОРИЮ (отображение), не баланс — см. врезку про applyEffect
const RATES_CACHE_MS = 10 * 60 * 1000; // 10 минут — курсы не скачут быстрее, незачем дёргать внешние API чаще

const ACCOUNTS = {
  card: 'Карта',
  deposit: 'Депозит',
};

async function ensureDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readBalances() {
  try {
    const raw = await fs.readFile(BALANCES_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      card: typeof parsed.card === 'number' ? parsed.card : 0,
      deposit: typeof parsed.deposit === 'number' ? parsed.deposit : 0,
    };
  } catch {
    return { card: 0, deposit: 0 };
  }
}

async function writeBalances(balances) {
  await ensureDir();
  await fs.writeFile(BALANCES_FILE, JSON.stringify(balances, null, 2));
}

async function readTransactions() {
  try {
    const raw = await fs.readFile(TRANSACTIONS_FILE, 'utf-8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function writeTransactions(list) {
  await ensureDir();
  const trimmed = list.length > MAX_TRANSACTIONS_KEPT ? list.slice(list.length - MAX_TRANSACTIONS_KEPT) : list;
  await fs.writeFile(TRANSACTIONS_FILE, trimmed.map((e) => JSON.stringify(e)).join('\n') + (trimmed.length ? '\n' : ''));
  return trimmed;
}

// ---------------------------------------------------------------------------
// Применяет (sign=+1) или откатывает (sign=-1) эффект ОДНОЙ операции на
// балансы — единая точка правды для создания, редактирования и удаления,
// чтобы логика переноса денег между картой и депозитом не продублировалась
// в трёх местах и не разошлась при будущей правке.
//
// account === 'card': обычная операция, трогает только карту.
// account === 'deposit': перевод — трогает депозит НА delta, а карту на
//   ОБРАТНУЮ delta (пополнение депозита забирает деньги с карты, снятие
//   с депозита возвращает их на карту) — правка "внесение на депозит
//   должно списывать с карты".
// ---------------------------------------------------------------------------
function applyEffect(balances, tx, sign) {
  const delta = (tx.direction === 'plus' ? tx.amount : -tx.amount) * sign;
  if (tx.account === 'card') {
    balances.card += delta;
  } else {
    balances.deposit += delta;
    balances.card -= delta;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function isSameMonth(iso, ref) {
  const d = new Date(iso);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

// "Потрачено за месяц" — правка "траты это списание с карты, а если на
// депозит — то это не траты": считаем ТОЛЬКО account === 'card' И
// direction === 'minus' за текущий календарный месяц, переводы на депозит
// (какого бы направления ни были) в сумму не попадают вообще.
function spentThisMonth(transactions) {
  const now = new Date();
  return transactions
    .filter((t) => t.account === 'card' && t.direction === 'minus' && isSameMonth(t.timestamp, now))
    .reduce((sum, t) => sum + t.amount, 0);
}

// ---------------------------------------------------------------------------
// Курсы — см. врезку в шапке файла про прямой запрос без хаба.
// Promise.allSettled — частичный отказ одного источника не должен прятать
// данные другого (тот же принцип "честной оговорки", что у Gemini-баланса
// в billing): если упал только CoinGecko, валюты всё равно показываем.
// ---------------------------------------------------------------------------
async function fetchFiatRates() {
  const res = await fetch('https://www.cbr-xml-daily.ru/daily_json.js');
  if (!res.ok) throw new Error('ЦБ РФ: HTTP ' + res.status);
  const data = await res.json();
  const pick = (code) => {
    const v = data && data.Valute && data.Valute[code];
    if (!v || !v.Value || !v.Nominal) return null;
    return v.Value / v.Nominal; // курс за ЕДИНИЦУ валюты, не за номинал (у тенге/юаня номинал не всегда 1)
  };
  return { USD: pick('USD'), EUR: pick('EUR'), CNY: pick('CNY'), KZT: pick('KZT') };
}

async function fetchCryptoRates() {
  const res = await fetch(
    'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,monero,the-open-network&vs_currencies=usd'
  );
  if (!res.ok) throw new Error('CoinGecko: HTTP ' + res.status);
  const data = await res.json();
  const pick = (id) => (data && data[id] && typeof data[id].usd === 'number' ? data[id].usd : null);
  return { BTC: pick('bitcoin'), ETH: pick('ethereum'), XMR: pick('monero'), TON: pick('the-open-network') };
}

let ratesCache = { data: null, fetchedAt: 0 };

async function getRates() {
  const now = Date.now();
  if (ratesCache.data && now - ratesCache.fetchedAt < RATES_CACHE_MS) {
    return ratesCache.data;
  }
  const [fiatRes, cryptoRes] = await Promise.allSettled([fetchFiatRates(), fetchCryptoRates()]);
  const result = {
    fiat: fiatRes.status === 'fulfilled' ? fiatRes.value : null,
    crypto: cryptoRes.status === 'fulfilled' ? cryptoRes.value : null,
    updatedAt: new Date().toISOString(),
    errors: [
      fiatRes.status === 'rejected' ? String((fiatRes.reason && fiatRes.reason.message) || fiatRes.reason) : null,
      cryptoRes.status === 'rejected' ? String((cryptoRes.reason && cryptoRes.reason.message) || cryptoRes.reason) : null,
    ].filter(Boolean),
  };
  ratesCache = { data: result, fetchedAt: now };
  return result;
}

// ---------------------------------------------------------------------------
// Главная страница модуля — 4 карточки + история. Числа сами по себе не
// подставляются в разметку (были бы неактуальны при следующем открытии
// закешированной страницы) — только заготовки с id, реальные значения
// подтягивает клиентский JS через /api/state и /api/rates сразу после
// загрузки (тот же принцип, что и в billing/monitoring).
//
// Курсы валют/крипты — тот же вид плиток (.stat-tiles-grid/.stat-tile),
// что и у карточек модулей на главной странице хаба (правка "сделай как
// у нас на главной сделано внешне") — подпись сверху мелко, значение
// снизу крупным и жирным, 2 в ряд.
//
// Порядок карточек в разметке — Карта, Депозит, Курс валют, Крипта (не
// Карта/Курс/Крипта/Депозит, как было раньше) — важен на мобильной
// сетке 2 колонки (.finance-grid ниже): при чтении слева направо, сверху
// вниз ряды получаются "Карта + Депозит" и "Курс валют + Крипта" —
// правка "чтобы карта и депозит были в одной строке, а курсы в другой".
// ---------------------------------------------------------------------------
const BODY_CONTENT = `
  <div class="finance-grid">
    <div class="box finance-card">
      <div class="finance-card-title">Карта</div>
      <div class="finance-balance" id="balCard">—</div>
      <div class="finance-actions">
        <button class="finance-btn plus" data-account="card" data-direction="plus" title="пополнить">+</button>
        <button class="finance-btn minus" data-account="card" data-direction="minus" title="списать">&minus;</button>
      </div>
    </div>

    <div class="box finance-card">
      <div class="finance-card-title">Депозит</div>
      <div class="finance-balance" id="balDeposit">—</div>
      <div class="finance-actions">
        <button class="finance-btn plus" data-account="deposit" data-direction="plus" title="перевести с карты на депозит">+</button>
        <button class="finance-btn minus" data-account="deposit" data-direction="minus" title="перевести с депозита на карту">&minus;</button>
      </div>
    </div>

    <div class="box finance-card">
      <div class="finance-card-title">Курс валют</div>
      <div class="stat-tiles-grid">
        <div class="stat-tile"><span class="stat-label">USD</span><span class="stat-value" id="rateUSD">—</span></div>
        <div class="stat-tile"><span class="stat-label">EUR</span><span class="stat-value" id="rateEUR">—</span></div>
        <div class="stat-tile"><span class="stat-label">KZT</span><span class="stat-value" id="rateKZT">—</span></div>
        <div class="stat-tile"><span class="stat-label">CNY</span><span class="stat-value" id="rateCNY">—</span></div>
      </div>
    </div>

    <div class="box finance-card">
      <div class="finance-card-title">Крипта</div>
      <div class="stat-tiles-grid">
        <div class="stat-tile"><span class="stat-label">BTC</span><span class="stat-value" id="rateBTC">—</span></div>
        <div class="stat-tile"><span class="stat-label">ETH</span><span class="stat-value" id="rateETH">—</span></div>
        <div class="stat-tile"><span class="stat-label">XMR</span><span class="stat-value" id="rateXMR">—</span></div>
        <div class="stat-tile"><span class="stat-label">TON</span><span class="stat-value" id="rateTON">—</span></div>
      </div>
    </div>
  </div>

  <section>
    <div class="section-title">история операций</div>
    <div id="historyBox">
      <div class="empty-note">загрузка...</div>
    </div>
  </section>

  <div class="finance-overlay" id="txOverlay">
    <div class="finance-overlay-box">
      <button class="finance-overlay-close" id="txOverlayClose" title="закрыть">×</button>
      <iframe id="txFrame" class="finance-iframe" src="about:blank"></iframe>
    </div>
  </div>
`;

const EXTRA_HEAD = `
  .finance-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 22px; }
  @media (max-width: 720px) { .finance-grid { grid-template-columns: repeat(2, 1fr); } }
  .finance-card { display: flex; flex-direction: column; gap: 8px; }
  .finance-card-title { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; color: var(--muted); font-family: var(--font-mono); text-align: center; }
  .finance-balance { font-size: 1.25rem; font-weight: 700; color: var(--text); font-family: var(--font-mono); text-align: center; }
  .finance-actions { display: flex; gap: 8px; justify-content: center; }
  .finance-btn {
    width: 30px; height: 30px; padding: 0; border-radius: 4px; font-size: 1rem; font-weight: 700;
    display: flex; align-items: center; justify-content: center; line-height: 1;
  }
  .finance-btn.plus { color: var(--green); border-color: rgba(102, 187, 106, 0.3); }
  .finance-btn.plus:hover { border-color: var(--green); background: rgba(102, 187, 106, 0.08); box-shadow: 0 0 14px rgba(102, 187, 106, 0.25); }
  .finance-btn.minus { color: var(--red); border-color: rgba(239, 83, 80, 0.3); }
  .finance-btn.minus:hover { border-color: var(--red); background: rgba(239, 83, 80, 0.08); box-shadow: 0 0 14px rgba(239, 83, 80, 0.25); }

  /* Такие же плитки, что и у карточек модулей на главной странице хаба
     (.stat-tiles-grid/.stat-tile в dashboard.ts) — правка "сделай как у
     нас на главной сделано внешне", здесь тот же 2-колоночный вид вместо
     прежнего списка строк "ярлык: значение". */
  .stat-tiles-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; }
  .stat-tile { display: flex; flex-direction: column; gap: 2px; }
  .stat-tile .stat-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); font-family: var(--font-mono); }
  .stat-tile .stat-value { font-size: 0.85rem; font-weight: 700; color: var(--text); font-family: var(--font-mono); }

  /* Каждая операция — своя отдельная карточка (.box, тот же класс, что
     и у остальных блоков интерфейса), а не строка в общей таблице —
     правка "сделать каждую отдельной карточкой". #historyBox просто
     раскладывает эти карточки в столбик с отступом, сам никакой рамки
     не рисует (та теперь у каждой карточки своя). */
  #historyBox { display: flex; flex-direction: column; gap: 8px; font-family: var(--font-mono); }
  .finance-tx-card { display: flex; flex-direction: column; gap: 6px; }
  /* Верхняя строка карточки: счёт слева, дата и кнопки — справа. */
  .finance-tx-top { display: flex; align-items: center; gap: 8px; }
  .finance-history-account { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); border: 1px solid var(--line); border-radius: 3px; padding: 2px 5px; }
  .finance-tx-date { color: var(--muted); font-size: 0.72rem; margin-left: auto; }
  .finance-tx-actions { display: flex; gap: 4px; }
  .finance-tx-actions button {
    background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 4px;
    width: 22px; height: 22px; padding: 0; display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .finance-tx-actions button:hover { border-color: var(--accent); color: var(--accent); }
  .finance-tx-actions button.finance-del:hover { border-color: var(--red); color: var(--red); }
  /* Нижняя строка: описание слева (обрезается многоточием, если не
     влезает — целиком читается по клику на карточку, см. EXTRA_SCRIPT,
     открывает тот же iframe, что и "+"/"-" наверху, в режиме просмотра),
     сумма — справа, крупнее и цветом по направлению. */
  .finance-tx-body { display: flex; align-items: center; gap: 10px; font-size: 0.85rem; }
  .finance-tx-desc { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .finance-tx-amount { font-weight: 700; flex-shrink: 0; }
  .finance-tx-amount.plus { color: var(--green); }
  .finance-tx-amount.minus { color: var(--red); }

  /* Настоящий <iframe> с отдельной формой поверх страницы — просили
     именно так, не JS-модалку без iframe. Оверлей — просто затемнение +
     центрирование, вся форма (поля суммы/описания) целиком внутри
     iframe, живёт как отдельная страница на GET /entry (см. index.js).
     Тот же iframe используется и для редактирования (параметр edit). */
  .finance-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.65);
    align-items: center; justify-content: center; z-index: 100; padding: 16px;
  }
  .finance-overlay.open { display: flex; }
  .finance-overlay-box { position: relative; width: min(360px, 100%); }
  .finance-overlay-close {
    position: absolute; top: -34px; right: 0; background: transparent; border: 1px solid var(--line);
    color: var(--text); border-radius: 4px; width: 28px; height: 28px; font-size: 1.1rem; line-height: 1;
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .finance-overlay-close:hover { border-color: var(--red); color: var(--red); }
  /* Высота — запасное значение до первого открытия (пока не выбран
     конкретный счёт), реальную высоту на каждое открытие подставляет
     JS через frame.style.height (см. openEntry в EXTRA_SCRIPT) — у
     карты форма выше (есть поле "Описание"), у депозита короче. */
  .finance-iframe {
    width: 100%; height: 260px; border: 1px solid var(--line); border-radius: var(--card-radius);
    background: var(--bg); box-shadow: 0 0 30px rgba(179, 136, 255, 0.15);
  }
`;

const EXTRA_SCRIPT = `
  function formatMoney(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' \\u20bd';
  }
  function formatRate(n, digits) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '—';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: digits === undefined ? 2 : digits });
  }
  // Только дата, без времени — правка "время убери, оставь только дату".
  function formatDate(iso) {
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    } catch { return ''; }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var ACCOUNT_LABELS = { card: 'карта', deposit: 'депозит' };
  // У депозита нет своего описания (см. врезку в index.js) — вместо
  // пустой строки в истории показываем понятную фразу по направлению.
  var DEPOSIT_LABELS = { plus: 'внесение на депозит', minus: 'снятие с депозита' };

  async function loadState() {
    try {
      const res = await fetch('api/state');
      const s = await res.json();
      document.getElementById('balCard').textContent = formatMoney(s.balances.card);
      document.getElementById('balDeposit').textContent = formatMoney(s.balances.deposit);

      const box = document.getElementById('historyBox');
      if (!s.transactions.length) {
        box.innerHTML = '<div class="empty-note">операций пока нет</div>';
        return;
      }
      // Новые сверху — история хранится в порядке добавления, разворачиваем на клиенте.
      const rows = s.transactions.slice().reverse().map(function (t) {
        const sign = t.direction === 'plus' ? '+' : '\\u2212';
        const cls = t.direction === 'plus' ? 'plus' : 'minus';
        const desc = t.account === 'deposit' ? DEPOSIT_LABELS[t.direction] : t.description;
        return '<div class="box finance-tx-card" data-id="' + escapeHtml(t.id) + '" data-account="' + t.account + '" data-direction="' + t.direction + '" data-amount="' + t.amount + '" data-description="' + escapeHtml(t.description || '') + '">' +
          '<div class="finance-tx-top">' +
            '<span class="finance-history-account">' + escapeHtml(ACCOUNT_LABELS[t.account] || t.account) + '</span>' +
            '<span class="finance-tx-date">' + formatDate(t.timestamp) + '</span>' +
            '<span class="finance-tx-actions">' +
              '<button class="finance-edit" title="редактировать"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg></button>' +
              '<button class="finance-del" title="удалить"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg></button>' +
            '</span>' +
          '</div>' +
          '<div class="finance-tx-body">' +
            '<span class="finance-tx-desc">' + escapeHtml(desc) + '</span>' +
            '<span class="finance-tx-amount ' + cls + '">' + sign + formatMoney(t.amount) + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
      box.innerHTML = rows;
    } catch {
      document.getElementById('historyBox').innerHTML = '<div class="empty-note">не удалось загрузить</div>';
    }
  }

  async function loadRates() {
    try {
      const res = await fetch('api/rates');
      const r = await res.json();
      if (r.fiat) {
        document.getElementById('rateUSD').textContent = formatRate(r.fiat.USD);
        document.getElementById('rateEUR').textContent = formatRate(r.fiat.EUR);
        document.getElementById('rateKZT').textContent = formatRate(r.fiat.KZT, 3);
        document.getElementById('rateCNY').textContent = formatRate(r.fiat.CNY);
      }
      if (r.crypto) {
        document.getElementById('rateBTC').textContent = r.crypto.BTC ? '$' + formatRate(r.crypto.BTC, 0) : '—';
        document.getElementById('rateETH').textContent = r.crypto.ETH ? '$' + formatRate(r.crypto.ETH, 0) : '—';
        document.getElementById('rateXMR').textContent = r.crypto.XMR ? '$' + formatRate(r.crypto.XMR) : '—';
        document.getElementById('rateTON').textContent = r.crypto.TON ? '$' + formatRate(r.crypto.TON) : '—';
      }
    } catch {
      // Тихо — карточки курсов просто останутся с "—", не критично для
      // остальной страницы (баланс/история работают независимо).
    }
  }

  const overlay = document.getElementById('txOverlay');
  const frame = document.getElementById('txFrame');

  // Высота окна зависит от того, есть ли в форме поле "Описание" — оно
  // есть только у карты (пополнение/списание), у депозита его нет вообще
  // (см. врезку в index.js), форма короче. Раньше высота была одна на
  // оба случая — либо появлялся скролл у карты (не влезало), либо
  // оставалось много свободного места у депозита (влезало с запасом).
  function openEntry(account, params) {
    frame.style.height = account === 'deposit' ? '190px' : '260px';
    frame.src = 'entry?' + params;
    overlay.classList.add('open');
  }
  function closeEntry() {
    overlay.classList.remove('open');
    frame.src = 'about:blank';
  }

  document.querySelectorAll('.finance-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openEntry(btn.dataset.account, 'account=' + encodeURIComponent(btn.dataset.account) + '&direction=' + encodeURIComponent(btn.dataset.direction));
    });
  });

  // Клики по "редактировать"/"удалить" в истории — делегирование на
  // весь блок (строки перерисовываются целиком при каждом loadState,
  // навешивать слушатели на каждую по отдельности незачем). Карточка
  // сама по себе больше не кликабельна на просмотр (был отдельный режим
  // "только почитать" в iframe) — с тех пор, как история стала
  // карточками (см. .finance-tx-card), счёт/описание/сумма и так видны
  // сразу, отдельное окно для этого не нужно (правка "теперь в целом
  // всё видно, убираем"). Реагируем только на сами кнопки.
  document.getElementById('historyBox').addEventListener('click', async function (e) {
    const editBtn = e.target.closest ? e.target.closest('.finance-edit') : null;
    const delBtn = e.target.closest ? e.target.closest('.finance-del') : null;
    if (!editBtn && !delBtn) return;
    const row = (editBtn || delBtn).closest('.finance-tx-card');
    if (!row) return;
    const id = row.dataset.id;

    if (editBtn) {
      const params = 'edit=' + encodeURIComponent(id) +
        '&account=' + encodeURIComponent(row.dataset.account) +
        '&direction=' + encodeURIComponent(row.dataset.direction) +
        '&amount=' + encodeURIComponent(row.dataset.amount) +
        '&description=' + encodeURIComponent(row.dataset.description || '');
      openEntry(row.dataset.account, params);
      return;
    }

    if (delBtn) {
      if (!confirm('Удалить эту операцию?')) return;
      try {
        await fetch('api/transactions/' + encodeURIComponent(id), { method: 'DELETE' });
        loadState();
      } catch {
        alert('не удалось удалить');
      }
    }
  });

  document.getElementById('txOverlayClose').addEventListener('click', closeEntry);
  overlay.addEventListener('click', function (e) {
    if (e.target === overlay) closeEntry(); // клик по затемнению вне окна — тоже закрыть
  });

  // Сообщение от формы внутри iframe (см. GET /entry) — операция
  // сохранена, закрываем оверлей и обновляем цифры. targetOrigin у формы
  // не проверяем строго на этой стороне (та шлёт '*') — сам iframe мы
  // сами же и создали с src на свой собственный origin, посторонний
  // контент туда попасть не может.
  window.addEventListener('message', function (e) {
    if (e.data && e.data.source === 'nexus404-finance-entry' && e.data.ok) {
      closeEntry();
      loadState();
    }
  });

  loadState();
  loadRates();
  setInterval(loadState, 30000);
  setInterval(loadRates, 60000);
`;

// ---------------------------------------------------------------------------
// GET /entry — маленькая самостоятельная форма/просмотр, живёт ВНУТРИ
// iframe на главной странице модуля (см. EXTRA_SCRIPT/openEntry выше). Не
// через renderPage — та рисует полную шапку хаба, здесь нужна только сама
// форма, без ничего лишнего (места и так немного, iframe маленький).
//
// Два режима (mode):
//  - create: account + direction в query, поля пустые, POST на сохранение
//  - edit: id (в query — edit=<id>) + account + direction + amount +
//    description — поля уже заполнены текущими значениями, PATCH на
//    сохранение вместо POST.
// Поле "Описание" вообще не показывается, если account === 'deposit' — по
// просьбе "внесение и снятие на депозит комментариев быть не должно".
//
// Раньше был ещё и третий режим — "только посмотреть" (клик по карточке
// в истории открывал iframe для чтения полного описания). Убран — с тех
// пор, как история стала отдельными карточками (см. .finance-tx-card),
// описание и так видно прямо в списке, отдельное окно для этого больше
// не нужно (правка "теперь в целом всё видно, убираем").
// ---------------------------------------------------------------------------
function renderEntryPage(account, direction, mode, id, prefillAmount, prefillDescription) {
  const accountLabel = ACCOUNTS[account] || account;
  const isDeposit = account === 'deposit';
  const isEdit = mode === 'edit';
  let title;
  if (isDeposit) {
    title = direction === 'plus' ? 'Перевод на депозит' : 'Перевод с депозита';
  } else {
    title = direction === 'plus' ? 'Пополнение' : 'Списание';
  }
  const accentVar = direction === 'plus' ? '#66bb6a' : '#ef5350';
  const subNote = isDeposit
    ? (direction === 'plus' ? 'Спишется с карты' : 'Вернётся на карту')
    : '';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title}</title>
<style>
  :root { --bg: #08070c; --line: rgba(179, 136, 255, 0.15); --text: #ddd6ff; --muted: #7a72a0; --accent: ${accentVar}; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  /* Отступы поджаты (было padding 16 / gap 16 — жаловались на "слишком
     много свободного места" после того, как их до этого расширили из-за
     обратной жалобы "почти слитно"; это компромисс между двумя правками
     подряд, не полный откат к самому первому варианту). */
  body {
    background: var(--bg); color: var(--text); font-family: 'JetBrains Mono', 'Fira Code', monospace;
    padding: 14px; display: flex; flex-direction: column; gap: 11px; height: 100vh; overflow-y: auto;
  }
  h2 { font-size: 0.95rem; font-weight: 700; }
  .sub { font-size: 0.7rem; color: var(--muted); margin-top: 2px; }
  label { font-size: 0.7rem; color: var(--muted); display: block; margin-bottom: 4px; }
  input {
    width: 100%; background: transparent; border: 1px solid var(--line); border-radius: 4px;
    color: var(--text); font-family: inherit; font-size: 0.9rem; padding: 7px 9px;
  }
  input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 8px rgba(179, 136, 255, 0.2); }
  .btn-row { margin-top: auto; display: flex; gap: 8px; }
  button {
    flex: 1; background: transparent; border: 1px solid var(--accent); color: var(--accent);
    border-radius: 4px; padding: 8px; font-family: inherit; font-size: 0.85rem; font-weight: 700; cursor: pointer;
  }
  button:hover { background: rgba(255, 255, 255, 0.06); }
  button:disabled { opacity: 0.5; cursor: default; }
  .err { color: #ef5350; font-size: 0.72rem; min-height: 14px; }
</style>
</head>
<body>
  <div>
    <h2>${title}</h2>
    <div class="sub">${accountLabel}${subNote ? ' \u2014 ' + subNote : ''}</div>
  </div>
  <div>
    <label for="amount">Сумма, ₽</label>
    <input id="amount" type="number" inputmode="decimal" min="0.01" step="0.01" placeholder="0" value="${prefillAmount ? escapeAttr(prefillAmount) : ''}" autofocus />
  </div>
  ${isDeposit ? '' : `
  <div>
    <label for="description">Описание</label>
    <input id="description" type="text" maxlength="200" placeholder="На что / за что" value="${prefillDescription ? escapeAttr(prefillDescription) : ''}" />
  </div>`}
  <div class="err" id="err"></div>
  <div class="btn-row">
    <button id="saveBtn">${isEdit ? 'Сохранить' : 'Добавить'}</button>
  </div>
  <script>
    var account = ${JSON.stringify(account)};
    var direction = ${JSON.stringify(direction)};
    var entryId = ${JSON.stringify(id || null)};
    var isDeposit = ${JSON.stringify(isDeposit)};
    var btn = document.getElementById('saveBtn');
    var errEl = document.getElementById('err');

    btn.addEventListener('click', async function () {
      var amount = parseFloat(document.getElementById('amount').value);
      var description = isDeposit ? '' : document.getElementById('description').value.trim();
      errEl.textContent = '';

      if (!amount || amount <= 0) { errEl.textContent = 'укажи сумму больше нуля'; return; }
      if (!isDeposit && !description) { errEl.textContent = 'укажи описание'; return; }

      btn.disabled = true;
      try {
        var url = entryId ? ('api/transactions/' + encodeURIComponent(entryId)) : 'api/transactions';
        var method = entryId ? 'PATCH' : 'POST';
        var payload = entryId
          ? { amount: amount, description: description }
          : { account: account, direction: direction, amount: amount, description: description };
        var res = await fetch(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        var data = await res.json();
        if (!res.ok) {
          errEl.textContent = data.error || 'не удалось сохранить';
          btn.disabled = false;
          return;
        }
        window.parent.postMessage({ source: 'nexus404-finance-entry', ok: true }, '*');
      } catch {
        errEl.textContent = 'сеть недоступна';
        btn.disabled = false;
      }
    });

    var descEl = document.getElementById('description');
    if (descEl) {
      descEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') btn.click(); });
    }
    document.getElementById('amount').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && isDeposit) btn.click();
    });
  </script>
</body>
</html>`;
}

// Экранирование для HTML-атрибута value="..." (сумма/описание из query
// при редактировании — тоже пользовательский ввод, тот же принцип, что и
// везде в проекте: экранируем при вставке в разметку, не доверяем вслепую).
function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---------------------------------------------------------------------------
// HTTP-сервер — тот же сырой node:http, что и у остальных модулей (см.
// notifications/billing/index.js), без фреймворка: для пары ручек он не
// нужен, а разбираться в чужом require поверх require лишний раз незачем.
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      renderPage({
        title: 'Финансы',
        username: process.env.AUTH_USER || 'user',
        bodyContent: BODY_CONTENT,
        extraHead: EXTRA_HEAD,
        extraScript: EXTRA_SCRIPT,
      })
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/entry') {
    const account = url.searchParams.get('account');
    const direction = url.searchParams.get('direction');
    const editId = url.searchParams.get('edit');
    const prefillAmount = url.searchParams.get('amount');
    const prefillDescription = url.searchParams.get('description');
    if (!ACCOUNTS[account] || (direction !== 'plus' && direction !== 'minus')) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('некорректные параметры');
      return;
    }
    const mode = editId ? 'edit' : 'create';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderEntryPage(account, direction, mode, editId, prefillAmount, prefillDescription));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    try {
      const [balances, transactions] = await Promise.all([readBalances(), readTransactions()]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // Отдаём последние 200 для истории на странице — 2000 в файле нужны
      // только как более глубокий запас, показывать сразу столько на
      // странице незачем.
      res.end(JSON.stringify({ balances, transactions: transactions.slice(-200) }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось прочитать данные', details: String(err) }));
    }
    return;
  }

  // GET /api/summary — сводка для мини-карточки модуля на ГЛАВНОЙ
  // странице хаба (см. dashboard.ts, refreshFinanceSummary): только то,
  // что просили туда вывести — "у меня" (карта), депозит и потрачено в
  // этом месяце, не всё подряд.
  if (req.method === 'GET' && pathname === '/api/summary') {
    try {
      const [balances, transactions] = await Promise.all([readBalances(), readTransactions()]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        card: balances.card,
        deposit: balances.deposit,
        spentThisMonth: round2(spentThisMonth(transactions)),
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось прочитать данные', details: String(err) }));
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/rates') {
    try {
      const rates = await getRates();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rates));
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не удалось получить курсы', details: String(err) }));
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/transactions') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const account = parsed.account;
        const direction = parsed.direction;
        const amount = Number(parsed.amount);
        // Описание — только для карты (см. врезку в шапке файла): у
        // депозита что бы клиент ни прислал, оно молча игнорируется, не
        // просто "необязательно", а гарантированно пусто в хранилище.
        const description = account === 'deposit' ? '' : String(parsed.description || '').trim().slice(0, 200);

        if (!ACCOUNTS[account]) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'account должен быть card или deposit' }));
          return;
        }
        if (direction !== 'plus' && direction !== 'minus') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'direction должен быть plus или minus' }));
          return;
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'amount должен быть положительным числом' }));
          return;
        }
        if (account === 'card' && !description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'description обязателен' }));
          return;
        }

        const entry = {
          id: crypto.randomUUID(),
          account,
          direction,
          amount: round2(amount),
          description,
          timestamp: new Date().toISOString(),
        };

        const balances = await readBalances();
        applyEffect(balances, entry, +1);
        balances.card = round2(balances.card);
        balances.deposit = round2(balances.deposit);
        await writeBalances(balances);

        const transactions = await readTransactions();
        await writeTransactions([...transactions, entry]);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, balances, entry }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'некорректное тело запроса', details: String(err) }));
      }
    });
    return;
  }

  // PATCH/DELETE /api/transactions/<id> — редактирование и удаление уже
  // добавленной операции. Оба сначала ОТКАТЫВАЮТ эффект операции в её
  // старом виде (applyEffect с sign=-1), затем для PATCH — применяют
  // заново с новыми amount/description (account/direction не меняются:
  // затея "поменять карту на депозит задним числом" усложнила бы модель
  // сильнее, чем даёт пользы — проще удалить и добавить заново нужным
  // типом). Так баланс никогда не расходится с историей, даже после
  // серии правок подряд.
  const txMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
  if (txMatch && (req.method === 'PATCH' || req.method === 'DELETE')) {
    const id = decodeURIComponent(txMatch[1]);

    if (req.method === 'DELETE') {
      try {
        const [balances, transactions] = await Promise.all([readBalances(), readTransactions()]);
        const idx = transactions.findIndex((t) => t.id === id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'операция не найдена' }));
          return;
        }
        applyEffect(balances, transactions[idx], -1);
        balances.card = round2(balances.card);
        balances.deposit = round2(balances.deposit);
        await writeBalances(balances);

        transactions.splice(idx, 1);
        await writeTransactions(transactions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, balances }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'не удалось удалить', details: String(err) }));
      }
      return;
    }

    // PATCH
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        const amount = Number(parsed.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'amount должен быть положительным числом' }));
          return;
        }

        const [balances, transactions] = await Promise.all([readBalances(), readTransactions()]);
        const idx = transactions.findIndex((t) => t.id === id);
        if (idx === -1) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'операция не найдена' }));
          return;
        }
        const old = transactions[idx];
        const description = old.account === 'deposit' ? '' : String(parsed.description || '').trim().slice(0, 200);
        if (old.account === 'card' && !description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'description обязателен' }));
          return;
        }

        applyEffect(balances, old, -1); // откатить старое значение
        const updated = { ...old, amount: round2(amount), description, editedAt: new Date().toISOString() };
        applyEffect(balances, updated, +1); // применить новое
        balances.card = round2(balances.card);
        balances.deposit = round2(balances.deposit);
        await writeBalances(balances);

        transactions[idx] = updated;
        await writeTransactions(transactions);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, balances, entry: updated }));
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
  console.log(`[finance] модуль слушает порт ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
