#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {event} from '../../host/common.mjs';

const configFile = '/etc/nexus404-backup.json';
const node = '/usr/local/bin/nexus404-node';
const script = '/opt/nexus404/tools/backup/backup-schedule.mjs';
const service = '/etc/systemd/system/nexus404-backup.service';
const timer = '/etc/systemd/system/nexus404-backup.timer';

function command(name, args) {
  const result = spawnSync(name, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    timeout: 3600000
  });
  if (result.status !== 0 || result.error)
    throw new Error(`${name}: ${result.stderr?.trim() || result.error?.message || result.status}`);
}

export function remoteConfig(account, directory, identity) {
  if (
    !/^[a-z_][a-z0-9_-]{0,31}@[a-zA-Z0-9.-]{1,253}$/.test(account) ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(directory) ||
    directory.includes('..') ||
    !path.isAbsolute(identity)
  )
    throw new Error('Неверный адрес, каталог или SSH-ключ');
  const key = fs.lstatSync(identity);
  if (!key.isFile() || key.isSymbolicLink() || key.uid !== 0 || key.mode & 0o077)
    throw new Error('SSH-ключ должен принадлежать root и иметь права 0600');
  return {account, directory: directory.replace(/\/$/, ''), identity};
}

export function upload(file, remote, keepDays = 14, run = command) {
  const {account, directory, identity} = remoteConfig(
    remote.account,
    remote.directory,
    remote.identity
  );
  const name = path.basename(file);
  if (!/^nexus404-\d{8}T\d{6}Z\.nexus$/.test(name)) throw new Error('Неверное имя копии');
  const target = `${directory}/${name}`;
  const sshOptions = [
    '-i',
    identity,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15'
  ];
  run('scp', ['-q', ...sshOptions, file, `${account}:${target}.part`]);
  const hash = createHash('sha256');
  const fd = fs.openSync(file, 'r'),
    block = Buffer.allocUnsafe(1024 * 1024);
  try {
    let count;
    while ((count = fs.readSync(fd, block, 0, block.length, null)))
      hash.update(block.subarray(0, count));
  } finally {
    fs.closeSync(fd);
  }
  const expected = hash.digest('hex');
  // Пользовательский путь допускает только символы без синтаксиса shell.
  const verify = spawnSync('ssh', [...sshOptions, account, `sha256sum ${target}.part`], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4096
  });
  if (verify.status !== 0 || verify.stdout?.trim().split(/\s+/)[0] !== expected)
    throw new Error('Контрольная сумма удалённой копии не совпала');
  run('ssh', [...sshOptions, account, `mv -n ${target}.part ${target}`]);
  const confirmed = spawnSync('ssh', [...sshOptions, account, `sha256sum ${target}`], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 4096
  });
  if (confirmed.status !== 0 || confirmed.stdout?.trim().split(/\s+/)[0] !== expected)
    throw new Error('Не удалось подтвердить сохранение удалённой копии');
  const listing = spawnSync(
    'ssh',
    [
      ...sshOptions,
      account,
      `find ${directory} -maxdepth 1 -type f -name 'nexus404-*.nexus' -printf '%f\\n'`
    ],
    {encoding: 'utf8', timeout: 120000, maxBuffer: 1024 * 1024}
  );
  if (listing.status !== 0) throw new Error('Не удалось прочитать удалённые копии');
  const files = listing.stdout
    .split('\n')
    .filter((item) => /^nexus404-\d{8}T\d{6}Z\.nexus$/.test(item))
    .sort()
    .reverse();
  const cutoff = Date.now() - keepDays * 86400000;
  for (const old of files.slice(2)) {
    const m = /^nexus404-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.nexus$/.exec(old);
    if (Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) < cutoff)
      run('ssh', [...sshOptions, account, `rm -- ${directory}/${old}`]);
  }
}

export function prune(directory, keepDays, now = Date.now()) {
  const cutoff = now - keepDays * 86400000;
  const files = fs
    .readdirSync(directory)
    .filter((name) => /^nexus404-\d{8}T\d{6}Z\.nexus$/.test(name))
    .map((name) => ({name, file: path.join(directory, name)}))
    .filter(({file}) => fs.lstatSync(file).isFile());
  // Сохраняем минимум две последние успешные копии даже после срока хранения.
  for (const {file} of files.sort((a, b) => b.name.localeCompare(a.name)).slice(2))
    if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
}

