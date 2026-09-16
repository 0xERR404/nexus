// NEXUS404 — системный модуль
// Ключ DeepSeek + ключ Gemini + привилегированные действия через хаб.
// Общая шапка/стили — из chrome.js (см. modules/_shared/chrome.js), не
// дублируются здесь.

const http = require('node:http');
const { renderPage } = require('./chrome.js');

const PORT = process.env.MODULE_PORT || 4001;
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
    <div class="section-title">flowmusic — ключ api (генерация музыки)</div>
    <div class="box">
      <div class="row">
        <span class="dot unset" id="flowmusicDot"></span>
        <input type="password" id="flowmusicKeyInput" placeholder="FlowMusic API-ключ" autocomplete="off" />
        <button class="icon-btn" id="saveFlowmusicKeyBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="row" style="margin-top:8px;">
        <span class="dot unset" id="flowmusicBaseUrlDot"></span>
        <input type="text" id="flowmusicBaseUrlInput" placeholder="Свой адрес вместо flowmusic.ai (необязательно)" autocomplete="off" />
        <button class="icon-btn" id="saveFlowmusicBaseUrlBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
      </div>
      <div class="empty-note" style="margin-top:6px;">выбирается прямо над чатом, отдельно на каждое сообщение — отвечает аудио, не текстом. Второе поле — не ключ, а базовый адрес запроса, пусто = адрес по умолчанию</div>
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
        // модуль, хаб просто проксирует.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ module: 'technical' }));
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
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, () => {
    console.log(`[technical] модуль слушает порт ${PORT}, хаб на ${HUB_HOST}:${HUB_PORT}`);
});

process.on('SIGTERM', () => {
    server.close(() => process.exit(0));
});
