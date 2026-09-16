'use strict';

// Вход паролем через HTTP — тот же механизм, что runInteractiveLogin()
// в steamClientApi.js, но логин/пароль/код Guard приходят HTTP-запросом,
// не из stdin. Пароль не сохраняется, живёт в памяти на время logOn().

const { saveSession } = require('./steamClientApi.js');

// id -> { client, awaitingCode, codeCallback, status, steamID, refreshToken, error, createdAt }
const pendingLogins = new Map();
const SESSION_TTL_MS = 5 * 60 * 1000;

function cleanupStale() {
  const now = Date.now();
  for (const [id, entry] of pendingLogins) {
    if (now - entry.createdAt > SESSION_TTL_MS) {
      try { entry.client && entry.client.logOff(); } catch { /* уже отключён */ }
      pendingLogins.delete(id);
    }
  }
}

function randomId() {
  return require('crypto').randomBytes(16).toString('hex');
}

let SteamUser;
function loadSteamUser() {
  if (!SteamUser) SteamUser = require('steam-user');
  return SteamUser;
}

// Запускает попытку входа. Возвращает один из трёх исходов:
//   { status: 'authenticated', steamID, refreshToken }
//   { status: 'needs_code', id, codeType: 'email'|'device' }
//   { status: 'error', error }
async function startPasswordLogin({ accountName, password }) {
  cleanupStale();
  const SteamUserCtor = loadSteamUser();
  const client = new SteamUserCtor();
  const id = randomId();

  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { client.logOff(); } catch { /* noop */ }
      pendingLogins.delete(id);
      resolve({ status: 'error', error: 'Таймаут входа (30с) — Steam не ответил' });
    }, 30000);

    client.on('steamGuard', (domain, callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingLogins.set(id, { client, codeCallback: callback, status: 'needs_code', createdAt: Date.now() });
      resolve({ status: 'needs_code', id, codeType: domain ? 'email' : 'device' });
    });

    client.on('refreshToken', (token) => {
      client.__capturedRefreshToken = token;
    });

    client.on('loggedOn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const result = { status: 'authenticated', steamID: client.steamID.getSteamID64(), refreshToken: client.__capturedRefreshToken };
      client.logOff();
      resolve(result);
    });

    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingLogins.delete(id);
      resolve({ status: 'error', error: err.message });
    });

    client.logOn({ accountName, password });
  });
}

// Вторая половина потока — когда startPasswordLogin() вернул
// 'needs_code', фронтенд присылает код отдельным запросом сюда.
async function submitPasswordLoginCode(id, code) {
  const entry = pendingLogins.get(id);
  if (!entry) return { status: 'error', error: 'Сессия входа не найдена или истекла — начни заново.' };

  const { client, codeCallback } = entry;
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      pendingLogins.delete(id);
      try { client.logOff(); } catch { /* noop */ }
      resolve({ status: 'error', error: 'Таймаут проверки кода (30с)' });
    }, 30000);

    // Как и 'steamGuard' ниже: без removeAllListeners каждая повторная
    // попытка кода добавляла бы ещё одну once-подписку поверх прежних —
    // утечка слушателей на клиенте, живущем в pendingLogins.
    client.removeAllListeners('loggedOn');
    client.removeAllListeners('error');

    // Если код неверный, Steam снова пришлёт 'steamGuard' с
    // lastCodeWrong=true — обновляем callback в записи и просим
    // фронтенд повторить попытку, а не бросаем сессию.
    client.removeAllListeners('steamGuard');
    client.on('steamGuard', (domain, callback, lastCodeWrong) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      entry.codeCallback = callback;
      entry.createdAt = Date.now();
      resolve({ status: 'needs_code', id, codeType: domain ? 'email' : 'device', wrongCode: Boolean(lastCodeWrong) });
    });

    client.once('loggedOn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingLogins.delete(id);
      const result = { status: 'authenticated', steamID: client.steamID.getSteamID64(), refreshToken: client.__capturedRefreshToken };
      client.logOff();
      resolve(result);
    });

    client.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingLogins.delete(id);
      resolve({ status: 'error', error: err.message });
    });

    codeCallback(code);
  });
}

module.exports = { startPasswordLogin, submitPasswordLoginCode, saveSession };
