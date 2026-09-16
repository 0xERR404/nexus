function escapeHtmlServer(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

// Общие CSS-переменные и стили — терминальная стилистика, один вид на
// главной и на странице чата (разные страницы, общий BASE_STYLES).
const BASE_STYLES = `
  :root {
    --bg: #08070c;
    --line: rgba(179, 136, 255, 0.15);
    --text: #ddd6ff;
    --muted: #7a72a0;
    --accent: #b388ff;
    --amber: #ffcc66;
    --green: #66bb6a;
    --red: #ef5350;
    --card-radius: 6px;
    --font-sans: 'Space Grotesk', -apple-system, system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    /* Тонкий полосатый паттерн фона — вынесен в переменную, чтобы не
       повторять одну и ту же длинную строку градиента везде, где он
       нужен: не только на body::before, но и на любом sticky-элементе
       со своим непрозрачным фоном (шапка, панель инструментов чата,
       поле ввода) — иначе у них получается плоский однотонный "плюс"
       на фоне полосатой остальной страницы ("плотный" фон, о котором
       была жалоба — видимая заплатка на стыке). */
    --pattern-bg: repeating-linear-gradient(to bottom, rgba(179, 136, 255, 0.03) 0px, rgba(179, 136, 255, 0.03) 1px, transparent 1px, transparent 3px);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 14px; height: 100%; }
  * { scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; }
  body {
    background: var(--bg); color: var(--text); font-family: var(--font-sans);
    display: flex; justify-content: center; padding: 20px 16px; min-height: 100vh;
  }
  body::before {
    content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background: var(--pattern-bg);
  }
  .page { max-width: 900px; width: 100%; position: relative; z-index: 1; }

  /* ===== ШАПКА (терминальная строка + статус) — идентична шапке модулей
     (modules/_shared/chrome.js) — правка "привести оформление всех
     страниц к общему виду". Раньше у чата в этой строке была ссылка
     "назад в хаб" вместо "выйти", у модулей вообще не было ни prompt, ни
     статуса — теперь везде одно и то же: prompt + online + выйти здесь,
     название страницы + кнопка "Назад" (если есть куда возвращаться) —
     отдельной строкой ниже, в title-row. ===== */
  /* position: sticky вместо фиксированной высоты страницы — держит шапку
     видимой при прокрутке ДЛИННОЙ страницы (список модулей, история
     чата), но остаётся обычным элементом обычного потока страницы —
     никакого расчёта точной высоты экрана не требует и не завязана на
     100dvh/window.innerHeight, ту самую хрупкую конструкцию, от которой
     страница чата уже один раз отказалась из-за проблем на конкретном
     телефоне (см. правки renderChatPage выше). Свой непрозрачный фон —
     обязателен, иначе контент будет просвечивать сквозь шапку при
     прокрутке под ней. background: var(--pattern-bg), var(--bg) — два
     слоя (паттерн поверх сплошного цвета), а не просто var(--bg): чисто
     сплошным цветом шапка была непрозрачной, но выглядела плоской
     "заплаткой" на фоне полосатой остальной страницы (жалоба "видно,
     что там фон плотный") — так фон остаётся полностью непрозрачным
     (слой var(--bg) снизу), но с той же текстурой, что и везде. */
  .header {
    padding-bottom: 10px; border-bottom: 1px solid var(--line); margin-bottom: 16px; flex-shrink: 0;
    position: sticky; top: 0; z-index: 20; background: var(--pattern-bg), var(--bg); padding-top: 4px;
  }
  .header-top { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; margin-bottom: 10px; }
  .prompt { font-size: 0.8rem; font-family: var(--font-mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .prompt .user { color: var(--amber); }
  .prompt .muted { color: var(--muted); }
  .prompt .cmd { color: var(--accent); }
  .status-badge { display: flex; align-items: center; gap: 6px; font-size: 0.75rem; color: var(--text); font-family: var(--font-mono); flex-shrink: 0; margin-left: auto; white-space: nowrap; }
  .dot-status { display: inline-block; width: 7px; height: 7px; background: var(--green); border-radius: 50%; box-shadow: 0 0 12px rgba(102, 187, 106, 0.7); flex-shrink: 0; }
  .logout { color: var(--muted); text-decoration: none; cursor: pointer; font-size: 0.75rem; flex-shrink: 0; }
  .logout:hover { color: var(--red); }
  /* align-items: flex-start (не center) — кнопка "Назад" физически выше
     заголовка (у неё padding сверху/снизу 5px + своя высота строки,
     итого больше, чем просто текст h1). При center на странице БЕЗ
     кнопки (главная) заголовок сидел на своём естественном месте, а на
     страницах С кнопкой (чат, все модули) центрировался по высоте более
     высокого соседа и визуально съезжал вниз на пару пикселей —
     заголовок оказывался на разной высоте от одной и той же строки
     prompt в шапке. flex-start — верхний край заголовка всегда на одном
     и том же месте, независимо от того, есть рядом кнопка или нет. */
  .title-row { display: flex; align-items: flex-start; gap: 10px; }
  h1 { font-family: var(--font-mono); font-size: 1.2rem; border-left: 3px solid var(--accent); padding-left: 12px; text-shadow: 0 0 18px rgba(179, 136, 255, 0.35); }
  .back-btn {
    background: transparent; border: 1px solid var(--line); color: var(--accent); border-radius: 4px;
    padding: 5px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 0.8rem;
    text-decoration: none; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
    margin-left: auto; transition: border-color 0.15s, box-shadow 0.15s;
  }
  .back-btn:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.08); box-shadow: 0 0 14px rgba(179, 136, 255, 0.25); }

  /* ===== Окно подтверждения — замена системного confirm() браузера =====
     Тот же вид, что и в общем chrome.js у модулей (см. там) — держим
     оба места идентичными вручную, отдельного общего файла для хаба и
     модулей нет (разная сборка: хаб — TS-исходник, модули — чистый JS). */
  .nx-confirm-overlay {
    position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
    padding: 20px 16px; background: rgba(3, 5, 9, 0.72); backdrop-filter: blur(4px);
    opacity: 0; pointer-events: none; transition: opacity 0.15s;
  }
  .nx-confirm-overlay.show { opacity: 1; pointer-events: auto; }
  .nx-confirm-box {
    background: var(--bg); border: 1px solid rgba(179, 136, 255, 0.3); border-radius: 14px;
    width: 100%; max-width: 420px; padding: 20px 22px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6);
    transform: translateY(8px); transition: transform 0.15s;
  }
  .nx-confirm-overlay.show .nx-confirm-box { transform: translateY(0); }
  .nx-confirm-title { font-family: var(--font-sans); font-size: 15px; font-weight: 700; color: var(--text); margin-bottom: 10px; }
  .nx-confirm-message { font-family: var(--font-sans); font-size: 13px; color: var(--muted); line-height: 1.5; margin-bottom: 20px; white-space: pre-wrap; }
  .nx-confirm-actions { display: flex; justify-content: flex-end; gap: 10px; }
  .nx-confirm-actions button {
    margin: 0; background: transparent; border: 1px solid var(--line); color: var(--accent); border-radius: 4px;
    padding: 5px 12px; cursor: pointer; font-family: var(--font-sans); font-size: 13px; transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .nx-confirm-actions button:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.06); box-shadow: 0 0 14px rgba(179, 136, 255, 0.2); }
  .nx-confirm-ok.danger { background: rgba(239, 83, 80, 0.14); border-color: rgba(239, 83, 80, 0.4); color: #ff8a80; }
  .nx-confirm-ok.danger:hover { background: rgba(239, 83, 80, 0.24); border-color: rgba(239, 83, 80, 0.5); box-shadow: 0 0 14px rgba(239, 83, 80, 0.25); }
`;

// Сетка модулей — единственное содержимое главной страницы.
const MODULES_STYLES = `
  .modules-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; align-content: flex-start; }
  @media (max-width: 720px) { .modules-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 420px) { .modules-grid { grid-template-columns: 1fr; } }
  .module-card {
    background: rgba(12, 11, 20, 0.4); border: 1px solid var(--line); border-radius: var(--card-radius);
    padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; justify-content: space-between;
    text-decoration: none; color: inherit; transition: border-color 0.2s, box-shadow 0.2s;
  }
  .module-card:hover { border-color: var(--accent); box-shadow: 0 0 20px rgba(179, 136, 255, 0.15); }
  .module-card .name { font-size: 0.9rem; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; font-family: var(--font-sans); }
  .module-card .footer-row { border-top: 1px solid var(--line); padding-top: 8px; }
  .status-pill { font-size: 0.65rem; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.5px; padding: 3px 8px; border-radius: 3px; border: 1px solid; }
  .status-pill.online { color: var(--green); border-color: var(--green); background: rgba(102, 187, 106, 0.08); box-shadow: 0 0 12px rgba(102, 187, 106, 0.25); }
  .status-pill.offline { color: var(--red); border-color: var(--red); background: rgba(239, 83, 80, 0.08); box-shadow: 0 0 12px rgba(239, 83, 80, 0.2); }
  .status-pill.checking { color: var(--amber); border-color: var(--amber); background: rgba(255, 204, 102, 0.08); box-shadow: 0 0 12px rgba(255, 204, 102, 0.2); }
  .empty-note { color: var(--muted); font-size: 0.85rem; font-family: var(--font-mono); }

  /* Единый вид у всех карточек — подпись сверху, значение снизу (не в
     одну строку рядом): подпись+число на тесной ширине переносится
     непредсказуемо, из-за чего "прыгает" вся сетка. Раздельные строки —
     перенос подписи статичен, высота не скачет от значения. */
  .stat-tiles-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; border-top: 1px solid var(--line); padding-top: 8px; }
  .stat-tile { display: flex; flex-direction: column; gap: 2px; }
  .stat-tile .stat-label { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.4px; color: var(--muted); font-family: var(--font-mono); }
  .stat-tile .stat-value { font-size: 0.85rem; font-weight: 700; color: var(--text); font-family: var(--font-mono); }
`;

// Fullscreen API убран осознанно — ломал отрисовку под системной панелью
// Android; standalone-режим сам уменьшает видимую область без JS.

const MODULES_SCRIPT = `
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatTokensShort(n) {
    if (n === undefined || n === null) return '\u2014';
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  const STATUS_LABELS = {
    running: { text: 'ONLINE', cls: 'online' },
    building: { text: 'CHECKING...', cls: 'checking' },
    starting: { text: 'CHECKING...', cls: 'checking' },
    restarting: { text: 'RESTARTING...', cls: 'checking' },
    broken: { text: 'OFFLINE', cls: 'offline' },
    stopped: { text: 'OFFLINE', cls: 'offline' },
  };
  const healthTimes = {};
  function formatRelative(iso) {
    if (!iso) return '\u2013';
    const diffSec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (diffSec < 60) return diffSec + '\u0441 \u043d\u0430\u0437\u0430\u0434';
    if (diffSec < 3600) return Math.floor(diffSec / 60) + '\u043c \u043d\u0430\u0437\u0430\u0434';
    return Math.floor(diffSec / 3600) + '\u0447 \u043d\u0430\u0437\u0430\u0434';
  }
  function tickHealthTimes() {
    Object.keys(healthTimes).forEach(function (name) {
      const el = document.querySelector('[data-health-for="' + CSS.escape(name) + '"]');
      if (el) el.textContent = formatRelative(healthTimes[name]);
    });
  }
  setInterval(tickHealthTimes, 1000);

  // Карточка чата не приходит из GET /modules (живёт в самом хабе, не
  // контейнером) — дорисовываем вручную первой, статус всегда ONLINE.
  function chatCardHtml() {
    return '<a class="module-card" href="/chat">' +
      '<div class="name">\u0427\u0430\u0442</div>' +
      '<div class="stat-tiles-grid" id="chatTokenTiles">' +
        '<div class="stat-tile"><span class="stat-label">\u0442\u043e\u043a\u0435\u043d\u044b \u0437\u0430 \u0447\u0430\u0441</span><span class="stat-value" id="chatTokensHour">\u2014</span></div>' +
        '<div class="stat-tile"><span class="stat-label">\u0442\u043e\u043a\u0435\u043d\u044b \u0437\u0430 \u0441\u0443\u0442\u043a\u0438</span><span class="stat-value" id="chatTokensDay">\u2014</span></div>' +
        '<div class="stat-tile"><span class="stat-label">\u0442\u043e\u043a\u0435\u043d\u044b \u0437\u0430 \u043c\u0435\u0441\u044f\u0446</span><span class="stat-value" id="chatTokensMonth">\u2014</span></div>' +
        '<div class="stat-tile"><span class="stat-label">\u0442\u043e\u043a\u0435\u043d\u044b \u0432\u0441\u0435\u0433\u043e</span><span class="stat-value" id="chatTokensAll">\u2014</span></div>' +
      '</div>' +
      '<div class="footer-row"><span class="status-pill online">ONLINE</span></div>' +
      '</a>';
  }

  async function refreshChatSummary() {
    try {
      const res = await fetch('/api/chat/usage');
      const data = await res.json();
      const u = data.usage;
      var anchorEl = document.getElementById('chatTokensHour');
      if (!anchorEl || !u) return; // карточка ещё не отрисована / уже сменилась
      document.getElementById('chatTokensHour').textContent = formatTokensShort(u.lastHour.totalTokens);
      document.getElementById('chatTokensDay').textContent = formatTokensShort(u.lastDay.totalTokens);
      document.getElementById('chatTokensMonth').textContent = formatTokensShort(u.lastMonth.totalTokens);
      document.getElementById('chatTokensAll').textContent = formatTokensShort(u.allTime.totalTokens);
    } catch {}
  }

  // Пересоздаём разметку только если что-то реально изменилось —
  // "живые" карточки обновляют текст в уже существующих <span>.
  var lastGridSignature = null;

  async function loadModules() {
    const grid = document.getElementById('modulesGrid');
    try {
      const res = await fetch('/modules');
      const data = await res.json();
      data.modules = data.modules || [];
      data.modules.forEach(function (m) { healthTimes[m.name] = m.lastHealthAt; });

      const signature = data.modules.map(function (m) { return m.name + ':' + m.status; }).join('|');
      if (signature === lastGridSignature) {
        return; // ничего структурно не изменилось — не трогаем DOM
      }
      lastGridSignature = signature;

      const moduleCards = data.modules.map(function (m) {
        const st = STATUS_LABELS[m.status] || { text: m.status.toUpperCase(), cls: 'checking' };
        // Единый вид у всех карточек (те же плитки, что у Чата/Расходов
        // AI). Монитор/billing точечно заполняют плитки живыми данными,
        // общая карточка ниже показывает только то, что реально есть.
        if (m.name === 'monitoring') {
          return '<a class="module-card" href="/modules/' + encodeURIComponent(m.name) + '/">' +
            '<div class="name">' + escapeHtml(m.displayName) + '</div>' +
            '<div class="stat-tiles-grid" id="monitoringMiniGrid">' +
              '<div class="stat-tile"><span class="stat-label">CPU</span><span class="stat-value" id="monCpu">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">RAM</span><span class="stat-value" id="monRam">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u0414\u0438\u0441\u043a</span><span class="stat-value" id="monDisk">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u0421\u0435\u0442\u044c</span><span class="stat-value" id="monNet">\u2014</span></div>' +
            '</div>' +
            '<div class="footer-row">' +
              '<span class="status-pill ' + st.cls + '">' + st.text + '</span>' +
            '</div>' +
            '</a>';
        }
        // Модуль billing — то же точечное исключение: остаток на счёте, не токены.
        if (m.name === 'billing') {
          return '<a class="module-card" href="/modules/' + encodeURIComponent(m.name) + '/">' +
            '<div class="name">' + escapeHtml(m.displayName) + '</div>' +
            '<div class="stat-tiles-grid" id="billingTiles">' +
              '<div class="stat-tile"><span class="stat-label">DeepSeek</span><span class="stat-value" id="billDeepseekBalance">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">Gemini</span><span class="stat-value" id="billGeminiBalance">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">FlowMusic</span><span class="stat-value" id="billFlowmusicBalance">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">Claude</span><span class="stat-value" id="billClaudeBalance">\u2014</span></div>' +
            '</div>' +
            '<div class="footer-row">' +
              '<span class="status-pill ' + st.cls + '">' + st.text + '</span>' +
            '</div>' +
            '</a>';
        }
        // Модуль notifications — то же точечное исключение: сразу видно
        // события за сегодня, не только порт/время проверки.
        if (m.name === 'notifications') {
          return '<a class="module-card" href="/modules/' + encodeURIComponent(m.name) + '/">' +
            '<div class="name">' + escapeHtml(m.displayName) + '</div>' +
            '<div class="stat-tiles-grid" id="notifTiles">' +
              '<div class="stat-tile"><span class="stat-label">\u0441\u043e\u0431\u044b\u0442\u0438\u0439 \u0441\u0435\u0433\u043e\u0434\u043d\u044f</span><span class="stat-value" id="notifEventsToday">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u043f\u0440\u0435\u0434\u0443\u043f\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u0439</span><span class="stat-value" id="notifWarningsToday">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u0443\u0441\u0442\u0440\u043e\u0439\u0441\u0442\u0432 \u043f\u043e\u0434\u043f\u0438\u0441\u0430\u043d\u043e</span><span class="stat-value" id="notifSubscriptions">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u043f\u043e\u0441\u043b\u0435\u0434\u043d\u0435\u0435</span><span class="stat-value" id="notifLastEvent">\u2014</span></div>' +
            '</div>' +
            '<div class="footer-row">' +
              '<span class="status-pill ' + st.cls + '">' + st.text + '</span>' +
            '</div>' +
            '</a>';
        }
        // Модуль finance — то же точечное исключение: только то, что
        // просили ("сумма у меня и на депозите, и потрачено за этот
        // месяц") — не порт/версия/etc, как у обычных модулей ниже.
        if (m.name === 'finance') {
          return '<a class="module-card" href="/modules/' + encodeURIComponent(m.name) + '/">' +
            '<div class="name">' + escapeHtml(m.displayName) + '</div>' +
            '<div class="stat-tiles-grid" id="financeTiles">' +
              '<div class="stat-tile"><span class="stat-label">\u0443 \u043c\u0435\u043d\u044f</span><span class="stat-value" id="financeCard">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u0434\u0435\u043f\u043e\u0437\u0438\u0442</span><span class="stat-value" id="financeDeposit">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u043f\u043e\u0442\u0440\u0430\u0447\u0435\u043d\u043e \u0437\u0430 \u043c\u0435\u0441\u044f\u0446</span><span class="stat-value" id="financeSpent">\u2014</span></div>' +
            '</div>' +
            '<div class="footer-row">' +
              '<span class="status-pill ' + st.cls + '">' + st.text + '</span>' +
            '</div>' +
            '</a>';
        }
        // Модуль cheevoscope — то же точечное исключение: ачивки Steam,
        // ачивки RA и часы в Steam (у RA понятия наигранного времени
        // вообще нет — сервис только для достижений).
        if (m.name === 'cheevoscope') {
          return '<a class="module-card" href="/modules/' + encodeURIComponent(m.name) + '/">' +
            '<div class="name">' + escapeHtml(m.displayName) + '</div>' +
            '<div class="stat-tiles-grid" id="cheevoscopeTiles">' +
              '<div class="stat-tile"><span class="stat-label">\u0430\u0447\u0438\u0432\u043a\u0438 steam</span><span class="stat-value" id="cheevoSteamAch">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u0430\u0447\u0438\u0432\u043a\u0438 ra</span><span class="stat-value" id="cheevoRaAch">\u2014</span></div>' +
              '<div class="stat-tile"><span class="stat-label">\u0447\u0430\u0441\u043e\u0432 \u0432 steam</span><span class="stat-value" id="cheevoHours">\u2014</span></div>' +
            '</div>' +
            '<div class="footer-row">' +
              '<span class="status-pill ' + st.cls + '">' + st.text + '</span>' +
            '</div>' +
            '</a>';
        }
        return '<a class="module-card" href="/modules/' + encodeURIComponent(m.name) + '/">' +
          '<div class="name">' + escapeHtml(m.displayName) + '</div>' +
          '<div class="stat-tiles-grid">' +
            '<div class="stat-tile"><span class="stat-label">\u043f\u043e\u0440\u0442</span><span class="stat-value">' + m.port + '</span></div>' +
            '<div class="stat-tile"><span class="stat-label">\u0432\u0435\u0440\u0441\u0438\u044f</span><span class="stat-value">' + escapeHtml(m.version) + '</span></div>' +
            '<div class="stat-tile"><span class="stat-label">\u043f\u0440\u043e\u0432\u0435\u0440\u043a\u0430</span><span class="stat-value" data-health-for="' + escapeHtml(m.name) + '">' + formatRelative(m.lastHealthAt) + '</span></div>' +
            '<div class="stat-tile"><span class="stat-label">\u0441\u0431\u043e\u0435\u0432 \u043f\u043e\u0434\u0440\u044f\u0434</span><span class="stat-value">' + m.consecutiveFailures + '</span></div>' +
          '</div>' +
          '<div class="footer-row">' +
            '<span class="status-pill ' + st.cls + '">' + st.text + '</span>' +
          '</div>' +
          '</a>';
      });

      // Пустой список модулей не обязательно поломка — супервизор может
      // ещё сканировать после перезагрузки; сообщение само пропадёт на
      // следующем опросе (раз в 10с).
      const emptyNote = data.modules.length === 0
        ? '<div class="empty-note">Модули ещё не появились — если сервер только что перезагружен, супервизор ждёт готовности Docker и скоро их найдёт.</div>'
        : '';
      grid.innerHTML = chatCardHtml() + moduleCards.join('') + emptyNote;
      refreshChatSummary();

      var hasMonitoring = data.modules.some(function (m) { return m.name === 'monitoring'; });
      if (hasMonitoring) refreshMonitoringSummary();
      var hasBilling = data.modules.some(function (m) { return m.name === 'billing'; });
      if (hasBilling) refreshBillingSummary();
      var hasNotifications = data.modules.some(function (m) { return m.name === 'notifications'; });
      if (hasNotifications) refreshNotificationsSummary();
      var hasFinance = data.modules.some(function (m) { return m.name === 'finance'; });
      if (hasFinance) refreshFinanceSummary();
      var hasCheevoscope = data.modules.some(function (m) { return m.name === 'cheevoscope'; });
      if (hasCheevoscope) refreshCheevoscopeSummary();
    } catch {
      if (lastGridSignature === 'ERROR') return; // уже показана ошибка — не пересоздаём
      lastGridSignature = 'ERROR';
      grid.innerHTML = chatCardHtml() + '<div class="empty-note">не удалось загрузить остальные модули</div>';
      refreshChatSummary();
    }
  }

  function formatBytesShort(n) {
    if (!n || n <= 0) return '0\u0411';
    var units = ['\u0411', '\u041a\u0411', '\u041c\u0411', '\u0413\u0411', '\u0422\u0411'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + units[i];
  }

  // Отдельный, более частый опрос — только сводки локального сервера
  // (не всего списка модулей) — так карточка обновляется в реальном
  // времени, не дожидаясь следующего полного цикла loadModules (10с).
  async function refreshMonitoringSummary() {
    try {
      const res = await fetch('/modules/monitoring/api/summary');
      const data = await res.json();
      const s = data.server;
      const cpuEl = document.getElementById('monCpu');
      if (!cpuEl) return; // карточка ещё не отрисована / уже сменилась
      if (!s) {
        ['monCpu', 'monRam', 'monDisk', 'monNet'].forEach(function (id) {
          document.getElementById(id).textContent = '\u2014';
        });
        return;
      }
      document.getElementById('monCpu').textContent = Math.round(s.cpuPercent || 0) + '% \u00b7 ' + (s.cpuCores || 1) + ' \u044f\u0434.';
      document.getElementById('monRam').textContent = formatBytesShort(s.ramUsedBytes) + '/' + formatBytesShort(s.ramTotalBytes);
      document.getElementById('monDisk').textContent = formatBytesShort(s.diskUsedBytes) + '/' + formatBytesShort(s.diskTotalBytes);
      document.getElementById('monNet').textContent = formatBytesShort(s.netRxBytesPerSec) + '/\u0441';
    } catch {}
  }

  // Остаток на счёте — только у DeepSeek есть публичный эндпоинт баланса.
  async function refreshBillingSummary() {
    try {
      const [summaryRes, keysRes] = await Promise.all([
        fetch('/modules/billing/api/summary'),
        fetch('/api/settings/keys'),
      ]);
      const anchorEl = document.getElementById('billDeepseekBalance');
      if (!anchorEl) return; // карточка ещё не отрисована / уже сменилась
      if (!summaryRes.ok) {
        // Модуль недоступен — не "проверяю..." (звучит как будто мы
        // прямо сейчас реально спрашиваем), а честное "—", тем же
        // принципом, что и у остальных карточек.
        ['billGeminiBalance', 'billFlowmusicBalance', 'billClaudeBalance', 'billDeepseekBalance'].forEach(function (id) {
          document.getElementById(id).textContent = '\u2014';
        });
        return;
      }
      const s = await summaryRes.json();
      const keys = await keysRes.json();

      // Gemini — короткий статус, не просто "н/д": последний реально
      // увиденный по факту запросов (chat/providers.ts), не проверка по требованию.
      const geminiSt = s.geminiStatus;
      if (!keys.gemini) {
        document.getElementById('billGeminiBalance').textContent = '\u043d\u0435\u0442 \u043a\u043b\u044e\u0447\u0430';
      } else if (!geminiSt) {
        document.getElementById('billGeminiBalance').textContent = '\u043d/\u0434';
      } else if (geminiSt.status === 'ok') {
        document.getElementById('billGeminiBalance').textContent = '\u043e\u043a';
      } else if (geminiSt.status === 'rate_limited') {
        document.getElementById('billGeminiBalance').textContent = '\u043b\u0438\u043c\u0438\u0442';
      } else if (geminiSt.status === 'billing_error') {
        document.getElementById('billGeminiBalance').textContent = '\u0431\u0438\u043b\u043b\u0438\u043d\u0433';
      } else {
        document.getElementById('billGeminiBalance').textContent = '\u043d/\u0434';
      }
      document.getElementById('billFlowmusicBalance').textContent = keys.flowmusic ? '\u043d/\u0434' : '\u043d\u0435\u0442 \u043a\u043b\u044e\u0447\u0430';
      document.getElementById('billClaudeBalance').textContent = keys.claude ? '\u043d/\u0434' : '\u043d\u0435\u0442 \u043a\u043b\u044e\u0447\u0430';

      const dsEl = document.getElementById('billDeepseekBalance');
      if (!keys.deepseek) {
        dsEl.textContent = '\u043d\u0435\u0442 \u043a\u043b\u044e\u0447\u0430';
      } else {
        const b = s.deepseekBalance;
        if (b && b.ok === true) {
          const first = (b.balances || [])[0];
          dsEl.textContent = first ? first.totalBalance + ' ' + first.currency : '\u043d/\u0434';
        } else if (b && b.ok === false) {
          dsEl.textContent = '\u043e\u0448\u0438\u0431\u043a\u0430';
        } else {
          dsEl.textContent = '\u043f\u0440\u043e\u0432\u0435\u0440\u044f\u044e...';
        }
      }
    } catch {}
  }

  // Раз в 15с, тот же принцип, что у billing.
  async function refreshNotificationsSummary() {
    try {
      const res = await fetch('/modules/notifications/api/summary');
      const anchorEl = document.getElementById('notifEventsToday');
      if (!anchorEl) return; // карточка ещё не отрисована / уже сменилась
      if (!res.ok) {
        // Модуль недоступен — хаб отвечает {"error": ...} без нужных
        // полей. String(undefined) дал бы буквально "undefined" на
        // экране (как у billing/finance/monitoring — честное "—").
        ['notifEventsToday', 'notifWarningsToday', 'notifSubscriptions', 'notifLastEvent'].forEach(function (id) {
          document.getElementById(id).textContent = '\u2014';
        });
        return;
      }
      const s = await res.json();
      document.getElementById('notifEventsToday').textContent = String(s.eventsToday);
      document.getElementById('notifWarningsToday').textContent = String(s.warningsToday);
      document.getElementById('notifSubscriptions').textContent = String(s.subscriptions);
      document.getElementById('notifLastEvent').textContent = s.lastEvent ? s.lastEvent.label : '\u2014';
    } catch {}
  }

  function formatMoneyShort(n) {
    if (typeof n !== 'number' || Number.isNaN(n)) return '\u2014';
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 0 }) + ' \u20bd';
  }

  // Та же частота и принцип, что у billing/notifications выше.
  async function refreshFinanceSummary() {
    try {
      const res = await fetch('/modules/finance/api/summary');
      const s = await res.json();
      const anchorEl = document.getElementById('financeCard');
      if (!anchorEl) return; // карточка ещё не отрисована / уже сменилась
      document.getElementById('financeCard').textContent = formatMoneyShort(s.card);
      document.getElementById('financeDeposit').textContent = formatMoneyShort(s.deposit);
      document.getElementById('financeSpent').textContent = formatMoneyShort(s.spentThisMonth);
    } catch {}
  }

  // Та же частота и принцип, что и у finance выше. Значения могут быть
  // null (ни разу не обновлялось на соответствующей платформе) — "—",
  // не "null"/"undefined" на экране.
  async function refreshCheevoscopeSummary() {
    try {
      const res = await fetch('/modules/cheevoscope/api/summary');
      const anchorEl = document.getElementById('cheevoSteamAch');
      if (!anchorEl) return;
      if (!res.ok) {
        // Модуль недоступен (offline/ещё не поднялся) — хаб отвечает
        // {"error": ...} без нужных полей, честно "—", не "undefined/undefined".
        document.getElementById('cheevoSteamAch').textContent = '\u2014';
        document.getElementById('cheevoRaAch').textContent = '\u2014';
        document.getElementById('cheevoHours').textContent = '\u2014';
        return;
      }
      const s = await res.json();
      document.getElementById('cheevoSteamAch').textContent =
        s.steamAchievementsTotal !== null && s.steamAchievementsTotal !== undefined ? s.steamAchievementsUnlocked + '/' + s.steamAchievementsTotal : '\u2014';
      document.getElementById('cheevoRaAch').textContent =
        s.raAchievementsTotal !== null && s.raAchievementsTotal !== undefined ? s.raAchievementsUnlocked + '/' + s.raAchievementsTotal : '\u2014';
      document.getElementById('cheevoHours').textContent = s.steamHours !== null && s.steamHours !== undefined ? s.steamHours : '\u2014';
    } catch {}
  }

  loadModules();
  setInterval(loadModules, 10000);
  // Сбор на сервере тоже раз в 5с (SAMPLE_INTERVAL_MS в monitoring/store.js).
  setInterval(refreshMonitoringSummary, 5000);
  setInterval(refreshBillingSummary, 15000);
  setInterval(refreshNotificationsSummary, 15000);
  setInterval(refreshFinanceSummary, 15000);
  setInterval(refreshCheevoscopeSummary, 15000);
  setInterval(refreshChatSummary, 15000);
`;

// GET / — главная страница. Чат — карточка, как и остальные модули
// (просто не Docker-контейнер, а часть хаба) — открывается на /chat.
// Один вид на мобильной и десктопной версии, без свайпов между экранами.
export function renderDashboard(username: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>NEXUS404</title>
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#08070c" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="NEXUS404" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
${BASE_STYLES}
${MODULES_STYLES}
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-top">
      <div class="prompt">
        <span class="user">${escapeHtmlServer(username)}</span><span class="muted">@NEXUS404:~$</span> <span class="cmd">./hub</span>
      </div>
      <div class="status-badge">
        <span class="dot-status"></span>
        <span>online</span>
        <a class="logout" id="logoutBtn">выйти</a>
      </div>
    </div>
    <div class="title-row">
      <h1>NEXUS404 INTERFACE</h1>
    </div>
  </div>

  <div class="modules-grid" id="modulesGrid">
    <div class="empty-note">загружаю...</div>
  </div>
</div>

<script>
(function () {
  // Толчок скролла — см. modules/_shared/chrome.js. Возвращаем свою
  // текущую позицию, не 0 — иначе перебивало бы автоскролл чата.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
    }, 50);
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  ${MODULES_SCRIPT}

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  }
})();
</script>
</body>
</html>`;
}

// GET /chat — отдельная страница, та же терминальная шапка, что и на
// главной (не шаблон chrome.js — тот для Docker-модулей, чат в самом хабе).
export function renderChatPage(username: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
<title>Чат — NEXUS404</title>
<link rel="manifest" href="/manifest.json" />
<meta name="theme-color" content="#08070c" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="NEXUS404" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<style>
${BASE_STYLES}

  /* Раньше чат был единственной страницей с фиксированной высотой на
     весь экран (100dvh / вычисленный в JS window.innerHeight или
     window.visualViewport.height) — список сообщений внутри своего
     прокручиваемого блока, поле ввода прибито к низу через flex. На
     практике это оказалось хрупко именно на этой странице: на части
     Android-прошивок с постоянной (не оверлейной) панелью навигации
     внизу экрана вычисленная высота не совпадала с реально видимой
     областью, и низ страницы уезжал за пределы экрана — при этом
     ВСЕ ОСТАЛЬНЫЕ страницы (главная, любой модуль), которые просто
     обычные прокручиваемые страницы без этого трюка, всегда выглядели
     нормально на том же телефоне.
     Проще и надёжнее — не бороться за точный расчёт высоты вообще, а
     сделать чат такой же обычной прокручиваемой страницей, как и всё
     остальное (наследует обычные body/.page из BASE_STYLES выше, без
     переопределений). Список сообщений растёт вместе со страницей, поле
     ввода прижато к низу ВИДИМОЙ области через position: sticky — это
     чисто CSS-механизм, не требует знать точную высоту экрана и не
     ломается на устройствах с любыми системными панелями. */

  /* Обёртка вокруг шапки + строки выбора ИИ/темы + расхода
     токенов — одним sticky-блоком, а не по отдельности: иначе для
     каждого элемента ниже шапки пришлось бы вручную считать пиксельный
     отступ "top" (высота всего, что стоит выше), а она меняется в
     зависимости от длины имени пользователя и переноса строк — хрупко.
     Один общий контейнер решает сам, без ручных цифр. */
  .chat-toolbar { position: sticky; top: 0; z-index: 20; background: var(--pattern-bg), var(--bg); padding-bottom: 4px; }

  /* Строка выбора ИИ/темы — сжимается под ширину экрана вместо переноса
     на вторую строку (была жалоба "не влезает в одну строку на
     мобильном"). flex-wrap: nowrap запрещает перенос совсем. ИИ —
     flex: 0 0 auto, ширина строго по содержимому и не сжимается вообще
     (пробовали ужимать через max-width/width — нативная стрелочка
     <select> на Android съедает больше места, чем закладывалось, и
     название обрезалось многоточием, жалоба "очень сильно
     сократилось"). Раньше тут был ещё отдельный селектор модели
     DeepSeek (Flash/Pro) с той же логикой — убран вместе с Pro, выбор
     модели стал не из чего делать. Тема (topic-select) — единственная,
     кто сжимается (flex: 1, min-width: 0), забирает то, что осталось
     после ИИ и кнопок — ей не так жалко, длинное название и так
     показывалось бы многоточием. Кнопки — квадратные иконки
     фиксированного размера, тексту "+ новая тема" сжиматься было особо
     некуда, поэтому убран совсем, иконка того же плюса, что у кнопки
     вложения ниже. Итог — гарантированно одна строка на любой ширине
     экрана, без горизонтального скролла. */
  .topic-row { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; flex-wrap: nowrap; }
  .topic-select, .provider-select {
    background: transparent; border: 1px solid var(--line); border-radius: 4px; color: var(--text);
    font-family: var(--font-mono); padding: 3px 6px; font-size: 0.72rem; min-width: 0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  #providerSelect { flex: 0 0 auto; }
  .topic-select { flex: 1 1 auto; min-width: 0; }
  .topic-select:focus, .provider-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 10px rgba(179, 136, 255, 0.25); }
  /* Сам <select> уже прозрачный, но раскрывающийся список опций браузер
     рисует своими стилями (обычно белый/системный) — большинство
     браузеров всё же учитывают background-color/color на <option>. */
  .topic-select option, .provider-select option { background: var(--bg); color: var(--text); }
  /* "+ новая тема" и корзина — раньше кнопка "+ новая тема" была с
     текстом, теперь обе просто квадратные иконки одного размера
     (flex: 0 0 auto — не участвуют в сжатии строки вообще). */
  .topic-icon-btn {
    flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
    background: transparent; border: 1px solid var(--line); color: var(--accent); border-radius: 4px;
    cursor: pointer; display: flex; align-items: center; justify-content: center;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .topic-icon-btn:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.06); box-shadow: 0 0 14px rgba(179, 136, 255, 0.2); }
  .delete-topic-btn { color: var(--red) !important; border-color: var(--line) !important; margin-left: auto; }
  .delete-topic-btn:hover { border-color: var(--red) !important; background: rgba(239, 83, 80, 0.08); box-shadow: 0 0 14px rgba(239, 83, 80, 0.2) !important; }

  /* Расход токенов — сводка над окном чата (сегодня/всего) и метка под
     каждым ответом модели (сколько ушло на этот конкретный обмен). Оба —
     чисто информационные, ни на что не влияют, просто видимость расхода. */
  .usage-row { font-size: 0.7rem; font-family: var(--font-mono); color: var(--muted); margin-bottom: 8px; display: flex; gap: 14px; flex-wrap: wrap; }
  .usage-row .usage-value { color: var(--text); }

  .terminal-lines {
    display: flex; flex-direction: column; gap: 10px; min-height: 240px;
    padding: 12px; border: 1px solid var(--line); border-radius: var(--card-radius);
    background: rgba(12, 11, 20, 0.4); box-shadow: 0 0 24px rgba(179, 136, 255, 0.05);
  }
  .msg-block { font-family: var(--font-mono); font-size: 0.9rem; max-width: 88%; padding: 8px 10px; border-radius: 8px; }
  /* Сообщения с плеером FlowMusic — на всю доступную ширину, не 88%: у
     текстовых сообщений узкий блок читается лучше, у плеера — наоборот,
     чем шире, тем удобнее целиться в полосу перемотки, особенно с пальца. */
  .msg-block.has-audio { max-width: 100%; }
  .msg-block.role-assistant { align-self: flex-start; margin-right: auto; background: rgba(255, 204, 102, 0.04); border: 1px solid rgba(255, 204, 102, 0.12); }
  .msg-block.role-user { align-self: flex-end; margin-left: auto; background: rgba(179, 136, 255, 0.07); border: 1px solid rgba(179, 136, 255, 0.15); box-shadow: 0 0 14px rgba(179, 136, 255, 0.08); }
  .msg-block.typing { box-shadow: 0 0 14px rgba(255, 204, 102, 0.1); }
  .msg-role { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; padding-bottom: 4px; border-bottom: 1px solid var(--line); margin-bottom: 6px; }
  .role-assistant .msg-role { color: var(--amber); }
  .role-user .msg-role { color: var(--accent); }
  .msg-text { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .msg-text.err { color: var(--red); }
  .msg-text .chat-image { max-width: 100%; border-radius: var(--card-radius); border: 1px solid var(--line); margin-top: 6px; display: block; }

  /* Плеер FlowMusic — раньше был голый <audio controls>, у каждого
     браузера/ОС свой вид (часто нечитаемая заглушка, пока preload="none"
     не дал метаданных, как на скриншоте с жалобой) — теперь свой, тот же
     язык оформления, что у блока кода выше (карточка, граница, шапка). */
  .chat-audio-player {
    display: flex; align-items: center; gap: 10px; margin-top: 6px; padding: 8px 12px;
    border: 1px solid var(--line); border-radius: 10px; background: rgba(0, 0, 0, 0.25);
  }
  .chat-audio-play {
    flex-shrink: 0; width: 34px; height: 34px; border-radius: 50%; display: flex;
    align-items: center; justify-content: center; background: rgba(179, 136, 255, 0.14);
    border: 1px solid rgba(179, 136, 255, 0.4); color: var(--accent); cursor: pointer; padding: 0;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .chat-audio-play:hover { background: rgba(179, 136, 255, 0.24); box-shadow: 0 0 12px rgba(179, 136, 255, 0.25); }
  .chat-audio-play svg { width: 14px; height: 14px; }
  /* margin-left: 2px — визуальный центр треугольника play чуть смещён
     влево от геометрического, без сдвига он выглядит "не по центру". */
  .chat-audio-play .icon-play { margin-left: 2px; }
  .chat-audio-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  /* height: 28px — реальная область клика/тапа под палец, не только
     визуальная толщина полосы (та осталась тонкой — .chat-audio-track-bar
     ниже, по центру благодаря flex). 5px, как было раньше, на телефоне
     физически невозможно точно зацепить пальцем — отсюда и просьба
     "чтобы было удобно кликом, особенно на телефоне". */
  .chat-audio-track { position: relative; height: 28px; display: flex; align-items: center; cursor: pointer; }
  .chat-audio-track-bar { position: relative; width: 100%; height: 6px; border-radius: 3px; background: rgba(255, 255, 255, 0.08); }
  .chat-audio-progress {
    position: absolute; inset: 0; width: 0%; border-radius: 3px; background: var(--accent);
    box-shadow: 0 0 8px rgba(179, 136, 255, 0.5); pointer-events: none;
  }
  .chat-audio-time { font-family: var(--font-mono); font-size: 0.68rem; color: var(--muted); }
  .chat-audio-player.loading .chat-audio-play { opacity: 0.5; pointer-events: none; }

  /* Блок кода из ответа модели (тройные бэктики) — раньше рендерился
     как обычный текст в общем pre-wrap потоке ("простыня"), теперь —
     отдельная карточка с языком, кнопкой "копировать" и кнопкой
     "скачать" (формирует файл нужного расширения на лету, без похода
     на сервер — весь текст уже есть в браузере). */
  .code-block { margin: 8px 0; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; background: rgba(0, 0, 0, 0.25); }
  .code-block-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 8px; background: rgba(255, 255, 255, 0.03); border-bottom: 1px solid var(--line); }
  .code-lang { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; font-family: var(--font-mono); }
  .code-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .code-copy-btn, .code-download-btn {
    background: transparent; border: 1px solid var(--line); color: var(--accent);
    border-radius: 4px; padding: 2px 8px; font-size: 0.65rem; cursor: pointer;
    font-family: var(--font-sans); transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .code-copy-btn:hover, .code-download-btn:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.08); box-shadow: 0 0 10px rgba(179, 136, 255, 0.2); }
  .code-block pre { margin: 0; padding: 10px; overflow-x: auto; }
  .code-block code { font-family: var(--font-mono); font-size: 0.82rem; white-space: pre; }
  /* Токены и время — одна строка (было двумя строками одна под другой),
     весь блок прижат вправо, токены слева от времени внутри него. */
  .msg-meta { display: flex; justify-content: flex-end; align-items: baseline; gap: 8px; margin-top: 4px; }
  .msg-usage { font-size: 0.65rem; color: var(--muted); }
  .msg-time { font-size: 0.65rem; color: var(--muted); }
  .msg-block.typing .msg-text { color: var(--muted); }

  /* position: sticky вместо фиксированной высоты страницы — держит поле
     ввода прижатым к низу ВИДИМОЙ области при прокрутке, но остаётся
     обычным элементом потока страницы, если сообщений мало и страница
     ещё не доросла до полного экрана (в отличие от position: fixed,
     который надо было бы вручную выключать в этом случае). Свой фон —
     обязателен, иначе текст сообщений будет просвечивать сквозь эту
     панель при прокрутке под ней. background: var(--pattern-bg),
     var(--bg) — та же причина, что и у .header/.chat-toolbar выше: то
     же самое непрозрачное, но с текстурой, а не плоской "заплаткой". */
  .input-area {
    position: sticky; bottom: 0; margin-top: 8px; padding-top: 8px;
    padding-bottom: calc(8px + env(safe-area-inset-bottom, 0px));
    background: var(--pattern-bg), var(--bg);
  }
  .input-row {
    display: flex; align-items: center; gap: 8px; font-family: var(--font-mono);
    font-size: 1rem; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--card-radius);
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .attach-btn, .send-btn {
    background: transparent; border: 1px solid var(--line); color: var(--accent);
    border-radius: 4px; padding: 6px; cursor: pointer; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .attach-btn:hover, .send-btn:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.06); box-shadow: 0 0 14px rgba(179, 136, 255, 0.25); }
  .input-row:focus-within { border-color: var(--accent); box-shadow: 0 0 12px rgba(179, 136, 255, 0.2); }
  .input-row textarea {
    flex: 1; background: transparent; border: none; outline: none; resize: none;
    color: var(--text); font-family: var(--font-mono); font-size: 1rem; line-height: 1.4;
    height: calc(1.4em * 3); min-width: 0;
  }
  .input-row textarea::placeholder { color: var(--muted); }
  .input-hint { font-size: 0.6rem; color: var(--muted); font-family: var(--font-mono); margin-top: 3px; text-align: right; }
</style>
</head>
<body>
<div class="page">
  <div class="chat-toolbar">
    <div class="header">
      <div class="header-top">
        <div class="prompt">
          <span class="user">${escapeHtmlServer(username)}</span><span class="muted">@NEXUS404:~$</span> <span class="cmd">./hub</span>
        </div>
        <div class="status-badge">
          <span class="dot-status"></span>
          <span>online</span>
          <a class="logout" id="logoutBtn">выйти</a>
        </div>
      </div>
      <div class="title-row">
        <h1>ЧАТ</h1>
        <a class="back-btn" href="/" id="backBtn">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
          Назад
        </a>
      </div>
    </div>

    <div class="topic-row">
      <select class="provider-select" id="providerSelect">
        <option value="deepseek">DeepSeek</option>
        <option value="gemini">Gemini</option>
        <option value="flowmusic">FlowMusic</option>
        <option value="claude">Claude</option>
      </select>
      <select class="topic-select" id="topicSelect"></select>
      <button id="newTopicBtn" title="новая тема" class="topic-icon-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <button id="deleteTopicBtn" title="удалить текущую тему" class="topic-icon-btn delete-topic-btn">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    </div>

    <div class="usage-row" id="usageRow"></div>
  </div>

  <div class="terminal-lines" id="terminal"></div>

  <div class="input-area">
    <div class="input-row">
      <button class="attach-btn" id="attachBtn" title="прикрепить файл">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
      </button>
      <input type="file" id="fileInput" style="display:none;" />
      <textarea id="chatInput" placeholder="напиши что-нибудь..." rows="3" autocomplete="off"></textarea>
      <button class="send-btn" id="sendBtn" title="отправить">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
      </button>
    </div>
    <div class="input-hint" id="inputHint">Enter — отправить, Shift+Enter — новая строка</div>
  </div>
</div>

<script>
(function () {
  // Толчок скролла — подстраховка на случай ПУСТОЙ темы, когда addBlock
  // ни разу не вызовет свой scrollTo. Возвращаем СВОЮ текущую позицию, не
  // жёсткий 0 — иначе перебивало бы честный автоскролл addBlock вниз.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
    }, 50);
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });

  // Backspace возвращает в хаб — но только если фокус не в текстовом поле
  // (иначе стирание текста в поле ввода чата улетало бы на главную вместо
  // удаления символа — тот же приём и в chrome.js у модулей).
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    var t = document.activeElement;
    var isEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (isEditable) return;
    window.location.href = '/';
  });

  // Замена системного confirm() — та же реализация, что в modules/_shared/chrome.js
  // (держим вручную одинаковыми, общего файла между хабом (TS) и
  // модулями (чистый JS) нет). window.nexusConfirm(message, opts) -> Promise<boolean>.
  window.nexusConfirm = function (message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'nx-confirm-overlay';
      overlay.innerHTML =
        '<div class="nx-confirm-box">' +
          '<div class="nx-confirm-title"></div>' +
          '<div class="nx-confirm-message"></div>' +
          '<div class="nx-confirm-actions">' +
            '<button class="nx-confirm-cancel" type="button"></button>' +
            '<button class="nx-confirm-ok" type="button"></button>' +
          '</div>' +
        '</div>';
      overlay.querySelector('.nx-confirm-title').textContent = opts.title || 'Подтвердите действие';
      overlay.querySelector('.nx-confirm-message').textContent = message;
      overlay.querySelector('.nx-confirm-cancel').textContent = opts.cancelLabel || 'Отмена';
      var okBtn = overlay.querySelector('.nx-confirm-ok');
      okBtn.textContent = opts.okLabel || 'OK';
      if (opts.danger) okBtn.classList.add('danger');
      document.body.appendChild(overlay);
      requestAnimationFrame(function () { overlay.classList.add('show'); });

      function close(result) {
        document.removeEventListener('keydown', onKeydown);
        overlay.classList.remove('show');
        setTimeout(function () { overlay.remove(); }, 150);
        resolve(result);
      }
      function onKeydown(e) {
        if (e.key === 'Escape') close(false);
      }
      document.addEventListener('keydown', onKeydown);
      okBtn.addEventListener('click', function () { close(true); });
      overlay.querySelector('.nx-confirm-cancel').addEventListener('click', function () { close(false); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(false); });
      okBtn.focus();
    });
  };

  const terminal = document.getElementById('terminal');
  const topicSelect = document.getElementById('topicSelect');
  const providerSelect = document.getElementById('providerSelect');
  const chatInput = document.getElementById('chatInput');
  let currentTopicId = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Название темы — не длиннее 20 символов, иначе список растягивается на всю ширину.
  function truncateTitle(title) {
    var t = String(title || '');
    if (t.length <= 20) return t;
    return t.slice(0, 20) + '…';
  }

  function formatTime(iso) {
    try { return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
    catch { return ''; }
  }

  // 1234 -> "1.2k", 999 -> "999" — компактно для строки сводки в шапке.
  function formatTokenCount(n) {
    if (n >= 1000) return (n / 1000).toFixed(1).replace('.0', '') + 'k';
    return String(n);
  }

  // Реальные числа из usage.ts, не оценка. Строка всегда содержит оба
  // span (с "—" вместо чисел) — иначе высота скакала бы при первом ответе.
  async function loadUsage() {
    const usageRow = document.getElementById('usageRow');
    if (!usageRow.dataset.ready) {
      usageRow.innerHTML =
        '<span>токены сегодня: <span class="usage-value" id="usageToday">\u2014</span></span>' +
        '<span>всего: <span class="usage-value" id="usageAll">\u2014</span></span>';
      usageRow.dataset.ready = '1';
    }
    try {
      const res = await fetch('/api/chat/usage');
      const data = await res.json();
      const u = data.usage;
      document.getElementById('usageToday').textContent = u ? formatTokenCount(u.today.totalTokens) : '\u2014';
      document.getElementById('usageAll').textContent = u ? formatTokenCount(u.allTime.totalTokens) : '\u2014';
    } catch {
      // Тихо — это информационная строка, не часть основного потока чата.
    }
  }

  // Расширение файла по языку из тройных бэктиков (\`\`\`js ... \`\`\`) — для
  // имени файла при скачивании. Список — самые ходовые языки, всё
  // незнакомое/отсутствующее падает в обычный .txt, не ошибка.
  const LANG_EXTENSIONS = {
    js: 'js', javascript: 'js', jsx: 'jsx', ts: 'ts', typescript: 'ts', tsx: 'tsx',
    py: 'py', python: 'py', rb: 'rb', ruby: 'rb', go: 'go', golang: 'go',
    rs: 'rs', rust: 'rs', java: 'java', kt: 'kt', kotlin: 'kt', c: 'c',
    cpp: 'cpp', 'c++': 'cpp', cs: 'cs', csharp: 'cs', php: 'php', swift: 'swift',
    html: 'html', css: 'css', scss: 'scss', json: 'json', yaml: 'yaml', yml: 'yaml',
    xml: 'xml', sql: 'sql', sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
    dockerfile: 'dockerfile', md: 'md', markdown: 'md', toml: 'toml', ini: 'ini'
  };

  function extForLang(lang) {
    const key = String(lang || '').toLowerCase().trim();
    return LANG_EXTENSIONS[key] || 'txt';
  }

  // Своя карточка плеера вместо системного <audio controls> (см. CSS
  // .chat-audio-player выше и разметку в formatMessageText ниже) — click/
  // play/pause через делегирование не годится: события <audio> (timeupdate,
  // ended, loadedmetadata) не всплывают по спецификации HTML5 вообще,
  // единственный способ — навесить слушатели на каждый <audio> отдельно,
  // сразу после того, как он реально попал в DOM (innerHTML не запускает
  // никакие обработчики сам по себе).
  function wireAudioPlayers(container) {
    container.querySelectorAll('[data-audio-player]').forEach(function (player) {
      const audio = player.querySelector('audio');
      const playBtn = player.querySelector('.chat-audio-play');
      const iconPlay = player.querySelector('.icon-play');
      const iconPause = player.querySelector('.icon-pause');
      const track = player.querySelector('.chat-audio-track');
      const progress = player.querySelector('.chat-audio-progress');
      const timeEl = player.querySelector('.chat-audio-time');

      function fmt(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return m + ':' + (s < 10 ? '0' : '') + s;
      }

      playBtn.addEventListener('click', function () {
        if (audio.paused) audio.play().catch(function () {}); else audio.pause();
      });
      audio.addEventListener('play', function () {
        iconPlay.style.display = 'none';
        iconPause.style.display = '';
      });
      audio.addEventListener('pause', function () {
        iconPlay.style.display = '';
        iconPause.style.display = 'none';
      });
      audio.addEventListener('ended', function () {
        iconPlay.style.display = '';
        iconPause.style.display = 'none';
        progress.style.width = '0%';
        // Проигрывание по порядку сверху вниз — не только внутри одного
        // сообщения (FlowMusic обычно даёт сразу 2 варианта), а по всему
        // чату целиком: следующий трек — это следующий <audio> в DOM,
        // а DOM-порядок и есть порядок сообщений на экране.
        const allPlayers = terminal.querySelectorAll('[data-audio-player] audio');
        const idx = Array.prototype.indexOf.call(allPlayers, audio);
        const next = allPlayers[idx + 1];
        if (next) next.play().catch(function () {});
      });
      audio.addEventListener('loadedmetadata', function () {
        timeEl.textContent = fmt(0) + ' / ' + fmt(audio.duration);
      });
      audio.addEventListener('timeupdate', function () {
        const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
        progress.style.width = pct + '%';
        timeEl.textContent = fmt(audio.currentTime) + ' / ' + fmt(audio.duration || 0);
      });
      // Клик по треку — перемотка на позицию клика, не только play/pause.
      track.addEventListener('click', function (e) {
        if (!audio.duration) return;
        const rect = track.getBoundingClientRect();
        const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        audio.currentTime = pct * audio.duration;
      });
    });
  }

  // Простой markdown: код тройными бэктиками, **жирный**, картинки ![alt](url).
  // Код вырезается первым и заменяется заглушкой — иначе ** внутри кода
  // задело бы последующий replace для жирного текста.
  function formatMessageText(text) {
    let result = escapeHtml(text);

    const codeBlocks = [];
    result = result.replace(/\`\`\`([a-zA-Z0-9+#-]*)\\n?([\\s\\S]*?)\`\`\`/g, function (match, lang, code) {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang || '', code: code.replace(/\\n$/, '') });
      return '\u0000CODEBLOCK' + idx + '\u0000';
    });

    result = result.replace(/!\\[([^\\]]*)\\]\\(([^)]+)\\)/g, '<img src="$2" alt="$1" class="chat-image" loading="lazy" />');
    // FlowMusic отдаёт !audio(URL) — своя карточка с play/pause и прогресс-
    // баром (тот же язык оформления, что у блока кода выше), не голый
    // системный <audio controls> — у того на разных браузерах/ОС разный
    // вид, часто нечитаемая заглушка, пока preload="none" не подтянул
    // метаданные. url уже прошёл escapeHtml вместе со всем текстом
    // выше — та же безопасная схема, что и у ![alt](url) для картинок.
    result = result.replace(/!audio\\(([^)]+)\\)/g, function (match, url) {
      return '<div class="chat-audio-player" data-audio-player>' +
        '<button class="chat-audio-play" type="button" aria-label="Играть">' +
          '<svg class="icon-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>' +
          '<svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" style="display:none"><path d="M6 5h4v14H6zM14 5h4v14h-4z"></path></svg>' +
        '</button>' +
        '<div class="chat-audio-body">' +
          '<div class="chat-audio-track"><div class="chat-audio-track-bar"><div class="chat-audio-progress"></div></div></div>' +
          '<span class="chat-audio-time">0:00</span>' +
        '</div>' +
        '<audio preload="metadata" src="' + url + '"></audio>' +
      '</div>';
    });
    result = result.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

    result = result.replace(/\u0000CODEBLOCK(\\d+)\u0000/g, function (m, i) {
      const block = codeBlocks[Number(i)];
      if (!block) return '';
      const langLabel = block.lang ? block.lang : 'text';
      const ext = extForLang(block.lang);
      return (
        '<div class="code-block">' +
          '<div class="code-block-header">' +
            '<span class="code-lang">' + escapeHtml(langLabel) + '</span>' +
            '<div class="code-actions">' +
              '<button class="code-copy-btn" type="button">копировать</button>' +
              '<button class="code-download-btn" type="button" data-ext="' + ext + '">скачать</button>' +
            '</div>' +
          '</div>' +
          '<pre><code>' + block.code + '</code></pre>' +
        '</div>'
      );
    });

    return result;
  }

  function addBlock(role, text, opts) {
    opts = opts || {};
    const block = document.createElement('div');
    block.className = 'msg-block role-' + (role === 'ты' ? 'user' : 'assistant') + (opts.typing ? ' typing' : '');
    const roleEl = document.createElement('div');
    roleEl.className = 'msg-role';
    if (role === 'ты') {
      roleEl.textContent = 'ТЫ';
    } else {
      // Подпись — реальная модель из сохранённого сообщения, не текущий переключатель.
      const providerNames = { deepseek: 'DEEPSEEK', gemini: 'GEMINI', flowmusic: 'FLOWMUSIC', claude: 'CLAUDE' };
      let label = providerNames[opts.provider] || providerSelect.value.toUpperCase();
      // 'deepseek-v4-pro' оставлен в карте только ради подписи у СТАРЫХ
      // сообщений в истории — выбора Flash/Pro для новых больше нет.
      const deepseekModelNames = { 'deepseek-v4-flash': 'FLASH', 'deepseek-v4-pro': 'PRO' };
      if (opts.provider === 'deepseek' && deepseekModelNames[opts.model]) {
        label += ' · ' + deepseekModelNames[opts.model];
      }
      roleEl.textContent = label;
    }
    const textEl = document.createElement('div');
    textEl.className = 'msg-text' + (opts.err ? ' err' : '');
    if (opts.typing || opts.err) {
      textEl.textContent = text;
    } else {
      textEl.innerHTML = formatMessageText(text);
      wireAudioPlayers(textEl);
      if (textEl.querySelector('[data-audio-player]')) block.classList.add('has-audio');
    }
    block.appendChild(roleEl);
    block.appendChild(textEl);
    if (!opts.typing) {
      // Токены и время — в одну строку (было двумя отдельными строками
      // одна под другой) — порядок слева направо: сначала расход
      // токенов, время последним.
      const metaEl = document.createElement('div');
      metaEl.className = 'msg-meta';

      if (role !== 'ты' && opts.usage) {
        const usageEl = document.createElement('span');
        usageEl.className = 'msg-usage';
        usageEl.textContent = formatTokenCount(opts.usage.totalTokens) + ' ток. (' +
          formatTokenCount(opts.usage.promptTokens) + ' + ' + formatTokenCount(opts.usage.completionTokens) + ')';
        metaEl.appendChild(usageEl);
      }

      const timeEl = document.createElement('span');
      timeEl.className = 'msg-time';
      timeEl.textContent = opts.time ? formatTime(opts.time) : formatTime(new Date().toISOString());
      metaEl.appendChild(timeEl);

      block.appendChild(metaEl);
    }
    terminal.appendChild(block);
    // Скроллится вся страница, не .terminal-lines — поле ввода прижато
    // снизу через sticky, окажется у края экрана само.
    window.scrollTo(0, document.documentElement.scrollHeight);
    return block;
  }

  // Один делегирующий обработчик на весь контейнер — блоки кода
  // появляются/исчезают динамически. textContent у <code> отдаёт код в
  // исходном виде, HTML-сущности браузер раскодирует сам.
  terminal.addEventListener('click', function (e) {
    const copyBtn = e.target.closest ? e.target.closest('.code-copy-btn') : null;
    const downloadBtn = e.target.closest ? e.target.closest('.code-download-btn') : null;
    if (!copyBtn && !downloadBtn) return;

    const wrap = (copyBtn || downloadBtn).closest('.code-block');
    const codeEl = wrap ? wrap.querySelector('code') : null;
    const code = codeEl ? codeEl.textContent : '';

    if (copyBtn) {
      navigator.clipboard.writeText(code).then(function () {
        const old = copyBtn.textContent;
        copyBtn.textContent = 'скопировано';
        setTimeout(function () { copyBtn.textContent = old; }, 1200);
      }).catch(function () {
        copyBtn.textContent = 'не вышло';
        setTimeout(function () { copyBtn.textContent = 'копировать'; }, 1200);
      });
      return;
    }

    if (downloadBtn) {
      const ext = downloadBtn.dataset.ext || 'txt';
      const blob = new Blob([code], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'code-' + Date.now() + '.' + ext;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }
  });

  // allTopics — список со всех ИИ разом, фильтруется на клиенте — проще,
  // чем спрашивать сервер на каждое переключение списка.
  let allTopics = [];

  function topicsForProvider(provider) {
    return allTopics.filter(function (t) { return t.provider === provider; });
  }

  // preferredId — если после пересборки списка нужно выбрать конкретную
  // тему (например, только что созданную), а не просто первую в списке.
  function renderTopicOptions(topics, preferredId) {
    if (topics.length === 0) {
      // Не создаём тему автоматически — список должен быть пустым,
      // пока пользователь сам не нажмёт "+ новая тема".
      topicSelect.innerHTML = '<option value=""></option>';
      currentTopicId = null;
      setChatEnabled(false);
      terminal.innerHTML = '';
      return Promise.resolve();
    }
    topicSelect.innerHTML = topics.map(function (t) {
      return '<option value="' + t.id + '">' + escapeHtml(truncateTitle(t.title)) + '</option>';
    }).join('');
    const selected = preferredId && topics.some(function (t) { return t.id === preferredId; }) ? preferredId : topics[0].id;
    topicSelect.value = selected;
    currentTopicId = selected;
    setChatEnabled(true);
    return loadMessages();
  }

  async function loadTopics() {
    const res = await fetch('/api/chat/topics');
    const data = await res.json();
    allTopics = data.topics || [];
    await renderTopicOptions(topicsForProvider(providerSelect.value));
  }

  // Пока нет ни одной темы, само поле ввода/кнопки — заблокированы, а не
  // просто "тихо ничего не делают" при попытке отправить.
  function setChatEnabled(enabled) {
    chatInput.disabled = !enabled;
    document.getElementById('sendBtn').disabled = !enabled;
    document.getElementById('attachBtn').disabled = !enabled;
    chatInput.placeholder = enabled ? 'напиши что-нибудь...' : 'сначала создай тему';
  }

  async function loadMessages() {
    terminal.innerHTML = '';
    const res = await fetch('/api/chat/' + currentTopicId + '/messages');
    const data = await res.json();
    (data.messages || []).forEach(function (m) {
      addBlock(m.role === 'user' ? 'ты' : 'ассистент', m.content, { time: m.timestamp, provider: m.provider, model: m.model, usage: m.usage });
    });
  }

  topicSelect.addEventListener('change', function () {
    currentTopicId = topicSelect.value;
    loadMessages();
  });

  // Переключение ИИ теперь переключает не модель для следующего
  // сообщения, а СПИСОК тем, который сейчас показан — у каждого ИИ свой,
  // отдельный (правка по просьбе "каждый ИИ запоминал свои чаты").
  providerSelect.addEventListener('change', function () {
    renderTopicOptions(topicsForProvider(providerSelect.value));
  });

  document.getElementById('newTopicBtn').addEventListener('click', async () => {
    const title = prompt('Название темы:');
    if (!title) return;
    const created = await (await fetch('/api/chat/topics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: title, provider: providerSelect.value }),
    })).json();
    allTopics.push(created);
    await renderTopicOptions(topicsForProvider(providerSelect.value), created.id);
  });

  document.getElementById('deleteTopicBtn').addEventListener('click', async () => {
    if (!currentTopicId) return;
    const title = topicSelect.options[topicSelect.selectedIndex]
      ? topicSelect.options[topicSelect.selectedIndex].textContent
      : 'эту тему';
    if (!(await nexusConfirm('Удалить тему "' + title + '"? Вся история разговора удалится безвозвратно.', { okLabel: 'Удалить', danger: true }))) return;

    await fetch('/api/chat/topics/' + currentTopicId, { method: 'DELETE' });

    const res = await fetch('/api/chat/topics');
    const data = await res.json();
    allTopics = data.topics || [];
    await renderTopicOptions(topicsForProvider(providerSelect.value));
  });

  async function sendCurrentMessage() {
    const text = chatInput.value.trim();
    if (!text || !currentTopicId) return;
    chatInput.value = '';
    addBlock('ты', text, { time: new Date().toISOString() });

    const typingBlock = addBlock('ассистент', '...', { typing: true });

    // Выбора Flash/Pro больше нет — сервер сам подставит дефолт, если
    // body.model не передан (см. resolveDeepSeekModel в chat/providers.ts).
    const body = { content: text };

    try {
      const res = await fetch('/api/chat/' + currentTopicId + '/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      typingBlock.remove();
      if (data.assistantMessage) {
        addBlock('ассистент', data.assistantMessage.content, {
          time: data.assistantMessage.timestamp,
          provider: data.assistantMessage.provider,
          model: data.assistantMessage.model,
          usage: data.assistantMessage.usage,
        });
        loadUsage(); // обновить сводку сегодня/всего после реального ответа
      } else if (data.error) {
        // details — реальный текст ошибки от провайдера, показываем сразу.
        const text = data.details ? data.error + '\\n' + data.details : data.error;
        addBlock('ассистент', text, { err: true, time: new Date().toISOString() });
      }
    } catch {
      typingBlock.remove();
      addBlock('ассистент', 'не удалось отправить сообщение', { err: true, time: new Date().toISOString() });
    }
  }

  document.getElementById('sendBtn').addEventListener('click', sendCurrentMessage);

  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  document.getElementById('inputHint').textContent = isCoarsePointer
    ? 'кнопка справа — отправить'
    : 'Enter — отправить, Shift+Enter — новая строка';

  chatInput.addEventListener('keydown', async function (e) {
    if (isCoarsePointer) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      await sendCurrentMessage();
    }
  });

  // ---- вложения ----
  const fileInput = document.getElementById('fileInput');
  document.getElementById('attachBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async function () {
    const file = fileInput.files[0];
    if (!file || !currentTopicId) return;
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/chat/' + currentTopicId + '/attachments', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.url) {
        chatInput.value += (chatInput.value ? '\\n' : '') + '📎 ' + data.filename + ': ' + data.url;
      }
    } catch {}
    fileInput.value = '';
  });

  loadTopics();
  loadUsage();
})();
</script>
</body>
</html>`;
}
