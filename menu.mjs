import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  ROOT,
  HUB,
  STATE,
  CADDY,
  json,
  atomic,
  query,
  withLock,
  installHost,
  supported,
  event,
  exec
} from './host/common.mjs';
import {UI} from './host/ui.mjs';
import {checkRevision} from './bootstrap.mjs';
import {BaseSetup} from './host/base.mjs';
import {installCaddy, installHub, installModule} from './host/platform.mjs';
import {updateRuntime} from './host/runtime.mjs';
import {migrate} from './host/maintenance.mjs';
import {serverInfo} from './host/info.mjs';
const version = json(ROOT + '/02-hub/package.json').version;
export const modules = [
  {id: 'pulse', title: 'Пульс'},
  {id: 'signal', title: 'Сигнал'},
  {id: 'chat', title: 'Чат · DeepSeek и FlowMusic'},
  {id: 'balance', title: 'Баланс'},
  {id: 'anime', title: 'Кадр · Shikimori'}
];
export async function installModules(
  ui,
  selection,
  {install = installModule, maintenance = migrate} = {}
) {
  const selected = selection === 'all' ? modules : modules.filter((m) => m.id === selection);
  if (!selected.length) throw new Error('Неизвестный модуль');
  const completed = [];
  let failure;
  try {
    for (const module of selected) {
      ui.section(`${completed.length + 1} / ${selected.length} · ${module.title}`);
      await install(ui, module.id, false);
      completed.push(module);
    }
  } catch (error) {
    failure = error;
    ui.line('[!] Установка остановлена. Повтори запуск после исправления ошибки.');
    if (completed.length) ui.line('[✓] Готово: ' + completed.map((m) => m.title).join(', '));
    throw error;
  } finally {
    if (completed.length) {
      try {
        await maintenance(ui);
      } catch (error) {
        if (!failure) throw error;
        ui.line('[!] Обслуживание: ' + error.message);
      }
    }
  }
  ui.line('[✓] ' + (selection === 'all' ? 'Все модули установлены / обновлены' : 'Модуль готов'));
}
export async function modulesMenu(
  ui,
  {
    install = installModules,
    lock = (fn) => withLock('/run/lock/nexus404-setup.lock', fn, true),
    report = (message) => event('system.update.failed', message)
  } = {}
) {
  while (true) {
    ui.section('NEXUS404 · модули');
    ui.line('1  Установить / обновить все');
    modules.forEach((module, i) => ui.line(`${i + 2}  ${module.title}`));
    ui.line();
    ui.line('0  Назад');
    const choice = await ui.prompt(`Выбери действие · 0–${modules.length + 1}`);
    if (choice === '0') return;
    const selected = choice === '1' ? 'all' : modules.find((m, i) => choice === String(i + 2))?.id;
    if (!selected) {
      ui.line('[?] Выбери пункт из списка.');
      continue;
    }
    try {
      await lock(() => install(ui, selected));
    } catch (error) {
      report(error.message);
      ui.line('[!] ' + error.message);
    }
    await ui.prompt('Enter — вернуться к модулям');
  }
}
async function update(ui) {
  if (!fs.existsSync(ROOT + '/.git'))
    throw new Error('Это ZIP-копия. Для пункта 3 нужен git clone.');
  const status = query('git', ['-C', ROOT, 'status', '--porcelain']);
  if (!status.ok || status.text)
    throw new Error('Сохрани локальные изменения коммитом перед обновлением.');
  const branch = query('git', ['-C', ROOT, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!branch.ok) throw new Error('Выбери ветку Git');
  await ui.run('Получение изменений', 'git', ['-C', ROOT, 'fetch', '--prune', 'origin']);
  checkRevision(ROOT, 'origin/' + branch.text);
  await ui.run('Обновление репозитория', 'git', [
    '-C',
    ROOT,
    'merge',
    '--ff-only',
    'origin/' + branch.text
  ]);
  await updateRuntime(ui);
  await exec('/usr/local/bin/nexus404-node', [ROOT + '/menu.mjs', '--apply-update'], {
    inherit: true
  });
}
async function applyUpdate(ui) {
  installHost();
  await migrate(ui);
  if (fs.existsSync(CADDY + '/upstream')) await installCaddy(ui, true);
  if (fs.existsSync(HUB + '/config/auth.json')) await installHub(ui, true, false);
  for (const {id} of modules)
    if (fs.existsSync(STATE + '/' + id + '-installed')) await installModule(ui, id, false);
  ui.line('[*] Изменения базовой настройки применяются отдельно через пункт 1.');
}
async function action(choice, ui) {
  if (choice === '1') return new BaseSetup(ui).run();
  if (choice === '2') return installCaddy(ui);
  if (choice === '3') return update(ui);
  if (choice === '5') return installHub(ui);
  throw new Error('Неизвестный пункт');
}
async function main() {
  supported();
  if (Number(process.versions.node.split('.')[0]) < 24)
    throw new Error('Нужен Node.js 24 или новее. Запусти menu.sh.');
  if (!fs.existsSync('/usr/local/bin/nexus404-node'))
    fs.symlinkSync(process.execPath, '/usr/local/bin/nexus404-node');
  process.env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  process.umask(0o077);
  const ui = new UI('/var/lib/nexus404-menu/menu.log');
  try {
    if (process.argv[2] === '--apply-update') {
      await applyUpdate(ui);
      return;
    }
    if (process.argv[2] === '--module') {
      await withLock(
        '/run/lock/nexus404-setup.lock',
        () => installModules(ui, process.argv[3]),
        true
      );
      return;
    }
    if (process.argv[2] === '--task') {
      const legacy = {6: 'pulse', 7: 'signal', 8: 'balance', 9: 'chat'}[process.argv[3]];
      await withLock(
        '/run/lock/nexus404-setup.lock',
        () => (legacy ? installModules(ui, legacy) : action(process.argv[3], ui)),
        true
      );
      return;
    }
    while (true) {
      ui.section('NEXUS404 · v' + version);
      for (const line of [
        '1  Базовая настройка',
        '2  Docker и Caddy',
        '3  Обновить проект',
        '4  Информация о сервере',
        '',
        '5  Хаб · логин и PWA',
        '6  Модули · установка и обновление',
        '',
        '0  Выход'
      ])
        ui.line(line);
      const choice = await ui.prompt('Выбери действие · 0–6');
      if (choice === '0') return;
      if (choice === '6') {
        await modulesMenu(ui);
        continue;
      }
      try {
        if (choice === '4') {
          const text = serverInfo();
          atomic('/var/lib/nexus404-menu/server-info.txt', text);
          for (const row of text.split('\n')) ui.line(row);
          if ((await ui.prompt('1 — текст для копирования · Enter — назад')) === '1') {
            ui.footer();
            process.stdout.write('\n' + text + '\n');
          }
        } else await withLock('/run/lock/nexus404-setup.lock', () => action(choice, ui), true);
      } catch (e) {
        event('system.update.failed', e.message);
        ui.line('[!] ' + e.message);
      }
      if (choice === '3') {
        ui.line('[*] Запусти menu.sh заново, чтобы меню использовало актуальный код.');
        return;
      }
      await ui.prompt('Enter — вернуться в меню');
    }
  } finally {
    ui.footer();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((e) => {
    console.error('[!] ' + e.message);
    process.exitCode = 1;
  });
