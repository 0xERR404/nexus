// NEXUS404 — модуль "Системные ресурсы".
//
// Показывает CPU/RAM/диск/сеть/аптайм: своего сервера (через смонтированные
// host-bridge'ом /host/proc, /host/root — см. metrics.js) и удалённых
// серверов, где поставлен агент (см. ../../agent/). История — на диске в
// /app/data (персистентная папка модуля, см. bridge.py), переживает
// перезапуск хаба.

const http = require('node:http');
const os = require('node:os');
const { renderPage } = require('./chrome.js');
const { collectLocalMetrics } = require('./metrics.js');
const store = require('./store.js');

const PORT = process.env.MODULE_PORT || 4004;
const HUB_HOST = process.env.HUB_HOST || 'hub';
const HUB_PORT = process.env.HUB_PORT || 3000;
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';

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

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // защита от неадекватно большого тела
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Сбор ЛОКАЛЬНЫХ метрик — раз в SAMPLE_INTERVAL_MS. Имя сервера
// резолвится ОДИН раз при старте процесса (store.resolveLocalServerName —
// LOCAL_SERVER_NAME, если задан, иначе то, что сохранено в /app/data с
// прошлого запуска, иначе генерируется и сохраняется заново), не на
// каждый тик — переименование через интерфейс убрано (задаётся только на
// этапе деплоя), перечитывать нечего, а лишний файловый I/O на каждую
// секунду ни к чему. Смена имени происходит только пересозданием
// контейнера с новым LOCAL_SERVER_NAME — это уже новый процесс, кэш
// пересчитается сам.
// Честная оговорка: если сервер переименовать, старая запись под старым
// именем никуда не денется из списка (там же осталась история) — просто
// перестанет обновляться и через OFFLINE_AFTER_MS уйдёт в "оффлайн".
// Отдельного удаления так и не сделано, можно добавить позже.
// ---------------------------------------------------------------------------
let localServerNamePromise = null;

async function collectLoop() {
  try {
    if (!localServerNamePromise) {
      localServerNamePromise = store.resolveLocalServerName(os.hostname());
    }
    const name = await localServerNamePromise;
    const metrics = await collectLocalMetrics();
    await store.recordSample(name, true, metrics);
  } catch (err) {
    console.error('[monitoring] ошибка сбора локальных метрик:', err);
  }
}
collectLoop();
setInterval(collectLoop, store.SAMPLE_INTERVAL_MS);
setInterval(() => store.pruneOldHistory().catch(() => {}), 60 * 60 * 1000);
store.restoreLatestFromHistory().catch((err) => console.error('[monitoring] восстановление истории:', err));

// ---------------------------------------------------------------------------
// Разметка страницы. Списки серверов и графики — целиком клиентские
// (polling), сервер отдаёт только пустые контейнеры под них.
// ---------------------------------------------------------------------------
const BODY_CONTENT = `
  <section>
    <div class="section-title">серверы</div>
    <div id="serversList" class="servers-list">
      <div class="empty-note">загружаю...</div>
    </div>
  </section>

  <section>
    <div class="section-title">графики</div>
    <div class="box">
      <div class="row graph-controls-row" style="margin-bottom: 12px;">
        <select id="graphServerSelect"></select>
        <div class="range-buttons">
          <button class="icon-btn range-btn" data-hours="1" id="rangeBtn1h">1ч</button>
          <button class="icon-btn range-btn" data-hours="24" id="rangeBtn24h">24ч</button>
        </div>
      </div>
      <div class="chart-block">
        <div class="chart-label">CPU, %</div>
        <canvas id="chartCpu" width="900" height="110"></canvas>
      </div>
      <div class="chart-block">
        <div class="chart-label">RAM, %</div>
        <canvas id="chartRam" width="900" height="110"></canvas>
      </div>
      <div class="chart-block">
        <div class="chart-label">Диск, %</div>
        <canvas id="chartDisk" width="900" height="110"></canvas>
      </div>
      <div class="chart-block">
        <div class="chart-label"><span style="color:#b388ff;">■</span> приём &nbsp; <span style="color:#ffcc66;">■</span> отдача — КБ/с</div>
        <canvas id="chartNet" width="900" height="110"></canvas>
      </div>
    </div>
  </section>

  <section>
    <div class="section-title">агент для удалённых серверов</div>
    <div class="box">
      <div class="empty-note">
        На нужном сервере (не на этом):
        <br /><code>curl -fsSL https://raw.githubusercontent.com/0xERR404/nexus/main/menu.sh | sudo bash</code>
        <br />и выбрать пункт 4 — "Агент мониторинга — установка на ЭТОТ сервер". Не требует Docker и не зависит от остальных пунктов меню.
        <br />Спросит имя сервера, URL хаба и токен агентов (генерируется здесь же, в разделе AI API — "мониторинг — общий токен агентов"). Появится в списке выше в течение пары секунд.
      </div>
    </div>
  </section>
`;

