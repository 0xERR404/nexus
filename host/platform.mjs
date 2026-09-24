import fs from 'node:fs';
import {isIP} from 'node:net';
import {
  ROOT,
  HUB,
  STATE,
  CADDY,
  read,
  atomic,
  json,
  saveJSON,
  query,
  exec,
  apt,
  installHost,
  supported,
  sleep,
  event
} from './common.mjs';
import {passwordHash, validateAuth} from '../02-hub/src/auth.mjs';
import {validateManifest} from '../02-hub/src/modules.mjs';
import {migrate} from './maintenance.mjs';
const APP = '/opt/nexus404';
export function validDomain(v) {
  return (
    typeof v === 'string' &&
    v.length <= 253 &&
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(v)
  );
}
export function validUpstream(v) {
  if (!v) return true;
  if (!/^[A-Za-z0-9.:/\[\]_-]+$/.test(v)) return false;
  try {
    const u = new URL(v);
    if (
      !['http:', 'https:'].includes(u.protocol) ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      v.endsWith('/') ||
      !u.hostname ||
      (u.port && Number(u.port) < 1)
    )
      return false;
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (h.includes(':')) return isIP(h) === 6;
    return h.split('.').every((s) => /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i.test(s));
  } catch {
    return false;
  }
}
export function renderCaddy(domain, upstream) {
  if (!validDomain(domain) || !validUpstream(upstream))
    throw new Error('Некорректный домен или адрес сервиса');
  return `${domain} {\n    ${upstream ? 'reverse_proxy ' + upstream : 'respond "NEXUS404: Caddy ready" 200'}\n    encode gzip\n    header Strict-Transport-Security "max-age=604800"\n    log {\n        output file /data/access.log {\n            roll_size 10mb\n            roll_keep 5\n        }\n    }\n}\n`;
}
export function preflight(domain, run = query) {
  const expected = new Set(['tcp:80', 'tcp:443', 'udp:443']),
    owned = new Set(),
    lines = [],
    errors = [];
  const ids = run('docker', ['ps', '-q']);
  if (!ids.ok) throw new Error('Docker недоступен');
  for (const id of ids.text.split(/\s+/).filter(Boolean)) {
    try {
      const r = run('docker', ['inspect', id]);
      if (!r.ok) throw new Error();
      const c = JSON.parse(r.text)[0],
        labels = c.Config?.Labels ?? {},
        ours =
          labels['com.docker.compose.project'] === 'nexus404' &&
          labels['com.docker.compose.service'] === 'caddy';
      for (const [target, bindings] of Object.entries(c.NetworkSettings?.Ports ?? {}))
        for (const b of bindings ?? []) {
          const key = target.split('/')[1] + ':' + b.HostPort;
          if (!expected.has(key)) continue;
          if (ours) owned.add(key);
          else errors.push(`${key}: занят другим контейнером`);
        }
    } catch {
      errors.push('Не удалось проверить контейнер ' + id);
    }
  }
  for (const key of expected) {
    const [proto, port] = key.split(':'),
      r = run('ss', ['-H', proto === 'tcp' ? '-ltn' : '-lun', 'sport = :' + port]);
    if (!r.ok || (r.text && !owned.has(key))) errors.push(key + ': занят или недоступен');
    else lines.push('[✓] ' + key + ': ' + (owned.has(key) ? 'текущий Caddy' : 'свободен'));
  }
  const dns = run('getent', ['ahosts', domain]);
  lines.push(
    dns.ok
      ? '[*] DNS: ' + [...new Set(dns.text.split('\n').map((r) => r.split(/\s+/)[0]))].join(', ')
      : '[?] DNS пока не отвечает. HTTPS потребует корректного DNS.'
  );
  if (errors.length) throw new Error(errors.join('\n'));
  return lines;
}
export const composeArgs = (project, dir, args) => [
  'compose',
  '-p',
  project,
  '-f',
  dir + '/docker-compose.yml',
  ...(fs.existsSync(dir + '/docker-compose.override.yml')
    ? ['-f', dir + '/docker-compose.override.yml']
    : []),
  ...args
];
export async function caddyApply(ui, domain, upstream) {
  fs.mkdirSync(CADDY, {recursive: true, mode: 0o700});
  atomic(CADDY + '/apply_status', 'applying');
  try {
    if (!query('docker', ['network', 'inspect', 'nexus404']).ok)
      await ui.run('Сеть nexus404', 'docker', ['network', 'create', 'nexus404']);
    for (const dir of ['data', 'config']) fs.mkdirSync(APP + '/caddy/' + dir, {recursive: true});
    for (const line of preflight(domain)) ui.line(line);
    const stage = fs.mkdtempSync(APP + '/.caddy.');
    try {
      fs.mkdirSync(stage + '/caddy');
      fs.copyFileSync(ROOT + '/01-caddy-docker/docker-compose.yml', stage + '/docker-compose.yml');
      atomic(stage + '/caddy/Caddyfile', renderCaddy(domain, upstream), 0o644);
      await ui.run('Образ Caddy', 'docker', ['pull', 'caddy:2-alpine']);
      await ui.run('Проверка Compose', 'docker', [
        'compose',
        '-p',
        'nexus404',
        '-f',
        stage + '/docker-compose.yml',
        'config',
        '--quiet'
      ]);
      await ui.run('Проверка Caddyfile', 'docker', [
        'run',
        '--rm',
        '-v',
        stage + '/caddy/Caddyfile:/etc/caddy/Caddyfile:ro',
        'caddy:2-alpine',
        'caddy',
        'validate',
        '--config',
        '/etc/caddy/Caddyfile',
        '--adapter',
        'caddyfile'
      ]);
      fs.copyFileSync(stage + '/docker-compose.yml', APP + '/docker-compose.yml');
      fs.writeFileSync(APP + '/caddy/Caddyfile', fs.readFileSync(stage + '/caddy/Caddyfile'));
      fs.chmodSync(APP + '/caddy/Caddyfile', 0o644);
    } finally {
      fs.rmSync(stage, {recursive: true, force: true});
    }
    if (query('ufw', ['status']).text.includes('Status: active'))
      for (const port of ['80/tcp', '443/tcp', '443/udp'])
        await ui.run('Firewall ' + port, 'ufw', ['allow', port]);
    await ui.run(
      'Запуск Caddy',
      'docker',
      composeArgs('nexus404', APP, ['up', '-d', '--no-deps', '--force-recreate', 'caddy'])
    );
    await ui.run(
      'Процесс Caddy',
      'docker',
      composeArgs('nexus404', APP, ['exec', '-T', 'caddy', 'caddy', 'version'])
    );
    let verified = false;
    await ui.task('Проверка HTTPS', async () => {
      for (let i = 0; i < 12; i++) {
        const r = query('curl', [
          '--noproxy',
          '*',
          '--silent',
          '--connect-timeout',
          '2',
          '--max-time',
          '4',
          '--resolve',
          domain + ':443:127.0.0.1',
          '--output',
          '/dev/null',
          '--write-out',
          '%{http_code}',
          'https://' + domain + '/'
        ]);
        if (r.ok && /^[234]\d\d$/.test(r.text)) {
          verified = true;
          break;
        }
        await sleep(1000);
      }
    });
    for (const [key, value] of Object.entries({
      domain,
      upstream,
      https_status: verified ? 'verified' : 'pending',
      https_checked_at: new Date().toISOString(),
      installed_at: new Date().toISOString(),
      apply_status: 'applied'
    }))
      atomic(CADDY + '/' + key, value + '\n');
    ui.line(
      verified
        ? '[✓] HTTPS подтверждён'
        : '[?] HTTPS пока не подтверждён. Проверь DNS и firewall провайдера.'
    );
    ui.line('Адрес: https://' + domain);
  } catch (e) {
    atomic(CADDY + '/apply_status', 'failed');
    event('system.update.failed', 'Caddy: ' + e.message);
    throw e;
  }
}
export async function installCaddy(ui, update = false) {
  const os = supported();
  if (!update) {
    await apt(ui, 'Список пакетов', 'update');
    await apt(ui, 'Инструменты', 'install', '-y', 'ca-certificates', 'curl', 'iproute2');
    if (!query('docker', ['version']).ok || !query('docker', ['compose', 'version']).ok) {
      if (
        query('docker', ['--version']).ok &&
        !fs.existsSync('/etc/apt/sources.list.d/docker.list')
      )
        throw new Error('Найдена другая установка Docker. Проверь её перед заменой.');
      fs.mkdirSync('/etc/apt/keyrings', {recursive: true, mode: 0o755});
      fs.chmodSync('/etc/apt/keyrings', 0o755);
      await ui.run('Ключ Docker', 'curl', [
        '-fsSL',
        '--retry',
        '3',
        `https://download.docker.com/linux/${os.ID}/gpg`,
        '-o',
        '/etc/apt/keyrings/docker.asc'
      ]);
      fs.chmodSync('/etc/apt/keyrings/docker.asc', 0o644);
      const arch = query('dpkg', ['--print-architecture']).text;
      if (
        !/^(amd64|arm64|armhf|ppc64el|s390x)$/.test(arch) ||
        !/^[a-z]+$/.test(os.VERSION_CODENAME)
      )
        throw new Error('Неизвестная платформа Docker');
      atomic(
        '/etc/apt/sources.list.d/docker.list',
        `deb [arch=${arch} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${os.ID} ${os.VERSION_CODENAME} stable\n`,
        0o644
      );
      await apt(ui, 'Пакеты Docker', 'update');
      await apt(
        ui,
        'Docker и Compose',
        'install',
        '-y',
        'docker-ce',
        'docker-ce-cli',
        'containerd.io',
        'docker-buildx-plugin',
        'docker-compose-plugin'
      );
    }
    await ui.run('Автозапуск Docker', 'systemctl', ['enable', '--now', 'docker']);
  }
  let domain = read(CADDY + '/domain'),
    upstream = read(CADDY + '/upstream');
  if (!update) {
    domain =
      process.env.PRESET_DOMAIN ||
      (await ui.prompt('Домен · Enter: ' + (domain || 'не выбран'))) ||
      domain;
    domain = (await ui.ask('Домен · server.example.com', validDomain, domain)).toLowerCase();
    upstream =
      process.env.PRESET_UPSTREAM ??
      ((await ui.prompt('Адрес сервиса · Enter: сохранить · 0: тестовая страница')) || upstream);
    if (upstream === '0') upstream = '';
    upstream = await ui.ask('http(s)://хост:порт', validUpstream, upstream);
  } else if (!validDomain(domain) || !fs.existsSync(CADDY + '/upstream'))
    throw new Error('Сначала настрой Caddy через пункт 2');
  await caddyApply(ui, domain, upstream);
  if (upstream === 'http://nexus404-hub:3000') await updateHubOrigin(ui, domain);
}
async function password(ui) {
  let value = process.env.PRESET_HUB_PASSWORD ?? '';
  while (true) {
    if (
      Array.from(value).length < 12 ||
      Buffer.byteLength(value) > 1024 ||
      /[\r\n\0]/.test(value)
    ) {
      value = await ui.prompt('Пароль хаба · от 12 символов, до 1024 байт', true);
      continue;
    }
    if (
      process.env.PRESET_HUB_PASSWORD === value ||
      value === (await ui.prompt('Повтори пароль', true))
    ) {
      delete process.env.PRESET_HUB_PASSWORD;
      return value;
    }
    value = '';
  }
}
export async function installHub(ui, update = false, maintenance = true) {
  supported();
  const domain = read(CADDY + '/domain');
  if (!validDomain(domain)) throw new Error('Сначала настрой Caddy через пункт 2');
  if (update && !fs.existsSync(HUB + '/config/auth.json')) throw new Error('Хаб ещё не установлен');
  installHost();
  ui.section('01 / 04 · Образ хаба');
  await ui.run('Сборка хаба', 'docker', [
    'build',
    '--pull',
    '-t',
    'nexus404-shell:local',
    ROOT + '/02-hub'
  ]);
  for (const name of ['config', 'data', 'modules'])
    fs.mkdirSync(HUB + '/' + name, {recursive: true});
  fs.chmodSync(HUB + '/config', 0o750);
  fs.chownSync(HUB + '/config', 0, 1000);
  fs.chmodSync(HUB + '/data', 0o700);
  fs.chownSync(HUB + '/data', 1000, 1000);
  fs.chmodSync(HUB + '/modules', 0o755);
  ui.section('02 / 04 · Вход');
  const file = HUB + '/config/auth.json';
  let config = json(file);
  if (!config || process.env.PRESET_HUB_PASSWORD) {
    const username = await ui.ask(
      'Логин хаба',
      (v) => /^[A-Za-z0-9_.@-]{1,64}$/.test(v),
      process.env.PRESET_HUB_USER ?? config?.username ?? ''
    );
    const pass = await password(ui);
    config = {username, origin: 'https://' + domain, ...(await passwordHash(pass))};
  } else config.origin = 'https://' + domain;
  writeAuth(file, config);
  fs.copyFileSync(ROOT + '/02-hub/docker-compose.yml', HUB + '/docker-compose.yml');
  ui.section('03 / 04 · Запуск');
  await restartHub(ui);
  ui.section('04 / 04 · HTTPS');
  await caddyApply(ui, domain, 'http://nexus404-hub:3000');
  for (const [key, value] of Object.entries({
    username: config.username,
    domain,
    installed_at: new Date().toISOString()
  }))
    atomic(STATE + '/' + key, value + '\n');
  if (maintenance) await migrate(ui);
  event('system.update.completed', 'Хаб обновлён');
}
export function writeAuth(file, config) {
  validateAuth(config);
  saveJSON(file, config, 0o640);
  fs.chownSync(file, 0, 1000);
}
export async function updateHubOrigin(
  ui,
  domain,
  {hub = HUB, state = STATE, write = writeAuth, restart = restartHub} = {}
) {
  const file = hub + '/config/auth.json',
    config = json(file);
  if (!config || (config.origin === 'https://' + domain && read(state + '/domain') === domain))
    return;
  if (!validDomain(domain)) throw new Error('Некорректный домен');
  write(file, {...config, origin: 'https://' + domain});
  await restart(ui, hub);
  atomic(state + '/domain', domain + '\n');
}
export async function restartHub(ui, directory = HUB) {
  await ui.run(
    'Проверка Compose',
    'docker',
    composeArgs('nexus404-shell', directory, ['config', '--quiet'])
  );
  await ui.run(
    'Запуск хаба',
    'docker',
    composeArgs('nexus404-shell', directory, ['up', '-d', '--no-build', '--force-recreate', 'hub'])
  );
  await waitHub(ui, directory);
}
export async function waitHub(ui, directory = HUB) {
  await ui.task('Готовность хаба', async () => {
    for (let i = 0; i < 30; i++) {
      const r = query(
        'docker',
        composeArgs('nexus404-shell', directory, [
          'exec',
          '-T',
          'hub',
          'node',
          '-e',
          "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ])
      );
      if (r.ok) return;
      await sleep(1000);
    }
    throw new Error('Хаб не ответил');
  });
}
export function moduleFiles(
  id,
  {root = ROOT, hub = HUB, state = STATE, copy = fs.copyFileSync} = {}
) {
  if (!/^(pulse|signal|balance|chat)$/.test(id)) throw new Error('Неизвестный модуль');
  const source = root + '/02-hub/modules/' + id,
    target = hub + '/modules/' + id,
    marker = state + '/' + id + '-installed';
  if (fs.existsSync(target) && !fs.existsSync(marker))
    throw new Error('Каталог модуля занят: ' + id);
  const manifest = json(target + '/manifest.json') ?? json(source + '/manifest.json');
  validateManifest(manifest);
  fs.mkdirSync(hub + '/modules', {recursive: true, mode: 0o755});
  const work = fs.mkdtempSync(hub + '/modules/.' + id + '-update-'),
    staged = work + '/new',
    previous = work + '/old';
  let activated = false;
  try {
    fs.mkdirSync(staged, {mode: 0o755});
    for (const file of fs.readdirSync(source, {withFileTypes: true})) {
      if (!file.isFile()) throw new Error('Ожидался файл модуля: ' + file.name);
      if (file.name === 'manifest.json') continue;
      copy(source + '/' + file.name, staged + '/' + file.name);
      fs.chmodSync(staged + '/' + file.name, 0o644);
    }
    saveJSON(staged + '/manifest.json', manifest, 0o644);
    fs.chmodSync(staged, 0o755);
    if (fs.existsSync(target)) fs.renameSync(target, previous);
    fs.renameSync(staged, target);
    activated = true;
    atomic(marker, new Date().toISOString());
  } catch (error) {
    try {
      if (activated) fs.rmSync(target, {recursive: true});
      if (fs.existsSync(previous)) fs.renameSync(previous, target);
    } catch (rollback) {
      throw new AggregateError([error, rollback], 'Не удалось вернуть модуль. Копия: ' + work);
    }
    throw error;
  } finally {
    if (!fs.existsSync(previous)) fs.rmSync(work, {recursive: true, force: true});
  }
  fs.rmSync(work, {recursive: true, force: true});
}
export function moduleOverride(extra) {
  const render = (pulse, signal) =>
    '# NEXUS404 modules · managed override\nservices:\n  hub:\n    environment:\n' +
    (pulse ? '      PULSE_FILE: /app/metrics/pulse.json\n' : '') +
    (signal
      ? '      SIGNAL_FEED: /app/signal/feed.json\n      SIGNAL_PUBLIC: /app/signal/public.json\n'
      : '') +
    '    volumes:\n' +
    (pulse ? '      - /var/lib/nexus404-metrics:/app/metrics:ro\n' : '') +
    (signal ? '      - /var/lib/nexus404-signal/public:/app/signal:ro\n' : '');
  const old = read(HUB + '/docker-compose.override.yml');
  const allowed = [
    read(ROOT + '/03-modules/pulse/docker-compose.override.yml'),
    render(true, false),
    render(false, true),
    render(true, true)
  ].map((v) => v.trim());
  if (old && !allowed.includes(old.trim()))
    throw new Error('Compose override изменён вручную. Рабочий файл сохранён.');
  for (const other of [
    'docker-compose.override.yaml',
    'compose.override.yml',
    'compose.override.yaml'
  ])
    if (fs.existsSync(HUB + '/' + other)) throw new Error('Найден другой Compose override');
  return render(
    extra === 'pulse' || fs.existsSync(STATE + '/pulse-installed'),
    extra === 'signal' || fs.existsSync(STATE + '/signal-installed')
  );
}

export async function installModule(ui, id, maintenance = true) {
  supported();
  if (!fs.existsSync(HUB + '/config/auth.json'))
    throw new Error('Сначала установи хаб через пункт 5');
  if (!['pulse', 'signal', 'balance', 'chat'].includes(id)) throw new Error('Неизвестный модуль');
  const embedded = ['balance', 'chat'].includes(id);
  const override = embedded ? null : moduleOverride(id);
  const installed = query(
    'docker',
    composeArgs('nexus404-shell', HUB, [
      'exec',
      '-T',
      'hub',
      'node',
      '-p',
      "require('/app/package.json').version"
    ])
  );
  if (!installed.ok || installed.text !== json(ROOT + '/02-hub/package.json').version)
    await installHub(ui, true, false);
  installHost();
  if (id === 'pulse') {
    if (!query('id', ['nexus404-metrics']).ok)
      await ui.run('Пользователь сборщика', 'useradd', [
        '--system',
        '--user-group',
        '--no-create-home',
        '--home-dir',
        '/nonexistent',
        '--shell',
        '/usr/sbin/nologin',
        'nexus404-metrics'
      ]);
    if (query('id', ['-u', 'nexus404-metrics']).text === '0')
      throw new Error('Сборщик не должен работать от root');
    fs.mkdirSync('/var/lib/nexus404-metrics', {recursive: true, mode: 0o755});
    fs.chmodSync('/var/lib/nexus404-metrics', 0o755);
    await exec('chown', ['nexus404-metrics:nexus404-metrics', '/var/lib/nexus404-metrics']);
    fs.copyFileSync(
      ROOT + '/03-modules/pulse/nexus404-pulse.service',
      '/etc/systemd/system/nexus404-pulse.service'
    );
    fs.rmSync('/usr/local/lib/nexus404/pulse.py', {force: true});
  } else if (id === 'signal') {
    const {prepareSignal} = await import('./signal.mjs');
    prepareSignal();
    fs.copyFileSync(
      ROOT + '/03-modules/signal/nexus404-signal.service',
      '/etc/systemd/system/nexus404-signal.service'
    );
  }
  moduleFiles(id);
  if (override !== null) atomic(HUB + '/docker-compose.override.yml', override, 0o644);
  await ui.run(
    'Проверка Compose',
    'docker',
    composeArgs('nexus404-shell', HUB, ['config', '--quiet'])
  );
  if (!embedded) {
    await ui.run('Обновление systemd', 'systemctl', ['daemon-reload']);
    await ui.run('Автозапуск ' + id, 'systemctl', ['enable', 'nexus404-' + id + '.service']);
    await ui.run('Запуск ' + id, 'systemctl', ['restart', 'nexus404-' + id + '.service']);
  }
  await restartHub(ui);
  await waitModule(ui, id);
  if (maintenance) await migrate(ui);
  ui.line(
    '[✓] Модуль ' +
      {pulse: '«Пульс»', signal: '«Сигнал»', balance: '«Баланс»', chat: '«Чат»'}[id] +
      ' установлен'
  );
  event('system.update.completed', 'Модуль ' + id + ' обновлён');
}

export async function waitModule(ui, id) {
  const embedded = ['balance', 'chat'].includes(id);
  const file = id === 'pulse' ? '/app/metrics/pulse.json' : '/app/signal/feed.json';
  const code = embedded
    ? `import('/app/modules/${id}/index.mjs').then(async m=>{await m.summary();process.exit(0)}).catch(()=>process.exit(1))`
    : `const fs=require('node:fs');try{const d=JSON.parse(fs.readFileSync(${JSON.stringify(file)},'utf8'));const t=d.generated_at??d.updatedAt;const age=Date.now()-t;process.exit(Number.isFinite(t)&&age>=-10000&&age<${id === 'pulse' ? 20000 : 90000}?0:1);}catch{process.exit(1);}`;
  await ui.task(
    embedded ? 'Хранилище модуля доступно' : 'Показатели модуля доступны хабу',
    async () => {
      for (let i = 0; i < 30; i++) {
        if (
          query(
            'docker',
            composeArgs('nexus404-shell', HUB, ['exec', '-T', 'hub', 'node', '-e', code])
          ).ok
        )
          return;
        await sleep(1000);
      }
      throw new Error(
        embedded
          ? 'Хранилище модуля недоступно. Проверь журнал хаба и права data.'
          : 'Нет свежих данных модуля. Проверь службу и права каталога.'
      );
    }
  );
}
