// NEXUS404 — модуль "CheevoScope" (Steam + RetroAchievements).
//
// В отличие от остальных модулей, ключи (Steam API Key, SteamID, RA
// Username/Key) — не общий пул провайдеров чата, у них своя ручка
// GET /internal/cheevoscope-keys (см. hub/src/index.ts), настраиваются в
// модуле "AI API" (technical). Спрашиваются заново перед КАЖДЫМ прогоном
// пайплайна (см. lib/pipeline.js/retroPipeline.js — getStats/getRetroStats),
// не кэшируются в процессе — смена ключей в интерфейсе действует сразу.
//
// Своей авторизации нет вообще (в отличие от оригинала — там была Basic
// Auth на случай запуска без Caddy) — модуль живёт за сессионной кукой
// хаба, тем же гейтом, что и всё остальное под /modules/*.
//
// Почасовая автопроверка — не systemd-таймер (в контейнере его нет), а
// обычный setInterval внутри самого процесса.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { renderPage } = require('./chrome.js');

const { createSteamApi } = require('./lib/steamApi.js');
const { createRetroApi } = require('./lib/retroApi.js');
const { makeCache } = require('./lib/cache.js');
const { createStats, computeRarityTiers } = require('./lib/stats.js');
const { createRetroStats } = require('./lib/retroStats.js');
const { createAchievementDetails } = require('./lib/achievementDetails.js');
const { createPipeline } = require('./lib/pipeline.js');
const { createRetroPipeline } = require('./lib/retroPipeline.js');

const PORT = process.env.MODULE_PORT || 4006;
const HUB_HOST = process.env.HUB_HOST || 'hub';
const HUB_PORT = process.env.HUB_PORT || 3000;
const HUB_INTERNAL_TOKEN = process.env.HUB_INTERNAL_TOKEN || '';

const DATA_DIR = process.env.MODULE_DATA_DIR || '/app/data';
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const GAME_IMAGES_DIR = path.join(DATA_DIR, 'game_images'); // персистентно, растёт со временем
const BUNDLED_STATIC_DIR = path.join(__dirname, 'static'); // на будущее, если понадобятся свои статические файлы

const paths = {
  dataDir: DATA_DIR,
  gamesListFile: path.join(DATA_DIR, 'games_list.json'),
  imagesFile: path.join(DATA_DIR, 'images.json'),
  gameImagesDir: GAME_IMAGES_DIR,
  achievementsStatsFile: path.join(DATA_DIR, 'achievements_stats.json'),
  libraryCostFile: path.join(DATA_DIR, 'library_cost.json'),
  reviewsFile: path.join(DATA_DIR, 'reviews.json'),
  reportMdFile: path.join(DATA_DIR, 'report.md'),
  reportJsonFile: path.join(DATA_DIR, 'report.json'),
  manualAppidsFile: path.join(DATA_DIR, 'manual_appids.json'),
  retroReportJsonFile: path.join(DATA_DIR, 'retro_report.json'),
};
const STATUS_FILE = path.join(DATA_DIR, 'status.json');
const RETRO_STATUS_FILE = path.join(DATA_DIR, 'retro_status.json');

function requestHub(hubPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: HUB_HOST, port: HUB_PORT, path: hubPath, method: 'GET', headers: { 'x-internal-token': HUB_INTERNAL_TOKEN } },
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

async function getHubKeys() {
  try {
    const res = await requestHub('/internal/cheevoscope-keys');
    return res.status === 200 ? res.body : {};
  } catch {
    return {};
  }
}

// Один кэш на весь процесс — не зависит от того, какие сейчас ключи (сам
// кэш только на диске по appid/gameId, не по учётной записи).
const cache = makeCache(CACHE_DIR, 24 * 7);

// Пересобирается заново на каждый вызов — см. врезку про getStats выше.
async function getSteamStats() {
  const keys = await getHubKeys();
  if (!keys.steamApiKey || !keys.steamId) return null;
  const steamApi = createSteamApi({ apiKey: keys.steamApiKey, steamId: keys.steamId, logger: console });
  return createStats({ steamApi, cache, paths, steamId: keys.steamId, logger: console });
}

async function getRetroStatsInstance() {
  const keys = await getHubKeys();
  if (!keys.raUsername || !keys.raApiKey) return null;
  const retroApi = createRetroApi({ username: keys.raUsername, apiKey: keys.raApiKey, logger: console });
  return createRetroStats({ retroApi, cache, paths, computeRarityTiers, logger: console });
}

// Для модалки "все ачивки" — тоже свежие ключи на каждый запрос, тот же
// принцип, без отдельного кэширования api-инстансов между вызовами.
async function getAchievementDetails() {
  const keys = await getHubKeys();
  const steamApi = createSteamApi({ apiKey: keys.steamApiKey || '', steamId: keys.steamId || '', logger: console });
  const retroApi = createRetroApi({ username: keys.raUsername || '', apiKey: keys.raApiKey || '', logger: console });
  return createAchievementDetails({ steamApi, retroApi, cache });
}

const pipeline = createPipeline({ getStats: getSteamStats, statusFile: STATUS_FILE, cacheDir: CACHE_DIR, logger: console });
const retroPipeline = createRetroPipeline({ getRetroStats: getRetroStatsInstance, statusFile: RETRO_STATUS_FILE, logger: console });

// Почасовая автопроверка — quick-режим по обеим платформам, тем же кодом,
// что и кнопка "Обновить". RA пропускается молча, если ключи не заданы —
// это необязательная вторая вкладка.
async function hourlyRefresh() {
  console.log('[cheevoscope] почасовая автопроверка: запускаю Steam (quick)');
  try {
    const { promise } = pipeline.startRefresh('quick');
    if (promise) await promise;
  } catch (e) {
    console.error('[cheevoscope] почасовая автопроверка: Steam не выполнен —', e.message);
  }

  const keys = await getHubKeys();
  if (keys.raUsername && keys.raApiKey) {
    console.log('[cheevoscope] почасовая автопроверка: запускаю RetroAchievements (quick)');
    try {
      const { promise } = retroPipeline.startRefresh('quick');
      if (promise) await promise;
    } catch (e) {
      console.error('[cheevoscope] почасовая автопроверка: RetroAchievements не выполнен —', e.message);
    }
  } else {
    console.log('[cheevoscope] почасовая автопроверка: RA_USERNAME/RA_API_KEY пусты — RA пропущен');
  }
}
setInterval(() => { hourlyRefresh().catch((e) => console.error('[cheevoscope] почасовая автопроверка упала:', e)); }, 60 * 60 * 1000);

