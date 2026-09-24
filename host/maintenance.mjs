import fs from 'node:fs';
import {
  BASE,
  HOST,
  NODE,
  read,
  atomic,
  query,
  exec,
  event,
  lock,
  direct,
  validTime,
  sleep,
  clean
} from './common.mjs';
import {report} from './security.mjs';
export async function waitForSSHJail(ui, {inspect = query, pause = sleep, now = Date.now} = {}) {
  await ui.task('Проверка SSH jail', async () => {
    const deadline = now() + 30000;
    let result;
    do {
      result = inspect('fail2ban-client', ['status', 'sshd'], {timeout: 2000});
      if (result.ok) return;
      if (now() >= deadline) break;
      await pause(Math.min(1000, deadline - now()));
    } while (now() < deadline);
    const detail = clean(result.error || result.text || 'нет ответа').slice(0, 500);
    if (ui.log) {
      const journal = inspect('journalctl', ['-u', 'fail2ban.service', '-n', '40', '--no-pager'], {
        timeout: 5000
      });
      fs.appendFileSync(ui.log, `Fail2ban: ${detail}\n${journal.text || journal.error}\n`);
    }
    throw new Error(
      'SSH jail не готов за 30 с. ' +
        detail +
        '. Проверь: sudo journalctl -u fail2ban -n 40 --no-pager'
    );
  });
}
const setupLock = '/run/lock/nexus404-setup.lock';
export async function job(
  name,
  {
    base = BASE,
    bootFile = '/proc/sys/kernel/random/boot_id',
    requiredFile = '/var/run/reboot-required',
    acquire = lock,
    run = exec,
    inspect = query,
    emit = event,
    check = report
  } = {}
) {
  if (
    ![
      'health',
      'pre-reboot',
      'reboot',
      'cleanup',
      'pre-security-reboot',
      'security-reboot'
    ].includes(name)
  )
    throw new Error('Неизвестная задача');
  let release;
  try {
    release = await acquire(setupLock, true);
  } catch (e) {
    if (e.code === 'ELOCKED') return;
    throw e;
  }
  try {
    if (!fs.existsSync(base + '/installed.flag')) return;
    if (name.includes('security') && !fs.existsSync(requiredFile)) return;
    if (name.startsWith('pre-')) {
      emit('system.reboot.scheduled', 'Плановая перезагрузка через 5 минут');
      return;
    }
    if (name === 'health') {
      if (check({strict: true, log: true})) throw new Error('Диагностика обнаружила проблемы');
      return;
    }
    const marker = base + '/cleanup-after-reboot',
      boot = read(bootFile),
      previous = read(marker);
    if (!boot) throw new Error('Не удалось определить текущую загрузку');
    if (name.endsWith('reboot')) {
      for (const unit of ['apt-daily.service', 'apt-daily-upgrade.service']) {
        const status = inspect('systemctl', ['show', '-p', 'ActiveState', '--value', unit]);
        if (!status.ok) throw new Error('Не удалось проверить службу обновлений');
        if (!['inactive', 'failed'].includes(status.text)) return;
      }
      if (previous === boot) return;
      atomic(marker, boot + '\n');
      emit('system.reboot.started', 'Начата плановая перезагрузка');
      try {
        await run('/sbin/shutdown', ['-r', 'now']);
      } catch (e) {
        if (previous) atomic(marker, previous + '\n');
        else fs.rmSync(marker, {force: true});
        throw e;
      }
      return;
    }
    if (!previous || previous === boot) return;
    for (const args of [
      ['autoremove', '-y'],
      ['autoclean', '-y']
    ])
      await run('apt-get', ['-o', 'DPkg::Lock::Timeout=120', ...args], {
        log: base + '/cleanup.log'
      });
    await run('journalctl', ['--vacuum-time=7d'], {log: base + '/cleanup.log'});
    emit('system.cleanup.completed', 'Очистка после плановой перезагрузки завершена');
    fs.rmSync(marker, {force: true});
  } finally {
    await release();
  }
}

const unit = (description, command, extra = '') =>
  `[Unit]\nDescription=${description}\n${extra}\n[Service]\nType=oneshot\nExecStart=${command}\n`;
