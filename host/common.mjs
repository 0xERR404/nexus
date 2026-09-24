import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NODE = '/usr/local/bin/nexus404-node';
export const HOST = '/opt/nexus404/host';
export const BASE = '/var/lib/nexus404-base';
export const HUB = '/opt/nexus404/hub-platform';
export const CADDY = '/var/lib/nexus404-caddy';
export const STATE = '/var/lib/nexus404-shell';
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function read(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export function json(file, fallback = null, limit = 2 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size > limit) throw new Error('Слишком большой файл');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
}
export function atomic(file, data, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o755});
  const temp = file + '.' + randomBytes(6).toString('hex');
  try {
    fs.writeFileSync(temp, data, {mode, flag: 'wx'});
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, {force: true});
  }
}
export const saveJSON = (file, data, mode = 0o600) =>
  atomic(file, JSON.stringify(data, null, 2) + '\n', mode);
export const clean = (value) =>
  String(value ?? '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .trim();
export function query(command, args = [], options = {}) {
  const r = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 8 * 1024 * 1024,
    env: {...process.env, LC_ALL: 'C.UTF-8'},
    ...options
  });
  return {ok: r.status === 0, text: (r.stdout ?? '').trim(), error: (r.stderr ?? '').trim()};
}
export function exec(command, args = [], {input, log, timeout = 0, cwd, inherit = false} = {}) {
  return new Promise((resolve, reject) => {
    const fd = log ? fs.openSync(log, 'a', 0o600) : null;
    const child = spawn(command, args, {
      cwd,
      env: {...process.env, LC_ALL: 'C.UTF-8', DEBIAN_FRONTEND: 'noninteractive'},
      stdio: [
        input === undefined ? (inherit ? 'inherit' : 'ignore') : 'pipe',
        inherit ? 'inherit' : (fd ?? 'ignore'),
        inherit ? 'inherit' : (fd ?? 'ignore')
      ]
    });
    let failure, deadline, force;
    const stop = () => {
      failure ??= Object.assign(new Error('Выполнение прервано'), {code: 'ECANCELLED'});
      child.kill('SIGTERM');
      force ??= setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    if (timeout) deadline = setTimeout(stop, timeout);
    for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, stop);
    child.once('error', (e) => {
      failure = e;
    });
    if (input !== undefined) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.once('close', (code) => {
      clearTimeout(deadline);
      clearTimeout(force);
      for (const signal of ['SIGTERM', 'SIGINT']) process.removeListener(signal, stop);
      if (fd !== null) fs.closeSync(fd);
      if (failure || code !== 0)
        reject(failure ?? new Error(`${command}: код ${code ?? 'signal'}`));
      else resolve();
    });
  });
}
export async function lock(file, nonblock = false) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const child = spawn(
    'flock',
    [
      ...(nonblock ? ['-n'] : []),
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
    child.once('exit', (code) =>
      reject(
        Object.assign(new Error(`Задача уже выполняется или flock недоступен (${code})`), {
          code: code === 1 ? 'ELOCKED' : 'ELOCK'
        })
      )
    );
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
export async function withLock(file, fn, nonblock = false) {
  const release = await lock(file, nonblock);
  try {
    return await fn();
  } finally {
    await release();
  }
}
export function requireRoot() {
  if (process.getuid?.() !== 0) throw new Error('Запусти через sudo.');
}
export function supported() {
  requireRoot();
  if (!fs.existsSync('/run/systemd/system')) throw new Error('Нужна система с systemd.');
  const os = Object.fromEntries(
    read('/etc/os-release')
      .split('\n')
      .map((r) => {
        const i = r.indexOf('=');
        return [r.slice(0, i), r.slice(i + 1).replace(/^"|"$/g, '')];
      })
  );
  if (!['debian', 'ubuntu'].includes(os.ID)) throw new Error('Поддерживаются Debian и Ubuntu.');
  return os;
}
export function installHost(directory = '/opt/nexus404') {
  const host = path.join(directory, 'host'),
    shared = path.join(directory, '02-hub/src');
  fs.mkdirSync(host, {recursive: true, mode: 0o755});
  fs.chmodSync(directory, 0o755);
  fs.chmodSync(host, 0o755);
  if (path.resolve(ROOT, 'host') !== path.resolve(host))
    fs.cpSync(path.join(ROOT, 'host'), host, {recursive: true});
  fs.mkdirSync(shared, {recursive: true, mode: 0o755});
  fs.chmodSync(path.dirname(shared), 0o755);
  fs.chmodSync(shared, 0o755);
  for (const name of ['webpush.mjs', 'auth.mjs', 'modules.mjs']) {
    const source = path.join(ROOT, '02-hub/src', name),
      target = path.join(shared, name);
    if (source !== path.resolve(target)) fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o644);
  }
  for (const name of fs.readdirSync(host))
    if (name.endsWith('.mjs')) fs.chmodSync(path.join(host, name), 0o644);
}
export function event(type, details = '') {
  try {
    fs.mkdirSync('/opt/nexus404/hooks/events', {recursive: true, mode: 0o700});
    fs.appendFileSync(
      '/opt/nexus404/hooks/events/events.jsonl',
      JSON.stringify({
        type,
        time: new Date().toISOString(),
        details: clean(details).slice(0, 500)
      }) + '\n',
      {mode: 0o600}
    );
  } catch {
    console.error('Не удалось записать событие');
  }
}
export async function apt(ui, label, ...args) {
  for (let i = 0; i < 3; i++) {
    try {
      return await ui.run(label, 'apt-get', ['-o', 'DPkg::Lock::Timeout=120', ...args]);
    } catch (e) {
      if (i === 2 || e.code === 'ECANCELLED') throw e;
      await sleep(3000);
    }
  }
}
export const validUser = (v) => /^[a-z_][a-z0-9_-]{0,31}$/.test(v) && v !== 'root';
export const validPort = (v) =>
  /^\d{1,5}$/.test(String(v)) && Number(v) >= 1024 && Number(v) <= 65535;
export const validTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
export const direct = (url) =>
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);