const EXTRA_HEAD = `
<style>
  /* Переиспользуем переменные хаба (--accent/--amber/--green/--red/--muted/
     --line/--text/--card-radius/--font-sans/--font-mono — уже объявлены в
     chrome.js на :root) вместо собственной палитры оригинала. Соответствие:
     --steam/--cyan -> --accent (фиолетовый, основной), --retro -> --amber
     (золото, второй цвет для сравнения Steam/RA), --gold -> --amber,
     --indigo -> --muted, --magenta -> --red, --panel -> тот же полупрозрачный
     тёмный фон, что у .box. */
  .cs-header {
    display: flex; justify-content: space-between; align-items: center;
    flex-wrap: wrap; gap: 14px; margin-bottom: 18px;
  }
  .cs-title { font-family: var(--font-sans); font-size: 20px; font-weight: 700; color: var(--text); margin: 0; }
  .cs-subtitle { color: var(--muted); font-size: 11px; margin-top: 3px; }
  #status-line { font-size: 11px; color: var(--muted); margin-top: 2px; }
  #status-line.error { color: var(--red); }

  .cs-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .cs-btn-primary, .cs-btn-secondary {
    display: inline-flex; align-items: center; gap: 7px;
    font-family: var(--font-sans); font-weight: 700; font-size: 12.5px;
    padding: 8px 16px; border-radius: 999px; cursor: pointer;
    transition: box-shadow .15s ease, background .15s ease, opacity .15s ease;
  }
  /* Тот же стиль, что у .login-btn (страница входа) — прозрачный фон,
     фиолетовая рамка/текст в покое, фиолетовое свечение при наведении.
     Единственная главная кнопка действия в хабе выглядит именно так —
     сплошная золотая заливка и красная рамка (было раньше) выбивались
     из общего вида. */
  .cs-btn-primary { background: transparent; border: 1px solid var(--accent); color: var(--accent); }
  .cs-btn-primary:hover { background: rgba(179, 136, 255, 0.08); box-shadow: 0 0 18px rgba(179, 136, 255, 0.3); }
  .cs-btn-primary:disabled { border-color: var(--line); color: var(--muted); cursor: default; background: transparent; box-shadow: none; }
  .cs-btn-primary.spinning svg { animation: cs-spin 0.9s linear infinite; }
  /* "Обновить всё" — та же основа, но рамка приглушённее в покое (не
     фиолетовая, не красная — просто менее заметная): это более редкое,
     "тяжёлое" действие, не то, что нужно так же выделять, как обычное
     "Обновить", но и не сигнализировать цветом тревоги на ровном месте. */
  .cs-btn-secondary { background: transparent; border: 1px solid var(--line); color: var(--muted); }
  .cs-btn-secondary:hover { border-color: var(--accent); color: var(--accent); background: rgba(179, 136, 255, 0.08); box-shadow: 0 0 18px rgba(179, 136, 255, 0.3); }
  .cs-btn-secondary:disabled { color: var(--muted); border-color: var(--line); cursor: default; background: transparent; opacity: 0.5; }
  @keyframes cs-spin { to { transform: rotate(360deg); } }

  .cs-tab-row { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
  .cs-tab-btn {
    display: inline-flex; align-items: center; gap: 7px;
    background: transparent; border: 1px solid var(--line); color: var(--muted);
    font-family: var(--font-sans); font-weight: 700; font-size: 12px;
    padding: 8px 16px; border-radius: 999px; cursor: pointer;
    transition: border-color .15s ease, color .15s ease, background .15s ease;
  }
  .cs-tab-btn svg { width: 14px; height: 14px; }
  .cs-tab-btn.active { color: var(--text); border-color: rgba(179,136,255,0.4); background: rgba(179,136,255,0.14); }
  .cs-tab-btn:not(.active):hover { border-color: rgba(179,136,255,0.3); color: var(--text); }
  .cs-tab-panel { display: none; }
  .cs-tab-panel.active { display: block; }

  .cs-stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin-bottom: 14px; }
  .cs-stat-card { display: flex; align-items: center; gap: 12px; }
  .cs-stat-icon {
    width: 34px; height: 34px; min-width: 34px; border-radius: var(--card-radius);
    display: flex; align-items: center; justify-content: center;
    background: rgba(179,136,255,0.14); color: var(--accent);
  }
  .cs-stat-icon svg { width: 17px; height: 17px; }
  .cs-stat-body { min-width: 0; }
  .cs-stat-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-bottom: 3px; font-weight: 600; white-space: nowrap; }
  .cs-stat-value { font-family: var(--font-mono); font-size: 19px; font-weight: 700; color: var(--text); white-space: nowrap; }
  .cs-stat-value-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
  .cs-stat-value-cost { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--amber); white-space: nowrap; }
  .cs-stat-value .unit { font-size: 11px; color: var(--muted); font-weight: 600; }

  .cs-rate-limit-note { background: rgba(239,83,80,0.1); border: 1px solid rgba(239,83,80,0.3); border-radius: var(--card-radius); padding: 9px 14px; font-size: 12px; color: #f5b3b7; margin-bottom: 16px; }

  .cs-section { margin-bottom: 26px; }
  .cs-section h2 {
    font-family: var(--font-sans); font-size: 14px; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.04em; color: var(--text);
    margin: 0 0 12px; padding-left: 10px; position: relative;
  }
  .cs-section h2::before { content: ''; position: absolute; left: 0; top: 1px; bottom: 1px; width: 3px; border-radius: 2px; background: var(--amber); }

  .cs-progress-row { display: flex; gap: 16px; align-items: stretch; margin-bottom: 18px; flex-wrap: wrap; }
  .cs-progress-row > .cs-mastery-card, .cs-progress-row > .cs-rarity-card { flex: 1; min-width: 260px; margin-bottom: 0; }
  .cs-mastery-card, .cs-rarity-card {
    display: flex; align-items: center; gap: 20px; flex-wrap: wrap; padding: 16px 20px;
  }
  .cs-score-wrap { text-align: center; min-width: 90px; }
  .cs-score { font-family: var(--font-mono); font-weight: 700; font-size: 28px; color: var(--text); line-height: 1; }
  .cs-score-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin-top: 4px; }
  .cs-body { flex: 1; min-width: 220px; }
  .cs-label-row { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 700; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
  .cs-label-row svg { width: 13px; height: 13px; color: var(--amber); }
  .cs-bar-bg { height: 7px; border-radius: 4px; background: rgba(255,255,255,0.06); overflow: hidden; margin: 2px 0 8px; }
  .cs-bar-fill { height: 100%; border-radius: 4px; background: var(--amber); transition: width .8s ease; }
  .cs-sub { font-size: 11.5px; color: var(--muted); margin-top: 6px; line-height: 1.5; }
  .cs-sub strong { color: var(--text); font-weight: 700; }
  .cs-sub .badge { color: var(--amber); font-weight: 700; }

  .cs-rarity-tiers { display: flex; flex-wrap: wrap; gap: 6px; }
  .cs-rarity-chip { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 10.5px; font-weight: 600; color: var(--text); white-space: nowrap; }
  .cs-rarity-chip .dot { width: 8px; height: 8px; flex-shrink: 0; clip-path: polygon(50% 0%, 100% 38%, 82% 100%, 18% 100%, 0% 38%); box-shadow: 0 0 5px currentColor; }
  .cs-rarity-chip .count { color: var(--text); font-family: var(--font-mono); }

  .cs-group-label { grid-column: 1 / -1; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 700; color: var(--muted); margin: 16px 0 8px; display: flex; align-items: center; gap: 8px; }
  .cs-group-label::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); flex-shrink: 0; }
  .cs-group-label.with::before { background: var(--amber); }
  .cs-group-label.without::before { background: var(--muted); }
  .cs-group-label:first-child { margin-top: 0; }
  .cs-group-label .count { color: var(--accent); font-family: var(--font-mono); font-weight: 500; text-transform: none; letter-spacing: 0; }

  .cs-games-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; }
  .cs-tile { overflow: hidden; position: relative; cursor: pointer; padding: 0; transition: transform .15s ease, border-color .15s ease; }
  .cs-tile:hover { transform: translateY(-2px); border-color: rgba(179,136,255,0.3); }
  .cs-tile .cs-thumb { width: 100%; aspect-ratio: 460/215; background: rgba(255,255,255,0.04); }
  .cs-tile .cs-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .cs-tile.no-image .cs-thumb img { display: none; }
  .cs-tile .cs-tile-body { padding: 9px 11px 10px; }
  .cs-tile .cs-name { font-size: 12px; color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 6px; }
  .cs-tile-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
  .cs-tile-meta .cs-hours { font-size: 10px; color: var(--muted); white-space: nowrap; }
  .cs-review-badge { display: flex; align-items: center; gap: 4px; font-size: 9px; font-weight: 700; white-space: nowrap; padding: 2px 6px; border-radius: 5px; background: rgba(255,255,255,0.06); min-width: 0; }
  .cs-review-badge .cs-review-label { overflow: hidden; text-overflow: ellipsis; }
  .cs-ach-numbers { font-size: 10px; color: var(--muted); font-family: var(--font-mono); display: flex; justify-content: space-between; margin-bottom: 5px; }
  .cs-ach-numbers .cs-pct { font-weight: 700; }
  .cs-ach-bar-bg { height: 5px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
  .cs-ach-bar-fill { height: 100%; border-radius: 3px; transition: width .5s ease, background .3s ease; width: 0; }
  .cs-tile.no-ach .cs-tile-body { opacity: 0.5; }
  .cs-no-ach-label { font-size: 10px; font-style: italic; color: var(--muted); display: none; }
  .cs-tile.no-ach .cs-no-ach-label { display: block; }

  .cs-empty-state { grid-column: 1 / -1; border: 1px dashed var(--line); border-radius: var(--card-radius); padding: 26px 20px; text-align: center; color: var(--muted); font-size: 12.5px; }
  .cs-empty-state strong { color: var(--text); display: block; margin-bottom: 6px; font-size: 14px; }

  .cs-retro-list { display: flex; flex-direction: column; gap: 8px; }
  .cs-retro-row { display: flex; align-items: center; gap: 12px; padding: 9px 14px; cursor: pointer; transition: border-color .15s ease, transform .15s ease; }
  .cs-retro-row:hover { border-color: rgba(179,136,255,0.3); transform: translateX(2px); }
  .cs-retro-row .cs-icon-wrap { width: 38px; height: 38px; border-radius: var(--card-radius); overflow: hidden; flex-shrink: 0; background: rgba(255,255,255,0.04); display: flex; align-items: center; justify-content: center; }
  .cs-retro-row .cs-icon-wrap img { width: 100%; height: 100%; object-fit: cover; }
  .cs-retro-row .cs-icon-wrap svg { width: 16px; height: 16px; color: var(--muted); }
  .cs-retro-row .cs-info { flex: 1; min-width: 0; }
  .cs-retro-row .cs-name { font-weight: 600; font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cs-retro-row .cs-meta-line { display: flex; align-items: center; gap: 8px; margin-top: 3px; font-size: 10px; color: var(--muted); }
  .cs-console-chip { font-size: 8.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; padding: 2px 6px; border-radius: 5px; background: rgba(255,204,102,0.14); color: var(--amber); flex-shrink: 0; }
  .cs-retro-row .cs-bars { width: 120px; flex-shrink: 0; display: none; }
  .cs-retro-row .cs-bar-bg-mini { height: 5px; border-radius: 3px; background: rgba(255,255,255,0.06); overflow: hidden; }
  .cs-retro-row .cs-bar-bg-mini + .cs-bar-bg-mini { margin-top: 3px; }
  .cs-retro-row .cs-bar-fill-mini { height: 100%; border-radius: 3px; }
  .cs-retro-row .cs-pct-block { width: 48px; flex-shrink: 0; text-align: right; font-family: var(--font-mono); font-weight: 700; font-size: 12px; color: var(--text); }
  .cs-status-badge { display: inline-flex; align-items: center; justify-content: center; gap: 4px; font-size: 9px; font-weight: 700; white-space: nowrap; padding: 3px 7px; border-radius: 6px; background: rgba(255,255,255,0.06); flex-shrink: 0; width: 88px; text-align: center; }
  .cs-status-badge.mastered { color: var(--amber); background: rgba(255,204,102,0.14); }
  .cs-status-badge.completed { color: var(--accent); background: rgba(179,136,255,0.14); }
  @media (min-width: 560px) { .cs-retro-row .cs-bars { display: block; } }

  .cs-toolbar { display: flex; gap: 10px; margin-bottom: 12px; flex-wrap: nowrap; }
  .cs-toolbar input, .cs-toolbar select {
    background: rgba(12,11,20,0.5); border: 1px solid var(--line); color: var(--text);
    font-family: var(--font-sans); font-size: 12px; padding: 8px 11px; border-radius: var(--card-radius); outline: none;
  }
  .cs-toolbar input { flex: 1 1 auto; min-width: 0; }
  .cs-toolbar select { flex: 0 0 auto; max-width: 46%; }
  .cs-toolbar input::placeholder { color: var(--muted); }
  .cs-toolbar input:focus, .cs-toolbar select:focus { border-color: rgba(179,136,255,0.4); }

  .cs-modal-overlay { position: fixed; inset: 0; background: rgba(3,5,9,0.72); backdrop-filter: blur(4px); display: none; align-items: flex-start; justify-content: center; z-index: 100; padding: 40px 16px; overflow-y: auto; }
  .cs-modal-overlay.show { display: flex; }
  .cs-modal-box { background: var(--bg); border: 1px solid rgba(179,136,255,0.3); border-radius: 14px; width: 100%; max-width: 540px; padding: 20px 22px 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.6); }
  .cs-modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
  .cs-modal-head h3 { font-family: var(--font-sans); font-size: 16px; font-weight: 700; color: var(--text); margin: 0; }
  .cs-modal-close { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 8px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex-shrink: 0; }
  .cs-modal-close:hover { border-color: rgba(179,136,255,0.3); color: var(--text); }
  .cs-modal-close svg { width: 14px; height: 14px; }
  .cs-modal-loading, .cs-modal-empty { color: var(--muted); font-size: 12.5px; text-align: center; padding: 22px 0; }
  .cs-ach-modal-list { display: flex; flex-direction: column; gap: 8px; max-height: 60vh; overflow-y: auto; }
  .cs-ach-modal-row { display: flex; align-items: center; gap: 12px; border-radius: var(--card-radius); border: 1px solid var(--line); padding: 9px 11px; }
  .cs-ach-modal-row.unlocked { border-color: rgba(102,187,106,0.35); }
  .cs-ach-check { width: 20px; height: 20px; min-width: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,0.06); color: var(--muted); }
  .cs-ach-modal-row.unlocked .cs-ach-check { background: rgba(102,187,106,0.16); color: var(--green); }
  .cs-ach-check svg { width: 12px; height: 12px; }
  .cs-ach-icon { width: 34px; height: 34px; min-width: 34px; border-radius: 7px; object-fit: cover; background: rgba(255,255,255,0.04); }
  .cs-ach-body { min-width: 0; flex: 1; }
  .cs-ach-name { font-size: 12px; font-weight: 600; color: var(--text); margin-bottom: 2px; }
  .cs-ach-desc { font-size: 10.5px; color: var(--muted); line-height: 1.45; }
  .cs-ach-rarity { font-size: 11.5px; font-weight: 700; color: var(--amber); text-align: right; white-space: nowrap; }

  .cs-compare-list { display: flex; flex-direction: column; gap: 14px; }
  .cs-compare-row .cs-compare-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .cs-compare-row .cs-compare-head .cs-label { font-size: 12px; color: var(--text); font-weight: 600; }
  .cs-compare-row .cs-compare-head .cs-total { font-size: 10.5px; color: var(--muted); font-family: var(--font-mono); }
  .cs-compare-bar { display: flex; height: 9px; border-radius: 5px; overflow: hidden; background: rgba(255,255,255,0.06); }
  .cs-compare-bar .cs-seg { height: 100%; }
  .cs-compare-bar .cs-seg.steam { background: var(--accent); }
  .cs-compare-bar .cs-seg.retro { background: var(--amber); }
  .cs-compare-legend { display: flex; gap: 16px; margin-top: 14px; font-size: 10.5px; color: var(--muted); }
  .cs-compare-legend span { display: flex; align-items: center; gap: 6px; }
  .cs-compare-legend .dot { width: 8px; height: 8px; border-radius: 3px; }

  .cs-rarity-list { display: flex; flex-direction: column; gap: 8px; }
  .cs-rarity-row { display: grid; grid-template-columns: 18px 1fr 52px; align-items: center; gap: 10px; border-radius: var(--card-radius); border: 1px solid var(--line); padding: 9px 12px; }
  .cs-rarity-row .cs-rank { font-family: var(--font-mono); font-weight: 700; color: var(--muted); font-size: 12px; }
  .cs-rarity-row .cs-a-name { font-size: 12px; color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cs-rarity-row .cs-a-game { font-size: 10px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cs-rarity-row .cs-rarity-pct { font-size: 12px; font-weight: 700; color: var(--amber); text-align: right; }
  .cs-rarity-columns { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
  .cs-rarity-column { flex: 1; min-width: 240px; display: flex; flex-direction: column; gap: 8px; }
  .cs-rarity-column-head { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin-bottom: 2px; }
  .cs-rarity-column-head .dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }

  .cs-heatmap-grid { display: flex; gap: 3px; width: 100%; }
  .cs-heatmap-week { display: flex; flex-direction: column; gap: 3px; flex: 1 1 0; min-width: 0; }
  .cs-heatmap-cell { width: 100%; aspect-ratio: 1; border-radius: 2px; background: rgba(255,255,255,0.05); }
  .cs-heatmap-cell[data-level="1"] { background: rgba(179,136,255,0.25); }
  .cs-heatmap-cell[data-level="2"] { background: rgba(179,136,255,0.45); }
  .cs-heatmap-cell[data-level="3"] { background: rgba(179,136,255,0.7); }
  .cs-heatmap-cell[data-level="4"] { background: var(--accent); }
  .cs-heatmap-legend { display: flex; align-items: center; gap: 6px; margin-top: 10px; font-size: 10px; color: var(--muted); }
  .cs-heatmap-legend .cs-heatmap-cell { width: 10px; height: 10px; }
  .cs-heatmap-empty { color: var(--muted); font-size: 12.5px; padding: 8px 0; }

  @media (max-width: 600px) {
    .cs-stats-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
    .cs-stats-grid .cs-stat-card:first-child { grid-column: 1 / -1; }
    .cs-games-grid { grid-template-columns: 1fr 1fr; }
    .cs-tab-btn { font-size: 10.5px; padding: 7px 11px; flex: 1 1 auto; justify-content: center; }
    .cs-review-badge .cs-review-label { display: none; }
    .cs-rarity-columns { flex-direction: column; }
    .cs-progress-row { flex-direction: column; }
    .cs-header { gap: 10px; }
    .cs-actions { width: 100%; }
    .cs-btn-primary, .cs-btn-secondary { font-size: 11.5px; padding: 8px 12px; flex: 1 1 auto; justify-content: center; white-space: nowrap; }
    .cs-title { font-size: 17px; }
    .cs-score { font-size: 24px; }
    .cs-mastery-card, .cs-rarity-card { padding: 14px 16px; gap: 14px; }
  }

  @media (max-width: 380px) {
    .cs-stats-grid { grid-template-columns: 1fr; }
    .cs-games-grid { grid-template-columns: 1fr 1fr; gap: 8px; }
    .cs-btn-primary, .cs-btn-secondary { font-size: 11px; padding: 7px 10px; }
    .cs-retro-row .cs-pct-block { width: 38px; font-size: 11px; }
    .cs-status-badge { width: 72px; font-size: 8px; }
  }
</style>
`;

