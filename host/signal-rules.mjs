import {randomUUID} from 'node:crypto';
export const categories = [
  'resources',
  'services',
  'security',
  'maintenance',
  'recovery',
  'summary'
];
export const defaultSettings = {
  categories: Object.fromEntries(categories.map((c) => [c, true])),
  dailyTime: '09:00',
  detailOnLockScreen: false
};
export class Rules {
  constructor(state = {}, now = Date.now) {
    this.state = state;
    this.state.conditions ??= {};
    this.state.groups ??= {};
    this.now = now;
    this.events = [];
  }
  emit(key, title, body, level = 'warning', category = 'services') {
    const event = {id: randomUUID(), key, title, body, level, category, time: this.now()};
    this.events.push(event);
    return event;
  }
  condition(
    key,
    active,
    {
      title,
      body = '',
      level = 'warning',
      category = 'services',
      delay = 0,
      recoverDelay = 60000,
      repeat = 6 * 3600000
    }
  ) {
    const now = this.now();
    let c = this.state.conditions[key];
    if (active === null) {
      if (c && !c.announced) delete this.state.conditions[key];
      else if (c) delete c.recoveredAt;
      return;
    }
    if (active) {
      if (!c) c = this.state.conditions[key] = {since: now, announced: false, last: 0, level};
      delete c.recoveredAt;
      if (c.level !== level) {
        c.level = level;
        c.announced = false;
        c.since = now;
      }
      if (now - c.since >= delay && (!c.announced || now - c.last >= repeat)) {
        this.emit(key, title, body, level, category);
        c.announced = true;
        c.last = now;
      }
    } else if (c) {
      if (!c.announced) {
        delete this.state.conditions[key];
        return;
      }
      c.recoveredAt ??= now;
      if (now - c.recoveredAt >= recoverDelay) {
        this.emit(
          key + '.recovered',
          'Проблема устранена',
          title + ' — состояние вернулось в норму.',
          'info',
          'recovery'
        );
        delete this.state.conditions[key];
      }
    }
  }
  metrics(data) {
    const age = this.now() - data?.generated_at;
    const valid = Number.isFinite(age) && age >= -10000 && age < 20000;
    this.condition('metrics.stale', !valid, {
      title: 'Нет свежих показателей сервера',
      delay: 60000
    });
    if (!valid) {
      for (const key of Object.keys(this.state.conditions))
        if (key.startsWith('resources.')) this.condition(key, null, {title: ''});
      return;
    }
    this.condition('metrics.partial', Boolean(data.warnings?.length), {
      title: 'Часть показателей сервера недоступна',
      delay: 60000
    });
    this.condition('resources.cpu', data.cpu?.percent == null ? null : data.cpu.percent > 90, {
      title: 'Длительная нагрузка CPU',
      body: `CPU ${data.cpu?.percent}% более 5 минут.`,
      category: 'resources',
      delay: 300000
    });
    this.condition(
      'resources.memory',
      data.memory ? data.memory.available / data.memory.total < 0.1 : null,
      {
        title: 'Мало доступной памяти',
        body: `RAM занято ${data.memory?.percent}%.`,
        category: 'resources',
        delay: 300000
      }
    );
    this.condition(
      'resources.swap',
      data.swap && data.memory
        ? data.swap.total > 0 &&
            data.swap.percent > 80 &&
            data.memory.available / data.memory.total < 0.1
        : null,
      {title: 'Заполнен swap при нехватке RAM', category: 'resources', delay: 300000}
    );
    const observed = new Set();
    for (const disk of data.disks ?? []) {
      for (const [field, label] of [
        ['percent', 'Диск'],
        ['inodes_percent', 'Inode']
      ]) {
        const value = disk[field];
        if (!Number.isFinite(value)) continue;
        observed.add('resources.' + field + '.' + disk.mount);
        const old = this.state.conditions['resources.' + field + '.' + disk.mount];
        const active = old ? value >= 82 : value >= 85;
        this.condition('resources.' + field + '.' + disk.mount, active, {
          title: `${label} ${disk.mount}: мало места`,
          body: `Использовано ${value}%.`,
          level: value >= 95 ? 'critical' : 'warning',
          category: 'resources',
          delay: value >= 95 ? 0 : 60000
        });
      }
    }
    for (const key of Object.keys(this.state.conditions))
      if (/^resources\.(percent|inodes_percent)\./.test(key) && !observed.has(key))
        this.condition(key, null, {title: ''});
  }
  group(
    key,
    title,
    details,
    {threshold = 5, window = 600000, category = 'security', level = 'warning'} = {}
  ) {
    const now = this.now();
    let group = this.state.groups[key];
    if (group && now - group.started >= (group.window ?? window)) {
      this.closeGroup(key, group);
      group = null;
    }
    if (!group) group = this.state.groups[key] = {started: now, count: 0, last: null, window};
    group.count++;
    group.details = details;
    if (group.count >= threshold && (group.last === null || now - group.last >= window)) {
      this.emit(key, title, `${group.count} событий за интервал. ${details}`, level, category);
      group.last = now;
      group.count = 0;
    }
  }
  event(entry) {
    const d = String(entry.details ?? '').slice(0, 500);
    switch (entry.type) {
      case 'system.update.completed':
        this.state.lastUpdate = entry.time;
        break;
      case 'security.ssh.login_succeeded':
        this.emit(entry.type, 'Вход по SSH', d, 'info', 'security');
        break;
      case 'security.hub.login_new':
        this.emit(entry.type, 'Вход в хаб с нового IP', d, 'info', 'security');
        break;
      case 'security.ssh.login_failed':
      case 'security.hub.login_failed':
        this.group(entry.type, 'Серия неудачных входов', d, {threshold: 10});
        break;
      case 'security.fail2ban.ban':
        this.group(entry.type, 'Блокировки Fail2ban', d, {threshold: 1});
        break;
      case 'system.reboot.scheduled':
        this.emit(entry.type, 'Плановая перезагрузка через 5 минут', d, 'info', 'maintenance');
        break;
      case 'system.reboot.completed':
        this.emit(entry.type, 'Сервер загружен', d, 'info', 'maintenance');
        break;
      case 'system.cleanup.failed':
        this.condition('system.cleanup', true, {
          title: 'Ошибка очистки после перезагрузки',
          body: d,
          category: 'maintenance',
          level: 'critical'
        });
        break;
      case 'system.update.failed':
      case 'system.maintenance.failed':
      case 'system.service.failed':
        this.emit(entry.type, 'Ошибка обслуживания', d, 'critical', 'maintenance');
        break;
      case 'system.healthcheck.completed':
        this.condition('system.healthcheck', !d.includes('status=ok'), {
          title: 'Плановая проверка обнаружила проблемы',
          body: d,
          category: 'security',
          recoverDelay: 0
        });
        break;
      case 'system.cleanup.completed':
        this.state.lastCleanup = entry.time;
        this.condition('system.cleanup', false, {
          title: 'Очистка после перезагрузки',
          category: 'maintenance',
          recoverDelay: 0
        });
        break;
    }
  }
  closeGroup(key, group) {
    if (group.count && key === 'security.fail2ban.ban')
      this.emit(
        key,
        'Сводка блокировок Fail2ban',
        `Дополнительно заблокировано: ${group.count}.`,
        'warning',
        'security'
      );
    delete this.state.groups[key];
  }
  flushGroups() {
    for (const [key, group] of Object.entries(this.state.groups))
      if (this.now() - group.started >= (group.window ?? 600000)) this.closeGroup(key, group);
  }
  daily(time, enabled, summary) {
    const now = new Date(this.now());
    const day = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`,
      clock =
        String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    if (enabled && clock >= time && this.state.summaryDay !== day) {
      this.state.summaryDay = day;
      this.emit('daily.summary', 'Ежедневная сводка', summary, 'info', 'summary');
    }
  }
  take() {
    const events = this.events;
    this.events = [];
    return events;
  }
}
