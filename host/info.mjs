import fs from 'node:fs';
import os from 'node:os';
import {BASE, HUB, CADDY, STATE, ROOT, read, query, clean} from './common.mjs';
import {Collector} from './metrics.mjs';
import {cronSchedule} from './maintenance.mjs';
export function serverInfo() {
  const rows = [];
  const field = (label, value) => rows.push(label + ': ' + (clean(value) || 'не настроено'));
  const command = (c, args) => query(c, args).text;
  const status = (unit) =>
    query('systemctl', ['is-active', '--quiet', unit]).ok
      ? 'работает'
      : 'не активна или не установлена';
  field('Версия', JSON.parse(read(ROOT + '/02-hub/package.json')).version);
  field('Сводка', new Date().toISOString());
  field('Сервер', os.hostname());
  field('Система', read('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1]);
  field(
    'Базовая настройка',
    fs.existsSync(BASE + '/installed.flag') ? 'завершена' : 'не завершена'
  );
  rows.push('\nПОДКЛЮЧЕНИЕ');
  const user = read(BASE + '/sudo_user'),
    port = read(BASE + '/ssh_port'),
    ips = Object.entries(os.networkInterfaces())
      .filter(([name]) => !/^(lo|docker|br-|veth)/.test(name))
      .flatMap(([, v]) => v.filter((a) => !a.internal).map((a) => a.address));
  field('Пользователь sudo', user);
  field('SSH-порт', port);
  field('SSH-вход', read(BASE + '/auth_method'));
  field('Разрешённые пользователи SSH', read(BASE + '/ssh_users'));
  field('Адреса', ips.join(', '));
  const address = process.env.SSH_CONNECTION?.split(' ')[2] || ips[0];
  if (/^[a-z_][a-z0-9_-]*$/.test(user) && /^\d+$/.test(port) && address)
    rows.push('Команда SSH:', `ssh -p ${port} ${user}@${address}`);
  field('Отпечаток ED25519', command('ssh-keygen', ['-lf', '/etc/ssh/ssh_host_ed25519_key.pub']));
  rows.push('\nDOCKER И CADDY');
  field('Docker', command('docker', ['version', '--format', '{{.Server.Version}}']));
  field('Служба Docker', status('docker'));
  const domain = read(CADDY + '/domain');
  if (/^[A-Za-z0-9.-]+$/.test(domain)) rows.push('Сайт:', 'https://' + domain);
  const upstream = read(CADDY + '/upstream');
  field(
    'Направление Caddy',
    /^https?:\/\/[A-Za-z0-9_.:\[\]-]+$/.test(upstream)
      ? upstream
      : upstream
        ? 'адрес скрыт'
        : 'тестовая страница'
  );
  field('Последняя проверка HTTPS', read(CADDY + '/https_status'));
  field('Время проверки', read(CADDY + '/https_checked_at'));
  field('Последнее применение', read(CADDY + '/apply_status'));
  field(
    'Контейнеры проекта',
    command('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project=nexus404',
      '--format',
      '{{.Names}} | {{.Status}} | {{.Ports}}'
    ])
  );
  rows.push('\nХАБ И МОДУЛИ');
  field('Логин хаба', read(STATE + '/username'));
  const hd = read(STATE + '/domain');
  if (/^[A-Za-z0-9.-]+$/.test(hd)) rows.push('Вход:', 'https://' + hd);
  field(
    'Контейнер хаба',
    command('docker', [
      'ps',
      '--filter',
      'label=com.docker.compose.project=nexus404-shell',
      '--format',
      '{{.Names}} | {{.Status}}'
    ])
  );
  field('Модули', HUB + '/modules');
  for (const id of ['pulse', 'signal', 'balance', 'chat'])
    if (fs.existsSync(STATE + '/' + id + '-installed')) {
      field(
        {pulse: 'Пульс', signal: 'Сигнал', balance: 'Баланс', chat: 'Чат'}[id],
        ['balance', 'chat'].includes(id) ? 'в составе хаба' : status('nexus404-' + id)
      );
      if (/^[A-Za-z0-9.-]+$/.test(hd)) rows.push('https://' + hd + '/modules/' + id + '/');
    }
  rows.push('\nСИСТЕМА И ОБСЛУЖИВАНИЕ');
  const m = new Collector().sample();
  field(
    'RAM · всего / доступно, МиБ',
    m.memory
      ? `${Math.round(m.memory.total / 2 ** 20)} / ${Math.round(m.memory.available / 2 ** 20)}`
      : ''
  );
  field('Swap, МиБ', m.swap ? Math.round(m.swap.total / 2 ** 20) : '');
  for (const d of m.disks) field('Диск ' + d.mount + ' · занято', d.percent + '%');
  field('Таймзона', command('timedatectl', ['show', '-p', 'Timezone', '--value']));
  field('NTP', command('timedatectl', ['show', '-p', 'NTPSynchronized', '--value']));
  field('BBR / TCP', command('sysctl', ['-n', 'net.ipv4.tcp_congestion_control']));
  field(
    'DNS',
    command('resolvectl', ['dns']) ||
      read('/etc/resolv.conf')
        .split('\n')
        .filter((r) => r.startsWith('nameserver '))
        .join(', ')
  );
  const reboot = cronSchedule('/etc/cron.d/deploy_kit_weekly_reboot');
  field(
    'Перезагрузка',
    reboot ? `${['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'][+reboot.day]}, ${reboot.time}` : ''
  );
  field('Проверка', cronSchedule('/etc/cron.d/deploy_kit_healthcheck')?.time);
  for (const unit of [
    'nexus404-post-reboot-cleanup.timer',
    'nexus404-security-check.timer',
    'nexus404-logrotate.timer',
    'apt-daily-upgrade.timer',
    'ssh.service',
    'fail2ban.service',
    'auditd.service'
  ])
    field(unit, status(unit));
  field(
    'Security-обновления',
    command('apt-config', ['shell', 'ENABLED', 'APT::Periodic::Unattended-Upgrade'])
  );
  field(
    'Рестарт после обновлений',
    cronSchedule('/etc/cron.d/nexus404_security_reboot')
      ? '02:00, если требуется; во время установки откладывается'
      : ''
  );
  field(
    'Лимит открытых файлов',
    command('systemctl', ['show', '-p', 'DefaultLimitNOFILE', '--value'])
  );
  field(
    'Пароль root',
    command('passwd', ['-S', 'root']).split(/\s+/)[1] === 'L' ? 'заблокирован' : 'проверь состояние'
  );
  field('Очистка ожидает', fs.existsSync(BASE + '/cleanup-after-reboot') ? 'да' : 'нет');
  field('UFW', command('ufw', ['status']));
  field('AppArmor', command('aa-status', ['--enabled']) || status('apparmor'));
  field('Git', command('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']) || 'ZIP-копия');
  rows.push('\nПУТИ И КОМАНДЫ');
  field('Caddyfile', '/opt/nexus404/caddy/Caddyfile');
  field('Данные хаба', HUB);
  field('Логи базы', BASE);
  field('Логи хаба и модулей', STATE);
  rows.push(
    'Диагностика:',
    'sudo nexus404-security-check',
    'Порты:',
    'sudo nexus404-security-check --ports',
    'Сигнал:',
    'sudo journalctl -u nexus404-signal.service -n 50 --no-pager'
  );
  return rows.join('\n') + '\n';
}
