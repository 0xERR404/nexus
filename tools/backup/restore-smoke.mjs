#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {stdin, stdout} from 'node:process';
import {check} from './restore-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

async function hiddenPassword() {
  if (!stdin.isTTY) throw new Error('Для ввода пароля нужен терминал');
  const readline = await import('node:readline');
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  stdout.write('Пароль восстановленного хаба: ');
  return new Promise((resolve, reject) => {
    let value = '';
    const keypress = (character, key) => {
      if (key.name === 'return') finish(resolve, value);
      else if (key.ctrl && key.name === 'c') finish(reject, new Error('Отменено'));
      else if (key.name === 'backspace') value = value.slice(0, -1);
      else if (character && !key.ctrl && value.length < 1024) value += character;
    };
    const finish = (callback, result) => {
      stdin.removeListener('keypress', keypress);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      callback(result);
    };
    stdin.on('keypress', keypress);
  });
}

async function serve(directory) {
  const data = path.join(directory, 'opt/nexus404/hub-platform/data');
  const auth = path.join(directory, 'opt/nexus404/hub-platform/config/auth.json');
  process.env.DATA_DIR = data;
  globalThis.fetch = async () => {
    throw new Error('Внешние запросы отключены при проверке восстановления');
  };
  const [{createApp}, {loadModules}] = await Promise.all([
    import('../../02-hub/src/server.mjs'),
    import('../../02-hub/src/modules.mjs')
  ]);
  const config = JSON.parse(fs.readFileSync(auth, 'utf8'));
  const modules = await loadModules(path.join(root, '02-hub/modules'), {start: false});
  const installed = path.join(directory, 'opt/nexus404/hub-platform/modules');
  if (fs.existsSync(installed)) {
    for (const id of modules.keys()) {
      const manifest = path.join(installed, id, 'manifest.json');
      if (!fs.existsSync(manifest) || !JSON.parse(fs.readFileSync(manifest)).enabled)
        modules.delete(id);
    }
  }
  const app = createApp({
    config,
    modules,
    sessionsFile: path.join(data, 'sessions.json'),
    securityFile: path.join(data, 'security.json'),
    dashboardFile: path.join(data, 'dashboard.json'),
    auditFile: path.join(data, 'auth-events.jsonl')
  });
  app.listen(0, '127.0.0.1', () =>
    process.send?.({port: app.address().port, modules: [...modules.keys()]})
  );
  process.on('SIGTERM', () => app.close());
}

async function smoke(archive, key) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus404-restore-'));
  // restore-check требует новый каталог; данные теста не затрагивают рабочий хаб.
  fs.rmdirSync(directory);
  let child;
  try {
    await check(archive, key, directory);
    const auth = JSON.parse(
      fs.readFileSync(path.join(directory, 'opt/nexus404/hub-platform/config/auth.json'))
    );
    const password = await hiddenPassword();
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve', directory], {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    const {port, modules} = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Тестовый хаб не запустился за 30 секунд')),
        30000
      );
      child.once('message', (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('Тестовый хаб завершился: ' + code));
      });
    });
    const base = `http://127.0.0.1:${port}`;
    const login = await fetch(base + '/api/auth/login', {
      method: 'POST',
      redirect: 'manual',
      headers: {Origin: auth.origin, 'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({username: auth.username, password})
    });
    if (login.status !== 303 || login.headers.get('location') !== '/')
      throw new Error('Парольный вход не подтверждён (или требуется второй фактор)');
    const cookie = login.headers.get('set-cookie')?.split(';')[0];
    if (!cookie) throw new Error('Сессия после входа не выдана');
    const home = await fetch(base + '/', {headers: {Cookie: cookie}});
    if (home.status !== 200 || !(await home.text()).includes('NEXUS404'))
      throw new Error('Главная страница не открылась после входа');
    for (const id of modules) {
      const result = await fetch(base + `/modules/${id}/`, {headers: {Cookie: cookie}});
      if (result.status !== 200) throw new Error(`Модуль ${id}: HTTP ${result.status}`);
    }
    console.log(
      `Проверены вход и открытие ${modules.length} страниц модулей. Полноту данных нужно проверить отдельно.`
    );
  } finally {
    if (child && child.exitCode === null) {
      await new Promise((resolve) => {
        const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => {
          clearTimeout(deadline);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    fs.rmSync(directory, {recursive: true, force: true});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === 'serve' && process.argv.length === 4)
    serve(process.argv[3]).catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
  else if (process.argv.length === 4)
    smoke(process.argv[2], process.argv[3]).catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
  else {
    console.error('Использование: node tools/backup/restore-smoke.mjs АРХИВ КЛЮЧ');
    process.exitCode = 2;
  }
}
