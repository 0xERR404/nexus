import fs from 'node:fs';
import {BASE, read, query, direct, requireRoot, clean, event} from './common.mjs';
import {parseSSH} from './ssh.mjs';
export const loopback = (value) =>
  /^(127\.|::1$|::ffff:127\.)/i.test(value.replace(/^\[|\]$/g, '').split('%')[0]);
export function portFindings(
  run = query,
  saved = (name) => read(BASE + '/' + name),
  hasCaddy = fs.existsSync('/opt/nexus404/docker-compose.yml')
) {
  const list = [];
  const add = (key, title, bad, detail = '') =>
    list.push({key, title, level: bad ? 'warning' : 'ok', detail});
  const expected = new Set([
    'tcp:' + (saved('ssh_port') || '22'),
    ...(hasCaddy ? ['tcp:80', 'tcp:443', 'udp:443'] : [])
  ]);
  for (const family of ['4', '6']) {
    const r = run('ss', ['-H', '-lntup', '-' + family]);
    add('ports.read.' + family, 'Список портов IPv' + family, !r.ok);
    for (const row of r.text.split('\n').filter(Boolean)) {
      const p = row.trim().split(/\s+/);
      if (p.length < 5) {
        add('ports.parse', 'Не удалось разобрать слушатель', true);
        continue;
      }
      const endpoint = p[4],
        i = endpoint.lastIndexOf(':'),
        address = endpoint.slice(0, i),
        port = endpoint.slice(i + 1);
      if (loopback(address)) continue;
      add(
        `port.${p[0]}.${address}.${port}`,
        `Порт ${port}/${p[0]} на ${address}`,
        !expected.has(p[0] + ':' + port)
      );
    }
  }
  const firewall = run('ufw', ['status']);
  add('security.ufw', 'Firewall UFW', !firewall.ok || !firewall.text.includes('Status: active'));
  add(
    'security.ufw.ipv6',
    'Защита UFW для IPv6',
    read('/proc/sys/net/ipv6/conf/all/disable_ipv6') === '0' &&
      !/^IPV6=['"]?yes['"]?$/m.test(read('/etc/default/ufw'))
  );
  const ids = run('docker', ['ps', '-q']);
  if (!ids.ok) {
    if (hasCaddy) add('docker.inspect', 'Docker недоступен', true);
    return list;
  }
  for (const id of ids.text.split(/\s+/).filter(Boolean)) {
    const r = run('docker', ['inspect', id]);
    try {
      if (!r.ok) throw new Error();
      const c = JSON.parse(r.text)[0],
        name = c.Name?.replace(/^\//, '') || id;
      if (c.HostConfig?.NetworkMode === 'host')
        add('docker.host.' + name, 'Контейнер использует сеть хоста: ' + name, true);
      for (const [target, bindings] of Object.entries(c.NetworkSettings?.Ports ?? {})) {
        const proto = target.split('/')[1];
        for (const b of bindings ?? []) {
          add(
            `docker.port.${name}.${b.HostPort}.${proto}`,
            `${name}: ${b.HostIp}:${b.HostPort} → ${target}`,
            !loopback(b.HostIp) && !expected.has(proto + ':' + b.HostPort)
          );
        }
      }
      const l = c.HostConfig?.LogConfig ?? {};
      if (l.Type === 'json-file' && !/^[1-9]\d*[kmg]?$/i.test(l.Config?.['max-size'] ?? ''))
        add('docker.logs.' + name, 'Не ограничен журнал ' + name, true);
    } catch {
      add('docker.inspect.' + id, 'Не удалось проверить контейнер', true);
    }
  }
  return list;
}
export function protection(run = query, saved = (name) => read(BASE + '/' + name), full = true) {
  const rows = [];
  const check = (key, title, ok) => rows.push({key, title, level: ok ? 'ok' : 'error'});
  const user = saved('sudo_user'),
    port = saved('ssh_port'),
    auth = saved('auth_method'),
    allowed = saved('ssh_users').split(/\s+/).filter(Boolean);
  check(
    'security.config',
    'Сохранены настройки SSH',
    Boolean(user && port && ['key', 'password'].includes(auth) && allowed.includes(user))
  );
  check('security.sudo', 'Права sudo', run('id', ['-nG', user]).text.split(/\s+/).includes('sudo'));
  const passwd = run('passwd', ['-S', 'root']);
  check(
    'security.root',
    'Пароль root заблокирован',
    passwd.ok && passwd.text.split(/\s+/)[1] === 'L'
  );
  check('security.ssh.valid', 'Конфигурация SSH', run('sshd', ['-t']).ok);
  const u = run('ufw', ['status']);
  check('security.ufw', 'Правила UFW включены', u.ok && u.text.includes('Status: active'));
  for (const service of ['ssh', 'ufw', 'fail2ban', 'auditd', 'cron'])
    check(
      'service.' + service,
      service + ' работает',
      run('systemctl', ['is-active', '--quiet', service]).ok ||
        (service === 'ssh' && run('systemctl', ['is-active', '--quiet', 'sshd']).ok)
    );
  check('security.fail2ban', 'SSH jail активен', run('fail2ban-client', ['status', 'sshd']).ok);
  check('security.apparmor', 'AppArmor активен', run('aa-status', ['--enabled']).ok);
  for (const timer of [
    'apt-daily',
    'apt-daily-upgrade',
    'nexus404-post-reboot-cleanup',
    'nexus404-logrotate',
    'nexus404-security-check'
  ])
    check(
      'timer.' + timer,
      timer + '.timer',
      run('systemctl', ['is-active', '--quiet', timer + '.timer']).ok &&
        run('systemctl', ['is-enabled', '--quiet', timer + '.timer']).ok
    );
  const listen = run('ss', ['-H', '-ltn', 'sport = :' + port]);
  check('security.ssh.listener', 'SSH слушает ' + port, listen.ok && Boolean(listen.text));
  const accountResult = run('getent', ['passwd']);
  if (full)
    check(
      'security.accounts',
      'Список пользователей доступен',
      accountResult.ok && Boolean(accountResult.text)
    );
  const names = full
    ? [
        ...new Set([
          ...allowed,
          ...accountResult.text
            .split('\n')
            .map((r) => r.split(':')[0])
            .filter(Boolean),
          'root',
          'nexus404-denied-user'
        ])
      ]
    : [...new Set([...allowed, 'root'])];
  for (const name of names)
    for (const address of new Set(['127.0.0.1', saved('ssh_check_address') || '127.0.0.1'])) {
      const r = run('sshd', ['-T', '-C', `user=${name},host=localhost,addr=${address}`]),
        c = parseSSH(r.text);
      let ok =
        r.ok &&
        allowed.length > 0 &&
        [...new Set(c.allowusers ?? [])].sort().join(' ') === [...allowed].sort().join(' ') &&
        [...new Set(c.port ?? [])].join(' ') === port;
      if (name === 'root') ok &&= c.permitrootlogin?.join(' ') === 'no';
      else if (allowed.includes(name))
        ok &&=
          auth === 'key'
            ? c.pubkeyauthentication?.[0] === 'yes' &&
              c.passwordauthentication?.[0] === 'no' &&
              c.kbdinteractiveauthentication?.[0] === 'no'
            : c.passwordauthentication?.[0] === 'yes';
      check(`security.ssh.${name}.${address}`, `Политика SSH: ${name}, ${address}`, ok);
    }
  const swap = run('swapon', ['--noheadings', '--raw', '--show=NAME']);
  check(
    'system.swap',
    'Сохранённая подкачка активна',
    swap.ok &&
      fs.existsSync(BASE + '/swap_devices') &&
      saved('swap_devices')
        .split('\n')
        .filter(Boolean)
        .every((v) => swap.text.split('\n').includes(v))
  );
  for (const [key, label, cmd, args] of [
    ['congestion_control', 'Алгоритм TCP', 'sysctl', ['-n', 'net.ipv4.tcp_congestion_control']],
    ['timezone', 'Таймзона', 'timedatectl', ['show', '-p', 'Timezone', '--value']]
  ]) {
    const r = run(cmd, args);
    check('system.' + key, label, r.ok && Boolean(saved(key)) && r.text === saved(key));
  }
  rows.push({
    key: 'system.ntp',
    title: 'Синхронизация NTP',
    level:
      run('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']).text === 'yes'
        ? 'ok'
        : 'warning'
  });
  return rows;
}
export function report({portsOnly = false, strict = false, log = false} = {}) {
  requireRoot();
  const rows = [...(portsOnly ? [] : protection()), ...portFindings()];
  const errors = rows.filter((r) => r.level === 'error').length,
    warnings = rows.filter((r) => r.level === 'warning').length;
  const text =
    new Date().toISOString() +
    '\n' +
    rows
      .map((r) => `[${r.level === 'ok' ? '✓' : r.level === 'error' ? '!' : '?'}] ${clean(r.title)}`)
      .join('\n') +
    `\nОшибок: ${errors}; предупреждений: ${warnings}\n`;
  if (log) {
    fs.mkdirSync(BASE, {recursive: true});
    fs.appendFileSync(BASE + '/security.log', text, {mode: 0o600});
  } else process.stdout.write(text);
  event(
    'system.healthcheck.completed',
    `errors=${errors} warnings=${warnings} status=${errors || warnings ? 'warning' : 'ok'}`
  );
  return errors || (strict && warnings) ? 1 : 0;
}
if (direct(import.meta.url))
  try {
    process.exitCode = report({
      portsOnly: process.argv.includes('--ports'),
      strict: process.argv.includes('--strict'),
      log: process.argv.includes('--log')
    });
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