const BODY_CONTENT = `
  <div class="cs-header">
    <div>
      <h1 class="cs-title" id="page-title">CheevoScope</h1>
      <div class="cs-subtitle" id="last-updated">данных пока нет</div>
      <div id="status-line"></div>
    </div>
    <div class="cs-actions">
      <button class="cs-btn-primary" id="refresh-btn" title="Быстро: список игр (+ новые, если появились) и достижения. Цены/отзывы не трогает, картинки подтягивает только для новых игр. На вкладке RA всегда полное обновление — там нет отдельного лёгкого режима.">
        <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M20 11a8 8 0 10-2.34 5.66M20 5v6h-6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Обновить
      </button>
      <button class="cs-btn-secondary" id="force-refresh-btn" title="Жёсткий пересчёт с нуля: список игр, картинки, достижения, отзывы и цены — кэш полностью очищается.">Обновить всё</button>
      <button class="cs-btn-primary" id="refresh-both-btn" style="display:none" title="Обновить только достижения на обеих платформах — без картинок/цен/отзывов Steam, но с полным RA-прогоном (нужен для очков по консолям и топ-10 редких)">
        <svg viewBox="0 0 24 24" fill="none" width="14" height="14"><path d="M20 11a8 8 0 10-2.34 5.66M20 5v6h-6" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
        Обновить достижения
      </button>
    </div>
  </div>

  <div class="cs-tab-row">
    <button class="cs-tab-btn active" id="tab-steam">
      <svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9.5" stroke="currentColor" stroke-width="1.5"/><circle cx="8.7" cy="8.3" r="2.4" fill="currentColor"/><path d="M8.7 8.3L14.2 13.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="14.9" cy="14.6" r="2.1" stroke="currentColor" stroke-width="1.5"/><circle cx="14.9" cy="14.6" r="0.7" fill="currentColor"/></svg>
      Steam
    </button>
    <button class="cs-tab-btn" id="tab-retro">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M7 4h10v4a5 5 0 01-10 0V4z" stroke-linejoin="round"/><path d="M7 5H4v1a4 4 0 004 4M17 5h3v1a4 4 0 01-4 4M9 20h6M12 14v6" stroke-linecap="round"/></svg>
      RA
    </button>
    <button class="cs-tab-btn" id="tab-overall">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="12" width="4" height="8" rx="1"/><rect x="10" y="7" width="4" height="13" rx="1"/><rect x="17" y="3" width="4" height="17" rx="1"/></svg>
      Общая статистика
    </button>
  </div>

  <div class="cs-tab-panel active" id="panel-steam">
    <div id="content">
      <div class="cs-empty-state" style="grid-column:unset;">
        <strong>Библиотека пуста</strong>
        Нажмите «Обновить», чтобы собрать данные из Steam. Первый сбор может занять несколько минут.
      </div>
    </div>
  </div>

  <div class="cs-tab-panel" id="panel-retro">
    <div id="retro-content">
      <div class="cs-empty-state" style="grid-column:unset;">
        <strong>Данных пока нет</strong>
        Нажмите «Обновить», чтобы собрать данные из RetroAchievements.
      </div>
    </div>
  </div>

  <div class="cs-tab-panel" id="panel-overall">
    <div id="overall-content">
      <div class="cs-empty-state" style="grid-column:unset;">
        <strong>Нужны данные обеих платформ</strong>
        Обновите вкладки Steam и RetroAchievements хотя бы по разу — здесь появится общая сводка.
      </div>
    </div>
  </div>

  <div class="cs-modal-overlay" id="ach-modal-overlay">
    <div class="cs-modal-box">
      <div class="cs-modal-head">
        <h3 id="ach-modal-title">Достижения</h3>
        <button class="cs-modal-close" id="ach-modal-close-btn" aria-label="Закрыть">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 6l12 12M18 6L6 18" stroke-linecap="round"/></svg>
        </button>
      </div>
      <div id="ach-modal-body">
        <div class="cs-modal-loading">Загрузка…</div>
      </div>
    </div>
  </div>
`;