const EXTRA_HEAD = `
  /* auto-fill вместо жёсткого "1fr 1fr" — раньше карточка сервера всегда
     растягивалась на половину ширины страницы, даже когда реального
     содержимого (4 коротких строки CPU/RAM/Диск/Сеть) там на треть
     меньше — отсюда и жалоба "очень широко получается". Теперь ширина
     карточки — по содержимому, до 320px, и они сами переносятся, если
     не помещаются в ряд. */
  .servers-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 320px)); gap: 12px; }
  @media (max-width: 700px) {
    .servers-list { grid-template-columns: 1fr; }
    .server-card { padding: 10px 12px; }
    .server-card-head { font-size: 0.85rem; gap: 6px; margin-bottom: 8px; }
    .mini-grid { row-gap: 5px; font-size: 0.78rem; }
    .mini-label { font-size: 0.68rem; }
  }
  .range-buttons { display: flex; gap: 8px; }
  @media (max-width: 480px) {
    .graph-controls-row {
      flex-wrap: nowrap;
      gap: 6px;
      font-size: 0.7rem;
    }
    .graph-controls-row #graphServerSelect {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 40vw;
      text-overflow: ellipsis;
      padding: 4px 4px;
    }
    .graph-controls-row .range-buttons { margin-left: auto; flex-shrink: 0; }
    .graph-controls-row .range-btn { padding: 4px 8px; flex-shrink: 0; }
  }
  .server-card { border: 1px solid var(--line); border-radius: var(--card-radius); padding: 12px 14px; background: rgba(12, 11, 20, 0.4); min-width: 0; overflow: hidden; transition: border-color 0.15s, box-shadow 0.15s; }
  .server-card:hover { border-color: var(--accent); box-shadow: 0 0 16px rgba(179, 136, 255, 0.12); }
  .server-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-family: var(--font-mono); font-size: 0.85rem; min-width: 0; }
  .server-card-head .delete-server-btn { padding: 4px 9px; }
  .server-card-head .server-name { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .server-card-head .badge { font-size: 0.65rem; color: var(--accent); border: 1px solid rgba(179, 136, 255, 0.4); border-radius: 3px; padding: 2px 7px; flex-shrink: 0; box-shadow: 0 0 10px rgba(179, 136, 255, 0.15); }
  /* Одна колонка (было 2 — CPU/RAM в одну строку, Диск/Сеть в другую) —
     после того как сама карточка сузилась (см. врезку про .servers-list
     выше), двум колонкам стало тесно: длинные значения вроде "742.3 МБ /
     3.8 ГБ" обрезались многоточием и вылезали за правый край карточки.
     Одна колонка — каждая строка на всю ширину карточки, значению есть
     где поместиться, и заодно ещё честнее по анти-дрожащей логике ниже:
     при одной колонке смена числа цифр вообще не может ничего сдвинуть
     по горизонтали — делить нечего. */
  .mini-grid { display: grid; grid-template-columns: 1fr; row-gap: 6px; font-family: var(--font-mono); font-size: 0.8rem; }
  .mini-grid > div { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
  .mini-label { color: var(--muted); flex-shrink: 0; }
  .mini-value { color: var(--text); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .mini-uptime { margin-top: 10px; font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); }
  .chart-block { margin-bottom: 16px; }
  .chart-block:last-child { margin-bottom: 0; }
  .chart-label { font-family: var(--font-mono); font-size: 0.75rem; color: var(--muted); margin-bottom: 4px; }
  .chart-block canvas { width: 100%; height: 110px; display: block; border: 1px solid var(--line); border-radius: 4px; }
  #graphServerSelect { background: transparent; border: 1px solid var(--line); border-radius: 4px; color: var(--text); font-family: var(--font-mono); padding: 4px 8px; }
  #graphServerSelect option { background: var(--bg); color: var(--text); }
  .range-btn.active { border-color: var(--accent); background: rgba(179, 136, 255, 0.15); color: var(--text); box-shadow: 0 0 12px rgba(179, 136, 255, 0.2); }
`;

