import fs from 'node:fs';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function options(args) {
  const result = {
    repo: '0xERR404/nexus',
    branch: 'main',
    directory: '/opt/nexus404-repo',
    menu: []
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      result.menu = args.slice(i + 1);
      break;
    }
    const key = {'--repo': 'repo', '--branch': 'branch', '--directory': 'directory'}[args[i]];
    if (!key || !args[i + 1]) throw new Error('Неизвестный или неполный параметр: ' + args[i]);
    result[key] = args[++i];
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(result.repo) ||
    /\/(\.|\.\.)$/.test(result.repo)
  )
    throw new Error('Репозиторий: OWNER/REPO, без URL и токенов');
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(result.branch) ||
    result.branch.includes('..') ||
    result.branch.includes('//')
  )
    throw new Error('Некорректная ветка');
  if (!path.isAbsolute(result.directory) || path.resolve(result.directory) === '/')
    throw new Error('Нужен абсолютный каталог проекта, отличный от /');
  result.directory = path.resolve(result.directory);
  result.url = 'https://github.com/' + result.repo + '.git';
  return result;
}

export function git(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
    env: {...process.env, GIT_TERMINAL_PROMPT: '0'}
  });
  if (result.status !== 0)
    throw new Error(result.error?.message || result.stderr?.trim() || 'Git завершился с ошибкой');
  return result.stdout.trim();
}
const sameRemote = (a, b) =>
  a.replace(/\.git\/?$/, '').replace(/\/$/, '') === b.replace(/\.git\/?$/, '').replace(/\/$/, '');
export const projectFiles = [
  '02-hub/Dockerfile',
  '02-hub/public/fonts/JetBrainsMono-LICENSE.txt',
  '02-hub/public/fonts/SpaceGrotesk-LICENSE.txt',
  '00-base-server/install.mjs',
  '01-caddy-docker/docker-compose.yml',
  '01-caddy-docker/install.mjs',
  '02-hub/docker-compose.yml',
  '02-hub/install.mjs',
  '02-hub/modules/anime/index.mjs',
  '02-hub/modules/anime/store.mjs',
  '02-hub/modules/anime/anime.js',
  '02-hub/modules/anime/anime.css',
  '02-hub/modules/anime/manifest.json',
  '03-modules/anime/install.mjs',
  '02-hub/modules/trophies/index.mjs',
  '02-hub/modules/trophies/store.mjs',
  '02-hub/modules/trophies/providers.mjs',
  '02-hub/modules/trophies/steam-auth.mjs',
  '02-hub/modules/trophies/trophies.js',
  '02-hub/modules/trophies/trophies.css',
  '02-hub/modules/trophies/manifest.json',
  '03-modules/trophies/install.mjs',
  '02-hub/modules/balance/index.mjs',
  '02-hub/modules/balance/store.mjs',
  '02-hub/modules/balance/balance.js',
  '02-hub/modules/balance/balance.css',
  '02-hub/modules/balance/manifest.json',
  '03-modules/balance/install.mjs',
  '02-hub/modules/chat/index.mjs',
  '02-hub/modules/chat/store.mjs',
  '02-hub/modules/chat/deepseek.mjs',
  '02-hub/modules/chat/flow-session.mjs',
  '02-hub/modules/chat/flowmusic.mjs',
  '02-hub/modules/chat/flow-audio.mjs',
  '02-hub/modules/chat/chat.js',
  '02-hub/modules/chat/chat.css',
  '02-hub/modules/chat/manifest.json',
  '03-modules/chat/install.mjs',
  '02-hub/modules/pulse/index.mjs',
  '02-hub/modules/pulse/manifest.json',
  '02-hub/modules/pulse/pulse.css',
  '02-hub/modules/pulse/pulse.js',
  '02-hub/modules/signal/index.mjs',
  '02-hub/modules/signal/manifest.json',
  '02-hub/modules/signal/signal.css',
  '02-hub/modules/signal/signal.js',
  '02-hub/package.json',
  '02-hub/public/app.css',
  '02-hub/public/cosmos.webp',
  '02-hub/public/app.js',
  '02-hub/public/apple-touch-icon.png',
  '02-hub/public/fonts/jetbrains-mono.woff2',
  '02-hub/public/fonts/space-grotesk.woff2',
  '02-hub/public/icon-192.png',
  '02-hub/public/icon-512.png',
  '02-hub/public/manifest.json',
  '02-hub/public/offline.html',
  '02-hub/public/sw.js',
  '02-hub/src/auth.mjs',
  '02-hub/src/ai-usage.mjs',
  '02-hub/modules/balance/market.mjs',
  '02-hub/src/modules.mjs',
  '02-hub/src/server.mjs',
  '02-hub/src/views.mjs',
  '02-hub/src/webpush.mjs',
  '03-modules/pulse/docker-compose.override.yml',
  '03-modules/pulse/install.mjs',
  '03-modules/pulse/nexus404-pulse.service',
  '03-modules/signal/install.mjs',
  '03-modules/signal/nexus404-signal.service',
  'bootstrap.mjs',
  'host/base.mjs',
  'host/common.mjs',
  'host/events.mjs',
  'host/info.mjs',
  'host/maintenance.mjs',
  'host/metrics.mjs',
  'host/platform.mjs',
  'host/runtime.mjs',
  'host/security.mjs',
  'host/signal-rules.mjs',
  'host/signal.mjs',
  'host/ssh.mjs',
  'host/ui.mjs',
  'host/webpush.mjs',
  'menu.mjs',
  'menu.sh'
];
export function checkRevision(directory, ref, run = git) {
  const entries = new Map(
    run(['-C', directory, 'ls-tree', '-r', ref])
      .split('\n')
      .map((row) => {
        const [meta, file] = row.split('\t');
        return [file, meta];
      })
  );
  for (const file of projectFiles)
    if (!/^100(?:644|755) blob /.test(entries.get(file) ?? ''))
      throw new Error('Неполное обновление: ' + file);
}
export function checkProject(directory) {
  for (const file of projectFiles) {
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const stat = fs.lstatSync(path.join(directory, ...parts.slice(0, i)), {
        throwIfNoEntry: false
      });
      if (!(i === parts.length ? stat?.isFile() : stat?.isDirectory()))
        throw new Error('Неполный проект: ' + file + '. Загрузи весь архив в корень репозитория.');
    }
  }
}