export function backupDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error('Нужен абсолютный путь каталога');
  const resolved = path.resolve(directory);
  let parent = resolved;
  while (!fs.existsSync(parent)) parent = path.dirname(parent);
  const destination = path.resolve(fs.realpathSync(parent), path.relative(parent, resolved));
  if (
    ['/', '/etc', '/var', '/var/lib', '/opt', '/usr', '/home', '/root', '/tmp', '/run'].includes(
      destination
    ) ||
    /\s/.test(destination) ||
    destination === '/opt/nexus404' ||
    destination.startsWith('/opt/nexus404/') ||
    destination.startsWith('/var/lib/nexus404-')
  )
    throw new Error('Нужен отдельный каталог копий вне приложения');
  return destination;
}

export function install(directory, key, keepDays = 14) {
  if (process.getuid?.() !== 0) throw new Error('Нужны права root');
  if (
    !path.isAbsolute(directory) ||
    !path.isAbsolute(key) ||
    !Number.isInteger(keepDays) ||
    keepDays < 2 ||
    keepDays > 365
  )
    throw new Error('Укажи абсолютные пути и срок хранения 2–365 дней');
  const stat = fs.lstatSync(key);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    stat.mode & 0o077 ||
    fs.statSync(key).size !== 32
  )
    throw new Error('Нужен 32-байтовый ключ root с правами 0600');
  const destination = backupDirectory(directory);
  if (!fs.existsSync(destination)) fs.mkdirSync(destination, {recursive: true, mode: 0o700});
  if (!fs.statSync(destination).isDirectory()) throw new Error('Нужен каталог копий');
  const previous = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
  fs.writeFileSync(
    configFile,
    JSON.stringify({...previous, directory: destination, key, keepDays}) + '\n',
    {mode: 0o600}
  );
  fs.chmodSync(configFile, 0o600);
  fs.writeFileSync(
    service,
    `[Unit]\nDescription=NEXUS404 Mnemosyne encrypted backup\nRequiresMountsFor=${destination}\n[Service]\nType=oneshot\nExecStart=${node} ${script} run\n`,
    {mode: 0o644}
  );
  fs.writeFileSync(
    timer,
    '[Unit]\nDescription=NEXUS404 Mnemosyne daily encrypted backup\n[Timer]\nOnCalendar=*-*-* 03:30:00\nPersistent=true\nRandomizedDelaySec=10min\n[Install]\nWantedBy=timers.target\n',
    {mode: 0o644}
  );
  command('systemctl', ['daemon-reload']);
  command('systemctl', ['enable', '--now', 'nexus404-backup.timer']);
}

export function scheduled() {
  if (process.getuid?.() !== 0) throw new Error('Нужны права root');
  const {directory, key, keepDays, remote} = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (
    !path.isAbsolute(directory) ||
    !path.isAbsolute(key) ||
    !Number.isInteger(keepDays) ||
    keepDays < 2 ||
    keepDays > 365
  )
    throw new Error('Неверная конфигурация резервных копий');
  backupDirectory(directory);
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const file = path.join(directory, `nexus404-${stamp}.nexus`);
  command(node, ['/opt/nexus404/tools/backup/backup.mjs', file, key]);
  if (remote) upload(file, remote, keepDays);
  prune(directory, keepDays);
}

export function configureRemote(account, directory, identity) {
  if (process.getuid?.() !== 0) throw new Error('Нужны права root');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  config.remote = remoteConfig(account, directory, identity);
  const temp = configFile + '.new';
  fs.writeFileSync(temp, JSON.stringify(config) + '\n', {mode: 0o600});
  fs.renameSync(temp, configFile);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    if (process.argv[2] === 'install' && process.argv.length >= 5 && process.argv.length <= 6)
      install(
        process.argv[3],
        process.argv[4],
        process.argv[5] === undefined ? 14 : Number(process.argv[5])
      );
    else if (process.argv[2] === 'remote' && process.argv.length === 6)
      configureRemote(process.argv[3], process.argv[4], process.argv[5]);
    else if (process.argv[2] === 'run' && process.argv.length === 3) scheduled();
    else
      throw new Error(
        'Феникс · использование: backup-schedule.mjs install КАТАЛОГ КЛЮЧ [ДНЕЙ] | remote USER@HOST КАТАЛОГ SSH_КЛЮЧ | run'
      );
  } catch (e) {
    event('system.backup.failed', e.message);
    console.error(e.message);
    process.exitCode = 1;
  }
}