const EXTRA_SCRIPT = `
  function formatBytes(n) {
    if (!n || n <= 0) return '0 Б';
    var units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
    var i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return (n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1) + ' ' + units[i];
  }
  function formatRate(bytesPerSec) {
    return formatBytes(bytesPerSec) + '/с';
  }
  function formatUptime(seconds) {
    seconds = Math.floor(seconds || 0);
    var days = Math.floor(seconds / 86400);
    var hours = Math.floor((seconds % 86400) / 3600);
    var minutes = Math.floor((seconds % 3600) / 60);
    if (days > 0) return days + 'д ' + hours + 'ч';
    if (hours > 0) return hours + 'ч ' + minutes + 'м';
    return minutes + 'м';
  }
  function percent(used, total) {
    if (!total || total <= 0) return 0;
    return Math.min(100, (used / total) * 100);
  }

  var serversList = document.getElementById('serversList');
  var graphServerSelect = document.getElementById('graphServerSelect');
  var knownServerNames = [];

  function renderServerCard(s) {
    var deleteBtn = s.online
      ? '<button class="icon-btn delete-server-btn" disabled title="сервер ещё активен — удаление бессмысленно, отчёт придёт заново через пару секунд" style="margin-left:auto; opacity:0.35; cursor:not-allowed;">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
        '</button>'
      : '<button class="icon-btn delete-server-btn" data-name="' + s.name + '" title="удалить из списка" style="margin-left:auto;">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
        '</button>';
    var head = '<div class="server-card-head">' +
      '<span class="dot ' + (s.online ? 'set' : 'unset') + '"></span>' +
      '<span class="server-name">' + s.name + '</span>' +
      (s.isLocal ? '<span class="badge">этот сервер</span>' : '') +
      deleteBtn +
      '</div>';
    var grid = '<div class="mini-grid">' +
      '<div><span class="mini-label">CPU</span><span class="mini-value">' + (s.cpuPercent || 0).toFixed(0) + '% · ' + (s.cpuCores || 1) + ' ядер</span></div>' +
      '<div><span class="mini-label">RAM</span><span class="mini-value">' + formatBytes(s.ramUsedBytes) + ' / ' + formatBytes(s.ramTotalBytes) + '</span></div>' +
      '<div><span class="mini-label">Диск</span><span class="mini-value">' + formatBytes(s.diskUsedBytes) + ' / ' + formatBytes(s.diskTotalBytes) + '</span></div>' +
      '<div><span class="mini-label">Сеть</span><span class="mini-value">\u2193 ' + formatRate(s.netRxBytesPerSec) + ' · \u2191 ' + formatRate(s.netTxBytesPerSec) + '</span></div>' +
      '</div>';
    var uptime = '<div class="mini-uptime">аптайм: ' + formatUptime(s.uptimeSeconds) + '</div>';
    return '<div class="server-card" data-server-card="' + s.name + '">' + head + grid + uptime + '</div>';
  }

  // Обновляет ТОЛЬКО текст внутри уже существующей карточки — не трогает
  // DOM (см. loadServers ниже: полная пересборка через renderServerCard
  // нужна лишь когда меняется сам СОСТАВ серверов, не когда просто
  // подъехали новые цифры). Раньше карточка пересоздавалась целиком
  // каждую секунду (opросы realtime) — визуально "дёргалась" даже когда
  // менялись только числа, из-за чего казалось, что обновление
  // прерывистое, не по-настоящему realtime.
  function updateServerCardValues(s) {
    var card = serversList.querySelector('[data-server-card="' + CSS.escape(s.name) + '"]');
    if (!card) return;
    var dot = card.querySelector('.dot');
    if (dot) dot.className = 'dot ' + (s.online ? 'set' : 'unset');
    var values = card.querySelectorAll('.mini-value');
    if (values[0]) values[0].textContent = (s.cpuPercent || 0).toFixed(0) + '% · ' + (s.cpuCores || 1) + ' ядер';
    if (values[1]) values[1].textContent = formatBytes(s.ramUsedBytes) + ' / ' + formatBytes(s.ramTotalBytes);
    if (values[2]) values[2].textContent = formatBytes(s.diskUsedBytes) + ' / ' + formatBytes(s.diskTotalBytes);
    if (values[3]) values[3].textContent = '\u2193 ' + formatRate(s.netRxBytesPerSec) + ' · \u2191 ' + formatRate(s.netTxBytesPerSec);
    var uptimeEl = card.querySelector('.mini-uptime');
    if (uptimeEl) uptimeEl.textContent = 'аптайм: ' + formatUptime(s.uptimeSeconds);
    var deleteBtn = card.querySelector('.delete-server-btn');
    if (deleteBtn) {
      var shouldDisable = Boolean(s.online);
      if (deleteBtn.disabled !== shouldDisable) {
        deleteBtn.disabled = shouldDisable;
        deleteBtn.title = shouldDisable
          ? 'сервер ещё активен — удаление бессмысленно, отчёт придёт заново через пару секунд'
          : 'удалить из списка';
        deleteBtn.style.opacity = shouldDisable ? '0.35' : '';
        deleteBtn.style.cursor = shouldDisable ? 'not-allowed' : '';
        if (shouldDisable) deleteBtn.removeAttribute('data-name');
        else deleteBtn.setAttribute('data-name', s.name);
      }
    }
  }

  // Делегирование клика — карточки перерисовываются целиком на каждый
  // опрос (innerHTML), вешать обработчик на каждую кнопку заново после
  // каждой перерисовки бессмысленно, слушаем один раз на контейнере.
  serversList.addEventListener('click', async function (e) {
    var btn = e.target.closest('.delete-server-btn');
    if (!btn) return;
    var name = btn.getAttribute('data-name');
    if (!confirm('Удалить сервер "' + name + '" из списка? История метрик тоже удалится безвозвратно.')) return;
    try {
      var res = await fetch('api/servers/' + encodeURIComponent(name), { method: 'DELETE' });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        alert(data.error || ('не удалось удалить: HTTP ' + res.status));
      }
      loadServers();
    } catch {
      alert('не удалось удалить — сервер модуля не ответил');
    }
  });

  async function loadServers() {
    try {
      var res = await fetch('api/servers');
      var data = await res.json();
      var servers = data.servers || [];
      if (servers.length === 0) {
        serversList.innerHTML = '<div class="empty-note">пока нет данных — подожди первый цикл сбора (~5с) или разверни агента на удалённом сервере</div>';
        knownServerNames = [];
        return;
      }

      var names = servers.map(function (s) { return s.name; });
      var structureChanged = names.join('|') !== knownServerNames.join('|');
      if (structureChanged) {
        serversList.innerHTML = servers.map(renderServerCard).join('');
      } else {
        // Состав серверов тот же — обновляем цифры в уже существующих
        // карточках на месте (см. updateServerCardValues), не пересоздаём
        // DOM. Полная пересборка — только когда реально что-то появилось
        // или пропало из списка.
        servers.forEach(updateServerCardValues);
      }

      if (structureChanged) {
        knownServerNames = names;
        var prevSelected = graphServerSelect.value;
        graphServerSelect.innerHTML = names.map(function (n) {
          return '<option value="' + n + '">' + n + '</option>';
        }).join('');
        if (names.includes(prevSelected)) graphServerSelect.value = prevSelected;
        loadGraphs();
      }
    } catch {
      serversList.innerHTML = '<div class="empty-note">не удалось загрузить</div>';
      knownServerNames = [];
    }
  }

  function formatAxisValue(v, unit) {
    if (unit === '%') return Math.round(v) + '%';
    if (v >= 1024) return (v / 1024).toFixed(1) + ' МБ/с';
    return Math.round(v) + ' КБ/с';
  }

  // Подписи у рисок — максимум, середина и ноль. Рисуются ПОСЛЕ линии
  // данных (последним слоем), иначе линия могла бы перекрыть текст —
  // сама риска и направляющие, наоборот, рисуются ДО линии, фоном.
  // Готовит canvas к рисованию: подгоняет внутреннее разрешение под
  // реальный CSS-размер элемента С УЧЁТОМ плотности пикселей экрана
  // (devicePixelRatio) — раньше у canvas было жёстко зашитое разрешение
  // 900×110 (HTML-атрибуты width/height), а CSS растягивал его на 100%
  // ширины контейнера — на экране уже/шире 900px и на retina-дисплеях
  // (где 1 CSS-пиксель — это 2+ физических) это давало смазанную,
  // непропорционально растянутую картинку и подписи "не в размер" —
  // и есть та самая "странная" картинка. Теперь: внутреннее разрешение
  // = реальный CSS-размер × devicePixelRatio, контекст масштабируется
  // обратно, чтобы координаты внутри drawChart остались в CSS-пикселях
  // (та же арифметика x/y, что и раньше, но по-настоящему совпадает с
  // тем, что видно на экране).
  function setupCanvas(canvas) {
    var dpr = window.devicePixelRatio || 1;
    var cssWidth = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
    var cssHeight = canvas.clientHeight || 110;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: cssWidth, h: cssHeight };
  }

  function drawAxisLabels(ctx, w, h, maxV, unit) {
    ctx.fillStyle = 'rgba(221, 214, 255, 0.65)';
    ctx.font = '9px monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(formatAxisValue(maxV, unit), 8, 2);
    ctx.textBaseline = 'middle';
    ctx.fillText(formatAxisValue(maxV / 2, unit), 8, h / 2);
    ctx.textBaseline = 'bottom';
    ctx.fillText(formatAxisValue(0, unit), 8, h - 2);
  }

  // Риски "как у линейки" по левому и правому краю на нескольких уровнях
  // высоты — визуальная привязка к масштабу, плюс лёгкие горизонтальные
  // направляющие через весь график на тех же уровнях. Числовые подписи —
  // отдельной функцией выше, рисуются поверх линии данных.
  function drawRuler(ctx, w, h) {
    var divisions = 4;
    ctx.strokeStyle = 'rgba(179, 136, 255, 0.12)';
    ctx.lineWidth = 1;
    for (var i = 0; i <= divisions; i++) {
      var y = Math.round((i / divisions) * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(221, 214, 255, 0.35)';
    var tickLen = 5;
    for (var j = 0; j <= divisions; j++) {
      var ty = Math.round((j / divisions) * h) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, ty);
      ctx.lineTo(tickLen, ty);
      ctx.moveTo(w - tickLen, ty);
      ctx.lineTo(w, ty);
      ctx.stroke();
    }
  }

  function drawChart(canvas, seriesList, maxOverride, unit) {
    var setup = setupCanvas(canvas);
    var ctx = setup.ctx, w = setup.w, h = setup.h;
    ctx.clearRect(0, 0, w, h);
    drawRuler(ctx, w, h);
    var allValues = [];
    seriesList.forEach(function (s) { allValues = allValues.concat(s.values); });
    if (!allValues.length) {
      ctx.fillStyle = '#7a72a0';
      ctx.font = '12px monospace';
      ctx.fillText('недостаточно данных — подожди пару минут', 8, h / 2);
      return;
    }
    var maxV = maxOverride != null ? maxOverride : Math.max.apply(null, allValues);
    if (maxV <= 0) maxV = 1;
    seriesList.forEach(function (s) {
      if (!s.values.length) return;
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = 1.5;
      if (s.values.length === 1) {
        // Линию из одной точки нарисовать нечем (moveTo без единого
        // lineTo ничего не рисует) — рисуем маркер, чтобы график не был
        // просто пустым сразу после первых сэмплов.
        var y0 = h - (Math.min(s.values[0], maxV) / maxV) * h;
        ctx.beginPath();
        ctx.arc(2, y0, 2.5, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      s.values.forEach(function (v, i) {
        var x = (i / (s.values.length - 1 || 1)) * w;
        var y = h - (Math.min(v, maxV) / maxV) * h;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
    drawAxisLabels(ctx, w, h, maxV, unit);
  }

  var currentGraphHours = 1;
  var rangeBtn1h = document.getElementById('rangeBtn1h');
  var rangeBtn24h = document.getElementById('rangeBtn24h');

  function setActiveRangeBtn() {
    rangeBtn1h.className = 'icon-btn range-btn' + (currentGraphHours === 1 ? ' active' : '');
    rangeBtn24h.className = 'icon-btn range-btn' + (currentGraphHours === 24 ? ' active' : '');
  }
  setActiveRangeBtn();

  [rangeBtn1h, rangeBtn24h].forEach(function (btn) {
    btn.addEventListener('click', function () {
      currentGraphHours = Number(btn.getAttribute('data-hours'));
      setActiveRangeBtn();
      loadGraphs();
    });
  });

  async function loadGraphs() {
    var name = graphServerSelect.value;
    if (!name) return;
    try {
      var res = await fetch('api/servers/' + encodeURIComponent(name) + '/history?hours=' + currentGraphHours);
      var data = await res.json();
      var points = data.points || [];
      var cpu = points.map(function (p) { return p.cpuPercent || 0; });
      var ram = points.map(function (p) { return percent(p.ramUsedBytes, p.ramTotalBytes); });
      var disk = points.map(function (p) { return percent(p.diskUsedBytes, p.diskTotalBytes); });
      var rx = points.map(function (p) { return (p.netRxBytesPerSec || 0) / 1024; });
      var tx = points.map(function (p) { return (p.netTxBytesPerSec || 0) / 1024; });

      [['chartCpu', 'canvas'], ['chartRam', 'canvas'], ['chartDisk', 'canvas'], ['chartNet', 'canvas']].forEach(function (pair) {
        var c = document.getElementById(pair[0]);
        c.width = c.clientWidth || c.width;
      });

      drawChart(document.getElementById('chartCpu'), [{ values: cpu, color: '#b388ff' }], 100, '%');
      drawChart(document.getElementById('chartRam'), [{ values: ram, color: '#66bb6a' }], 100, '%');
      drawChart(document.getElementById('chartDisk'), [{ values: disk, color: '#ffcc66' }], 100, '%');
      drawChart(document.getElementById('chartNet'), [{ values: rx, color: '#b388ff' }, { values: tx, color: '#ffcc66' }], null, 'rate');
    } catch {}
  }

  graphServerSelect.addEventListener('change', loadGraphs);

  // Пересчёт разрешения canvas при изменении размера окна (поворот
  // телефона, ресайз окна на десктопе) — раньше графики пересчитывались
  // только при смене сервера/диапазона, при простом ресайзе оставались
  // растянутыми под старую ширину до следующего клика. setupCanvas сам
  // читает актуальный clientWidth при каждом вызове drawChart, здесь
  // просто нужно вызвать loadGraphs заново — с debounce, чтобы не дёргать
  // сеть на каждый промежуточный кадр во время самого ресайза.
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(loadGraphs, 150);
  });

  loadServers();
  // Было раз в 1с — сам сбор на сервере (SAMPLE_INTERVAL_MS в store.js)
  // теперь тоже раз в 5с, опрашивать чаще источника незачем.
  setInterval(loadServers, 5000);
  setInterval(loadGraphs, 5000);
`;