export function syncRepository({url, branch, directory}, run = git) {
  run(['check-ref-format', '--branch', branch]);
  if (fs.lstatSync(directory, {throwIfNoEntry: false})) {
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.existsSync(path.join(directory, '.git')))
      throw new Error('Каталог занят и не является Git-копией: ' + directory);
    if (path.resolve(run(['-C', directory, 'rev-parse', '--show-toplevel'])) !== directory)
      throw new Error('Найден другой корень Git');
    const remote = run(['-C', directory, 'remote', 'get-url', 'origin']);
    if (!sameRemote(remote, url))
      throw new Error('В каталоге другой origin. Укажи отдельный NEXUS_DIRECTORY.');
    if (run(['-C', directory, 'status', '--porcelain']))
      throw new Error('Есть локальные изменения. Сохрани их коммитом перед обновлением.');
    if (run(['-C', directory, 'symbolic-ref', '--quiet', '--short', 'HEAD']) !== branch)
      throw new Error('В каталоге другая ветка. Выбери её явно или отдельный NEXUS_DIRECTORY.');
    run(['-C', directory, 'fetch', '--no-tags', 'origin', branch]);
    checkRevision(directory, 'FETCH_HEAD', run);
    run(['-C', directory, 'merge', '--ff-only', 'FETCH_HEAD']);
    checkProject(directory);
    return 'updated';
  }
  const parent = path.dirname(directory);
  fs.mkdirSync(parent, {recursive: true});
  const stage = fs.mkdtempSync(path.join(parent, '.nexus404-download-'));
  try {
    run(['clone', '--depth', '1', '--single-branch', '--branch', branch, '--', url, stage]);
    checkProject(stage);
    fs.chmodSync(stage, 0o755);
    fs.renameSync(stage, directory);
  } finally {
    fs.rmSync(stage, {recursive: true, force: true});
  }
  return 'cloned';
}

async function lock(file) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const child = spawn(
    'flock',
    [
      '-n',
      '-x',
      file,
      process.execPath,
      '-e',
      "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));"
    ],
    {stdio: ['pipe', 'pipe', 'pipe']}
  );
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => reject(new Error('Установка или обновление уже выполняется.')));
    child.stdout.once('data', resolve);
  });
  return async () => {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      child.once('close', resolve);
      child.stdin.end();
    });
  };
}

export function launchMenu(directory, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(directory, 'menu.mjs'), ...args], {
      cwd: directory,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
}
async function main() {
  const config = options(process.argv.slice(2));
  if (process.getuid?.() !== 0) throw new Error('Запусти загрузчик через sudo.');
  const release = await lock('/run/lock/nexus404-setup.lock');
  try {
    console.log('[*] GitHub: ' + config.repo + ' · ветка ' + config.branch);
    const result = syncRepository(config);
    console.log(
      '[✓] ' + (result === 'cloned' ? 'Проект загружен: ' : 'Проект обновлён: ') + config.directory
    );
  } finally {
    await release();
  }
  process.exitCode = await launchMenu(config.directory, config.menu);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error('[!] ' + error.message);
    process.exitCode = 1;
  });
