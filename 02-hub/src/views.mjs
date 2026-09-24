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
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#08070c"><meta name="mobile-web-app-capable" content="yes"><title>${title}</title><link rel="manifest" href="/manifest.json"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><link rel="stylesheet" href="/app.css"><script src="/app.js" defer></script></head>`;
const install = `<button class="install-btn" data-install hidden type="button">Установить</button>`;
const dialog = `<dialog id="installHelp" aria-labelledby="installHelpTitle"><h2 id="installHelpTitle">Хаб на телефоне</h2><p>Открой меню браузера и выбери «Установить приложение» или «Добавить на главный экран».</p><form method="dialog"><button class="login-btn">Понятно</button></form></dialog>`;
export function login(error = '', username = '') {
  return `${head('NEXUS404 — вход')}<body class="login-page"><main class="box"><div class="prompt login-prompt"><span class="user">guest</span><span class="muted">@</span>nexus404<span class="muted">:~$</span> authenticate</div><div class="lines"><div class="line"><span class="prefix">system ::</span><span>введите логин и пароль,<br>чтобы продолжить</span></div>${error ? `<div class="line err" role="alert"><span class="prefix">system ::</span><span>${escape(error)}</span></div>` : ''}</div><form class="login-form" method="post" action="/api/auth/login"><div class="field-row"><span class="sym" aria-hidden="true">&gt;</span><label class="sr-only" for="username">Логин</label><input id="username" name="username" placeholder="логин" value="${escape(username)}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="64" required></div><div class="field-row"><span class="sym" aria-hidden="true">&gt;</span><label class="sr-only" for="password">Пароль</label><input id="password" name="password" type="password" placeholder="пароль" autocomplete="current-password" maxlength="1024" required><button class="reveal" id="revealPassword" type="button" aria-label="Показать пароль" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><button class="login-btn" type="submit">войти <span class="cursor" aria-hidden="true"></span></button></form><div class="login-foot"><span>личное пространство</span>${install}</div></main>${dialog}</body></html>`;
}
export function dashboard(username, modules) {
  const cards = modules
    .map(
      (module) =>
        `<a class="module-card" href="/modules/${module.id}/"><h2>${escape(module.title)}</h2>${module.summary ? `<div class="module-summary" data-summary="${module.id}" data-state="loading"><span class="module-summary-note">Получаем данные…</span></div>` : ''}</a>`
    )
    .join('');
  const settingsCount = modules.filter((module) => module.settings).length;
  const settingsCard = `<a class="module-card" href="/settings/"><h2>Настройки</h2><div class="module-summary"><span class="module-summary-note">Разделы</span><strong class="settings-count">${settingsCount}</strong></div></a>`;
  return `${head('NEXUS404')}<body><div class="page"><header class="header"><div class="header-top"><div class="prompt"><span class="user">${escape(username)}</span><span class="muted">@NEXUS404:~$</span> <span class="cmd">./hub</span></div><div class="status-badge"><span class="dot-status" id="statusDot"></span><span id="statusText">online</span><form method="post" action="/api/auth/logout"><button class="logout" type="submit">выйти</button></form></div></div><div class="title-row"><h1>NEXUS404 INTERFACE</h1>${install}</div></header><main><div class="section-line"><span>МОДУЛИ</span><span>${modules.length} подключено</span></div>${!modules.length ? `<p class="settings-empty">Пока нет модулей.</p>` : ''}<div class="modules-grid">${cards}${settingsCard}</div></main><footer class="page-foot"><span>NEXUS404 · v${escape(version)}</span><span>личное пространство</span></footer></div>${dialog}</body></html>`;
}

export function modulePage({username, title, content}) {
  return `${head(escape(title) + ' — NEXUS404')}<body><div class="page"><header class="header"><div class="header-top"><div class="prompt"><span class="user">${escape(username)}</span><span class="muted">@NEXUS404:~$</span> <span class="cmd">./hub</span></div><div class="status-badge"><span class="dot-status" id="statusDot"></span><span id="statusText">online</span><form method="post" action="/api/auth/logout"><button class="logout" type="submit">выйти</button></form></div></div><div class="title-row"><h1>${escape(title)}</h1><a class="install-btn" href="/">В хаб</a></div></header><main>${content}</main></div></body></html>`;
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