const PAGE = renderPage({
  title: 'Системные ресурсы',
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
    res.end(JSON.stringify({ status: 'ok', module: 'monitoring' }));
    return;
  }

  if (req.method === 'GET' && pathname === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ module: 'monitoring', servers: store.listServers().length }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/servers') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers: store.listServers() }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/summary') {
    // Только ЛОКАЛЬНЫЙ сервер — это то, что показывает мини-карточка
    // модуля на главной странице хаба (там нет места на весь список).
    const local = store.listServers().find((s) => s.isLocal);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ server: local || null }));
    return;
  }

  const historyMatch = pathname.match(/^\/api\/servers\/([^/]+)\/history$/);
  if (req.method === 'GET' && historyMatch) {
    const name = decodeURIComponent(historyMatch[1]);
    const hours = Math.max(1, Math.min(24, Number(url.searchParams.get('hours')) || 24));
    const points = await store.loadHistory(name, hours);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ points }));
    return;
  }

  // DELETE /api/servers/:name — реальное удаление, не просто скрыть в
  // интерфейсе: стирает и текущую запись, и историю на диске (см.
  // store.removeServer). Проверка "не активен ли" — на бэкенде, а не
  // только в интерфейсе (там кнопка для активных задизейблена, но это
  // подсказка для человека, не защита): если сервер прямо сейчас
  // отчитывается, удаление тут же откатится следующим тиком — честнее
  // отказать сразу, чем создавать иллюзию, что что-то произошло.
  const deleteMatch = pathname.match(/^\/api\/servers\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteMatch) {
    const name = decodeURIComponent(deleteMatch[1]);
    const current = store.listServers().find((s) => s.name === name);
    if (current && current.online) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `сервер '${name}' ещё активен — удаление откатится следующим отчётом` }));
      return;
    }
    const existed = await store.removeServer(name);
    res.writeHead(existed ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(existed ? { ok: true } : { error: `сервер '${name}' не найден` }));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/local-name') {
    res.writeHead(410, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'имя локального сервера теперь задаётся на этапе деплоя (LOCAL_SERVER_NAME), не через интерфейс',
      })
    );
    return;
  }

  // -------------------------------------------------------------------
  // POST /api/agent/report — единственная ручка модуля, доступная БЕЗ
  // сессии браузера (хаб пропускает именно этот путь публично, см.
  // PUBLIC_PATHS-исключение в hub/src/index.ts). Вместо сессии — общий
  // токен агентов, который спрашиваем у хаба заново на каждый запрос
  // (не кэшируем у себя) — так смена токена в интерфейсе действует
  // сразу на всех агентов, без пересоздания контейнера модуля.
  // -------------------------------------------------------------------
  if (req.method === 'POST' && pathname === '/api/agent/report') {
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

    try {
      const body = await readJsonBody(req);
      const name = String(body.name || '').trim().slice(0, 64);
      if (!name) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'name обязателен' }));
        return;
      }
      const metrics = {
        cpuPercent: Number(body.cpuPercent) || 0,
        cpuCores: Number(body.cpuCores) || 1,
        ramUsedBytes: Number(body.ramUsedBytes) || 0,
        ramTotalBytes: Number(body.ramTotalBytes) || 0,
        diskUsedBytes: Number(body.diskUsedBytes) || 0,
        diskTotalBytes: Number(body.diskTotalBytes) || 0,
        netRxBytesPerSec: Number(body.netRxBytesPerSec) || 0,
        netTxBytesPerSec: Number(body.netTxBytesPerSec) || 0,
        uptimeSeconds: Number(body.uptimeSeconds) || 0,
      };
      await store.recordSample(name, false, metrics);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'некорректное тело запроса' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[monitoring] модуль слушает порт ${PORT}, хаб на ${HUB_HOST}:${HUB_PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
