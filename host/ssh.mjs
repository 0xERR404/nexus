import fs from 'node:fs';
import path from 'node:path';
import {
  BASE,
  HOST,
  NODE,
  read,
  atomic,
  saveJSON,
  json,
  query,
  exec,
  lock,
  sleep,
  clean,
  direct
} from './common.mjs';
export function parseSSH(text) {
  const data = {};
  for (const row of text.split('\n')) {
    const [key, ...v] = row.trim().split(/\s+/);
    if (key) (data[key] ??= []).push(...v);
  }
  return data;
}
export function clearPorts(text) {
  let match = false;
  return text
    .split('\n')
    .filter((row) => {
      if (/^\s*Match\s/i.test(row)) match = true;
      return match || !/^\s*Port\s/i.test(row);
    })
    .join('\n');
}
export function prepareRuntime(directory = '/run/sshd') {
  fs.mkdirSync(directory, {recursive: true, mode: 0o755});
  if (!fs.lstatSync(directory).isDirectory())
    throw new Error('Некорректный каталог SSH: ' + directory);
  fs.chmodSync(directory, 0o755);
}
export class SSH {
  constructor(
    ui,
    {
      base = BASE,
      sshDirectory = '/etc/ssh',
      runtimeDirectory = '/run/sshd',
      run = exec,
      inspect = query
    } = {}
  ) {
    this.ui = ui;
    this.base = base;
    this.sshDirectory = sshDirectory;
    this.runtimeDirectory = runtimeDirectory;
    this.managedFile = sshDirectory + '/sshd_config.d/00-nexus404.conf';
    this.run = run;
    this.inspect = inspect;
    this.service = this.inspect('systemctl', ['cat', 'ssh.service']).ok
      ? 'ssh.service'
      : 'sshd.service';
    this.guard = null;
  }
  config(user, address = process.env.SSH_CONNECTION?.split(' ')[0] ?? '127.0.0.1') {
    return this.inspectConfig(['-T', '-C', `user=${user},host=localhost,addr=${address}`]);
  }
  inspectConfig(args) {
    prepareRuntime(this.runtimeDirectory);
    const r = this.inspect('sshd', args);
    if (!r.ok)
      throw new Error(
        'Не удалось проверить SSH: ' +
          clean(r.error || 'sshd -T завершился с ошибкой').slice(0, 1000)
      );
    return parseSSH(r.text);
  }
  ports() {
    return [...new Set(this.inspectConfig(['-T']).port ?? [])].map(Number).sort((a, b) => a - b);
  }
  previousPorts() {
    const pid = this.inspect('systemctl', ['show', '-p', 'MainPID', '--value', this.service]).text;
    const ports = this.inspect('ss', ['-H', '-ltnp'])
      .text.split('\n')
      .filter((r) => pid && pid !== '0' && r.includes(`pid=${pid},`))
      .map((r) => Number(r.trim().split(/\s+/)[3]?.split(':').at(-1)))
      .filter(Number.isFinite);
    if (this.inspect('systemctl', ['is-active', '--quiet', 'ssh.socket']).ok) {
      ports.push(
        ...[
          ...this.inspect('systemctl', [
            'show',
            '-p',
            'Listen',
            '--value',
            'ssh.socket'
          ]).text.matchAll(/:(\d+)\s/g)
        ].map((m) => Number(m[1]))
      );
    }
    return ports.length ? [...new Set(ports)].sort((a, b) => a - b) : this.ports();
  }
  managed() {
    fs.mkdirSync(path.dirname(this.managedFile), {recursive: true});
    const file = this.sshDirectory + '/sshd_config',
      text = read(file);
    if (!text.split('\n').includes('Include ' + this.managedFile))
      atomic(
        file,
        'Include ' + this.managedFile + '\n' + text + '\n',
        fs.statSync(file).mode & 0o777
      );
    if (!fs.existsSync(this.managedFile)) atomic(this.managedFile, '');
  }
  set(key, value) {
    const text = read(this.managedFile)
      .split('\n')
      .filter((r) => r.trim().split(/\s+/)[0]?.toLowerCase() !== key.toLowerCase())
      .join('\n')
      .trim();
    atomic(this.managedFile, (text ? text + '\n' : '') + key + ' ' + value + '\n');
  }
  clearPorts() {
    for (const file of [
      this.sshDirectory + '/sshd_config',
      ...fs
        .readdirSync(path.dirname(this.managedFile))
        .filter((f) => f.endsWith('.conf'))
        .map((f) => path.join(path.dirname(this.managedFile), f))
    ])
      atomic(file, clearPorts(read(file)) + '\n', fs.statSync(file).mode & 0o777);
  }
  async reload() {
    prepareRuntime(this.runtimeDirectory);
    await this.run('sshd', ['-t'], {log: this.ui.log});
    let action = 'reload-or-restart';
    if (this.inspect('systemctl', ['is-active', '--quiet', 'ssh.socket']).ok) {
      if (
        this.inspect('systemctl', ['show', '-p', 'KillMode', '--value', this.service]).text !==
        'process'
      )
        throw new Error('KillMode SSH не сохраняет текущие подключения');
      await this.run('systemctl', ['disable', '--now', 'ssh.socket'], {log: this.ui.log});
      action = 'restart';
    } else this.inspect('systemctl', ['disable', 'ssh.socket']);
    await this.run('systemctl', ['enable', this.service], {log: this.ui.log});
    await this.run('systemctl', [action, this.service], {log: this.ui.log});
    if (!this.inspect('systemctl', ['is-active', '--quiet', this.service]).ok)
      throw new Error('SSH не запущен');
  }
  async waitPorts(ports) {
    for (const port of ports) {
      let ok = false;
      for (let i = 0; i < 30; i++) {
        const r = this.inspect('ss', ['-H', '-ltn', `sport = :${port}`]);
        if (r.ok && r.text) {
          ok = true;
          break;
        }
        await sleep(100);
      }
      if (!ok) throw new Error(`SSH-порт ${port} не слушается`);
    }
  }
  async begin() {
    if (this.guard) throw new Error('Незавершённая проверка SSH');
    const folder = fs.mkdtempSync(this.base + '/ssh-rollback.');
    fs.chmodSync(folder, 0o700);
    await this.run('cp', ['-a', this.sshDirectory, folder + '/ssh']);
    const socketPorts = this.inspect('systemctl', ['is-active', '--quiet', 'ssh.socket']).ok
      ? this.previousPorts()
      : [];
    saveJSON(folder + '/state.json', {service: this.service, socketPorts});
    const release = await lock(folder + '/lock');
    const unit = 'nexus404-ssh-rollback-' + path.basename(folder).split('.').at(-1);
    this.guard = {folder, release, unit};
    await this.run(
      'systemd-run',
      [
        '--quiet',
        '--collect',
        '--unit=' + unit,
        '--on-active=10m',
        NODE,
        HOST + '/ssh.mjs',
        '--rollback',
        folder
      ],
      {log: this.ui.log}
    );
    this.ui.line('[*] Откат SSH через 10 минут, если доступ не подтверждён.');
  }
  async unlock() {
    if (this.guard?.release) {
      await this.guard.release();
      this.guard.release = null;
    }
  }
  async acquire() {
    if (!this.guard) throw new Error('Нет проверки SSH');
    if (!this.guard.release) this.guard.release = await lock(this.guard.folder + '/lock');
    if (fs.existsSync(this.guard.folder + '/rolled-back'))
      throw new Error('Таймер уже восстановил SSH. Повтори шаг.');
  }
  async confirm(message) {
    await this.unlock();
    this.ui.line('Не закрывай текущую SSH-сессию.');
    if (!(await this.ui.confirm(message)))
      throw new Error('Доступ не подтверждён. Выполняется откат.');
    await this.acquire();
  }
  async commit() {
    await this.acquire();
    atomic(this.guard.folder + '/committed', 'yes');
    await this.unlock();
    this.inspect('systemctl', ['stop', this.guard.unit + '.timer']);
    this.guard = null;
  }
  async abort() {
    if (!this.guard) return;
    const {folder, unit} = this.guard;
    await this.unlock();
    await rollback(folder, {
      base: this.base,
      sshDirectory: this.sshDirectory,
      runtimeDirectory: this.runtimeDirectory,
      run: this.run,
      inspect: this.inspect
    });
    this.inspect('systemctl', ['stop', unit + '.timer']);
    this.guard = null;
  }
}
export async function rollback(
  folder,
  {
    base = BASE,
    sshDirectory = '/etc/ssh',
    runtimeDirectory = '/run/sshd',
    run = exec,
    inspect = query
  } = {}
) {
  if (!path.resolve(folder).startsWith(base + '/ssh-rollback.'))
    throw new Error('Некорректная копия SSH');
  const release = await lock(folder + '/lock');
  try {
    if (fs.existsSync(folder + '/committed')) return;
    const {service, socketPorts = []} = json(folder + '/state.json');
    if (!['ssh.service', 'sshd.service'].includes(service)) throw new Error('Некорректная служба');
    fs.rmSync(sshDirectory + '/sshd_config.d/00-nexus404.conf', {force: true});
    await run('cp', ['-a', folder + '/ssh/.', sshDirectory + '/']);
    if (socketPorts.length) {
      if (!socketPorts.every((p) => Number.isInteger(p) && p > 0 && p <= 65535))
        throw new Error('Некорректные порты копии SSH');
      const managed = sshDirectory + '/sshd_config.d/00-nexus404.conf',
        config = sshDirectory + '/sshd_config';
      atomic(
        managed,
        clearPorts(read(managed)) + '\n' + socketPorts.map((p) => 'Port ' + p).join('\n') + '\n'
      );
      const original = read(config);
      if (!original.split('\n').includes('Include ' + managed))
        atomic(config, 'Include ' + managed + '\n' + original + '\n');
    }
    prepareRuntime(runtimeDirectory);
    await run('sshd', ['-t']);
    await run('systemctl', ['enable', service]);
    inspect('systemctl', ['disable', '--now', 'ssh.socket']);
    await run('systemctl', ['reload-or-restart', service]);
    atomic(folder + '/rolled-back', 'yes');
  } finally {
    await release();
  }
}
if (direct(import.meta.url) && process.argv[2] === '--rollback')
  rollback(process.argv[3]).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
