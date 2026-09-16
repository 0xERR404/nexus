#!/usr/bin/env node
'use strict';

// Запускать вручную, один раз (и заново, если сессия отозвалась):
//   docker exec -it nexus404-module-cheevoscope node lib/steamClientAuth.js
// Спросит логин/пароль/код Guard, сохранит refreshToken в
// /app/data/steam_client_session.json (0600). Пароль не сохраняется.

const path = require('path');
const { runInteractiveLogin } = require('./steamClientApi.js');

const DATA_DIR = process.env.MODULE_DATA_DIR || '/app/data';
const sessionFile = path.join(DATA_DIR, 'steam_client_session.json');

console.log('=== Вход в Steam как владелец аккаунта (steam-user) ===');
console.log('Пароль нигде не сохраняется — только сессионный токен после успешного входа.');
console.log();

runInteractiveLogin({ sessionFile, logger: console })
  .then(({ steamID }) => {
    console.log();
    console.log(`✅ Готово. SteamID: ${steamID}`);
    console.log(`Сессия сохранена в ${sessionFile}`);
    console.log('Дальнейшие обновления CheevoScope будут использовать её автоматически, без повторного ввода пароля.');
    process.exit(0);
  })
  .catch((e) => {
    console.error();
    console.error('❌ Вход не удался:', e.message);
    process.exit(1);
  });
