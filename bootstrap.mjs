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
  'host/data-backup.mjs',
  'host/backup-browser.mjs',
  '02-hub/src/data-backup.mjs',
  '02-hub/src/backup-browser.mjs',
  '02-hub/public/data-backup.js',
  '02-hub/public/data-backup.css',
  'host/hub-lifecycle.mjs',
  'host/hub-update.mjs',
  '02-hub/src/hub-update.mjs',
  '02-hub/src/archive.mjs',
  '02-hub/public/updates.js',
  '02-hub/public/updates.css',
  'AUDIT.md',
  'README.md',
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  "03-modules/vpn/flags/LICENSE.txt",
  "03-modules/vpn/flags.json",
  "02-hub/src/vpn-protocol.mjs",
  "02-hub/src/vpn-hysteria.mjs",
  "02-hub/src/vpn-transport.mjs",
  "03-modules/vpn/hysteria-fields.js",
  "host/vpn-ports.mjs",
  "host/vpn-node.mjs",
  "host/vpn-network.mjs",
  "host/vpn-diagnose.mjs",
  "host/vpn-install.mjs",
  "host/vpn-acme.mjs",
  "host/vpn-cert.mjs",
  "03-modules/vpn/app.js",
  "03-modules/vpn/cloudflare-fields.js",
  "03-modules/vpn/diagnostics.mjs",
  "03-modules/vpn/diagnostics.js",
  "03-modules/vpn/diagnostic-stats.js",
  "03-modules/vpn/routing-fields.js",
  "03-modules/vpn/countries.mjs",
  "03-modules/vpn/country-picker.js",
  "03-modules/vpn/index.mjs",
  "03-modules/vpn/manifest.json",
  "03-modules/vpn/qr.mjs",
  "03-modules/vpn/store.mjs",
  "03-modules/vpn/style.css",
  "03-modules/vpn/subscriptions.mjs",
  "03-modules/vpn/xray-client.mjs",
  '02-hub/src/agent-protocol.mjs',
  '02-hub/src/agents.mjs',
  '02-hub/src/diagnostics.mjs',
  '02-hub/public/servers.css',
  '02-hub/public/servers.js',
  'host/agent.mjs',
  'host/agent-control.mjs',
  'host/agent-jobs.mjs',
  'host/agent-install.mjs',
  'host/agent-http.mjs',
  'host/remote-install.mjs',
  'host/event-reader.mjs',

  '02-hub/public/card-layout.css',
  '02-hub/public/mobile.css',
  '02-hub/public/orbit.css',
  '02-hub/public/sections.css',
  '02-hub/public/settings.css',
  '02-hub/public/settings.js',

  '01-caddy-docker/docker-compose.yml',
  '02-hub/Dockerfile',
  '02-hub/docker-compose.yml',
  '03-modules/anime/anime.css',
  '03-modules/anime/anime.js',
  '03-modules/anime/index.mjs',
  '03-modules/anime/manifest.json',
  '03-modules/anime/store.mjs',
  '03-modules/articles/index.mjs',
  '03-modules/articles/manifest.json',
  '03-modules/balance/balance.css',
  '03-modules/balance/balance.js',
  '03-modules/balance/bank.js',
  '03-modules/balance/bank.mjs',
  '03-modules/balance/companion.apk',
  '03-modules/balance/companion.json',
  '03-modules/balance/index.mjs',
  '03-modules/balance/manifest.json',
  '03-modules/balance/market.mjs',
  '03-modules/balance/store.mjs',
  '03-modules/chat/chat.css',
  '03-modules/chat/chat.js',
  '03-modules/chat/flow-audio.mjs',
  '03-modules/chat/flow-session.mjs',
  '03-modules/chat/flowmusic.mjs',
  '03-modules/chat/index.mjs',
  '03-modules/chat/manifest.json',
  '03-modules/chat/store.mjs',
  '03-modules/cinema/cinema.css',
  '03-modules/cinema/cinema.js',
  '03-modules/cinema/index.mjs',
  '03-modules/cinema/manifest.json',
  '03-modules/cinema/store.mjs',
  '03-modules/gallery/index.mjs',
  '03-modules/gallery/manifest.json',
  '03-modules/kanban/index.mjs',
  '03-modules/kanban/archive.mjs',
  '03-modules/kanban/kanban.css',
  '03-modules/kanban/kanban.js',
  '03-modules/kanban/manifest.json',
  '03-modules/kanban/store.mjs',
  '03-modules/projects/index.mjs',
  '03-modules/projects/manifest.json',
  '03-modules/projects/projects.css',
  '03-modules/projects/projects.js',
  '03-modules/projects/store.mjs',
  '03-modules/projects/zip.mjs',
  '03-modules/pulse/index.mjs',
  '03-modules/pulse/history.mjs',
  '03-modules/pulse/manifest.json',
  '03-modules/pulse/pulse.css',
  '03-modules/pulse/pulse.js',
  '03-modules/reader/engine.js',
  '03-modules/reader/index.mjs',
  '03-modules/reader/manifest.json',
  '03-modules/reader/parse.mjs',
  '03-modules/reader/nbk.mjs',
  '03-modules/reader/reader.css',
  '03-modules/reader/reader.js',
  '03-modules/reader/store.mjs',
  '03-modules/rhythm/analysis.mjs',
  '03-modules/rhythm/index.mjs',
  '03-modules/rhythm/manifest.json',
  '03-modules/rhythm/refresh.mjs',
  '03-modules/rhythm/reports.mjs',
  '03-modules/rhythm/rhythm.css',
  '03-modules/rhythm/rhythm.js',
  '03-modules/rhythm/store.mjs',
  '03-modules/rhythm/summary.mjs',
  '03-modules/rhythm/wake.mjs',
  '03-modules/signal/index.mjs',
  '03-modules/signal/manifest.json',
  '03-modules/signal/phone.mjs',
  '03-modules/signal/signal.css',
  '03-modules/signal/signal.js',
  '03-modules/statistics/index.mjs',
  '03-modules/statistics/manifest.json',
  '03-modules/storage/index.mjs',
  '03-modules/storage/manifest.json',
  '03-modules/storage/phone.mjs',
  '03-modules/storage/storage.css',
  '03-modules/storage/storage.js',
  '03-modules/storage/store.mjs',
  '03-modules/trophies/index.mjs',
  '03-modules/trophies/manifest.json',
  '03-modules/trophies/providers.mjs',
  '03-modules/trophies/store.mjs',
  '03-modules/trophies/trophies.css',
  '03-modules/trophies/trophies.js',
  '03-modules/wave/catalog.mjs',
  '03-modules/wave/index.mjs',
  '03-modules/wave/manifest.json',
  '03-modules/wave/phone.mjs',
  '03-modules/wave/player.js',
  '03-modules/wave/playback.mjs',
  '03-modules/wave/playback-sync.js',
  '03-modules/wave/store.mjs',
  '03-modules/wave/wave.css',
  '03-modules/wave/wave.js',
  '02-hub/package-lock.json',
  '02-hub/package.json',
  '02-hub/public/activity-views.js',
  '02-hub/public/activity.css',
  '02-hub/public/activity.js',
  '02-hub/public/app.css',
  '02-hub/public/app.js',
  '02-hub/public/apple-touch-icon.png',
  '02-hub/public/content.css',
  '02-hub/public/content.js',
  '02-hub/public/markdown-edit.js',
  '02-hub/public/fonts/JetBrainsMono-LICENSE.txt',
  '02-hub/public/fonts/jetbrains-mono.woff2',
  '02-hub/public/fonts/onest-cyrillic-ext.woff2',
  '02-hub/public/fonts/onest-cyrillic.woff2',
  '02-hub/public/fonts/onest-vietnamese.woff2',
  '02-hub/public/fonts/onest-latin-ext.woff2',
  '02-hub/public/fonts/onest-latin.woff2',
  '02-hub/public/fonts/unbounded-cyrillic-ext.woff2',
  '02-hub/public/fonts/unbounded-cyrillic.woff2',
  '02-hub/public/fonts/unbounded-vietnamese.woff2',
  '02-hub/public/fonts/unbounded-latin-ext.woff2',
  '02-hub/public/fonts/unbounded-latin.woff2',
  '02-hub/public/fonts/Onest-LICENSE.txt',
  '02-hub/public/fonts/Unbounded-LICENSE.txt',
  '02-hub/public/icon-192.png',
  '02-hub/public/icon-512.png',
  '02-hub/public/icon.svg',
  '02-hub/public/legacy-clients.js',
  '02-hub/public/manifest.json',
  '02-hub/public/mark.svg',
  '02-hub/public/offline.html',
  '02-hub/public/overview.css',
  '02-hub/public/overview.js',
  '02-hub/public/workspace.css',
  '02-hub/public/workspace.js',
  '02-hub/public/appearance.js',
  '02-hub/public/profile.js',
  '02-hub/public/pulse-history.js',
  '02-hub/public/install.js',
  '02-hub/public/home.js',
  '02-hub/public/quick-ping.js',
  '02-hub/public/auto-ping.js',
  '02-hub/public/performance.js',
  '02-hub/public/security.css',
  '02-hub/public/maintenance.js',
  '02-hub/public/maintenance.css',
  '02-hub/public/security.js',
  '02-hub/public/sw.js',
  '02-hub/public/ui.js',
  '02-hub/src/activity.mjs',
  '02-hub/src/profile.mjs',
  '02-hub/src/ai-usage.mjs',
  '02-hub/src/auth.mjs',
  '02-hub/src/cache.mjs',
  '02-hub/src/companion.mjs',
  '02-hub/src/content-module.mjs',
  '02-hub/src/content-store.mjs',
  '02-hub/src/deepseek.mjs',
  '02-hub/src/input.mjs',
  '02-hub/src/modules.mjs',
  '02-hub/src/notices.mjs',
  '02-hub/src/overview-views.mjs',
  '02-hub/src/overview.mjs',
  '02-hub/src/home-data.mjs',
  '02-hub/src/passkeys.mjs',
  '02-hub/src/security.mjs',
  '02-hub/src/maintenance.mjs',
  '02-hub/src/maintenance-schema.mjs',
  '02-hub/src/server.mjs',
  '02-hub/src/vendor/marked.LICENSE.md',
  '02-hub/src/vendor/marked.mjs',
  '02-hub/src/views.mjs',
  '02-hub/src/groups.mjs',
  '02-hub/src/webpush.mjs',
  '03-modules/pulse/deploy/docker-compose.override.yml',
  '03-modules/pulse/deploy/nexus404-pulse.service',
  '03-modules/signal/deploy/nexus404-signal.service',
  'bootstrap.mjs',
  'host/base.mjs',
  'host/common.mjs',
  'host/events.mjs',
  'host/info.mjs',
  'host/maintenance-control.mjs',
  'host/maintenance.mjs',
  'host/metrics.mjs',
  'host/module-events.mjs',
  'host/platform.mjs',
  'host/runtime.mjs',
  'host/security.mjs',
  'host/signal-rules.mjs',
  'host/signal.mjs',
  'host/ssh.mjs',
  'host/ui.mjs',
  'host/webpush.mjs',
  'menu.mjs',
  'menu.sh',
  'tools/backup/backup-schedule.mjs',
  'tools/backup/backup.mjs',
  'tools/backup/restore-check.mjs',
  'tools/backup/restore-smoke.mjs'
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
