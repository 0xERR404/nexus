import {homeSettings} from './overview-views.mjs';
import {readFileSync} from 'node:fs';
const version = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;
export const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]
  );
const head = (title) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#090909"><meta name="mobile-web-app-capable" content="yes"><title>${title}</title><link rel="manifest" href="/manifest.json"><link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/overview.css"><link rel="stylesheet" href="/intro.css"><script src="/intro.js" defer></script><script src="/ui.js" defer></script><script src="/activity.js" defer></script><script src="/performance.js" defer></script><script src="/app.js" defer></script></head>`;
const install = `<button class="install-btn" data-install hidden type="button">Установить</button>`;
const dialog = `<dialog id="installHelp" aria-labelledby="installHelpTitle"><h2 id="installHelpTitle">Хаб на телефоне</h2><p>Открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».</p><form method="dialog"><button class="login-btn">Понятно</button></form></dialog>`;
export function login(error = '', username = '', passkey = false, auto = true) {
  return `${head('NEXUS404 — вход')}<body class="login-page"><main class="box"${passkey ? ` id="passkeyLogin" data-auto="${auto ? '1' : '0'}"` : ''}>${passkey ? securityAssets : ''}<div class="brand login-brand">${brand}</div><div class="prompt login-prompt">личное пространство / вход</div><div class="lines"><div class="line"><span>С возвращением.</span></div>${error ? `<div class="line err" role="alert"><span>${escape(error)}</span></div>` : ''}</div>${passkey ? `<button class="login-btn" id="passkeyEnter" type="button">Войти по отпечатку</button><p id="securityStatus" role="status"></p><details id="passwordFallback"${auto ? '' : ' open'}><summary>Другой способ входа</summary>` : ''}<form class="login-form" method="post" action="/api/auth/login"><div class="field-row"><span class="sym" aria-hidden="true">&gt;</span><label class="sr-only" for="username">Логин</label><input id="username" name="username" placeholder="логин" value="${escape(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required></div><div class="field-row"><span class="sym" aria-hidden="true">&gt;</span><label class="sr-only" for="password">Пароль</label><input id="password" name="password" type="password" placeholder="пароль" autocomplete="current-password" maxlength="1024" required><button class="reveal" id="revealPassword" type="button" aria-label="Показать пароль" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><button class="login-btn" type="submit">Войти <span aria-hidden="true">→</span></button></form>${passkey ? '</details>' : ''}<div class="login-foot">${install}</div></main>${dialog}</body></html>`;
}
const securityAssets =
  '<link rel="stylesheet" href="/security.css"><script src="/security.js" defer></script>';
