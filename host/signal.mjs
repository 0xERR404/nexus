import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {
  BASE,
  HUB,
  CADDY,
  STATE,
  read,
  json,
  saveJSON,
  query,
  clean,
  direct,
  sleep,
  withLock
} from './common.mjs';
import {Collector} from './metrics.mjs';
import {protection, portFindings} from './security.mjs';
import {Rules, categories, defaultSettings} from './signal-rules.mjs';
import {vapidKeys, validateSubscription, subscriptionId, sendPush} from './webpush.mjs';
const DIR = '/var/lib/nexus404-signal';
const sha = (value) => createHash('sha256').update(value).digest('hex');
export function prepareSignal() {
  fs.mkdirSync(DIR, {recursive: true, mode: 0o700});
  fs.chmodSync(DIR, 0o700);
  fs.mkdirSync(DIR + '/public', {recursive: true, mode: 0o755});
  fs.chmodSync(DIR + '/public', 0o755);
  if (!fs.existsSync(DIR + '/keys.json')) saveJSON(DIR + '/keys.json', vapidKeys());
  const keys = json(DIR + '/keys.json');
  saveJSON(DIR + '/public/public.json', {publicKey: keys.publicKey}, 0o644);
}
export function readSettings(
  file = HUB + '/data/signal.json',
  authFile = HUB + '/config/auth.json'
) {
  const config = json(file, {}, 256 * 1024),
    auth = json(authFile, {});
  const identity = sha((auth.username ?? '') + ':' + (auth.salt ?? '') + ':' + (auth.hash ?? ''));
  const settings = {...defaultSettings, categories: {...defaultSettings.categories}, devices: []};
  if (config.identity !== identity) return settings;
  for (const key of categories)
    if (typeof config.categories?.[key] === 'boolean')
      settings.categories[key] = config.categories[key];
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(config.dailyTime ?? ''))
    settings.dailyTime = config.dailyTime;
  settings.detailOnLockScreen = config.detailOnLockScreen === true;
  for (const device of (Array.isArray(config.devices) ? config.devices : []).slice(0, 20)) {
    try {
      const subscription = validateSubscription(device.subscription),
        id = subscriptionId(subscription);
      settings.devices.push({
        id,
        name: clean(device.name).slice(0, 60) || 'Устройство',
        subscription,
        updatedAt: Number(device.updatedAt) || 0,
        testAt: Math.min(Number(device.testAt) || 0, Date.now())
      });
    } catch {}
  }
  return settings;
}
export function readEvents(file, state, limit = 256 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const s = fs.fstatSync(fd);
    let offset = state.inode === s.ino && state.offset <= s.size ? state.offset : 0;
    if (!Number.isFinite(offset)) offset = Math.max(0, s.size - limit);
    const start = offset;
    const buffer = Buffer.alloc(Math.min(limit, s.size - offset));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const content = buffer.subarray(0, n),
      end = content.lastIndexOf(10);
    state.inode = s.ino;
    if (end < 0) {
      state.offset = n === limit ? offset + n : offset;
      return [];
    }
    state.offset = start + end + 1;
    return content
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const e = JSON.parse(line);
          return typeof e.type === 'string' && Date.now() - Date.parse(e.time) < 3600000 ? [e] : [];
        } catch {
          return [];
        }
      });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
