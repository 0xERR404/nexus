'use strict';

// Вход через клиентский протокол Steam — getUserOwnedApps() дёргает ту
// же службу, что публичный API, разница в одном параметре,
// skip_unvetted_apps (default=true в REST), которого там нет.

const fs = require('fs/promises');
const readline = require('readline');

let SteamUser;
function loadSteamUser() {
  if (!SteamUser) SteamUser = require('steam-user');
  return SteamUser;
}

function readSession(sessionFile) {
  return fs.readFile(sessionFile, 'utf-8').then(JSON.parse).catch(() => null);
}

async function writeSession(sessionFile, session) {
  await fs.writeFile(sessionFile, JSON.stringify(session, null, 2), { mode: 0o600 });
  // На случай, если файл уже существовал с другими правами (umask при
  // создании применяется только один раз) — форсируем 0600 отдельно,
  // chmod идемпотентен и не бросает, если права уже верные.
  await fs.chmod(sessionFile, 0o600).catch(() => {});
}

function prompt(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      // readline не умеет скрывать ввод из коробки — глушим эхо
      // вручную, чтобы пароль не отображался в терминале построчно.
      const originalWrite = rl._writeToOutput;
      rl._writeToOutput = function (str) {
        if (str.includes(question)) originalWrite.call(rl, str);
        // иначе — молчим, символы пароля не эхуются
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// Интерактивный одноразовый вход (docker exec -it ... node
// lib/steamClientAuth.js), не часть автопайплайна. Пароль не сохраняется,
// только refreshToken (файл 0600, наружу не отдаётся).
async function runInteractiveLogin({ sessionFile, logger = console }) {
  const SteamUserCtor = loadSteamUser();
  const accountName = await prompt('Steam логин (accountName, не email): ');
  const password = await prompt('Steam пароль (не отображается на экране): ', { hidden: true });

  const client = new SteamUserCtor();

  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('Таймаут входа (60с) — Steam не ответил')); client.logOff(); }
    }, 60000);

    client.on('steamGuard', async (domain, callback, lastCodeWrong) => {
      if (lastCodeWrong) console.log('Код неверный, попробуй ещё раз.');
      const where = domain ? `на почту (${domain})` : 'в приложении Steam Guard/через SMS';
      const code = await prompt(`Код подтверждения Steam Guard, отправленный ${where}: `);
      callback(code);
    });

    client.on('refreshToken', (token) => {
      // Может прилететь до 'loggedOn' — не резолвим тут сразу, просто
      // запоминаем, отдаём наружу вместе с steamID в loggedOn ниже.
      client.__capturedRefreshToken = token;
    });

    client.on('loggedOn', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ steamID: client.steamID.getSteamID64(), refreshToken: client.__capturedRefreshToken });
      client.logOff();
    });

    client.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });

    client.logOn({ accountName, password });
  });

  if (!result.refreshToken) {
    throw new Error('Вход прошёл, но Steam не прислал refreshToken — попробуй ещё раз, это может быть временный сбой.');
  }

  await writeSession(sessionFile, { steamID: result.steamID, refreshToken: result.refreshToken, savedAt: new Date().toISOString() });
  logger.info(`Сессия сохранена в ${sessionFile} (SteamID: ${result.steamID}). Пароль нигде не сохранён.`);
  return result;
}

// Обычный автоматический вход по уже сохранённому refreshToken — без
// пароля, без интерактивности, вызывается из пайплайна. Если токен
// истёк/отозван — бросает понятную ошибку с инструкцией перелогиниться,
// не пытается угадать пароль ниоткуда (пароль нигде не хранится).
async function getOwnedAppsViaClient({ sessionFile, logger = console }) {
  const session = await readSession(sessionFile);
  if (!session || !session.refreshToken) {
    logger.warn('Нет сохранённой сессии steam-user (setup ещё не запускался) — пропускаю этот источник.');
    return { apps: null, needsLogin: true };
  }

  const SteamUserCtor = loadSteamUser();
  const client = new SteamUserCtor();

  try {
    const apps = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) { settled = true; client.logOff(); reject(new Error('Таймаут входа через сохранённую сессию (30с)')); }
      }, 30000);

      // Если Steam всё же просит код (например, сессия отозвана и это
      // на самом деле уже не тихий вход) — тут его взять неоткуда
      // (процесс фоновый, не интерактивный), поэтому явно проваливаем
      // с понятной причиной вместо зависания на неотвеченном событии.
      client.on('steamGuard', (domain, callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.logOff();
        reject(new Error('Steam запросил код Steam Guard при автоматическом входе — сохранённая сессия недействительна, нужен повторный ручной логин (запусти steamClientAuth.js заново).'));
      });

      client.on('refreshToken', (token) => {
        // Steam иногда ротирует токен даже при "тихом" входе — сохраняем
        // новый, чтобы следующий автоматический вход не отвалился.
        writeSession(sessionFile, { ...session, refreshToken: token, savedAt: new Date().toISOString() }).catch((e) => logger.warn(`Не удалось обновить сохранённый токен: ${e.message}`));
      });

      client.on('loggedOn', async () => {
        try {
          const response = await client.getUserOwnedApps(client.steamID, {
            includeAppInfo: true,
            includePlayedFreeGames: true,
            skipUnvettedApps: false, // ключевая разница с публичным REST API — см. комментарий в начале файла
          });
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(response.apps || []);
        } catch (e) {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(e);
        } finally {
          client.logOff();
        }
      });

      client.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });

      client.logOn({ refreshToken: session.refreshToken });
    });

    return {
      apps: apps.map((a) => ({ appid: a.appid, name: a.name || `appid ${a.appid}`, playtime_forever: a.playtime_forever || 0 })),
      needsLogin: false,
    };
  } catch (e) {
    logger.warn(`Вход через сохранённую сессию steam-user не удался: ${e.message}`);
    return { apps: null, needsLogin: /повторный ручной логин|refresh.?token/i.test(e.message) };
  }
}

module.exports = { runInteractiveLogin, getOwnedAppsViaClient, saveSession: writeSession };