export function factorLogin() {
  return `${head('Подтверждение входа — NEXUS404')}<body class="login-page"><main class="box" id="factorLogin">${securityAssets}<div class="brand login-brand">${brand}</div><h1>Подтверждение входа</h1><p>Используй ключ доступа на телефоне или другом устройстве.</p><button id="factorKey" type="button">Подтвердить ключом</button><details><summary>Потерял устройство?</summary><form id="factorRecovery"><label for="recoveryCode">Одноразовый код восстановления</label><input id="recoveryCode" type="password" autocomplete="off" maxlength="64" required><button type="submit">Восстановить доступ</button></form></details><p id="securityStatus" role="status"></p><a href="/login?password=1">Ввести пароль заново</a></main></body></html>`;
}
const securityContent = `${securityAssets}<section id="securitySettings"><p id="securityStatus" role="status"></p><p id="securityRecovered" hidden>Вход по коду восстановления. Добавь новый ключ и удали потерянный.</p><div class="security-grid"><section class="security-panel"><h2>Пароль</h2><form id="securityPasswordForm"><label>Текущий пароль<input id="securityOld" type="password" autocomplete="current-password" required maxlength="1024"></label><label>Новый пароль<input id="securityNew" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><label>Повтори новый пароль<input id="securityRepeat" type="password" autocomplete="new-password" required minlength="12" maxlength="1024"></label><button type="submit">Сменить пароль</button></form></section><section class="security-panel"><h2>Ключи доступа</h2><p id="securityFactorState"></p><label>Название устройства<input id="securityKeyName" maxlength="60" placeholder="Мой телефон"></label><div class="security-actions"><button id="securityKeyAdd" type="button">Добавить ключ доступа</button><button id="securityCodesNew" type="button" hidden>Новые коды восстановления</button></div><p id="securityRecoveryState"></p><div id="securityKeys"></div></section><section class="security-panel security-wide"><h2>Срок сессии</h2><form id="securityTTLForm"><label>Автоматический выход<select id="securityTTL"><option value="3600">Через час</option><option value="86400">Через сутки</option><option value="604800">Через 7 дней</option><option value="2592000">Через 30 дней</option></select></label><button type="submit">Сохранить</button></form><p>Отсчёт от входа. Сокращение срока действует и на текущие сессии; увеличение — на новые.</p></section><section class="security-panel security-wide"><div class="security-heading"><h2>Активные сессии</h2><div class="security-actions"><button id="securityRefresh" type="button">Обновить</button><button id="securityOthers" type="button">Завершить остальные</button></div></div><div id="securitySessions"></div></section></div><dialog id="securityConfirm" aria-labelledby="securityConfirmTitle"><div class="security-heading"><h2 id="securityConfirmTitle">Подтверди действие</h2><button type="button" class="dialog-close" data-security-close aria-label="Закрыть">×</button></div><form id="securityConfirmForm"><label for="securityCurrent">Текущий пароль</label><input id="securityCurrent" type="password" autocomplete="current-password" required maxlength="1024"><button type="submit">Подтвердить</button></form></dialog><dialog id="securityCodes" aria-labelledby="securityCodesTitle"><div class="security-heading"><h2 id="securityCodesTitle">Сохрани коды</h2><button type="button" class="dialog-close" data-security-close aria-label="Закрыть">×</button></div><p>Показываются один раз. Каждый код заменяет второй фактор при входе с паролем. Храни отдельно от телефона.</p><pre id="securityCodesText"></pre><button type="button" id="securityCodesDownload">Скачать коды</button></dialog></section>`;
const icons = {
  cinema: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>',
  statistics: '<path d="M4 20h17M6 17v-5M12 17V7M18 17V3"/>',
  rhythm: '<path d="M2 12h5l3-8 4 16 3-8h5"/>',
  kanban: '<path d="M3 4h18v16H3zM9 4v16M15 4v16M5 8h2M11 8h2M17 8h2M5 12h2M11 12h2"/>',
  storage: '<path d="M3 5h18v14H3zM3 10h18M7 15h4"/>',
  projects: '<path d="M3 6h8l2 2h8v12H3zM7 13h10M7 16h7"/>',
  reader: '<path d="M12 5C8 2 4 3 2 4v16c3-2 6-2 10 0 4-2 7-2 10 0V4c-2-1-6-2-10 1zM12 5v15"/>',
  gallery:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
  articles: '<path d="M5 3h14v18H5zM8 7h8M8 11h8M8 15h5"/>',
  wave: '<path d="M4 10v4m4-8v12m4-16v20m4-16v12m4-8v4"/>',
  trophies:
    '<path d="M8 3h8v6a4 4 0 0 1-8 0ZM8 5H4v2a4 4 0 0 0 4 4m8-6h4v2a4 4 0 0 1-4 4M12 13v7m-4 1h8"/>',
  anime: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="m9 2 3 3 3-3M10 10l5 3-5 3Z"/>',
  balance:
    '<rect x="3" y="6" width="18" height="15" rx="3"/><path d="M3 9V6a2 2 0 0 1 2-2l12-2v4m4 7h-5a2 2 0 0 0 0 4h5"/>',
  chat: '<path d="M21 11.5a9 9 0 0 1-9 9 10 10 0 0 1-4-.9L3 21l1.4-4.7A9 9 0 1 1 21 11.5Z"/>',
  pulse: '<path d="M2 12h5l3-9 4 18 3-9h5"/>',
  signal: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 2V1"/>',
  settings:
    '<path d="m9 3 1-2h4l1 2 3 2 2-.1 2 3-1 2v4l1 2-2 3-2-.1-3 2-1 2h-4l-1-2-3-2-2 .1-2-3 1-2v-4L2 8l2-3 2 .1Z"/><circle cx="12" cy="12" r="4"/>',
  logout: '<path d="M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9m2-15 6 6-6 6m-8-6h14"/>',
  back: '<path d="m14 6-6 6 6 6"/>',
  module:
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'
};
const icon = (name) =>
  `<svg class="ui-icon" viewBox="0 0 24 24" aria-hidden="true">${icons[name] ?? icons.module}</svg>`;
const brand = `<img class="brand-mark" src="/mark.svg" alt="" width="40" height="25"><span class="brand-name">NEXUS404</span>`;
const header = (username, title) =>
  `<header class="header"><div class="header-top"><a class="brand" href="/" aria-label="NEXUS404 — главная">${brand}</a><div class="status-badge"><span class="dot-status" id="statusDot"></span><span id="statusText">online</span></div><a class="header-settings" href="/settings/" aria-label="Настройки" title="Настройки">${icon('settings')}</a><form method="post" action="/api/auth/logout"><button class="logout" type="submit" aria-label="Выйти" title="Выйти">${icon('logout')}</button></form></div><div class="header-bottom"><div class="prompt">${escape(username)} <span>/</span> ${title ? escape(title) : 'home'}</div>${title ? `<a class="back-link" href="/">${icon('back')}В хаб</a>` : install}</div></header>`;
