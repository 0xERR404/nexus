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
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b1118"><meta name="mobile-web-app-capable" content="yes"><title>${title}</title><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>`;
const install = `<button class="install-btn" data-install hidden type="button">Установить</button>`;
const dialog = `<dialog id="installHelp" aria-labelledby="installHelpTitle"><h2 id="installHelpTitle">Хаб на телефоне</h2><p>Открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».</p><form method="dialog"><button class="login-btn">Понятно</button></form></dialog>`;
export function login(error = '', username = '') {
  return `${head('NEXUS404 — вход')}<body class="login-page"><main class="box"><div class="brand login-brand">${brand}</div><div class="prompt login-prompt">личное пространство / вход</div><div class="lines"><div class="line"><span>С возвращением.</span></div>${error ? `<div class="line err" role="alert"><span>${escape(error)}</span></div>` : ''}</div><form class="login-form" method="post" action="/api/auth/login"><div class="field-row"><span class="sym" aria-hidden="true">&gt;</span><label class="sr-only" for="username">Логин</label><input id="username" name="username" placeholder="логин" value="${escape(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required></div><div class="field-row"><span class="sym" aria-hidden="true">&gt;</span><label class="sr-only" for="password">Пароль</label><input id="password" name="password" type="password" placeholder="пароль" autocomplete="current-password" maxlength="1024" required><button class="reveal" id="revealPassword" type="button" aria-label="Показать пароль" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><button class="login-btn" type="submit">Войти <span aria-hidden="true">→</span></button></form><div class="login-foot"><span>личное пространство</span>${install}</div></main>${dialog}</body></html>`;
}
const icons = {
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
const brand = `<span class="brand-name">NEXUS404</span><span class="brand-dots" aria-hidden="true"><i></i><i></i></span>`;
const header = (username, title) =>
  `<header class="header"><div class="header-top"><a class="brand" href="/" aria-label="NEXUS404 — главная">${brand}</a><div class="status-badge"><span class="dot-status" id="statusDot"></span><span id="statusText">online</span></div><form method="post" action="/api/auth/logout"><button class="logout" type="submit" aria-label="Выйти" title="Выйти">${icon('logout')}</button></form></div><div class="header-bottom"><div class="prompt">${escape(username)} <span>/</span> ${title ? escape(title) : 'home'}</div>${title ? `<a class="back-link" href="/">${icon('back')}В хаб</a>` : install}</div></header>`;
const footer = `<footer class="page-foot"><span>NEXUS404 · v${escape(version)}</span><span>личное пространство</span></footer>`;
export function dashboard(username, modules) {
  const cards = modules
    .map(
      (module) =>
        `<a class="module-card" data-module="${module.id}" href="/modules/${module.id}/"><div class="module-heading">${icon(module.id)}<h2>${escape(module.title)}</h2></div>${module.summary ? `<div class="module-summary" data-summary="${module.id}" data-state="loading"><span class="module-summary-note">Получаем данные…</span></div>` : ''}</a>`
    )
    .join('');
  const count = modules.filter((module) => module.settings).length;
  const settingsCard = `<a class="settings-card" href="/settings/">${icon('settings')}<div><h2>Настройки</h2><span>${count} ${count === 1 ? 'раздел' : count > 1 && count < 5 ? 'раздела' : 'разделов'}</span></div><span class="settings-arrow" aria-hidden="true">›</span></a>`;
  return `${head('NEXUS404')}<body><div class="page">${header(username)}<main><div class="section-line"><h1>Модули</h1><span>${modules.length} подключено</span></div>${!modules.length ? '<p class="settings-empty">Пока нет модулей.</p>' : ''}<div class="modules-grid">${cards}</div>${settingsCard}</main>${footer}</div>${dialog}</body></html>`;
}
export function modulePage({username, title, content}) {
  return `${head(escape(title) + ' — NEXUS404')}<body><div class="page">${header(username, title)}<main><div class="section-line"><h1>${escape(title)}</h1></div>${content}</main>${footer}</div></body></html>`;
}

export function settingsPage(username, modules, selectedId) {
  const entries = modules.filter((module) => module.settings);
  const selected = entries.find((module) => module.id === selectedId) ?? entries[0];
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