// --- JS-логика дашборда. Перенос из оригинального index.html — следующий
// шаг (самый большой: рендер вкладок, статус-поллинг, модалка ачивок,
// картинки-фолбэки, теплокарта, свайп-навигация). Временная заготовка,
// чтобы файл был целостным и тестируемым уже сейчас. ---
const EXTRA_SCRIPT = `
// ==========================================================================
// Рендеринг Steam-отчёта — ТОЧЕЧНЫЕ обновления DOM, не полная пересборка.
// Отчёт на диске обновляется после каждого этапа пайплайна, а фронт дёргает
// /api/status раз в 2с во время работы — без точечных правок весь блок
// пересоздавался бы каждые 2с, теряя плавные переходы и мигая картинками.
// skeleton строится ОДИН раз при первом отчёте, дальше — только правки
// текста/стилей уже существующих узлов. Плитки хранятся в tileMap по appid.
// ==========================================================================

let lastReportJson = null;
let skeletonBuilt = false;
const tileMap = new Map();

const ICONS = {
  games: '<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 20h8M12 16v4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none"><path d="M11.5 3.5H5.5v6L14 18l6-6-8.5-8.5z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="9" cy="8" r="1.4" fill="currentColor"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/><path d="M8.5 12.3l2.4 2.4 4.6-5.4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  trophy: '<svg viewBox="0 0 24 24" fill="none"><path d="M7 4h10v4a5 5 0 01-10 0V4z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M7 5H4v1a4 4 0 004 4M17 5h3v1a4 4 0 01-4 4M9 20h6M12 14v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

// Тиры "крутости" ачивок по мировой редкости — порядок и цвета должны
// совпадать с RARITY_TIERS в lib/stats.js.
const RARITY_TIER_META = [
  { id: 'gold',   label: 'Легендарные', color: '#dcb35c' },
  { id: 'purple', label: 'Эпические',   color: '#b478f0' },
  { id: 'blue',   label: 'Редкие',      color: '#4a90d9' },
  { id: 'green',  label: 'Необычные',   color: '#4cb389' },
  { id: 'white',  label: 'Обычные',     color: '#d7dbe0' },
  { id: 'gray',   label: 'Частые',      color: '#6b7280' },
];

function rarityChipsHtml(counts, idPrefix){
  return RARITY_TIER_META.map(t => {
    const count = (counts && counts[t.id]) || 0;
    const countId = idPrefix ? \` id="\${idPrefix}-\${t.id}"\` : '';
    return \`<span class="cs-rarity-chip"><span class="dot" style="background:\${t.color}; color:\${t.color};"></span>\${t.label} <span class="count"\${countId}>\${count}</span></span>\`;
  }).join('');
}

function mergeRarityTiers(a, b){
  const ta = (a && a.totalRated) || 0;
  const tb = (b && b.totalRated) || 0;
  const total = ta + tb;
  const counts = {};
  RARITY_TIER_META.forEach(t => {
    counts[t.id] = ((a && a.counts && a.counts[t.id]) || 0) + ((b && b.counts && b.counts[t.id]) || 0);
  });
  const avgA = a ? (100 - a.coolnessScore) : 0;
  const avgB = b ? (100 - b.coolnessScore) : 0;
  const weightedAvg = total ? (avgA * ta + avgB * tb) / total : 0;
  return { totalRated: total, counts, coolnessScore: total ? Math.round((100 - weightedAvg) * 10) / 10 : 0 };
}

function raritySubText(rarityTiers){
  const total = rarityTiers ? rarityTiers.totalRated : 0;
  return total
    ? \`По редкости \${total} достижений — чем реже, тем выше тир.\`
    : 'Нужно полное «Обновить всё» — быстрое редкость не считает.';
}

function buildSkeleton(){
  const content = document.getElementById('content');
  content.innerHTML = \`
    <div class="cs-stats-grid" id="stats-grid">
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.games}</div>
        <div class="cs-stat-body">
          <div class="cs-stat-label">Библиотека</div>
          <div class="cs-stat-value-row">
            <div class="cs-stat-value" id="val-games-count">—</div>
            <div class="cs-stat-value-cost" id="val-cost">—</div>
          </div>
        </div>
      </div>
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.clock}</div>
        <div class="cs-stat-body">
          <div class="cs-stat-label">Общее время</div>
          <div class="cs-stat-value"><span id="val-total-hours">—</span> <span class="unit">ч.</span></div>
        </div>
      </div>
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.trophy}</div>
        <div class="cs-stat-body">
          <div class="cs-stat-label">Замастерено</div>
          <div class="cs-stat-value" id="val-mastered" style="color:var(--amber)">—</div>
        </div>
      </div>
    </div>
    <div class="cs-rate-limit-note" id="rate-limit-note" style="display:none"></div>
    <div class="cs-progress-row">
    <div class="box cs-mastery-card" id="mastery-card">
      <div class="cs-score-wrap">
        <div class="cs-score"><span id="mastery-pct">0</span><span class="unit">%</span></div>
        <div class="cs-score-label">Прогресс</div>
      </div>
      <div class="cs-body">
        <span class="cs-label-row">\${ICONS.trophy} Общий прогресс по достижениям</span>
        <div class="cs-bar-bg"><div class="cs-bar-fill" id="mastery-bar" style="width:0%"></div></div>
        <div class="cs-sub" id="mastery-sub-unlocked">—</div>
        <div class="cs-sub" id="mastery-sub-mastered">—</div>
      </div>
    </div>
    <div class="box cs-rarity-card">
      <div class="cs-score-wrap">
        <div class="cs-score" id="rarity-score">0</div>
        <div class="cs-score-label">Крутость</div>
      </div>
      <div class="cs-body">
        <span class="cs-label-row">\${ICONS.trophy} Счётчик крутости</span>
        <div class="cs-rarity-tiers">\${rarityChipsHtml(null, 'rarity-count')}</div>
        <div class="cs-sub" id="rarity-sub">—</div>
      </div>
    </div>
    </div>
    <div class="cs-section">
      <h2>Библиотека</h2>
      <div class="cs-toolbar">
        <input type="text" id="search-steam" placeholder="Поиск по названию…">
        <select id="sort-steam">
          <option value="name" selected>По алфавиту</option>
          <option value="hours">По часам в игре</option>
          <option value="achievements">По % достижений</option>
        </select>
      </div>
      <div class="cs-games-grid" id="games-grid"></div>
    </div>
  \`;
  tileMap.clear();
  document.getElementById('search-steam').addEventListener('input', () => filterGamesGrid('games-grid', 'search-steam', 'sort-steam'));
  document.getElementById('sort-steam').addEventListener('change', () => filterGamesGrid('games-grid', 'search-steam', 'sort-steam'));
}

function updateStats(s){
  document.getElementById('val-games-count').textContent = s.gamesCount + ' игр';
  document.getElementById('val-total-hours').textContent = s.totalHours;
  document.getElementById('val-cost').textContent = '$' + s.libraryCostUsd;
  document.getElementById('val-mastered').textContent = s.gamesCompleted100;

  const note = document.getElementById('rate-limit-note');
  if(s.gamesPriceRateLimited > 0){
    note.style.display = '';
    note.textContent = \`⚠ \${s.gamesPriceRateLimited} цен не удалось получить из-за лимита запросов Steam — пересчитаются при следующем обновлении.\`;
  } else {
    note.style.display = 'none';
  }
}

function updateMastery(s){
  const overallPct = s.achievementsOverallPercent || 0;
  const pctClamped = Math.max(0, Math.min(100, overallPct));
  const complete = overallPct >= 100;

  const bar = document.getElementById('mastery-bar');
  bar.style.width = pctClamped + '%';
  if(complete) bar.style.background = 'var(--amber)';

  document.getElementById('mastery-pct').textContent = overallPct;
  document.getElementById('mastery-sub-unlocked').innerHTML =
    \`Открыто <strong>\${s.achievementsUnlockedTotal}</strong> из <strong>\${s.achievementsAvailableTotal}</strong> достижений по всей библиотеке\`;
  document.getElementById('mastery-sub-mastered').innerHTML =
    \`<span class="badge">🏆 \${s.gamesCompleted100}</span> игр пройдено на 100%\`;
}

// Календарь активности — сетка как GitHub-контрибьюшены: 7 строк (дни
// недели), столбцы — недели, слева (год назад) направо (сегодня).
function renderHeatmap(containerId, heatmapData){
  const container = document.getElementById(containerId);
  const data = heatmapData || {};
  const entries = Object.keys(data);
  if(!entries.length){
    container.innerHTML = '<div class="cs-heatmap-empty">Пока нет данных — нужно хотя бы одно обновление, чтобы собрать даты разлочки достижений.</div>';
    return;
  }

  const today = new Date();
  today.setHours(0,0,0,0);
  const start = new Date(today);
  start.setDate(start.getDate() - 370);
  const startWeekday = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - startWeekday);

  const days = [];
  const cursor = new Date(start);
  while(cursor <= today){
    const key = cursor.toISOString().slice(0, 10);
    days.push({ date: key, count: data[key] || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const maxCount = Math.max(1, ...days.map(d => d.count));
  const levelFor = c => {
    if(c <= 0) return 0;
    const ratio = c / maxCount;
    if(ratio > 0.75) return 4;
    if(ratio > 0.5) return 3;
    if(ratio > 0.25) return 2;
    return 1;
  };

  const weeks = [];
  for(let i = 0; i < days.length; i += 7){
    weeks.push(days.slice(i, i + 7));
  }
  const weeksHtml = weeks.map(week => {
    const cells = week.map(d => {
      const level = levelFor(d.count);
      const label = d.count ? \`\${d.date}: \${d.count} дост.\` : \`\${d.date}: нет активности\`;
      return \`<div class="cs-heatmap-cell" data-level="\${level}" title="\${label}"></div>\`;
    }).join('');
    return \`<div class="cs-heatmap-week">\${cells}</div>\`;
  }).join('');

  container.innerHTML = \`
    <div class="cs-heatmap-grid">\${weeksHtml}</div>
    <div class="cs-heatmap-legend">
      <span>Меньше</span>
      <span class="cs-heatmap-cell" data-level="0"></span>
      <span class="cs-heatmap-cell" data-level="1"></span>
      <span class="cs-heatmap-cell" data-level="2"></span>
      <span class="cs-heatmap-cell" data-level="3"></span>
      <span class="cs-heatmap-cell" data-level="4"></span>
      <span>Больше</span>
    </div>\`;
}

function updateRarityCard(rarityTiers){
  const counts = (rarityTiers && rarityTiers.counts) || {};
  document.getElementById('rarity-score').textContent = rarityTiers ? rarityTiers.coolnessScore : 0;
  RARITY_TIER_META.forEach(t => {
    const el = document.getElementById('rarity-count-' + t.id);
    if(el) el.textContent = counts[t.id] || 0;
  });
  document.getElementById('rarity-sub').textContent = raritySubText(rarityTiers);
}

function buildGroupLabel(group, s){
  const div = document.createElement('div');
  div.className = 'cs-group-label ' + group;
  const text = group === 'with' ? 'С достижениями' : 'Без достижений';
  const count = group === 'with' ? s.gamesWithAchievements : s.gamesWithoutAchievements;
  div.innerHTML = \`\${text} <span class="count">(\${count})</span>\`;
  return div;
}

function buildTile(g){
  const tile = document.createElement('div');
  tile.className = 'box cs-tile';
  tile.dataset.appid = g.appid;
  tile.addEventListener('click', () => openAchievementsModal('steam', g.appid, g.name));
  const candidates = imgCandidates(g.appid, g);
  tile.innerHTML = \`
    <div class="cs-thumb">
      <img src="\${candidates[0]}" data-candidates='\${JSON.stringify(candidates)}' data-fallback-idx="0" alt="" loading="lazy">
    </div>
    <div class="cs-tile-body">
      <div class="cs-name"></div>
      <div class="cs-tile-meta">
        <span class="cs-hours"></span>
        <span class="cs-review-badge" style="display:none"><span class="cs-review-label"></span><span class="cs-review-pct"></span></span>
      </div>
      <div class="cs-ach-numbers"><span class="nums"></span><span class="cs-pct"></span></div>
      <div class="cs-ach-bar-bg"><div class="cs-ach-bar-fill"></div></div>
      <div class="cs-no-ach-label">нет достижений</div>
    </div>
  \`;
  tile.querySelector('img').addEventListener('error', function(){ handleThumbError(this); });
  updateTile(tile, g);
  return tile;
}

function updateTile(tile, g){
  const hasAch = g.achievementsPercent !== null && g.achievementsPercent !== undefined;
  tile.classList.toggle('no-ach', !hasAch);
  tile.dataset.name = g.name;
  tile.dataset.hours = g.hours;
  tile.dataset.achpct = hasAch ? g.achievementsPercent : -1;

  const nameEl = tile.querySelector('.cs-name');
  if(nameEl.textContent !== g.name){
    nameEl.textContent = g.name;
    nameEl.title = g.name;
  }

  tile.querySelector('.cs-hours').textContent = g.hours + ' ч.';
  const badge = tile.querySelector('.cs-review-badge');
  if(g.reviewDesc){
    const hasPercent = g.reviewPositivePercent !== null && g.reviewPositivePercent !== undefined;
    badge.style.display = '';
    badge.style.color = reviewColor(g.reviewPositivePercent);
    const labelEl = badge.querySelector('.cs-review-label');
    const pctEl = badge.querySelector('.cs-review-pct');
    const labelText = g.reviewDesc + (hasPercent ? ' ·' : '');
    if(labelEl.textContent !== labelText) labelEl.textContent = labelText;
    const pctText = hasPercent ? g.reviewPositivePercent + '%' : '';
    if(pctEl.textContent !== pctText) pctEl.textContent = pctText;
  } else {
    badge.style.display = 'none';
  }

  const numsWrap = tile.querySelector('.cs-ach-numbers');
  const barBg = tile.querySelector('.cs-ach-bar-bg');
  if(hasAch){
    numsWrap.style.display = '';
    barBg.style.display = '';
    const color = achColor(g.achievementsPercent);
    numsWrap.querySelector('.nums').textContent = \`\${g.achievementsUnlocked}/\${g.achievementsTotal}\`;
    const pctEl = numsWrap.querySelector('.cs-pct');
    pctEl.textContent = g.achievementsPercent + '%';
    pctEl.style.color = color;
    const fill = barBg.querySelector('.cs-ach-bar-fill');
    fill.style.width = g.achievementsPercent + '%';
    fill.style.background = color;
  } else {
    numsWrap.style.display = 'none';
    barBg.style.display = 'none';
  }

  const img = tile.querySelector('img');
  const candidates = imgCandidates(g.appid, g);
  const newCandJson = JSON.stringify(candidates);
  if(img.dataset.candidates !== newCandJson){
    img.dataset.candidates = newCandJson;
    img.dataset.fallbackIdx = '0';
    img.src = candidates[0];
    tile.classList.remove('no-image');
  }
}

function placeAfter(container, node, afterNode){
  const desired = afterNode ? afterNode.nextSibling : container.firstChild;
  if(desired !== node) container.insertBefore(node, desired);
}

function updateGamesGrid(gamesGrid, s){
  const container = document.getElementById('games-grid');

  if(!gamesGrid.length){
    container.innerHTML = '<div class="cs-empty-state">Нет данных</div>';
    tileMap.clear();
    return;
  }
  const placeholder = container.querySelector('.cs-empty-state');
  if(placeholder) placeholder.remove();
  container.querySelectorAll('.cs-group-label').forEach(el => el.remove());

  const hasAchOf = g => g.achievementsPercent !== null && g.achievementsPercent !== undefined;
  const withAch = gamesGrid.filter(hasAchOf).sort((a, b) => a.name.localeCompare(b.name));
  const withoutAch = gamesGrid.filter(g => !hasAchOf(g)).sort((a, b) => a.name.localeCompare(b.name));
  gamesGrid = withAch.concat(withoutAch);

  const seen = new Set();
  let anchor = null;
  let lastGroup = null;

  gamesGrid.forEach(g => {
    const hasAch = g.achievementsPercent !== null && g.achievementsPercent !== undefined;
    const group = hasAch ? 'with' : 'without';
    if(group !== lastGroup){
      const label = buildGroupLabel(group, s);
      placeAfter(container, label, anchor);
      anchor = label;
      lastGroup = group;
    }
    let tile = tileMap.get(g.appid);
    if(!tile){
      tile = buildTile(g);
      tileMap.set(g.appid, tile);
    } else {
      updateTile(tile, g);
    }
    placeAfter(container, tile, anchor);
    anchor = tile;
    seen.add(g.appid);
  });

  for(const [appid, el] of Array.from(tileMap.entries())){
    if(!seen.has(appid)){
      el.remove();
      tileMap.delete(appid);
    }
  }
}

function renderReport(report){
  if(!report || !report.summary) return;

  const json = JSON.stringify(report);
  if(json === lastReportJson) return;
  lastReportJson = json;

  if(!skeletonBuilt){
    buildSkeleton();
    skeletonBuilt = true;
  }

  updateStats(report.summary);
  updateMastery(report.summary);
  updateRarityCard(report.rarityTiers);
  updateGamesGrid(report.gamesGrid || [], report.summary);
  document.getElementById('last-updated').textContent = 'обновлено ' + fmtDate(report.generatedAt);
}

function fmtDate(iso){
  if(!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('ru-RU', {day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'});
}

function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// Steam раздаёт арт с двух CDN одновременно (Cloudflare/Akamai) — если один
// недоступен в конкретной сети, пробуем другой. Варианты картинки — на
// случай, если у игры не залит именно этот файл в Steamworks.
const IMG_CDN_HOSTS = ['cdn.cloudflare.steamstatic.com', 'cdn.akamai.steamstatic.com'];
const IMG_FILE_VARIANTS = [
  'header.jpg',
  'capsule_616x353.jpg',
  'library_hero.jpg',
  'capsule_231x87.jpg',
  'library_600x900_2x.jpg',
  'library_600x900.jpg',
  'capsule_184x69.jpg',
];

// localImage — реально скачанный файл на диске сервера (см. lib/stats.js:
// fetchGameImages), приоритетнее всего — не зависит от CDN Steam при
// повторных заходах. headerImage/capsuleImagev5/capsuleImage — прямые
// ссылки на Steam, резерв.
function imgCandidates(appid, g){
  const list = [];
  if(g && g.localImage) list.push(g.localImage);
  if(g && g.headerImage) list.push(g.headerImage);
  if(g && g.capsuleImagev5) list.push(g.capsuleImagev5);
  if(g && g.capsuleImage) list.push(g.capsuleImage);
  for(const file of IMG_FILE_VARIANTS){
    for(const host of IMG_CDN_HOSTS){
      list.push(\`https://\${host}/steam/apps/\${appid}/\${file}\`);
    }
  }
  return list;
}
function handleThumbError(img){
  let candidates;
  try {
    candidates = JSON.parse(img.dataset.candidates || '[]');
  } catch(e) {
    candidates = [];
  }
  const idx = parseInt(img.dataset.fallbackIdx || '0', 10) + 1;
  if(idx < candidates.length){
    img.dataset.fallbackIdx = String(idx);
    img.src = candidates[idx];
  } else {
    img.closest('.cs-tile').classList.add('no-image');
  }
}

// Градация прогресса ачивок — не 2 плоских цвета (было: "не начато" серым,
// "не 100%" фиолетовым, "100%" золотом), а плавный градиент от тусклого
// (только начал) через фиолетовый (в процессе) к золоту (почти/полностью
// пройдено) — тот же приём, что уже есть у reviewColor ниже.
const ACH_GRADIENT_STOPS = [
  { pct: 0,   rgb: [122, 114, 160] }, // var(--muted)
  { pct: 50,  rgb: [179, 136, 255] }, // var(--accent)
  { pct: 100, rgb: [255, 204, 102] }, // var(--amber)
];
function achColor(pct){
  if(pct === null || pct === undefined) return 'var(--muted)';
  const p = Math.max(0, Math.min(100, pct));
  let lo = ACH_GRADIENT_STOPS[0], hi = ACH_GRADIENT_STOPS[ACH_GRADIENT_STOPS.length - 1];
  for(let i = 0; i < ACH_GRADIENT_STOPS.length - 1; i++){
    if(p >= ACH_GRADIENT_STOPS[i].pct && p <= ACH_GRADIENT_STOPS[i+1].pct){
      lo = ACH_GRADIENT_STOPS[i]; hi = ACH_GRADIENT_STOPS[i+1]; break;
    }
  }
  const span = hi.pct - lo.pct;
  const t = span === 0 ? 0 : (p - lo.pct) / span;
  const [r, g, b] = mixRgb(lo.rgb, hi.rgb, t);
  return \`rgb(\${r}, \${g}, \${b})\`;
}

// Непрерывный градиент по проценту положительных отзывов: 0% — красный,
// 50% — золото, 100% — зелёный, линейная интерполяция между опорными точками.
const REVIEW_GRADIENT_STOPS = [
  { pct: 0,   rgb: [239, 83, 80] },
  { pct: 50,  rgb: [255, 204, 102] },
  { pct: 100, rgb: [102, 187, 106] },
];
function mixRgb(a, b, t){
  return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
}
function reviewColor(percent){
  if(percent === null || percent === undefined) return 'var(--muted)';
  const p = Math.max(0, Math.min(100, percent));
  let lo = REVIEW_GRADIENT_STOPS[0], hi = REVIEW_GRADIENT_STOPS[REVIEW_GRADIENT_STOPS.length - 1];
  for(let i = 0; i < REVIEW_GRADIENT_STOPS.length - 1; i++){
    if(p >= REVIEW_GRADIENT_STOPS[i].pct && p <= REVIEW_GRADIENT_STOPS[i+1].pct){
      lo = REVIEW_GRADIENT_STOPS[i]; hi = REVIEW_GRADIENT_STOPS[i+1]; break;
    }
  }
  const span = hi.pct - lo.pct;
  const t = span === 0 ? 0 : (p - lo.pct) / span;
  const [r, g, b] = mixRgb(lo.rgb, hi.rgb, t);
  return \`rgb(\${r}, \${g}, \${b})\`;
}

let activeTab = 'steam';
let steamPollTimer = null;
let retroPollTimer = null;
let retroLoaded = false;

function switchTab(t){
  ['steam','retro','overall'].forEach(name => {
    document.getElementById('panel-' + name).classList.toggle('active', t === name);
    document.getElementById('tab-' + name).classList.toggle('active', t === name);
  });
  activeTab = t;
  const titles = {
    steam: \`CheevoScope <span style="color:var(--accent)">· Steam</span>\`,
    retro: \`CheevoScope <span style="color:var(--amber)">· RetroAchievements</span>\`,
    overall: \`CheevoScope <span style="color:var(--amber)">· Общая статистика</span>\`,
  };
  document.getElementById('page-title').innerHTML = titles[t];

  const isOverall = t === 'overall';
  document.getElementById('refresh-btn').style.display = isOverall ? 'none' : '';
  document.getElementById('force-refresh-btn').style.display = (isOverall || t === 'retro') ? 'none' : '';
  document.getElementById('refresh-both-btn').style.display = isOverall ? '' : 'none';
  if(!isOverall) document.getElementById('status-line').textContent = '';

  if(t === 'retro' && !retroLoaded){
    retroLoaded = true;
    loadRetroReport();
    pollRetroStatus();
  }
  if(t === 'overall'){
    loadOverall();
  }
}

async function loadReport(){
  try{
    const res = await fetch('api/report');
    const data = await res.json();
    renderReport(data);
  }catch(e){ /* тихо игнорируем — покажем при следующей попытке */ }
}

async function pollSteamStatus(){
  try{
    const res = await fetch('api/status');
    const s = await res.json();
    const btn = document.getElementById('refresh-btn');
    const forceBtn = document.getElementById('force-refresh-btn');
    const line = document.getElementById('status-line');
    line.classList.remove('error');

    if(s.state === 'running'){
      btn.disabled = true;
      btn.classList.add('spinning');
      forceBtn.disabled = true;
      if(activeTab === 'steam'){
        var mainText = s.progress
          ? \`\${stageLabel(s.stage)}: \${s.progress.done} / \${s.progress.total}\`
          : stageLabel(s.stage) + '...';
        // secondaryStage — достижения считаются параллельно с картинками/
        // ценами/отзывами (см. lib/pipeline.js), у обоих свой прогресс.
        var secondaryText = (s.secondaryStage && s.secondaryProgress)
          ? \` · \${stageLabel(s.secondaryStage)}: \${s.secondaryProgress.done} / \${s.secondaryProgress.total}\`
          : '';
        line.textContent = mainText + secondaryText;
      }
      loadReport();
    } else if(s.state === 'error'){
      btn.disabled = false;
      btn.classList.remove('spinning');
      forceBtn.disabled = false;
      if(activeTab === 'steam'){
        line.classList.add('error');
        line.textContent = 'Ошибка: ' + (s.error || 'неизвестная');
      }
      clearInterval(steamPollTimer);
    } else if(s.state === 'done'){
      btn.disabled = false;
      btn.classList.remove('spinning');
      forceBtn.disabled = false;
      if(activeTab === 'steam') line.textContent = '';
      clearInterval(steamPollTimer);
      loadReport();
    } else {
      btn.disabled = false;
      btn.classList.remove('spinning');
      forceBtn.disabled = false;
      if(activeTab === 'steam') line.textContent = '';
      clearInterval(steamPollTimer);
    }
  }catch(e){ /* сервер мог ещё не подняться — попробуем на следующем тике */ }
}

function stageLabel(stage){
  return {
    games_list: 'Считываю библиотеку',
    images: 'Загружаю картинки',
    achievements: 'Собираю достижения',
    library_cost: 'Считаю стоимость',
    reviews: 'Собираю отзывы',
    report: 'Собираю отчёт',
    profile: 'Загружаю профиль',
    games: 'Считываю библиотеку',
    awards: 'Собираю награды',
    game_details: 'Считаю очки по играм',
  }[stage] || 'Обновляю';
}

async function triggerRefresh(mode){
  const btn = document.getElementById('refresh-btn');
  const forceBtn = document.getElementById('force-refresh-btn');
  btn.disabled = true;
  btn.classList.add('spinning');
  forceBtn.disabled = true;
  const isFull = mode === 'full';
  const endpoint = activeTab === 'retro' ? 'api/retro/refresh' : 'api/refresh';
  try{
    const res = await fetch(\`\${endpoint}?mode=\${mode}\`, {method:'POST'});
    const line = document.getElementById('status-line');
    if(res.status === 409){
      line.textContent = 'Обновление уже идёт';
    } else if(res.status === 400){
      const data = await res.json();
      line.textContent = 'Ошибка: ' + (data.error || 'некорректный запрос');
    } else if(isFull){
      line.textContent = 'Пересчитываю с нуля...';
    }
  }catch(e){}

  if(activeTab === 'retro'){
    if(retroPollTimer) clearInterval(retroPollTimer);
    retroPollTimer = setInterval(pollRetroStatus, 2000);
    pollRetroStatus();
  } else {
    if(steamPollTimer) clearInterval(steamPollTimer);
    steamPollTimer = setInterval(pollSteamStatus, 2000);
    pollSteamStatus();
  }
}

// ========================================================================
// RetroAchievements — набор данных на порядок меньше, полный innerHTML-
// ребилд тут не создаёт заметных тормозов/мигания, точечный диффинг не нужен.
// ========================================================================

let lastRetroJson = null;

async function loadRetroReport(){
  try{
    const res = await fetch('api/retro/report');
    const data = await res.json();
    renderRetroReport(data);
  }catch(e){}
}

async function pollRetroStatus(){
  try{
    const res = await fetch('api/retro/status');
    const s = await res.json();
    const btn = document.getElementById('refresh-btn');
    const forceBtn = document.getElementById('force-refresh-btn');
    const line = document.getElementById('status-line');

    if(s.state === 'running'){
      btn.disabled = true; btn.classList.add('spinning'); forceBtn.disabled = true;
      if(activeTab === 'retro'){
        line.classList.remove('error');
        line.textContent = s.progress
          ? \`\${stageLabel(s.stage)}: \${s.progress.done} / \${s.progress.total}\`
          : stageLabel(s.stage) + '...';
      }
      loadRetroReport();
    } else if(s.state === 'error'){
      btn.disabled = false; btn.classList.remove('spinning'); forceBtn.disabled = false;
      if(activeTab === 'retro'){ line.classList.add('error'); line.textContent = 'Ошибка: ' + (s.error || 'неизвестная'); }
      clearInterval(retroPollTimer);
    } else if(s.state === 'done'){
      btn.disabled = false; btn.classList.remove('spinning'); forceBtn.disabled = false;
      if(activeTab === 'retro') line.textContent = '';
      clearInterval(retroPollTimer);
      loadRetroReport();
    } else {
      btn.disabled = false; btn.classList.remove('spinning'); forceBtn.disabled = false;
      if(activeTab === 'retro') line.textContent = '';
      clearInterval(retroPollTimer);
    }
  }catch(e){}
}

function renderRetroReport(report){
  if(!report || !report.summary) return;
  const json = JSON.stringify(report);
  if(json === lastRetroJson) return;
  lastRetroJson = json;

  const s = report.summary;
  const games = (report.games || []).slice().sort((a, b) => a.title.localeCompare(b.title));
  const container = document.getElementById('retro-content');

  const gamesHtml = games.length ? games.map(g => {
    const statusClass = g.status === 'mastered' ? 'mastered' : (g.status === 'completed' ? 'completed' : '');
    const statusText = g.status === 'mastered' ? 'Замастерено' : (g.status === 'completed' ? 'Завершено' : 'В процессе');
    const barColor = g.status === 'mastered' ? 'var(--amber)' : 'var(--accent)';
    return \`
    <div class="box cs-retro-row" data-game-id="\${g.gameId}" data-title="\${escapeHtml(g.title)}" data-name="\${escapeHtml(g.title)}" data-hardcore="\${g.hardcorePercent}" data-softcore="\${g.softcorePercent}">
      <div class="cs-icon-wrap">
        \${g.imageIcon ? \`<img src="https://media.retroachievements.org\${g.imageIcon}" alt="" loading="lazy">\` : ICONS.trophy}
      </div>
      <div class="cs-info">
        <div class="cs-name">\${escapeHtml(g.title)}</div>
        <div class="cs-meta-line">
          <span class="cs-console-chip">\${escapeHtml(g.console)}</span>
          <span>\${g.numAwardedHardcore} / \${g.maxPossible} · HC</span>
        </div>
      </div>
      <div class="cs-bars">
        <div class="cs-bar-bg-mini"><div class="cs-bar-fill-mini" style="width:\${g.hardcorePercent}%; background:\${barColor}"></div></div>
        <div class="cs-bar-bg-mini"><div class="cs-bar-fill-mini" style="width:\${g.softcorePercent}%; background:var(--accent); opacity:0.6;"></div></div>
      </div>
      <div class="cs-pct-block">\${g.hardcorePercent}%</div>
      <span class="cs-status-badge \${statusClass}">\${statusText}</span>
    </div>\`;
  }).join('') : '<div class="cs-empty-state"><strong>Нет данных</strong>Нажмите «Обновить».</div>';

  container.innerHTML = \`
    <div class="cs-stats-grid">
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.trophy}</div>
        <div class="cs-stat-body"><div class="cs-stat-label">Очки (points)</div><div class="cs-stat-value">\${s.gamesCount ? report.profile.points : 0}</div></div>
      </div>
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.tag}</div>
        <div class="cs-stat-body"><div class="cs-stat-label">RetroPoints</div><div class="cs-stat-value">\${report.profile.retroPoints || 0}</div></div>
      </div>
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.trophy}</div>
        <div class="cs-stat-body"><div class="cs-stat-label">Замастерено</div><div class="cs-stat-value" style="color:var(--amber)">\${s.gamesMastered}</div></div>
      </div>
    </div>
    <div class="cs-progress-row">
    <div class="box cs-mastery-card">
      <div class="cs-score-wrap">
        <div class="cs-score">\${s.overallHardcorePercent || 0}<span class="unit">%</span></div>
        <div class="cs-score-label">Прогресс</div>
      </div>
      <div class="cs-body">
        <span class="cs-label-row">\${ICONS.trophy} Средний хардкор-прогресс</span>
        <div class="cs-bar-bg"><div class="cs-bar-fill" style="width:\${Math.max(0, Math.min(100, s.overallHardcorePercent || 0))}%; \${(s.overallHardcorePercent || 0) >= 100 ? 'background:var(--amber);' : ''}"></div></div>
        <div class="cs-sub">Открыто <strong>\${s.achievementsHardcoreTotal}</strong> hardcore-достижений из <strong>\${s.achievementsPossibleTotal}</strong></div>
        <div class="cs-sub"><span class="badge">🏅 \${s.gamesMastered}</span> игр замастерено</div>
      </div>
    </div>
    <div class="box cs-rarity-card">
      <div class="cs-score-wrap">
        <div class="cs-score">\${report.rarityTiers ? report.rarityTiers.coolnessScore : 0}</div>
        <div class="cs-score-label">Крутость</div>
      </div>
      <div class="cs-body">
        <span class="cs-label-row">\${ICONS.trophy} Счётчик крутости</span>
        <div class="cs-rarity-tiers">\${rarityChipsHtml(report.rarityTiers && report.rarityTiers.counts)}</div>
        <div class="cs-sub">\${raritySubText(report.rarityTiers)}</div>
      </div>
    </div>
    </div>
    <div class="cs-section">
      <h2>Игры</h2>
      <div class="cs-toolbar">
        <input type="text" id="search-retro" placeholder="Поиск по названию…">
        <select id="sort-retro">
          <option value="name" selected>По алфавиту</option>
          <option value="hardcore">По hardcore %</option>
          <option value="softcore">По softcore %</option>
        </select>
      </div>
      <div class="cs-retro-list" id="retro-games-grid">\${gamesHtml}</div>
    </div>
  \`;

  document.getElementById('search-retro').addEventListener('input', () => filterGamesGrid('retro-games-grid', 'search-retro', 'sort-retro'));
  document.getElementById('sort-retro').addEventListener('change', () => filterGamesGrid('retro-games-grid', 'search-retro', 'sort-retro'));
  // Делегирование на весь список — строки пересоздаются целиком при каждом
  // рендере, навешивать по одному слушателю на строку незачем.
  document.getElementById('retro-games-grid').addEventListener('click', (e) => {
    const row = e.target.closest('.cs-retro-row');
    if(!row) return;
    openAchievementsModal('retro', row.dataset.gameId, row.dataset.title);
  });

  document.getElementById('last-updated').textContent = activeTab === 'retro' ? 'обновлено ' + fmtDate(report.generatedAt) : document.getElementById('last-updated').textContent;
}

function filterGamesGrid(gridId, searchId, sortId){
  const grid = document.getElementById(gridId);
  const query = document.getElementById(searchId).value.trim().toLowerCase();
  const sortBy = document.getElementById(sortId).value;
  const tileSelector = gridId === 'retro-games-grid' ? '.cs-retro-row' : '.cs-tile';
  const tiles = Array.from(grid.querySelectorAll(tileSelector));

  tiles.forEach(tile => {
    const match = (tile.dataset.name || '').toLowerCase().includes(query);
    tile.style.display = match ? '' : 'none';
  });

  const labels = Array.from(grid.querySelectorAll('.cs-group-label'));

  if(sortBy !== 'name'){
    labels.forEach(l => l.style.display = 'none');
    const sorted = tiles.slice().sort((a, b) => {
      if(sortBy === 'hardcore') return Number(b.dataset.hardcore || 0) - Number(a.dataset.hardcore || 0);
      if(sortBy === 'softcore') return Number(b.dataset.softcore || 0) - Number(a.dataset.softcore || 0);
      if(sortBy === 'hours') return Number(b.dataset.hours || 0) - Number(a.dataset.hours || 0);
      if(sortBy === 'achievements') return Number(b.dataset.achpct ?? -1) - Number(a.dataset.achpct ?? -1);
      return 0;
    });
    sorted.forEach(tile => grid.appendChild(tile));
  } else {
    let currentLabel = null;
    let visibleCount = 0;
    const finalize = () => { if(currentLabel) currentLabel.style.display = visibleCount ? '' : 'none'; };
    Array.from(grid.children).forEach(el => {
      if(el.classList.contains('cs-group-label')){
        finalize();
        currentLabel = el;
        visibleCount = 0;
      } else if((el.classList.contains('cs-tile') || el.classList.contains('cs-retro-row')) && el.style.display !== 'none'){
        visibleCount++;
      }
    });
    finalize();
  }
}

// ========================================================================
// "Общая статистика" — комбинирует уже загруженные report.json + retro_report.json.
// ========================================================================

async function loadOverall(){
  const container = document.getElementById('overall-content');
  try{
    const [steamRes, retroRes] = await Promise.all([fetch('api/report'), fetch('api/retro/report')]);
    const steamReport = await steamRes.json();
    const retroReport = await retroRes.json();
    renderOverall(steamReport, retroReport);
  }catch(e){
    container.innerHTML = '<div class="cs-empty-state">Не удалось загрузить сводку</div>';
  }
}

let overallRefreshPoll = null;

async function triggerRefreshBoth(){
  const btn = document.getElementById('refresh-both-btn');
  const line = document.getElementById('status-line');
  btn.disabled = true;
  btn.classList.add('spinning');
  line.classList.remove('error');
  line.textContent = 'Запускаю обновление достижений (Steam + RetroAchievements)…';

  try{
    await Promise.all([
      fetch('api/refresh?mode=quick', {method:'POST'}),
      fetch('api/retro/refresh?mode=full', {method:'POST'}),
    ]);
  }catch(e){}

  if(steamPollTimer) clearInterval(steamPollTimer);
  if(retroPollTimer) clearInterval(retroPollTimer);
  steamPollTimer = setInterval(pollSteamStatus, 2000);
  retroPollTimer = setInterval(pollRetroStatus, 2000);
  pollSteamStatus();
  pollRetroStatus();

  if(overallRefreshPoll) clearInterval(overallRefreshPoll);
  overallRefreshPoll = setInterval(checkBothDoneForOverall, 1500);
  checkBothDoneForOverall();
}

async function checkBothDoneForOverall(){
  try{
    const [sRes, rRes] = await Promise.all([fetch('api/status'), fetch('api/retro/status')]);
    const s = await sRes.json();
    const r = await rRes.json();
    const line = document.getElementById('status-line');

    const describe = (label, st) => st.state === 'running'
      ? \`\${label}: \${stageLabel(st.stage)}\${st.progress ? ' ' + st.progress.done + '/' + st.progress.total : '...'}\`
      : \`\${label}: готово\`;
    if(activeTab === 'overall') line.textContent = describe('Steam', s) + ' · ' + describe('RA', r);

    if(s.state !== 'running' && r.state !== 'running'){
      clearInterval(overallRefreshPoll);
      const btn = document.getElementById('refresh-both-btn');
      btn.disabled = false;
      btn.classList.remove('spinning');
      if(activeTab === 'overall') line.textContent = '';
      loadOverall();
    }
  }catch(e){}
}

function renderOverall(steamReport, retroReport){
  const container = document.getElementById('overall-content');
  const ss = steamReport.summary;
  const rs = retroReport.summary;
  if(!ss && !rs){
    container.innerHTML = \`
      <div class="cs-empty-state">
        <strong>Нужны данные обеих платформ</strong>
        Обновите вкладки Steam и RetroAchievements хотя бы по разу — здесь появится общая сводка.
      </div>\`;
    return;
  }

  const steamGames = ss ? ss.gamesCount : 0;
  const retroGames = rs ? rs.gamesCount : 0;
  const steamAch = ss ? ss.achievementsUnlockedTotal : 0;
  const retroAch = rs ? rs.achievementsHardcoreTotal : 0;
  const steamMastered = ss ? ss.gamesCompleted100 : 0;
  const retroMastered = rs ? rs.gamesMastered : 0;

  const totalGames = steamGames + retroGames;
  const totalAch = steamAch + retroAch;
  const totalMastered = steamMastered + retroMastered;

  const totalPossible = (ss ? ss.achievementsAvailableTotal : 0) + (rs ? rs.achievementsPossibleTotal : 0);
  const overallPct = totalPossible ? Math.round(1000 * totalAch / totalPossible) / 10 : 0;

  const pct = (a, total) => total ? Math.round(1000 * a / total) / 10 : 0;
  const mergedRarity = mergeRarityTiers(ss ? steamReport.rarityTiers : null, rs ? retroReport.rarityTiers : null);

  container.innerHTML = \`
    <div class="cs-stats-grid">
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.games}</div>
        <div class="cs-stat-body">
          <div class="cs-stat-label">Игр всего</div>
          <div class="cs-stat-value">\${steamGames} <span class="unit">+ \${retroGames}</span></div>
        </div>
      </div>
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.trophy}</div>
        <div class="cs-stat-body"><div class="cs-stat-label">Всего открыто</div><div class="cs-stat-value">\${totalAch}</div></div>
      </div>
      <div class="box cs-stat-card">
        <div class="cs-stat-icon">\${ICONS.check}</div>
        <div class="cs-stat-body"><div class="cs-stat-label">Замастерено</div><div class="cs-stat-value" style="color:var(--amber)">\${totalMastered}</div></div>
      </div>
    </div>
    <div class="cs-progress-row">
    <div class="box cs-mastery-card">
      <div class="cs-score-wrap">
        <div class="cs-score">\${overallPct}<span class="unit">%</span></div>
        <div class="cs-score-label">Прогресс</div>
      </div>
      <div class="cs-body">
        <span class="cs-label-row">\${ICONS.trophy} Общий прогресс по всем платформам</span>
        <div class="cs-bar-bg"><div class="cs-bar-fill" style="width:\${Math.max(0, Math.min(100, overallPct))}%; \${overallPct >= 100 ? 'background:var(--amber);' : ''}"></div></div>
        <div class="cs-sub">Средневзвешенный процент открытых достижений</div>
        <div class="cs-sub"><span class="badge">🏆 \${totalMastered}</span> игр закрыто на 100%</div>
      </div>
    </div>
    <div class="box cs-rarity-card">
      <div class="cs-score-wrap">
        <div class="cs-score">\${mergedRarity.coolnessScore}</div>
        <div class="cs-score-label">Крутость</div>
      </div>
      <div class="cs-body">
        <span class="cs-label-row">\${ICONS.trophy} Счётчик крутости (обе платформы)</span>
        <div class="cs-rarity-tiers">\${rarityChipsHtml(mergedRarity.counts)}</div>
        <div class="cs-sub">\${raritySubText(mergedRarity)}</div>
      </div>
    </div>
    </div>
    <div class="cs-section">
      <h2>Активность за год</h2>
      <div class="cs-heatmap-wrap" id="overall-heatmap-wrap"></div>
    </div>
    <div class="cs-section">
      <h2>Сравнение платформ</h2>
      <div class="cs-compare-list">
        <div class="cs-compare-row">
          <div class="cs-compare-head"><span class="cs-label">Игры</span><span class="cs-total">\${steamGames} + \${retroGames} = \${totalGames}</span></div>
          <div class="cs-compare-bar"><div class="cs-seg steam" style="width:\${pct(steamGames, totalGames)}%"></div><div class="cs-seg retro" style="width:\${pct(retroGames, totalGames)}%"></div></div>
        </div>
        <div class="cs-compare-row">
          <div class="cs-compare-head"><span class="cs-label">Достижения</span><span class="cs-total">\${steamAch} + \${retroAch} = \${totalAch}</span></div>
          <div class="cs-compare-bar"><div class="cs-seg steam" style="width:\${pct(steamAch, totalAch)}%"></div><div class="cs-seg retro" style="width:\${pct(retroAch, totalAch)}%"></div></div>
        </div>
        <div class="cs-compare-row">
          <div class="cs-compare-head"><span class="cs-label">100%</span><span class="cs-total">\${steamMastered} + \${retroMastered} = \${totalMastered}</span></div>
          <div class="cs-compare-bar"><div class="cs-seg steam" style="width:\${pct(steamMastered, totalMastered)}%"></div><div class="cs-seg retro" style="width:\${pct(retroMastered, totalMastered)}%"></div></div>
        </div>
      </div>
      <div class="cs-compare-legend">
        <span><span class="dot" style="background:var(--accent)"></span>Steam</span>
        <span><span class="dot" style="background:var(--amber)"></span>RetroAchievements</span>
      </div>
    </div>
    <div class="cs-section">
      <h2>Самые редкие открытые достижения</h2>
      <div class="cs-rarity-columns">
        <div class="cs-rarity-column">
          <div class="cs-rarity-column-head"><span class="dot" style="background:var(--accent)"></span>Steam</div>
          \${renderRarestColumn(steamReport.rarestAchievements)}
        </div>
        <div class="cs-rarity-column">
          <div class="cs-rarity-column-head"><span class="dot" style="background:var(--amber)"></span>RetroAchievements</div>
          \${renderRarestColumn(retroReport.rarestAchievements)}
        </div>
      </div>
    </div>
  \`;
  renderHeatmap('overall-heatmap-wrap', ss ? steamReport.activityHeatmap : null);
}

function renderRarestColumn(list){
  const top = (list || []).slice(0, 10);
  if(!top.length){
    return '<div class="cs-empty-state">Пока нет данных — нужно хотя бы одно полное «Обновить всё» (быстрое обновление эту статистику не считает).</div>';
  }
  return '<div class="cs-rarity-list">' + top.map((a, i) => \`
    <div class="cs-rarity-row">
      <span class="cs-rank">\${i + 1}</span>
      <div class="cs-info">
        <div class="cs-a-name">\${escapeHtml(a.name)}</div>
        <div class="cs-a-game">\${escapeHtml(a.game)}</div>
      </div>
      <span class="cs-rarity-pct">\${a.globalPercent}%</span>
    </div>\`).join('') + '</div>';
}

// ========================================================================
// Модалка "все ачивки" — общая для Steam- и RA-плиток.
// ========================================================================

async function openAchievementsModal(platform, id, title){
  const overlay = document.getElementById('ach-modal-overlay');
  const body = document.getElementById('ach-modal-body');
  document.getElementById('ach-modal-title').textContent = title || 'Достижения';
  body.innerHTML = '<div class="cs-modal-loading">Загрузка…</div>';
  overlay.classList.add('show');

  const url = platform === 'retro' ? \`api/retro/game/\${id}/achievements\` : \`api/game/\${id}/achievements\`;
  try{
    const res = await fetch(url);
    const data = await res.json();
    renderAchievementsModal(data, platform);
  }catch(e){
    body.innerHTML = '<div class="cs-modal-empty">Не удалось загрузить список достижений</div>';
  }
}

function closeAchievementsModal(){
  document.getElementById('ach-modal-overlay').classList.remove('show');
}

function renderAchievementsModal(data, platform){
  const body = document.getElementById('ach-modal-body');
  if(data && data.error){
    body.innerHTML = \`<div class="cs-modal-empty">Ошибка на сервере: \${escapeHtml(data.error)}</div>\`;
    return;
  }
  if(!data || !data.available || !data.achievements || !data.achievements.length){
    body.innerHTML = '<div class="cs-modal-empty">Нет данных о достижениях для этой игры</div>';
    return;
  }
  body.innerHTML = \`<div class="cs-ach-modal-list">\${data.achievements.map(a => {
    const unlocked = platform === 'retro' ? a.unlockedHardcore || a.unlocked : a.unlocked;
    const icon = platform === 'retro' ? a.badgeUrl : (unlocked ? a.icon : (a.iconGray || a.icon));
    const rarityText = a.globalPercent !== null && a.globalPercent !== undefined ? a.globalPercent + '%' : '—';
    return \`
    <div class="cs-ach-modal-row \${unlocked ? 'unlocked' : ''}">
      <div class="cs-ach-check">\${unlocked ? ICONS.check : ''}</div>
      \${icon ? \`<img class="cs-ach-icon" src="\${icon}" alt="" loading="lazy">\` : ''}
      <div class="cs-ach-body">
        <div class="cs-ach-name">\${escapeHtml(a.name)}</div>
        <div class="cs-ach-desc" title="\${escapeHtml(a.description)}">\${escapeHtml(a.description)}</div>
      </div>
      <div class="cs-ach-rarity">\${rarityText}</div>
    </div>\`;
  }).join('')}</div>\`;
}

document.getElementById('tab-steam').addEventListener('click', () => switchTab('steam'));
document.getElementById('tab-retro').addEventListener('click', () => switchTab('retro'));
document.getElementById('tab-overall').addEventListener('click', () => switchTab('overall'));
document.getElementById('refresh-btn').addEventListener('click', () => triggerRefresh(activeTab === 'retro' ? 'full' : 'quick'));
document.getElementById('force-refresh-btn').addEventListener('click', () => triggerRefresh('full'));
document.getElementById('refresh-both-btn').addEventListener('click', () => triggerRefreshBoth());
document.getElementById('ach-modal-close-btn').addEventListener('click', () => closeAchievementsModal());
document.getElementById('ach-modal-overlay').addEventListener('click', (e) => { if(e.target === e.currentTarget) closeAchievementsModal(); });

switchTab('steam');
loadReport();
pollSteamStatus();

// Свайп влево/вправо переключает вкладки Steam ⇄ RA ⇄ Общая статистика.
(function initSwipeNav(){
  const TAB_ORDER = ['steam', 'retro', 'overall'];
  const MIN_DIST = 60;
  let startX = 0, startY = 0, tracking = false, dragging = false, transitioning = false;
  let panelEl = null;

  function onStart(e){
    if(transitioning || e.touches.length !== 1){ tracking = false; return; }
    if(e.target.closest('#ach-modal-overlay')){ tracking = false; return; }
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    tracking = true;
    dragging = false;
    panelEl = document.querySelector('.cs-tab-panel.active');
  }

  function onMove(e){
    if(!tracking || !panelEl) return;
    const t = e.touches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if(!dragging){
      if(Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if(Math.abs(dy) > Math.abs(dx)){ tracking = false; return; }
      dragging = true;
      panelEl.style.transition = 'none';
    }
    const idx = TAB_ORDER.indexOf(activeTab);
    const atEdge = (idx === 0 && dx > 0) || (idx === TAB_ORDER.length - 1 && dx < 0);
    panelEl.style.transform = \`translateX(\${dx * (atEdge ? 0.3 : 0.9)}px)\`;
  }

  function onEnd(e){
    if(!tracking) return;
    tracking = false;
    if(!dragging){ panelEl = null; return; }

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const idx = TAB_ORDER.indexOf(activeTab);
    const goNext = dx < -MIN_DIST && idx < TAB_ORDER.length - 1;
    const goPrev = dx > MIN_DIST && idx > 0;
    const el = panelEl;
    panelEl = null;

    el.style.transition = 'transform .2s ease';
    if(goNext || goPrev){
      transitioning = true;
      el.style.transform = \`translateX(\${goNext ? -40 : 40}px)\`;
      setTimeout(() => {
        el.style.transition = 'none';
        el.style.transform = '';
        switchTab(TAB_ORDER[idx + (goNext ? 1 : -1)]);
        transitioning = false;
      }, 200);
    } else {
      el.style.transform = 'translateX(0)';
    }
  }

  const wrap = document.querySelector('.page') || document.body;
  wrap.addEventListener('touchstart', onStart, {passive: true});
  wrap.addEventListener('touchmove', onMove, {passive: true});
  wrap.addEventListener('touchend', onEnd, {passive: true});
})();
`;