const footer = `<footer class="page-foot"><span>NEXUS404 · v${escape(version)}</span></footer>`;
export function dashboard(username, modules, total = modules.length) {
  const cards = [...modules]
    .map(
      (module) =>
        `<a class="module-card" data-module="${module.id}" href="/modules/${module.id}/"><div class="module-heading">${icon(module.id)}<h2>${escape(module.title)}</h2><span class="card-chevron" aria-hidden="true">›</span></div>${module.summary ? `<div class="module-summary" data-summary="${module.id}" data-state="loading"><span class="module-summary-note">Получаем данные…</span></div>` : ''}</a>`
    )
    .join('');
  return `${head('NEXUS404')}<body class="dashboard-page"><div class="page">${header(username)}<main><div class="section-line"><h1>Личное пространство</h1><span>${total} подключено</span></div>${!modules.length ? (total ? '<p class="settings-empty">Карточки скрыты. Вернуть их можно в настройках главной.</p>' : '<p class="settings-empty">Пока нет модулей.</p>') : ''}<div class="modules-grid">${cards}</div></main>${footer}</div>${dialog}</body></html>`;
}
export function modulePage({username, title, content}) {
  return `${head(escape(title) + ' — NEXUS404')}<body><div class="page">${header(username, title)}<main><div class="section-line"><h1>${escape(title)}</h1></div>${content}</main>${footer}</div></body></html>`;
}

export function settingsPage(username, modules, selectedId) {
  const entries = [
    {id: 'home', settings: {title: 'Главная', content: homeSettings}},
    {
      id: 'appearance',
      settings: {
        title: 'Оформление',
        content:
          '<section class="intro-settings"><label><input id="introEnabled" type="checkbox">Приветствие после входа</label><label><input id="introSound" type="checkbox">Звук приветствия</label><p>NEXUS ONLINE · WELCOME BACK</p><button id="introPreview" type="button">Посмотреть заставку</button><p id="introSettingStatus" role="status"></p></section>'
      }
    },
    {id: 'security', settings: {title: 'Безопасность', content: securityContent}},
    ...modules.filter((module) => module.settings)
  ];
  const selected =
    entries.find((module) => module.id === selectedId) ??
    entries.find((entry) => entry.id === 'appearance');
  const nav = entries.length
    ? `<nav class="settings-tabs" aria-label="Разделы настроек">${entries.map((module) => `<a href="/settings/?module=${module.id}"${module === selected ? ' aria-current="page"' : ''}>${escape(module.settings.title)}</a>`).join('')}</nav>`
    : '';
  return modulePage({
    username,
    title: 'Настройки',
    content:
      nav +
      (selected?.settings.content ??
        '<p class="settings-empty">Установленные модули пока не добавили настройки.</p>')
  });
}

export function playerShell(url) {
  const target = new URL(url, 'http://localhost');
  target.searchParams.set('_view', '1');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#090909"><title>NEXUS404</title><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/overview.css"><link rel="stylesheet" href="/intro.css"><script src="/intro.js" defer></script><script src="/ui.js" defer></script><script src="/activity.js" defer></script><link rel="stylesheet" href="/modules/wave/wave.css"><script src="/modules/wave/player.js" defer></script></head><body class="wave-shell"><iframe id="hubFrame" title="NEXUS404" src="${escape(target.pathname + target.search + target.hash)}" allow="autoplay; clipboard-write"></iframe><div id="waveTransfer" hidden><span id="waveTransferText" role="status"></span><button id="waveTransferStop" type="button">Остановить</button></div><section id="wavePlayer" aria-label="Плеер Аполлон" hidden><audio id="waveAudio" preload="metadata"></audio><div class="wave-player-heading"><span>АПОЛЛОН</span><span>СЕЙЧАС ИГРАЕТ</span></div><div class="wave-player-row"><button id="waveArtworkToggle" class="wave-player-art" aria-label="Открыть плеер"><img id="wavePlayerCover" alt="" hidden><span id="waveCoverFallback"><img src="/mark.svg" alt=""></span></button><button id="waveOpenTrack" class="wave-player-info" aria-label="Открыть плеер"><strong id="waveTrackTitle"></strong><span id="waveTrackArtist"></span></button><div class="wave-transport"><button id="wavePrev" aria-label="Предыдущий трек"></button><button id="waveToggle" aria-label="Воспроизвести"></button><button id="waveNext" aria-label="Следующий трек"></button></div><button id="waveExpand" aria-label="Раскрыть плеер" aria-expanded="false"></button></div><div class="wave-player-progress"><input id="waveSeek" type="range" min="0" max="100" step="0.1" value="0" disabled aria-label="Позиция трека"><span id="waveTime"><span id="waveElapsed">0:00</span><span class="wave-time-divider"> / </span><span id="waveDuration">0:00</span></span></div><div class="wave-player-extra"><button id="waveShuffle" aria-label="Перемешивание" aria-pressed="false"></button><button id="waveRepeat" aria-label="Повтор" aria-pressed="false"></button><label class="wave-volume-row"><span id="waveVolumeIcon" aria-hidden="true"></span><input id="waveVolume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Громкость"></label><button id="waveQueueToggle" aria-haspopup="dialog" aria-expanded="false">Очередь</button><span id="waveQueueCount"></span></div><p id="wavePlayerStatus" role="status"></p><dialog id="waveQueueDialog" aria-labelledby="waveQueueTitle"><div class="wave-queue-heading"><h2 id="waveQueueTitle">Очередь</h2><button id="waveQueueClose" aria-label="Закрыть очередь">×</button></div><div id="waveQueue"></div></dialog></section></body></html>`;
}
