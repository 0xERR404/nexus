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
        <span class="dot unset" id="steamIdDot"></span>
        <input type="text" id="steamIdInput" placeholder="SteamID64, ник или ссылка на профиль" autocomplete="off" />
        <button class="icon-btn" id="saveSteamIdBtn" title="сохранить">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
            <polyline points="17 21 17 13 7 13 7 21"></polyline>
            <polyline points="7 3 7 8 15 8"></polyline>
          </svg>
        </button>
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
      <div class="empty-note" style="margin-top:6px;">Steam API-ключ и SteamID обязательны для вкладки Steam, RetroAchievements — необязательная вторая вкладка, без них дашборд работает, та вкладка просто пустая</div>
    </div>
  </section>
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
      document.getElementById('steamIdDot').className = 'dot ' + (data.steamId ? 'set' : 'unset');
      document.getElementById('raUsernameDot').className = 'dot ' + (data.raUsername ? 'set' : 'unset');
      document.getElementById('raApiKeyDot').className = 'dot ' + (data.raApiKey ? 'set' : 'unset');
    } catch {}
  }
  loadKeyStatus();

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

  // Пустое поле — сознательно допустимо сохранять как есть (не игнорируем
  // "если не value return", как у ключей выше): это единственный способ
  // ВЕРНУТЬСЯ к адресу по умолчанию, если до этого был задан воркер, а он
  // перестал быть нужен — стереть поле и нажать сохранить. Тот же приём —
  // у всех трёх base-url кнопок ниже.
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

  // Токен придумывает сам браузер (32 случайных байта, hex) — не внешний
  // API-ключ, который надо куда-то вставлять, а свой секрет, который
  // потом надо будет скопировать в конфиг агента на каждом удалённом
  // сервере. Поэтому — обычный текст, не password, и не очищается после
  // сохранения (единственный шанс его увидеть).
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

  // Без "if (!value) return" — то же самое, что у geminiBaseUrl: пустое
  // значение здесь осмысленно (стереть SteamID, не секрет).
  document.getElementById('saveSteamIdBtn').addEventListener('click', async () => {
    const input = document.getElementById('steamIdInput');
    const value = input.value.trim();
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ steamId: value }),
    });
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