function safeJoin(baseDir, requestedPath) {
  const target = path.join(baseDir, requestedPath);
  if (!target.startsWith(path.normalize(baseDir + path.sep)) && target !== baseDir) return null;
  return target;
}

const EXT_TO_CONTENT_TYPE = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage({ title: 'CheevoScope', username: process.env.AUTH_USER || 'user', extraHead: EXTRA_HEAD, bodyContent: BODY_CONTENT, extraScript: EXTRA_SCRIPT }));
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', module: 'cheevoscope' }));
    return;
  }

  // /static/game_images/* — персистентная папка (реально скачанные картинки
  // игр). /static/* остальное — для будущих собственных файлов модуля,
  // сейчас не используется (favicon отдаёт хаб на уровне корня, своего PWA
  // у модуля нет — решение: страница CheevoScope как часть общего PWA хаба).
  if (req.method === 'GET' && pathname.startsWith('/static/')) {
    const rel = pathname.slice('/static/'.length);
    const baseDir = rel.startsWith('game_images/') ? GAME_IMAGES_DIR : BUNDLED_STATIC_DIR;
    const relInBase = rel.startsWith('game_images/') ? rel.slice('game_images/'.length) : rel;
    const filePath = safeJoin(baseDir, relInBase);
    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'некорректный путь' }));
      return;
    }
    try {
      const data = await fs.readFile(filePath);
      const contentType = EXT_TO_CONTENT_TYPE[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'не найдено' }));
    }
    return;
  }

  // --- Steam ---

  // GET /api/summary — для мини-карточки на главной хаба: ачивки Steam,
  // ачивки RA, часы в Steam (у RA нет понятия наигранного времени вообще —
  // сервис только для достижений, не трекер библиотеки). Читает уже
  // готовые отчёты, не гоняет собственный пайплайн заново.
  if (req.method === 'GET' && pathname === '/api/summary') {
    async function readJsonOrEmpty(filePath) {
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf-8'));
      } catch {
        return {};
      }
    }
    const [steam, retro] = await Promise.all([
      readJsonOrEmpty(paths.reportJsonFile),
      readJsonOrEmpty(paths.retroReportJsonFile),
    ]);
    const ss = steam.summary || {};
    const rs = retro.summary || {};
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      steamAchievementsUnlocked: ss.achievementsUnlockedTotal ?? null,
      steamAchievementsTotal: ss.achievementsAvailableTotal ?? null,
      raAchievementsUnlocked: rs.achievementsHardcoreTotal ?? null,
      raAchievementsTotal: rs.achievementsPossibleTotal ?? null,
      steamHours: ss.totalHours ?? null,
    }));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/report') {
    try {
      const raw = await fs.readFile(paths.reportJsonFile, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const status = await pipeline.readStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/refresh') {
    const mode = url.searchParams.get('mode') || 'quick';
    if (mode !== 'quick' && mode !== 'full') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Неизвестный режим обновления: ${mode}. Допустимо: quick, full.` }));
      return;
    }
    const { started } = pipeline.startRefresh(mode);
    if (!started) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: false, message: 'Обновление уже идёт' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true, mode }));
    return;
  }

  const steamAchMatch = pathname.match(/^\/api\/game\/(\d+)\/achievements$/);
  if (req.method === 'GET' && steamAchMatch) {
    const appid = Number(steamAchMatch[1]);
    try {
      const details = await getAchievementDetails();
      const result = await details.getSteamGameAchievements(appid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error(`[cheevoscope] ошибка при получении ачивок Steam appid=${appid}:`, e);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, achievements: [], error: e.message }));
    }
    return;
  }

  // --- RetroAchievements: отдельные роуты, параллельные Steam-версии выше ---

  if (req.method === 'GET' && pathname === '/api/retro/report') {
    try {
      const raw = await fs.readFile(paths.retroReportJsonFile, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(raw);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/retro/status') {
    const status = await retroPipeline.readStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
    return;
  }

  if (req.method === 'POST' && pathname === '/api/retro/refresh') {
    const mode = url.searchParams.get('mode') || 'quick';
    if (mode !== 'quick' && mode !== 'full') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Неизвестный режим обновления: ${mode}. Допустимо: quick, full.` }));
      return;
    }
    const { started } = retroPipeline.startRefresh(mode);
    if (!started) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: false, message: 'Обновление уже идёт' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ started: true, mode }));
    return;
  }

  const retroAchMatch = pathname.match(/^\/api\/retro\/game\/(\d+)\/achievements$/);
  if (req.method === 'GET' && retroAchMatch) {
    const gameId = Number(retroAchMatch[1]);
    try {
      const details = await getAchievementDetails();
      const result = await details.getRetroGameAchievements(gameId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      console.error(`[cheevoscope] ошибка при получении ачивок RA gameId=${gameId}:`, e);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, achievements: [], error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
  console.log(`[cheevoscope] модуль слушает порт ${PORT}`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
