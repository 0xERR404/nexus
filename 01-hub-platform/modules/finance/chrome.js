// NEXUS404 — общий каркас страницы модуля.
//
// Один файл вместо копирования CSS/разметки шапки в каждом модуле —
// модули просто вызывают renderPage(...) и добавляют свой контент.
//
// Подключение: Dockerfile копирует этот файл рядом с index.js, index.js —
// require('./chrome.js'). AUTH_USER пробрасывается супервизором
// (moduleSupervisor.ts) — тот же логин, что в шапке хаба.
//
// Шапка полностью идентична шапке хаба (dashboard.ts) — тот же prompt,
// статус "online", кнопка "выйти". Название страницы + "Назад" — второй
// строкой, кнопка в рамке, не голая ссылка.

const SHARED_STYLES = `
  :root {
    --bg: #08070c; --line: rgba(179, 136, 255, 0.15); --text: #ddd6ff; --muted: #7a72a0;
    --accent: #b388ff; --amber: #ffcc66; --green: #66bb6a; --red: #ef5350; --card-radius: 6px;
    --font-sans: 'Space Grotesk', -apple-system, system-ui, sans-serif;
    --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    /* Тот же паттерн, что на body::before ниже — в переменной, чтобы
       подложить под непрозрачный фон sticky-шапки, иначе шапка выглядит
       плоской заплаткой на полосатом фоне остальной страницы. */
    --pattern-bg: repeating-linear-gradient(to bottom, rgba(179, 136, 255, 0.03) 0px, rgba(179, 136, 255, 0.03) 1px, transparent 1px, transparent 3px);
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { font-size: 14px; }
  * { scrollbar-width: none; -ms-overflow-style: none; }
  *::-webkit-scrollbar { display: none; }
  body { background: var(--bg); color: var(--text); font-family: var(--font-sans); display: flex; justify-content: center; padding: 20px 16px; }
  /* Тот же полосатый паттерн, что и на главной/чате (dashboard.ts) —
     раньше здесь его не было (chrome.js — отдельный файл, не BASE_STYLES).
     inset:0 + z-index:0 — под содержимым, pointer-events:none — клики сквозь. */
  body::before {
    content: ''; position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background: var(--pattern-bg);
  }
  .page { max-width: 900px; width: 100%; position: relative; z-index: 1; }

  /* ===== ШАПКА — идентична шапке хаба (dashboard.ts), см. врезку выше ===== */
  /* position: sticky — шапка остаётся на виду при прокрутке, без
     расчёта высоты экрана (как в dashboard.ts). */
  .header {
    padding-bottom: 10px; border-bottom: 1px solid var(--line); margin-bottom: 16px;
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
  /* flex-start (не center) — кнопка "Назад" физически выше заголовка
     (свой padding), при center заголовок съезжал бы вниз по её высоте. */
  .title-row { display: flex; align-items: flex-start; gap: 10px; }
  h1 { font-family: var(--font-mono); font-size: 1.2rem; border-left: 3px solid var(--accent); padding-left: 12px; text-shadow: 0 0 18px rgba(179, 136, 255, 0.35); }
  .back-btn {
    background: transparent; border: 1px solid var(--line); color: var(--accent); border-radius: 4px;
    padding: 5px 12px; cursor: pointer; font-family: var(--font-mono); font-size: 0.8rem;
    text-decoration: none; display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0;
    margin-left: auto; transition: border-color 0.15s, box-shadow 0.15s;
  }
  .back-btn:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.08); box-shadow: 0 0 14px rgba(179, 136, 255, 0.25); }

  section { margin-bottom: 22px; }
  .section-title { font-size: 0.65rem; text-transform: uppercase; letter-spacing: 1.2px; color: var(--muted); margin-bottom: 8px; }
  .box { border: 1px solid var(--line); border-radius: var(--card-radius); padding: 12px 14px; background: rgba(12, 11, 20, 0.4); transition: border-color 0.15s, box-shadow 0.15s; }
  .box:hover { border-color: rgba(179, 136, 255, 0.3); box-shadow: 0 0 18px rgba(179, 136, 255, 0.08); }
  .row { display: flex; align-items: center; gap: 10px; font-family: var(--font-mono); font-size: 0.85rem; flex-wrap: wrap; }
  .row input { background: transparent; border: 1px solid var(--line); border-radius: 4px; color: var(--text); font-family: var(--font-mono); padding: 5px 8px; flex: 1; min-width: 0; transition: border-color 0.15s, box-shadow 0.15s; }
  .row input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 10px rgba(179, 136, 255, 0.25); }
  textarea { margin-top: 6px; background: transparent; border: 1px solid var(--line); border-radius: 4px; color: var(--text); font-family: var(--font-mono); padding: 8px; resize: vertical; width: 100%; }
  button {
    background: transparent; border: 1px solid var(--line); color: var(--accent); border-radius: 4px;
    padding: 5px 12px; cursor: pointer; font-family: var(--font-sans); transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  button:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.06); box-shadow: 0 0 14px rgba(179, 136, 255, 0.2); }
  .status { font-size: 0.75rem; }
  .status.set { color: var(--green); }
  .status.unset { color: var(--red); }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
  .dot.set { background: var(--green); box-shadow: 0 0 10px rgba(102,187,106,0.7); }
  .dot.unset { background: var(--red); box-shadow: 0 0 10px rgba(239,83,80,0.6); }
  .icon-btn { background: transparent; border: 1px solid var(--line); color: var(--accent); border-radius: 4px; padding: 5px 9px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; transition: border-color 0.15s, box-shadow 0.15s; }
  .icon-btn:hover { border-color: var(--accent); background: rgba(179, 136, 255, 0.06); box-shadow: 0 0 14px rgba(179, 136, 255, 0.2); }
  .empty-note { color: var(--muted); font-size: 0.85rem; font-family: var(--font-mono); }
  .item-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-family: var(--font-mono); font-size: 0.85rem; margin-bottom: 4px; }
  .forget-btn { cursor: pointer; color: var(--red); flex: none; }
`;

