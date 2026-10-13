#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {createCipheriv, randomBytes} from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {event, withLock} from '../../host/common.mjs';

const hub = '/opt/nexus404/hub-platform';
const compose = hub + '/docker-compose.yml';

function run(command, args) {
  const result = spawnSync(command, args, {encoding: 'utf8'});
  if (result.error || result.status !== 0)
    throw new Error(
      `${command} завершился с ошибкой: ${result.stderr?.trim() || result.error?.message || result.status}`
    );
  return result.stdout.trim();
}

async function backup(output, keyFile) {
  if (process.getuid?.() !== 0) throw new Error('Запусти от root через sudo');
  if (!path.isAbsolute(output) || !path.isAbsolute(keyFile))
    throw new Error('Укажи абсолютные пути архива и ключа');
  const keyStat = fs.lstatSync(keyFile);
  if (!keyStat.isFile() || keyStat.isSymbolicLink() || keyStat.uid !== 0 || keyStat.mode & 0o077)
    throw new Error('Ключ должен быть обычным файлом root с правами 0600');
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('Ключ должен содержать ровно 32 случайных байта');
  if (
    !fs.existsSync(compose) ||
    !fs.existsSync(hub + '/config/auth.json') ||
    !fs.existsSync(hub + '/data')
  )
    throw new Error('Установленный хаб или его данные не найдены');
  const target = path.resolve(output);
  if (
    target.startsWith('/opt/nexus404/') ||
    target === '/opt/nexus404' ||
    target.startsWith('/var/lib/nexus404-')
  )
    throw new Error('Сохрани архив вне каталогов NEXUS404');
  const dir = path.dirname(target);
  const realTarget = path.join(fs.realpathSync(dir), path.basename(target));
  if (realTarget.startsWith('/opt/nexus404/') || realTarget.startsWith('/var/lib/nexus404-'))
    throw new Error('Каталог назначения находится внутри приложения');
  if (fs.realpathSync(dir).startsWith(fs.realpathSync(hub) + '/'))
    throw new Error('Каталог назначения находится внутри данных хаба');
  const names = [
    'opt/nexus404/hub-platform/config',
    'opt/nexus404/hub-platform/data',
    'var/lib/nexus404-shell',
    'var/lib/nexus404-base/maintenance-settings.json',
    'var/lib/nexus404-caddy',
    'var/lib/nexus404-signal',
    'opt/nexus404/hub-platform/modules',
    'opt/nexus404/hub-platform/docker-compose.yml',
    'opt/nexus404/hub-platform/docker-compose.override.yml',
    'opt/nexus404/caddy',
    'opt/nexus404/docker-compose.yml',
    'opt/nexus404/docker-compose.override.yml'
  ].filter((name) => fs.existsSync('/' + name));
  const actualKey = fs.realpathSync(keyFile);
  if (names.some((name) => actualKey === '/' + name || actualKey.startsWith('/' + name + '/')))
    throw new Error('Ключ копии должен храниться вне каталогов приложения');
  const args = ['compose', '-p', 'nexus404-shell', '-f', compose];
  const id = run('docker', [...args, 'ps', '-q', 'hub']);
  const running = id && run('docker', ['inspect', '-f', '{{.State.Running}}', id]) === 'true';
  const signalRunning =
    spawnSync('systemctl', ['is-active', '--quiet', 'nexus404-signal.service']).status === 0;
  const caddyArgs = ['compose', '-p', 'nexus404', '-f', '/opt/nexus404/docker-compose.yml'];
  const caddyId = fs.existsSync('/opt/nexus404/docker-compose.yml')
    ? run('docker', [...caddyArgs, 'ps', '-q', 'caddy'])
    : '';
  const caddyRunning =
    caddyId && run('docker', ['inspect', '-f', '{{.State.Running}}', caddyId]) === 'true';
  let caddyStopped = false;
  let signalStopped = false;
  let stopped = false;
  let created = false;
  let failure;
  try {
    if (caddyRunning) {
      caddyStopped = true;
      run('docker', [...caddyArgs, 'stop', '-t', '10', 'caddy']);
    }
    if (signalRunning) {
      signalStopped = true;
      run('systemctl', ['stop', 'nexus404-signal.service']);
    }
    if (running) {
      stopped = true;
      run('docker', [...args, 'stop', '-t', '30', 'hub']);
    }
    const nonce = randomBytes(12);
    const fd = fs.openSync(target, 'wx', 0o600);
    created = true;
    try {
      fs.writeSync(fd, Buffer.concat([Buffer.from('NEXUS404-BACKUP-1\n'), nonce]));
      const tar = spawn(
        'tar',
        ['-C', '/', '--exclude=opt/nexus404/hub-platform/data/cinema/cache', '-cf', '-', ...names],
        {stdio: ['ignore', 'pipe', 'pipe']}
      );
      let stderr = '';
      tar.stderr.on('data', (data) => {
        stderr = (stderr + data.toString()).slice(-4096);
      });
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const sink = fs.createWriteStream(target, {fd, autoClose: false, start: 30});
      const copying = pipeline(tar.stdout, cipher, sink);
      const exit = new Promise((resolve, reject) => {
        tar.on('error', reject);
        tar.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`tar: ${stderr || code}`))
        );
      });
      try {
        await Promise.all([copying, exit]);
      } catch (e) {
        tar.kill('SIGKILL');
        await Promise.allSettled([copying, exit]);
        throw e;
      }
      fs.writeSync(fd, cipher.getAuthTag(), 0, 16, fs.fstatSync(fd).size);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    console.log(`Создана зашифрованная копия: ${target}`);
  } catch (e) {
    if (created) fs.rmSync(target, {force: true});
    failure = e;
  } finally {
    if (stopped) {
      try {
        run('docker', [...args, 'start', 'hub']);
      } catch (e) {
        failure = new Error(
          `${failure?.message ?? 'Копия создана'}, но хаб не запущен: ${e.message}`
        );
      }
    }
  }
  if (signalStopped) {
    try {
      run('systemctl', ['start', 'nexus404-signal.service']);
    } catch (e) {
      failure = new Error(
        `${failure?.message ?? 'Копия создана'}, но Гермес не запущен: ${e.message}`
      );
    }
  }
  if (caddyStopped) {
    try {
      run('docker', [...caddyArgs, 'start', 'caddy']);
    } catch (e) {
      failure = new Error(
        `${failure?.message ?? 'Копия создана'}, но Caddy не запущен: ${e.message}`
      );
    }
  }
  if (failure) throw failure;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length !== 4) {
    console.error(
      'Феникс · использование: sudo node tools/backup/backup.mjs /путь/копия.nexus /путь/ключ'
    );
    process.exitCode = 2;
  } else
    withLock(
      '/run/lock/nexus404-backup.lock',
      () =>
        withLock(
          '/run/lock/nexus404-setup.lock',
          () => backup(process.argv[2], process.argv[3]),
          true
        ),
      true
    ).catch((e) => {
      event('system.backup.failed', e.message);
      console.error('Ошибка резервного копирования:', e.message);
      process.exitCode = 1;
    });
}
