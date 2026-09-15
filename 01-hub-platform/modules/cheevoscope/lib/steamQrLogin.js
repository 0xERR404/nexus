'use strict';

// QR-вход через steam-session — то же семейство протоколов, что и
// steamClientApi.js/steamClientAuth.js (клиентский протокол Steam,
// не публичный REST), но без пароля вообще: пользователь сканирует
// QR мобильным приложением Steam и подтверждает вход там же. Steam
// в последние годы активно подталкивает именно к этому способу —
// логин+пароль+код Guard иногда просто недоступен как опция для
// части аккаунтов (учётная запись требует QR явно).
//
// EAuthTokenPlatformType.SteamClient — важно именно это значение, не
// WebBrowser: токен с аудиторией ['web','client'] нужен, чтобы
// получившийся refreshToken потом принял steam-user (client.logOn({
// refreshToken})) в steamClientApi.js — WebBrowser выдал бы токен
// только для веб-сессии, непригодный для клиентского протокола.

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

// Запускает новую QR-попытку входа, возвращает { id, qrCodeDataUrl }.
// Сама Steam-сессия и её polling продолжают жить в фоне (steam-session
// сам опрашивает Steam каждые несколько секунд внутри себя) — вызывающая
// сторона узнаёт результат через getQrLoginStatus(id) отдельным
// запросом (веб-страница поллит её раз в 2 секунды).
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

// Разовый опрос статуса. status: 'pending' | 'scanned' | 'authenticated'
// | 'error'. На 'authenticated' вызывающая сторона (index.js) должна
// сама сохранить refreshToken через writeSession() из steamClientApi.js
// и убрать запись отсюда — эта функция только сообщает результат, не
// пишет на диск сама (та же ответственность, что и у
// runInteractiveLogin, единая точка сохранения сессии).
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