const HEADER_SCRIPT = `
  // Толчок скролла на 1px и обратно — часть мобильных браузеров
  // сворачивает часть интерфейса при первом скролле, из-за чего страница
  // ДО и ПОСЛЕ занимает разную видимую высоту. Синтетический скролл даёт
  // тот же эффект сразу, без реального сдвига контента.
  //
  // Возвращаем СВОЮ текущую позицию (window.scrollY), не жёсткий 0 —
  // на чате это перебивало бы честный автоскролл вниз к последним
  // сообщениям. Здесь, в модулях, обычно и так 0, но тот же принцип
  // на случай восстановленной браузером прокрутки.
  window.addEventListener('load', function () {
    setTimeout(function () {
      var y = window.scrollY;
      window.scrollTo(0, y + 1);
      window.scrollTo(0, y);
    }, 50);
  });

  var __logoutBtn = document.getElementById('logoutBtn');
  if (__logoutBtn) {
    __logoutBtn.addEventListener('click', async function () {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    });
  }

  // Backspace возвращает в хаб, но только если фокус не в текстовом поле
  // (иначе стирание текста улетало бы на главную). Тот же приём в dashboard.ts.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Backspace') return;
    var t = document.activeElement;
    var isEditable = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (isEditable) return;
    window.location.href = '/';
  });
`;

// title — заголовок модуля. extraHead — доп. <style>/<meta>. bodyContent —
// содержательная часть страницы, готовой HTML-строкой. extraScript — JS
// модуля после общего скрипта шапки. username — для prompt в шапке.
function renderPage(options) {
  const title = options.title || 'NEXUS404';
  const extraHead = options.extraHead || '';
  const bodyContent = options.bodyContent || '';
  const extraScript = options.extraScript || '';
  const username = options.username || 'user';

  return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${title} — NEXUS404</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet" />
<style>${SHARED_STYLES}${extraHead}</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="header-top">
      <div class="prompt">
        <span class="user">${username}</span><span class="muted">@NEXUS404:~$</span> <span class="cmd">./hub</span>
      </div>
      <div class="status-badge">
        <span class="dot-status"></span>
        <span>online</span>
        <a class="logout" id="logoutBtn">выйти</a>
      </div>
    </div>
    <div class="title-row">
      <h1>${title}</h1>
      <a class="back-btn" href="/">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"></line><polyline points="12 19 5 12 12 5"></polyline></svg>
        Назад
      </a>
    </div>
  </div>
  ${bodyContent}
</div>
<script>
(function () {
  ${HEADER_SCRIPT}
  ${extraScript}
})();
</script>
</body>
</html>`;
}

module.exports = { renderPage };