export function probeHTTPS(domain) {
  return new Promise((resolve) => {
    if (!/^[a-z0-9.-]+$/i.test(domain)) {
      resolve({ok: false, error: 'Домен не настроен'});
      return;
    }
    const request = https.get(
      {
        hostname: '127.0.0.1',
        port: 443,
        servername: domain,
        headers: {Host: domain},
        path: '/',
        timeout: 5000,
        rejectUnauthorized: true
      },
      (response) => {
        const certificate = response.socket.getPeerCertificate();
        response.resume();
        resolve({
          ok: response.statusCode >= 200 && response.statusCode < 500,
          days: Math.floor((Date.parse(certificate.valid_to) - Date.now()) / 86400000),
          status: response.statusCode
        });
      }
    );
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', (e) => resolve({ok: false, error: e.code ?? 'HTTPS не отвечает'}));
  });
}
export class Signal {
  constructor({directory = DIR, settings = readSettings, sender = sendPush, now = Date.now} = {}) {
    this.dir = directory;
    this.settingsReader = settings;
    this.sender = sender;
    this.now = now;
    this.state = json(
      directory + '/state.json',
      {conditions: {}, groups: {}, events: [], queue: [], devices: {}, files: {}, cursors: {}},
      8 * 1024 * 1024
    );
    this.rules = new Rules(this.state, now);
    this.collector = new Collector();
    this.keys = json(directory + '/keys.json');
    this.busy = false;
    this.lastChecks = 0;
    this.checkFailed = false;
  }
  save() {
    this.state.events = this.state.events.slice(-300);
    this.state.queue = this.state.queue
      .filter((q) => this.now() - q.event.time < 86400000)
      .slice(-2000);
    const s = this.settingsReader();
    const valid = new Set(s.devices.map((d) => d.id));
    for (const id of Object.keys(this.state.devices))
      if (!valid.has(id)) delete this.state.devices[id];
    const devices = s.devices.map((d) => {
      const status = this.state.devices[d.id] ?? {};
      return {
        id: d.id,
        name: d.name,
        acceptedAt: status.acceptedAt ?? null,
        lastError: status.error ?? null,
        expired: status.expiredAt === d.updatedAt,
        pending: this.state.queue.filter((q) => q.id === d.id).length
      };
    });
    saveJSON(this.dir + '/state.json', this.state);
    saveJSON(
      this.dir + '/public/feed.json',
      {
        updatedAt: this.state.checkedAt ?? 0,
        events: this.state.events.slice().reverse(),
        active: Object.entries(this.state.conditions)
          .filter(([, c]) => c.announced)
          .map(([key, c]) => ({key, since: c.since, level: c.level})),
        devices
      },
      0o644
    );
  }
  enqueue(event, settings, target) {
    event = {
      ...event,
      key: String(event.key ?? 'event').slice(0, 160),
      title: String(event.title ?? '').slice(0, 160),
      body: String(event.body ?? '').slice(0, 500)
    };
    this.state.events.push(event);
    if (!settings.categories[event.category] && !target) return;
    for (const d of settings.devices) {
      if (target && d.id !== target) continue;
      const ds = this.state.devices[d.id] ?? {};
      if (ds.expiredAt === d.updatedAt) continue;
      this.state.queue.push({id: d.id, event, attempts: 0, next: this.now()});
    }
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      const settings = this.settingsReader(),
        byId = new Map(settings.devices.map((d) => [d.id, d]));
      const previousLength = this.state.queue.length;
      this.state.queue = this.state.queue.filter(
        (q) =>
          this.now() - q.event.time < 86400000 &&
          byId.has(q.id) &&
          (settings.categories[q.event.category] || q.event.key === 'push.test')
      );
      const selected = new Set();
      const pending = this.state.queue
        .filter((q) => {
          if (selected.has(q.id)) return false;
          selected.add(q.id);
          return q.next <= this.now();
        })
        .slice(0, 4);
      if (!pending.length && previousLength === this.state.queue.length) return;
      await Promise.all(
        pending.map(async (q) => {
          const device = byId.get(q.id),
            status = (this.state.devices[q.id] ??= {});
          if (status.expiredAt === device.updatedAt) {
            this.state.queue = this.state.queue.filter((x) => x !== q);
            return;
          }
          const show = settings.detailOnLockScreen;
          const payload = {
            id: q.event.id,
            title: show
              ? `${os.hostname().slice(0, 64)} · ${q.event.title.slice(0, 120)}`
              : 'NEXUS404 · Сигнал',
            body: show ? q.event.body.slice(0, 500) : q.event.title.slice(0, 180),
            level: q.event.level
          };
          try {
            const domain = read(CADDY + '/domain');
            const result = await this.sender(
              device.subscription,
              payload,
              this.keys,
              'https://' + domain,
              {now: this.now()}
            );
            if (result.ok) {
              status.acceptedAt = this.now();
              status.error = null;
              this.state.queue = this.state.queue.filter((x) => x !== q);
            } else if (result.gone) {
              status.expiredAt = device.updatedAt;
              status.error = 'Подписка истекла. Подключи устройство заново.';
              this.state.queue = this.state.queue.filter((x) => x.id !== q.id);
            } else {
              status.error = 'Push-служба ответила HTTP ' + result.status;
              q.attempts++;
              q.next =
                this.now() +
                Math.max(
                  (Number(result.retryAfter) || 60) * 1000,
                  Math.min(3600000, 30000 * 2 ** Math.min(q.attempts, 7))
                );
            }
          } catch {
            status.error = 'Нет связи со службой Push';
            q.attempts++;
            q.next = this.now() + Math.min(3600000, 30000 * 2 ** Math.min(q.attempts, 7));
          }
        })
      );
      this.save();
    } finally {
      this.busy = false;
    }
  }
  async checks() {
    for (const [unit, label, required] of [
      ['docker', 'Docker', fs.existsSync('/opt/nexus404/docker-compose.yml')],
      ['nexus404-pulse', 'Сборщик «Пульса»', fs.existsSync(STATE + '/pulse-installed')]
    ])
      if (required) {
        const ok = query('systemctl', ['is-active', '--quiet', unit + '.service']).ok;
        this.rules.condition('service.' + unit, !ok, {
          title: label + ' остановлен',
          level: 'critical',
          delay: 60000
        });
      }
    const ids = query('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project']);
    if (ids.ok) {
      const found = new Set();
      let inspectFailed = false;
      for (const id of ids.text.split(/\s+/).filter(Boolean)) {
        const r = query('docker', ['inspect', id]);
        try {
          if (!r.ok) throw new Error();
          const c = JSON.parse(r.text)[0],
            labels = c.Config?.Labels ?? {};
          if (!['nexus404', 'nexus404-shell'].includes(labels['com.docker.compose.project']))
            continue;
          const service = labels['com.docker.compose.service'],
            name = c.Name?.replace(/^\//, '') ?? id;
          found.add(service);
          const bad = !c.State?.Running || ['unhealthy'].includes(c.State?.Health?.Status);
          this.rules.condition('container.' + service, bad, {
            title: 'Контейнер ' + name + ' недоступен',
            body: 'Проверь состояние контейнера и его журнал.',
            level: 'critical',
            delay: 60000
          });
          const key = 'restart.' + id;
          const previous = this.state[key] ?? {count: c.RestartCount ?? 0, time: this.now()};
          if ((c.RestartCount ?? 0) > previous.count) {
            for (let i = 0; i < Math.min(20, c.RestartCount - previous.count); i++)
              this.rules.group(
                'container.restart.' + service,
                'Контейнер часто перезапускается',
                name,
                {threshold: 3, window: 600000, category: 'services'}
              );
          }
          this.state[key] = {count: c.RestartCount ?? 0, time: this.now()};
        } catch {
          inspectFailed = true;
        }
      }
      this.rules.condition('container.inspect', inspectFailed, {
        title: 'Не удалось проверить контейнеры',
        delay: 60000
      });
      for (const service of ['hub', 'caddy'])
        if (
          (service === 'hub'
            ? fs.existsSync(HUB + '/config/auth.json')
            : fs.existsSync(CADDY + '/domain')) &&
          !found.has(service)
        )
          this.rules.condition('container.' + service, true, {
            title: 'Контейнер ' + service + ' отсутствует',
            level: 'critical',
            delay: 60000
          });
    }
    const domain = read(CADDY + '/domain');
    if (domain) {
      const result = await probeHTTPS(domain);
      this.rules.condition('site.https', !result.ok, {
        title: 'Сайт или HTTPS недоступен',
        body: 'Проверка через локальный Caddy: ' + (result.error ?? 'HTTP ' + result.status),
        level: 'critical',
        delay: 60000
      });
      if (Number.isFinite(result.days))
        this.rules.condition('site.certificate', result.days <= 14, {
          title: 'Срок TLS-сертификата истекает',
          body: `Осталось дней: ${result.days}.`,
          level: result.days <= 3 ? 'critical' : 'warning',
          repeat: 86400000
        });
    }
    if (fs.existsSync(BASE + '/installed.flag'))
      this.securityFindings([...protection(query, undefined, false), ...portFindings()]);
    this.rules.condition('system.reboot.required', fs.existsSync('/var/run/reboot-required'), {
      title: 'После обновлений требуется перезагрузка',
      category: 'maintenance',
      repeat: 86400000
    });
    for (const file of new Set([
      '/etc/passwd',
      '/etc/group',
      '/etc/sudoers',
      '/etc/ssh/sshd_config',
      ...Object.keys(this.state.files),
      ...['/etc/ssh/sshd_config.d', '/etc/sudoers.d'].flatMap((dir) => {
        try {
          return fs
            .readdirSync(dir)
            .slice(0, 100)
            .map((name) => path.join(dir, name));
        } catch {
          return [];
        }
      })
    ])) {
      try {
        const digest = sha(fs.readFileSync(file));
        if (this.state.files[file] && this.state.files[file] !== digest)
          this.rules.emit(
            'security.file.' + file,
            'Изменены настройки безопасности',
            file,
            'warning',
            'security'
          );
        this.state.files[file] = digest;
      } catch (e) {
        if (e.code === 'ENOENT' && this.state.files[file]) {
          this.rules.emit(
            'security.file.' + file,
            'Удалён файл настроек безопасности',
            file,
            'warning',
            'security'
          );
          delete this.state.files[file];
        }
      }
    }
    for (const [key, value] of Object.entries(this.state))
      if (key.startsWith('restart.') && this.now() - value.time > 86400000) delete this.state[key];
    const args = [
      '--no-pager',
      '_TRANSPORT=kernel',
      '-o',
      'json',
      '-n',
      '1000',
      ...(this.state.journalCursor
        ? ['--after-cursor', this.state.journalCursor]
        : ['--since', '-1min'])
    ];
    let journal = query('journalctl', args);
    if (!journal.ok && this.state.journalCursor) {
      this.state.journalCursor = null;
      journal = query('journalctl', [
        '--no-pager',
        '_TRANSPORT=kernel',
        '-o',
        'json',
        '-n',
        '1000',
        '--since',
        '-1min'
      ]);
    }
    if (journal.ok)
      for (const line of journal.text.split('\n'))
        try {
          const entry = JSON.parse(line);
          this.state.journalCursor = entry.__CURSOR ?? this.state.journalCursor;
          if (/Out of memory:|oom-kill:|Killed process \d+/i.test(entry.MESSAGE ?? ''))
            this.rules.group(
              'system.oom',
              'Нехватка памяти: OOM',
              'Ядро завершило процесс из-за нехватки памяти.',
              {threshold: 1, window: 60000, category: 'resources', level: 'critical'}
            );
        } catch {}
  }
  securityFindings(findings) {
    const seen = new Set(findings.map((f) => f.key));
    for (const f of findings)
      this.rules.condition(f.key, f.level !== 'ok', {
        title: f.title,
        category: 'security',
        level: f.level === 'error' ? 'critical' : 'warning',
        delay: 60000
      });
    const complete = !findings.some(
      (f) => f.level !== 'ok' && /^(ports\.read|ports\.parse|docker\.inspect)/.test(f.key)
    );
    if (complete)
      for (const key of Object.keys(this.state.conditions))
        if (!seen.has(key) && /^(port\.|docker\.(port|host|logs)\.)/.test(key))
          this.rules.condition(key, false, {
            title: 'Открытые порты и контейнеры',
            category: 'security'
          });
  }
  async tick() {
    const settings = this.settingsReader(),
      data = this.collector.sample();
    this.rules.metrics(data);
    for (const file of ['/opt/nexus404/hooks/events/events.jsonl', HUB + '/data/auth-events.jsonl'])
      for (const e of readEvents(file, (this.state.cursors[file] ??= {}))) this.rules.event(e);
    this.rules.flushGroups();
    if (this.now() - this.lastChecks > 30000) {
      try {
        await this.checks();
        this.checkFailed = false;
      } catch {
        this.checkFailed = true;
      }
      this.rules.condition('monitor.checks', this.checkFailed, {
        title: 'Не удалось выполнить проверки сервера',
        level: 'critical',
        recoverDelay: 0
      });
      this.lastChecks = this.now();
    }
    for (const device of settings.devices) {
      const d = (this.state.devices[device.id] ??= {});
      if (device.testAt > 0 && device.testAt > (d.lastTestAt ?? 0)) {
        d.lastTestAt = device.testAt;
        const e = {
          id: 'test-' + device.id + '-' + device.testAt,
          key: 'push.test',
          title: 'Проверка уведомлений',
          body: '«Сигнал» подключён. Это проверочное уведомление.',
          category: 'services',
          level: 'info',
          time: this.now()
        };
        this.enqueue(e, settings, device.id);
      }
    }
    const active = Object.values(this.state.conditions).filter((c) => c.announced).length;
    this.rules.daily(
      settings.dailyTime,
      true,
      `Сервер ${os.hostname().slice(0, 64)}. CPU: ${data.cpu?.percent ?? '—'}%. RAM: ${data.memory?.percent ?? '—'}%. Службы: ${Object.entries(this.state.conditions).some(([k, c]) => c.announced && (k.startsWith('service.') || k.startsWith('container.'))) ? 'есть предупреждения' : 'без выявленных сбоев'}. Последнее обслуживание: ${this.state.lastUpdate ?? 'нет данных'}. Нерешённых предупреждений: ${active}. Диски: ${data.disks
        .slice(0, 4)
        .map((d) => d.mount.slice(0, 32) + ' ' + d.percent + '%')
        .join(', ')}${data.disks.length > 4 ? '…' : ''}.`
    );
    for (const e of this.rules.take()) this.enqueue(e, settings);
    if (!this.checkFailed) this.state.checkedAt = this.now();
    this.save();
  }
}
export async function runSignal() {
  prepareSignal();
  await withLock(
    '/run/lock/nexus404-signal.lock',
    async () => {
      const signal = new Signal();
      let running = true;
      for (const name of ['SIGINT', 'SIGTERM'])
        process.on(name, () => {
          running = false;
        });
      const sender = setInterval(
        () => signal.drain().catch(() => console.error('Push delivery error')),
        3000
      );
      try {
        while (running) {
          try {
            await signal.tick();
          } catch {
            console.error('Signal check failed');
          }
          for (let i = 0; i < 25 && running; i++) await sleep(200);
        }
      } finally {
        clearInterval(sender);
        while (signal.busy) await sleep(100);
        signal.save();
      }
    },
    true
  );
}
if (direct(import.meta.url))
  runSignal().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