export function installEvents() {
  fs.mkdirSync('/opt/nexus404/hooks/events', {recursive: true, mode: 0o700});
  atomic(
    '/etc/fail2ban/action.d/nexus404-hook.conf',
    `[Definition]\nactionban = ${NODE} ${HOST}/events.mjs security.fail2ban.ban "IP=<ip> jail=<name>"\nactionunban = ${NODE} ${HOST}/events.mjs security.fail2ban.unban "IP=<ip> jail=<name>"\n`,
    0o644
  );
  atomic(
    '/etc/fail2ban/jail.d/99-nexus404-events.local',
    '[sshd]\naction = %(action_)s\n         nexus404-hook\n',
    0o644
  );
  atomic(
    '/etc/systemd/system/nexus404-ssh-events.service',
    `[Unit]\nDescription=NEXUS404 SSH events\nAfter=network.target ssh.service sshd.service\n[Service]\nExecStart=${NODE} ${HOST}/events.mjs --watch-ssh\nRestart=always\nRestartSec=3\n[Install]\nWantedBy=multi-user.target\n`,
    0o644
  );
  atomic(
    '/etc/systemd/system/nexus404-boot-event.service',
    unit(
      'NEXUS404 boot event',
      `${NODE} ${HOST}/events.mjs system.reboot.completed "Сервер загружен"`,
      'After=network.target'
    ) + '[Install]\nWantedBy=multi-user.target\n',
    0o644
  );
  atomic(
    '/etc/systemd/system/nexus404-event-failure@.service',
    unit('NEXUS404 failure event', `${NODE} ${HOST}/events.mjs system.service.failed %i`),
    0o644
  );
  atomic(
    '/etc/systemd/system/apt-daily-upgrade.service.d/90-nexus404-events.conf',
    `[Unit]\nOnFailure=nexus404-event-failure@%n.service\n[Service]\nExecStartPost=-${NODE} ${HOST}/events.mjs system.update.completed "Security maintenance completed"\n`,
    0o644
  );
  for (const f of ['/usr/local/bin/deploy_kit_ssh_events.sh', '/opt/nexus404/hooks/event_hook.sh'])
    fs.rmSync(f, {force: true});
}
export function installLogging() {
  atomic(
    '/etc/systemd/journald.conf.d/90-nexus404.conf',
    '[Journal]\nSystemMaxUse=100M\nRuntimeMaxUse=50M\nSystemKeepFree=256M\nMaxRetentionSec=7day\n',
    0o644
  );
  for (const f of ['/etc/logrotate.d/nexus404-base', '/etc/logrotate.d/nexus404-hooks'])
    fs.rmSync(f, {force: true});
  atomic(
    '/etc/nexus404-logrotate.conf',
    '/var/lib/nexus404-base/*.log /var/lib/nexus404-caddy/*.log /var/lib/nexus404-menu/*.log /var/lib/nexus404-shell/*.log /opt/nexus404/hooks/events/events.jsonl /opt/nexus404/hub-platform/data/auth-events.jsonl {\n daily\n maxsize 10M\n rotate 5\n compress\n missingok\n notifempty\n copytruncate\n su root root\n}\n',
    0o644
  );
  atomic(
    '/etc/systemd/system/nexus404-logrotate.service',
    unit(
      'NEXUS404 log rotation',
      '/usr/sbin/logrotate --state /var/lib/nexus404-base/logrotate.status /etc/nexus404-logrotate.conf'
    ),
    0o644
  );
  atomic(
    '/etc/systemd/system/nexus404-logrotate.timer',
    '[Unit]\nDescription=NEXUS404 hourly log check\n[Timer]\nOnCalendar=hourly\nPersistent=true\nRandomizedDelaySec=5min\n[Install]\nWantedBy=timers.target\n',
    0o644
  );
}
export function cronSchedule(file) {
  const row = read(file)
    .split('\n')
    .find((r) => r.trim() && !r.trimStart().startsWith('#') && r.split(/\s+/).length >= 7);
  if (!row) return null;
  const [minute, hour, date, month, day] = row.trim().split(/\s+/);
  if (date !== '*' || month !== '*') return null;
  return /^\d+$/.test(minute) && /^\d+$/.test(hour) && +minute < 60 && +hour < 24
    ? {time: hour.padStart(2, '0') + ':' + minute.padStart(2, '0'), day}
    : null;
}
export function warnSchedule(time, day) {
  let [h, m] = time.split(':').map(Number),
    minutes = h * 60 + m - 5;
  if (minutes < 0) {
    minutes += 1440;
    if (day !== '*') day = (+day + 6) % 7;
  }
  return `${minutes % 60} ${Math.floor(minutes / 60)} * * ${day}`;
}
export function installSchedules(time, day, health, {write = atomic, remove = fs.rmSync} = {}) {
  if (!validTime(time) || !validTime(health) || !Number.isInteger(day) || day < 0 || day > 6)
    throw new Error('Некорректное расписание');
  write(
    '/etc/apt/apt.conf.d/99-nexus404-reboot',
    'Unattended-Upgrade::Automatic-Reboot "false";\n',
    0o644
  );
  write(
    '/etc/cron.d/nexus404_security_reboot',
    `55 1 * * * root ${NODE} ${HOST}/maintenance.mjs pre-security-reboot\n0 2 * * * root ${NODE} ${HOST}/maintenance.mjs security-reboot\n`,
    0o644
  );
  const [h, m] = time.split(':').map(Number),
    [hh, hm] = health.split(':').map(Number);
  write(
    '/etc/cron.d/deploy_kit_weekly_reboot',
    `${m} ${h} * * ${day} root ${NODE} ${HOST}/maintenance.mjs reboot\n`,
    0o644
  );
  write(
    '/etc/cron.d/nexus404_reboot_notice',
    `${warnSchedule(time, day)} root ${NODE} ${HOST}/maintenance.mjs pre-reboot\n`,
    0o644
  );
  write(
    '/etc/cron.d/deploy_kit_healthcheck',
    `${hm} ${hh} * * * root ${NODE} ${HOST}/maintenance.mjs health\n`,
    0o644
  );
  write(
    '/etc/systemd/system/nexus404-post-reboot-cleanup.service',
    unit(
      'NEXUS404 cleanup after planned reboot',
      `${NODE} ${HOST}/maintenance.mjs cleanup`,
      'ConditionPathExists=/var/lib/nexus404-base/cleanup-after-reboot\nAfter=network-online.target\nWants=network-online.target\nOnFailure=nexus404-event-failure@%n.service'
    ) + 'TimeoutStartSec=30min\n',
    0o644
  );
  write(
    '/etc/systemd/system/nexus404-post-reboot-cleanup.timer',
    '[Unit]\nDescription=NEXUS404 deferred cleanup\n[Timer]\nOnBootSec=10min\nOnUnitInactiveSec=10min\nAccuracySec=30s\nUnit=nexus404-post-reboot-cleanup.service\n[Install]\nWantedBy=timers.target\n',
    0o644
  );
  write(
    '/etc/systemd/system/nexus404-security-check.service',
    unit(
      'NEXUS404 security check after boot',
      `${NODE} ${HOST}/security.mjs --strict --log`,
      'ConditionPathExists=/var/lib/nexus404-base/installed.flag\nAfter=network-online.target ssh.service sshd.service ufw.service fail2ban.service docker.service\nWants=network-online.target\nOnFailure=nexus404-event-failure@%n.service'
    ) + 'TimeoutStartSec=5min\nNice=10\n',
    0o644
  );
  write(
    '/etc/systemd/system/nexus404-security-check.timer',
    '[Unit]\nDescription=NEXUS404 boot check\n[Timer]\nOnBootSec=3min\nAccuracySec=15s\nUnit=nexus404-security-check.service\n[Install]\nWantedBy=timers.target\n',
    0o644
  );
  const launcher = `#!${NODE}\nimport {report} from '${HOST}/security.mjs';\nprocess.exitCode=report({portsOnly:process.argv.includes('--ports'),strict:process.argv.includes('--strict')});\n`;
  write('/usr/local/bin/nexus404-security-check', launcher, 0o755);
  for (const f of [
    '/etc/cron.d/deploy_kit_cleanup',
    '/usr/local/bin/deploy_kit_reboot.sh',
    '/usr/local/bin/deploy_kit_cleanup.sh',
    '/usr/local/bin/deploy_kit_healthcheck.sh'
  ])
    remove(f, {force: true});
}
export async function migrate(ui) {
  if (!fs.existsSync(BASE + '/installed.flag')) return;
  const r = cronSchedule('/etc/cron.d/deploy_kit_weekly_reboot'),
    h = cronSchedule('/etc/cron.d/deploy_kit_healthcheck');
  if (!r || !/^\d$/.test(r.day) || +r.day > 6 || !h || h.day !== '*')
    throw new Error('Не удалось прочитать расписания. Повтори базовую настройку через пункт 1.');
  installEvents();
  installLogging();
  installSchedules(r.time, +r.day, h.time);
  await ui.run('Проверка Fail2ban', 'fail2ban-client', ['-t']);
  await ui.run('Обновление служб', 'systemctl', ['daemon-reload']);
  await ui.run('Автозапуск событий', 'systemctl', [
    'enable',
    'nexus404-ssh-events.service',
    'nexus404-boot-event.service'
  ]);
  await ui.run('События SSH', 'systemctl', ['restart', 'nexus404-ssh-events.service']);
  await ui.run('События Fail2ban', 'systemctl', ['restart', 'fail2ban']);
  await waitForSSHJail(ui);
  await ui.run('Таймеры обслуживания', 'systemctl', [
    'enable',
    '--now',
    'nexus404-post-reboot-cleanup.timer',
    'nexus404-security-check.timer',
    'nexus404-logrotate.timer'
  ]);
}
if (direct(import.meta.url))
  job(process.argv[2]).catch((e) => {
    event(
      process.argv[2] === 'cleanup' ? 'system.cleanup.failed' : 'system.maintenance.failed',
      e.message
    );
    console.error(e.message);
    process.exitCode = 1;
  });
