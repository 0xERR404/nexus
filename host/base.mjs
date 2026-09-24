import fs from 'node:fs';
import {
  BASE,
  read,
  atomic,
  query,
  exec,
  apt,
  validUser,
  validPort,
  validTime,
  installHost,
  supported,
  event
} from './common.mjs';
import {SSH} from './ssh.mjs';
import {protection, portFindings} from './security.mjs';
import {
  installEvents,
  installLogging,
  installSchedules,
  cronSchedule,
  waitForSSHJail
} from './maintenance.mjs';
export class BaseSetup {
  constructor(ui) {
    this.ui = ui;
    this.ssh = new SSH(ui);
    this.env = process.env;
    this.backup = '';
  }
  saved(name, fallback = '') {
    return read(BASE + '/' + name, fallback);
  }
  save(name, value) {
    atomic(BASE + '/' + name, String(value) + '\n');
  }
  async step(key, title, fn) {
    this.ui.section(title);
    if (this.saved('state-v2').split('\n').includes(key)) {
      this.ui.line('[✓] Уже выполнено');
      return;
    }
    await fn();
    fs.appendFileSync(BASE + '/state-v2', key + '\n', {mode: 0o600});
    this.ui.line('[✓] Шаг завершён');
  }
  backupFile(file) {
    if (fs.existsSync(file))
      fs.cpSync(file, this.backup + '/' + file.replaceAll('/', '_'), {
        recursive: true,
        dereference: false
      });
  }
  async dns() {
    for (const line of [
      '1  Яндекс · 77.88.8.8 / 77.88.8.1',
      '2  Google · 8.8.8.8 / 8.8.4.4',
      '3  Cloudflare · 1.1.1.1 / 1.0.0.1',
      '0  Сохранить текущий DNS'
    ])
      this.ui.line(line);
    const choice = await this.ui.ask(
      'DNS: 0–3',
      (v) => /^[0-3]$/.test(v),
      this.env.DNS_CHOICE ?? ''
    );
    if (choice === '0') return;
    const dns = [[], ['77.88.8.8', '77.88.8.1'], ['8.8.8.8', '8.8.4.4'], ['1.1.1.1', '1.0.0.1']][
      +choice
    ];
    const resolved = query('systemctl', ['is-active', '--quiet', 'systemd-resolved']).ok;
    const file = resolved ? '/etc/systemd/resolved.conf.d/90-nexus404.conf' : '/etc/resolv.conf';
    if (!resolved && fs.lstatSync(file, {throwIfNoEntry: false})?.isSymbolicLink())
      throw new Error('DNS управляется сетевым менеджером. Выбери 0.');
    const existed = fs.existsSync(file),
      old = read(file);
    this.backupFile(file);
    atomic(
      file,
      resolved
        ? `[Resolve]\nDNS=${dns.join(' ')}\nDomains=~.\n`
        : dns.map((v) => 'nameserver ' + v + '\n').join(''),
      0o644
    );
    try {
      if (resolved) await exec('systemctl', ['restart', 'systemd-resolved'], {log: this.ui.log});
      if (!query('getent', ['ahosts', 'deb.debian.org']).ok) throw new Error('DNS не отвечает');
    } catch (e) {
      if (existed) atomic(file, old + '\n', 0o644);
      else fs.rmSync(file, {force: true});
      if (resolved) query('systemctl', ['restart', 'systemd-resolved']);
      throw new Error('DNS не прошёл проверку. Конфигурация восстановлена.');
    }
  }
  async packages() {
    await apt(this.ui, 'Список пакетов', 'update');
    await apt(
      this.ui,
      'Обновление системы',
      '-o',
      'Dpkg::Options::=--force-confold',
      'upgrade',
      '-y'
    );
    await apt(
      this.ui,
      'Системные инструменты',
      'install',
      '-y',
      'ca-certificates',
      'curl',
      'openssl',
      'openssh-server',
      'sudo',
      'iproute2',
      'util-linux',
      'cron',
      'logrotate'
    );
    await this.ui.run('Автозапуск cron', 'systemctl', ['enable', '--now', 'cron']);
  }
  async time() {
    const zones = query('timedatectl', ['list-timezones']).text.split('\n');
    const zone = await this.ui.ask(
      'Часовой пояс · Region/City',
      (v) => zones.includes(v),
      this.env.PRESET_TIMEZONE ?? ''
    );
    await this.ui.run('Часовой пояс', 'timedatectl', ['set-timezone', zone]);
    try {
      await this.ui.run('Синхронизация времени', 'timedatectl', ['set-ntp', 'true']);
    } catch {
      await apt(this.ui, 'Установка timesyncd', 'install', '-y', 'systemd-timesyncd');
      await this.ui.run('NTP', 'timedatectl', ['set-ntp', 'true']);
    }
  }
  async swap() {
    const active = query('swapon', ['--noheadings', '--show=NAME']);
    if (!active.ok) throw new Error('Не удалось проверить swap');
    if (!active.text) {
      const ram = Math.floor(Number(read('/proc/meminfo').match(/MemTotal:\s+(\d+)/)?.[1]) / 1024),
        s = fs.statfsSync('/'),
        free = Math.floor((s.bavail * s.bsize) / 2 ** 20);
      let size = ram <= 2048 ? ram * 2 : ram <= 8192 ? ram : 4096;
      size = Math.min(size, free - 1024);
      if (size < 256) this.ui.line('[?] Мало места для swap: оставлен запас 1 ГиБ.');
      else {
        if (!fs.existsSync('/swapfile')) {
          this.save('swap_pending', 'yes');
          try {
            await this.ui.run('Выделение swap', 'fallocate', ['-l', size + 'M', '/swapfile']);
          } catch {
            await this.ui.run('Создание swap', 'dd', [
              'if=/dev/zero',
              'of=/swapfile',
              'bs=1M',
              'count=' + size,
              'status=none'
            ]);
          }
        }
        fs.chmodSync('/swapfile', 0o600);
        if (query('blkid', ['-p', '-s', 'TYPE', '-o', 'value', '/swapfile']).text !== 'swap') {
          if (!fs.existsSync(BASE + '/swap_pending'))
            throw new Error('/swapfile уже существует и не является swap');
          await this.ui.run('Форматирование swap', 'mkswap', ['/swapfile']);
        }
        await this.ui.run('Подключение swap', 'swapon', ['/swapfile']);
      }
    }
    if (query('swapon', ['--noheadings', '--show=NAME']).text.split('\n').includes('/swapfile')) {
      if (!/^\/swapfile\s/m.test(read('/etc/fstab')))
        fs.appendFileSync('/etc/fstab', '\n/swapfile none swap sw 0 0\n');
      fs.rmSync(BASE + '/swap_pending', {force: true});
    }
    atomic('/etc/sysctl.d/90-nexus404-swap.conf', 'vm.swappiness=10\n', 0o644);
    await this.ui.run('Параметры swap', 'sysctl', ['-p', '/etc/sysctl.d/90-nexus404-swap.conf']);
    query('modprobe', ['tcp_bbr']);
    if (
      query('sysctl', ['-n', 'net.ipv4.tcp_available_congestion_control'])
        .text.split(/\s+/)
        .includes('bbr')
    ) {
      atomic(
        '/etc/sysctl.d/90-nexus404-bbr.conf',
        'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n',
        0o644
      );
      atomic('/etc/modules-load.d/nexus404-bbr.conf', 'tcp_bbr\n', 0o644);
      await this.ui.run('Включение BBR', 'sysctl', ['-p', '/etc/sysctl.d/90-nexus404-bbr.conf']);
    } else this.ui.line('[?] BBR недоступен в текущем ядре.');
  }
  async audit() {
    await apt(this.ui, 'Установка auditd', 'install', '-y', 'auditd', 'audispd-plugins');
    fs.mkdirSync('/etc/ssh/sshd_config.d', {recursive: true});
    const paths = {
      identity: ['passwd', 'shadow', 'group', 'gshadow'].map((v) => '/etc/' + v),
      sshd_config: ['/etc/ssh/sshd_config', '/etc/ssh/sshd_config.d'],
      sudoers: ['/etc/sudoers', '/etc/sudoers.d']
    };
    atomic(
      '/etc/audit/rules.d/nexus404.rules',
      Object.entries(paths)
        .flatMap(([key, files]) => files.map((f) => `-w ${f} -p wa -k ${key}\n`))
        .join(''),
      0o644
    );
    await this.ui.run('Аудит', 'systemctl', ['enable', '--now', 'auditd']);
    await this.ui.run('Правила аудита', 'augenrules', ['--load']);
  }
  async password(label, min, preset = '') {
    let value = preset;
    while (true) {
      if (Array.from(value).length < min || /[\r\n\x00]/.test(value)) {
        value = await this.ui.prompt(`${label} · минимум ${min} символов`, true);
        continue;
      }
      if (preset && value === preset) return value;
      if (value === (await this.ui.prompt('Повтори пароль', true))) return value;
      this.ui.line('[?] Пароли не совпадают');
      value = '';
    }
  }
  home(user) {
    const r = query('getent', ['passwd', user]);
    const parts = r.text.split(':');
    if (!r.ok || !parts[5]?.startsWith('/') || !fs.existsSync(parts[5]))
      throw new Error('Домашний каталог не найден');
    return {dir: parts[5], uid: +parts[2], gid: +parts[3]};
  }
  async installKey(user) {
    const {dir, uid, gid} = this.home(user);
    const temp = BASE + '/key.check';
    let key = this.env.PRESET_SSH_PUBLIC_KEY ?? '';
    try {
      while (true) {
        if (!key) key = await this.ui.prompt('Вставь публичный SSH-ключ');
        atomic(temp, key + '\n');
        if (!/[\r\n\x00]/.test(key) && query('ssh-keygen', ['-l', '-f', temp]).ok) break;
        this.ui.line('[?] Нужен один корректный публичный ключ');
        key = '';
      }
    } finally {
      fs.rmSync(temp, {force: true});
    }
    fs.mkdirSync(dir + '/.ssh', {recursive: true, mode: 0o700});
    fs.chmodSync(dir + '/.ssh', 0o700);
    fs.chownSync(dir + '/.ssh', uid, gid);
    const file = dir + '/.ssh/authorized_keys';
    const lines = read(file).split('\n').filter(Boolean);
    if (!lines.includes(key)) lines.push(key);
    atomic(file, lines.join('\n') + '\n');
    fs.chownSync(file, uid, gid);
  }
  address() {
    return query('hostname', ['-I']).text.split(/\s+/)[0] || 'АДРЕС_СЕРВЕРА';
  }
  async user() {
    const prior = this.saved('pending_user', this.saved('sudo_user'));
    let user = this.env.PRESET_SUDO_USER ?? prior;
    while (true) {
      user = await this.ui.ask('Имя sudo-пользователя', validUser, user);
      if (query('id', [user]).ok) {
        if (user === prior) break;
        this.ui.line('[?] Имя уже занято');
        user = '';
        continue;
      }
      this.save('pending_user', user);
      await this.ui.run('Создание пользователя', 'adduser', [
        '--gecos',
        '',
        '--disabled-password',
        user
      ]);
      break;
    }
    if (query('passwd', ['-S', user]).text.split(/\s+/)[1] !== 'P') {
      const pass = await this.password('Пароль', 8, this.env.PRESET_SUDO_PASSWORD);
      delete this.env.PRESET_SUDO_PASSWORD;
      await exec('chpasswd', [], {input: `${user}:${pass}\n`});
    }
    await this.ui.run('Права sudo', 'usermod', ['-aG', 'sudo', user]);
    this.save('sudo_user', user);
    const {dir, uid, gid} = this.home(user),
      rootKeys = read('/root/.ssh/authorized_keys');
    if (rootKeys && !read(dir + '/.ssh/authorized_keys') && !rootKeys.includes('command=')) {
      fs.mkdirSync(dir + '/.ssh', {recursive: true, mode: 0o700});
      fs.chownSync(dir + '/.ssh', uid, gid);
      atomic(dir + '/.ssh/authorized_keys', rootKeys + '\n');
      fs.chownSync(dir + '/.ssh/authorized_keys', uid, gid);
      this.ui.line('[*] Ключи root скопированы для первого входа');
    }
    if (
      this.env.PRESET_SSH_PUBLIC_KEY ||
      (this.ssh.config(user).passwordauthentication?.[0] === 'no' &&
        !read(dir + '/.ssh/authorized_keys'))
    )
      await this.installKey(user);
    this.ui.line(
      `В новом терминале: ssh -p ${this.ssh.previousPorts()[0]} ${user}@${this.address()}`
    );
    if (!(await this.ui.confirm('Вход новым пользователем и sudo -v работают?')))
      throw new Error('Доступ не подтверждён');
    await this.ssh.begin();
    this.ssh.managed();
    this.ssh.set('PermitRootLogin', 'no');
    await this.ssh.reload();
    if (this.ssh.config('root').permitrootlogin?.[0] !== 'no')
      throw new Error('Match/Include разрешает root');
    await this.ssh.confirm('После запрета root новый пользователь и sudo работают?');
    await this.ssh.commit();
    await this.ui.run('Блокировка пароля root', 'passwd', ['-l', 'root']);
    await this.sshUsers(user);
    if (rootKeys) {
      const preset = this.env.PRESET_REMOVE_ROOT_KEYS;
      const remove = /^y$/i.test(preset ?? '')
        ? true
        : /^n$/i.test(preset ?? '')
          ? false
          : await this.ui.confirm('Убрать SSH-ключи root?');
      if (remove)
        fs.renameSync('/root/.ssh/authorized_keys', this.backup + '/root-authorized_keys');
    }
  }
  async sshUsers(primary) {
    const input =
      this.env.PRESET_SSH_USERS ||
      (await this.ui.prompt(
        `Пользователи SSH через пробел · Enter: ${this.saved('ssh_users', primary)}`
      )) ||
      this.saved('ssh_users', primary);
    const users = [...new Set(input.trim().split(/\s+/))].sort();
    if (!users.includes(primary)) throw new Error('Основной пользователь должен иметь SSH');
    for (const name of users) {
      const r = query('id', ['-u', name]);
      if (!validUser(name) || !r.ok || r.text === '0')
        throw new Error('Некорректный пользователь SSH');
    }
    await this.ssh.begin();
    this.ssh.managed();
    this.ssh.set('AllowUsers', users.join(' '));
    const accounts = query('getent', ['passwd']);
    if (!accounts.ok || !accounts.text) throw new Error('Список пользователей недоступен');
    for (const name of [
      ...accounts.text.split('\n').map((r) => r.split(':')[0]),
      'nexus404-denied-user'
    ])
      for (const address of new Set([
        '127.0.0.1',
        this.env.SSH_CONNECTION?.split(' ')[0] ?? '127.0.0.1'
      ]))
        if (
          [...new Set(this.ssh.config(name, address).allowusers ?? [])].sort().join(' ') !==
          users.join(' ')
        )
          throw new Error('Другой AllowUsers в Match/Include меняет список');
    await this.ssh.reload();
    await this.ssh.confirm('Разрешённые пользователи входят, основной выполняет sudo -v?');
    await this.ssh.commit();
    this.save('ssh_users', users.join(' '));
    this.save('ssh_check_address', this.env.SSH_CONNECTION?.split(' ')[0] ?? '127.0.0.1');
  }
  async sshPort() {
    const old = this.ssh.previousPorts();
    if (!old.length) throw new Error('Не удалось определить текущие SSH-порты');
    const port = +(await this.ui.ask(
      'Новый SSH-порт · 1024–65535',
      validPort,
      this.env.PRESET_SSH_PORT ?? ''
    ));
    const listen = query('ss', ['-H', '-ltn', 'sport = :' + port]);
    if (!listen.ok || (!old.includes(port) && listen.text))
      throw new Error('Новый порт занят или проверка недоступна');
    await apt(this.ui, 'Firewall', 'install', '-y', 'ufw');
    for (const p of new Set([...old, port]))
      await this.ui.run('Разрешение SSH · ' + p, 'ufw', ['allow', p + '/tcp']);
    await this.ssh.begin();
    this.ssh.managed();
    this.ssh.clearPorts();
    fs.appendFileSync(
      '/etc/ssh/sshd_config.d/00-nexus404.conf',
      [...new Set([...old, port])].map((p) => 'Port ' + p + '\n').join('')
    );
    this.ssh.set('MaxAuthTries', '3');
    this.ssh.set('LoginGraceTime', '20');
    await this.ssh.reload();
    await this.ssh.waitPorts([...old, port]);
    for (const args of [
      ['default', 'deny', 'incoming'],
      ['default', 'allow', 'outgoing'],
      ['--force', 'enable']
    ])
      await this.ui.run('Правила firewall', 'ufw', args);
    this.ui.line(`Старые порты пока работают: ${old.join(', ')}. Проверь firewall провайдера.`);
    this.ui.line(`ssh -p ${port} ${this.saved('sudo_user')}@${this.address()}`);
    await this.ssh.confirm('Вход по новому порту работает?');
    this.ssh.clearPorts();
    this.ssh.set('Port', String(port));
    if (this.ssh.ports().join(' ') !== String(port))
      throw new Error('В дополнительных Include остались порты');
    await this.ssh.reload();
    await this.ssh.waitPorts([port]);
    await this.ssh.commit();
    this.save('ssh_port', port);
    for (const p of old)
      if (p !== port)
        try {
          await this.ui.run('Закрытие старого порта · ' + p, 'ufw', [
            '--force',
            'delete',
            'allow',
            p + '/tcp'
          ]);
        } catch {
          this.ui.line('[?] Проверь старые правила UFW. SSH старый порт уже не слушает.');
        }
  }
  async sshAuth() {
    const method = await this.ui.ask(
      '1 — пароль · 2 — ключ',
      (v) => ['1', '2'].includes(v),
      this.env.PRESET_SSH_AUTH_METHOD ?? ''
    );
    const user = this.saved('sudo_user'),
      port = this.saved('ssh_port');
    if (method === '2') await this.installKey(user);
    await this.ssh.begin();
    this.ssh.managed();
    this.ssh.set(method === '1' ? 'PasswordAuthentication' : 'PubkeyAuthentication', 'yes');
    await this.ssh.reload();
    if (method === '1') {
      if (this.ssh.config(user).passwordauthentication?.[0] !== 'yes')
        throw new Error('Match/Include отключает пароль');
      this.ui.line(
        `ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password -p ${port} ${user}@${this.address()}`
      );
      await this.ssh.confirm('Вход по паролю работает?');
    } else {
      this.ui.line(
        `ssh -o PreferredAuthentications=publickey -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -p ${port} ${user}@${this.address()}`
      );
      await this.ssh.confirm('Новая сессия открылась именно по ключу?');
      for (const key of [
        'PasswordAuthentication',
        'KbdInteractiveAuthentication',
        'ChallengeResponseAuthentication'
      ])
        this.ssh.set(key, 'no');
      await this.ssh.reload();
      const c = this.ssh.config(user);
      if (
        c.passwordauthentication?.[0] !== 'no' ||
        c.kbdinteractiveauthentication?.[0] !== 'no' ||
        c.pubkeyauthentication?.[0] !== 'yes'
      )
        throw new Error('Match/Include переопределяет авторизацию');
      await this.ssh.confirm('После отключения пароля повторный вход по ключу работает?');
    }
    await this.ssh.commit();
    this.save('auth_method', method === '1' ? 'password' : 'key');
  }
  async fail2ban() {
    await apt(this.ui, 'Fail2ban', 'install', '-y', 'fail2ban');
    atomic(
      '/etc/fail2ban/jail.d/90-nexus404.local',
      `[sshd]\nenabled = true\nbackend = systemd\nport = ${this.saved('ssh_port')}\nbantime = 1h\nfindtime = 10m\nmaxretry = 5\nignoreip = 127.0.0.1/8 ::1\n`,
      0o644
    );
    await this.ui.run('Проверка Fail2ban', 'fail2ban-client', ['-t']);
    await this.ui.run('Автозапуск Fail2ban', 'systemctl', ['enable', 'fail2ban']);
    await this.ui.run('Применение Fail2ban', 'systemctl', ['restart', 'fail2ban']);
    await waitForSSHJail(this.ui);
  }
  async apparmor() {
    await apt(this.ui, 'AppArmor', 'install', '-y', 'apparmor', 'apparmor-utils');
    await this.ui.run('Автозапуск AppArmor', 'systemctl', ['enable', '--now', 'apparmor']);
    await this.ui.run('Проверка AppArmor', 'aa-status', []);
  }
  async limits() {
    atomic(
      '/etc/security/limits.d/99-nexus404.conf',
      '* soft nofile 65535\n* hard nofile 65535\nroot soft nofile 65535\nroot hard nofile 65535\n',
      0o644
    );
    atomic(
      '/etc/systemd/system.conf.d/90-nexus404.conf',
      '[Manager]\nDefaultLimitNOFILE=65535\n',
      0o644
    );
    this.ui.line('[✓] Лимиты применятся к новым сессиям и после перезагрузки.');
  }
  async events() {
    installEvents();
    installLogging();
    await this.ui.run('Проверка Fail2ban', 'fail2ban-client', ['-t']);
    await this.ui.run('Обновление служб', 'systemctl', ['daemon-reload']);
    await this.ui.run('События Fail2ban', 'systemctl', ['restart', 'fail2ban']);
    await waitForSSHJail(this.ui);
    await this.ui.run('Лимиты журналов', 'systemctl', ['restart', 'systemd-journald']);
    await this.ui.run('Проверка ротации', 'logrotate', ['--debug', '/etc/nexus404-logrotate.conf']);
    await this.ui.run('Автозапуск событий', 'systemctl', [
      'enable',
      '--now',
      'nexus404-ssh-events.service',
      'nexus404-logrotate.timer'
    ]);
    await this.ui.run('Обновление обработчика SSH', 'systemctl', [
      'restart',
      'nexus404-ssh-events.service'
    ]);
    await this.ui.run('События загрузки', 'systemctl', ['enable', 'nexus404-boot-event.service']);
  }
  async maintenance() {
    await apt(this.ui, 'Обслуживание', 'install', '-y', 'unattended-upgrades', 'logrotate');
    const old = cronSchedule('/etc/cron.d/deploy_kit_weekly_reboot');
    const time = await this.ui.ask(
      'Время еженедельного рестарта · ЧЧ:ММ',
      validTime,
      this.env.PRESET_REBOOT_TIME ?? old?.time ?? ''
    );
    const days = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const day = await this.ui.ask(
      'День рестарта · пн/вт/ср/чт/пт/сб/вс',
      (v) => days.includes(v),
      this.env.PRESET_REBOOT_DAY ?? days[+old?.day] ?? ''
    );
    this.save('reboot_time', time);
    this.save('reboot_day', days.indexOf(day));
    atomic(
      '/etc/apt/apt.conf.d/51-deploy-kit-security-only.conf',
      '#clear Unattended-Upgrade::Allowed-Origins;\n#clear Unattended-Upgrade::Origins-Pattern;\nUnattended-Upgrade::Origins-Pattern {\n "origin=Ubuntu,archive=${distro_codename}-security";\n "origin=UbuntuESMApps,archive=${distro_codename}-apps-security";\n "origin=UbuntuESM,archive=${distro_codename}-infra-security";\n "origin=Debian,label=Debian-Security,codename=${distro_codename}-security";\n};\nUnattended-Upgrade::Automatic-Reboot "false";\nUnattended-Upgrade::Automatic-Reboot-Time "02:00";\n',
      0o644
    );
    atomic(
      '/etc/apt/apt.conf.d/20auto-upgrades',
      'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n',
      0o644
    );
  }
  async health() {
    const old = cronSchedule('/etc/cron.d/deploy_kit_healthcheck');
    const time = await this.ui.ask(
      'Ежедневная проверка · ЧЧ:ММ',
      validTime,
      this.env.PRESET_HEALTHCHECK_TIME ?? old?.time ?? ''
    );
    const reboot = cronSchedule('/etc/cron.d/deploy_kit_weekly_reboot');
    installSchedules(
      this.saved('reboot_time', reboot?.time),
      +this.saved('reboot_day', reboot?.day),
      time
    );
    for (const [name, cmd, args] of [
      ['timezone', 'timedatectl', ['show', '-p', 'Timezone', '--value']],
      ['swap_devices', 'swapon', ['--noheadings', '--raw', '--show=NAME']],
      ['congestion_control', 'sysctl', ['-n', 'net.ipv4.tcp_congestion_control']]
    ]) {
      const r = query(cmd, args);
      if (!r.ok) throw new Error('Не удалось сохранить ' + name);
      this.save(name, r.text);
    }
    await this.ui.run('Обновление служб', 'systemctl', ['daemon-reload']);
    await this.ui.run('Таймеры обслуживания', 'systemctl', [
      'enable',
      '--now',
      'nexus404-post-reboot-cleanup.timer',
      'nexus404-security-check.timer',
      'apt-daily.timer',
      'apt-daily-upgrade.timer'
    ]);
  }
  async run() {
    const os = supported();
    fs.mkdirSync(BASE, {recursive: true, mode: 0o700});
    fs.mkdirSync('/run/sshd', {recursive: true});
    installHost();
    fs.rmSync(BASE + '/installed.flag', {force: true});
    this.backup = fs.mkdtempSync(BASE + '/backup.');
    fs.chmodSync(this.backup, 0o700);
    const stop = async () => {
      try {
        await this.ssh.abort();
      } finally {
        process.exit(130);
      }
    };
    for (const sig of ['SIGTERM', 'SIGHUP']) process.once(sig, stop);
    this.ui.section('NEXUS404 · базовая настройка');
    this.ui.line(os.PRETTY_NAME);
    try {
      const steps = [
        ['dns', 'DNS', 'dns'],
        ['packages_js1', 'Пакеты и обновления', 'packages'],
        ['time', 'Время и NTP', 'time'],
        ['swap', 'Swap и BBR', 'swap'],
        ['audit', 'Системный аудит', 'audit'],
        ['user_v5', 'Пользователь и root', 'user'],
        ['ssh_port', 'SSH-порт и firewall', 'sshPort'],
        ['ssh_auth', 'Способ входа', 'sshAuth'],
        ['fail2ban', 'Защита SSH', 'fail2ban'],
        ['apparmor', 'AppArmor', 'apparmor'],
        ['limits', 'Системные лимиты', 'limits'],
        ['events_js1', 'События и журналы', 'events'],
        ['maintenance_js2', 'Обновления и обслуживание', 'maintenance'],
        ['healthcheck_js2', 'Ежедневная проверка', 'health']
      ];
      for (let i = 0; i < steps.length; i++) {
        const [key, title, fn] = steps[i];
        await this.step(key, `${String(i + 1).padStart(2, '0')} / 15 · ${title}`, () => this[fn]());
      }
      this.ui.section('15 / 15 · Финальная проверка');
      const checks = [...protection(), ...portFindings()];
      checks.push({
        title: 'DNS отвечает',
        level: query('getent', ['ahosts', 'deb.debian.org']).ok ? 'ok' : 'error'
      });
      for (const c of checks)
        this.ui.line(`[${c.level === 'ok' ? '✓' : c.level === 'error' ? '!' : '?'}] ${c.title}`);
      if (checks.some((c) => c.level === 'error'))
        throw new Error('Есть ошибки проверки. Установка не объявлена завершённой.');
      this.save('installed.flag', 'VERSION=3\nINSTALLED_AT=' + new Date().toISOString());
      event('system.setup.completed', 'Базовая настройка завершена');
      this.ui.section('NEXUS404 · готово');
      this.ui.line(`ssh -p ${this.saved('ssh_port')} ${this.saved('sudo_user')}@${this.address()}`);
      this.ui.line('Резервные копии: ' + this.backup);
    } finally {
      for (const sig of ['SIGTERM', 'SIGHUP']) process.removeListener(sig, stop);
      await this.ssh.abort();
    }
  }
}
