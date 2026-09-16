'use strict';

// QR-вход через steam-session — тот же клиентский протокол, что
// steamClientApi.js, без пароля: сканируется QR, подтверждается в
// приложении. EAuthTokenPlatformType.SteamClient (не WebBrowser) —
// нужен токен с аудиторией ['web','client'], чтобы client.logOn()
// в steamClientApi.js принял refreshToken.

const QRCode = require('qrcode');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

// В памяти процесса, не на диске — сессии входа живут минуты, не имеет
// смысла их персистить. id -> { session, status, steamID, error, createdAt }.
const pendingLogins = new Map();

// Чистим протухшие записи (Steam-сессия истекает сама, но объект в
// Map должен исчезнуть и у нас, иначе процесс медленно течёт памятью
// при повторных попытках входа).
const SESSION_TTL_MS = 5 * 60 * 1000;
function cleanupStale() {
  const now = Date.now();
  for (const [id, entry] of pendingLogins) {
    if (now - entry.createdAt > SESSION_TTL_MS) pendingLogins.delete(id);
  }
}

function randomId() {
  return require('crypto').randomBytes(16).toString('hex');
}

// Запускает QR-попытку, возвращает { id, qrCodeDataUrl }. Сессия и её
// polling живут в фоне, результат — через getQrLoginStatus(id).
async function startQrLogin() {
  cleanupStale();
  const id = randomId();
  const session = new LoginSession(EAuthTokenPlatformType.SteamClient);

  const entry = { session, status: 'pending', steamID: null, refreshToken: null, error: null, createdAt: Date.now() };
  pendingLogins.set(id, entry);

  session.on('authenticated', () => {
    entry.status = 'authenticated';
    entry.steamID = session.steamID.getSteamID64();
    entry.refreshToken = session.refreshToken;
  });
  session.on('timeout', () => {
    entry.status = 'error';
    entry.error = 'QR-код истёк (не отсканирован вовремя) — начни заново.';
  });
  session.on('error', (err) => {
    entry.status = 'error';
    entry.error = err.message;
  });
  session.on('remoteInteraction', () => {
    // QR отсканирован телефоном, ждём подтверждения там — полезно
    // показать пользователю промежуточный статус, не только "готово".
    if (entry.status === 'pending') entry.status = 'scanned';
  });

  const startResult = await session.startWithQR();
  if (!startResult.qrChallengeUrl) {
    pendingLogins.delete(id);
    throw new Error('Steam не вернул QR-ссылку — возможно, для этого аккаунта нужен другой способ входа.');
  }

  const qrCodeDataUrl = await QRCode.toDataURL(startResult.qrChallengeUrl, { width: 300, margin: 1 });
  return { id, qrCodeDataUrl };
}

// Разовый опрос статуса ('pending'|'scanned'|'authenticated'|'error').
// На 'authenticated' index.js сам сохраняет refreshToken через
// writeSession() — эта функция на диск не пишет.
function getQrLoginStatus(id) {
  const entry = pendingLogins.get(id);
  if (!entry) return { status: 'error', error: 'Сессия входа не найдена или истекла — начни заново.' };

  if (entry.status === 'authenticated') {
    const result = { status: 'authenticated', steamID: entry.steamID, refreshToken: entry.refreshToken };
    pendingLogins.delete(id); // одноразовое использование — токен уже отдан, повторный опрос ничего не найдёт
    return result;
  }
  if (entry.status === 'error') {
    const result = { status: 'error', error: entry.error };
    pendingLogins.delete(id);
    return result;
  }
  return { status: entry.status }; // 'pending' | 'scanned'
}

module.exports = { startQrLogin, getQrLoginStatus };
