import {randomBytes, randomUUID, createHash} from 'node:crypto';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const valid = (id) => typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id);
export class SignalPhones {
  constructor({load, save, feed, now = Date.now}) {
    Object.assign(this, {load, save, feed, now});
  }
  list() {
    return (this.load().phones || []).map(({secret, read, ...item}) => ({
      ...item,
      readCount: read?.length || 0
    }));
  }
  create(name) {
    const state = this.load();
    state.phones ??= [];
    if (state.phones.length >= 10) throw Error('Не больше 10 подключений APK');
    const token = randomBytes(32).toString('base64url'),
      item = {
        id: randomUUID(),
        name: String(name || 'Геката')
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .trim()
          .slice(0, 60),
        created: this.now(),
        secret: digest(token),
        read: []
      };
    state.phones.push(item);
    this.save(state);
    return {id: item.id, token};
  }
  revoke(id) {
    const state = this.load();
    state.phones = (state.phones || []).filter((d) => d.id !== id);
    this.save(state);
  }
  test(id) {
    const state = this.load(),
      device = state.phones?.find((d) => d.id === id);
    if (!device) throw Error('Подключение не найдено');
    if (device.test && this.now() - device.test.time < 30000)
      throw Error('Повтори через 30 секунд');
    device.test = {
      id: 'apk-test-' + randomUUID(),
      time: this.now(),
      title: 'Гермес подключён',
      body: 'Проверка доставки из хаба. Можно открыть событие или отметить прочитанным.',
      category: 'services',
      level: 'info',
      key: 'apk.test'
    };
    this.save(state);
  }
  events(state, device) {
    const feed = this.feed(),
      items = (Array.isArray(feed.events) ? feed.events : []).filter(
        (e) =>
          valid(e.id) &&
          Number.isFinite(e.time) &&
          e.time >= device.created &&
          e.time >= this.now() - 86400000 &&
          e.time <= this.now() + 10000 &&
          state.categories[e.category] === true &&
          e.key !== 'push.test'
      );
    if (device.test && device.test.time >= this.now() - 86400000) items.push(device.test);
    return {
      feed,
      items: [...new Map(items.map((e) => [e.id, e])).values()].sort(
        (a, b) => a.time - b.time || a.id.localeCompare(b.id)
      )
    };
  }
  handle(request, input) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1],
      state = this.load(),
      device = token && (state.phones || []).find((d) => d.secret === digest(token));
    if (request.headers.origin || !device)
      return Response.json({error: 'Ключ Гермеса недействителен'}, {status: 401});
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return Response.json({error: 'Нужен объект'}, {status: 400});
    if (input.type === 'hello') return Response.json({state: 'ready', name: device.name});
    const {feed, items} = this.events(state, device);
    if (input.type === 'read') {
      if (!valid(input.id)) return Response.json({error: 'Некорректное событие'}, {status: 400});
      if (!device.read.includes(input.id) && !items.some((e) => e.id === input.id))
        return Response.json({error: 'Событие уже отсутствует'}, {status: 404});
      device.read = [...device.read.filter((id) => id !== input.id), input.id].slice(-100);
      this.save(state);
      return Response.json({ok: true});
    }
    if (
      input.type !== 'poll' ||
      !Array.isArray(input.seen) ||
      input.seen.length > 600 ||
      input.seen.some((id) => !valid(id))
    )
      return Response.json({error: 'Некорректный запрос'}, {status: 400});
    const seen = new Set([...input.seen, ...device.read]);
    const pending = items.filter((e) => !seen.has(e.id));
    return Response.json({
      state: 'ready',
      details: state.detailOnLockScreen === true,
      stale:
        !Number.isFinite(feed.updatedAt) ||
        this.now() - feed.updatedAt > 90000 ||
        this.now() - feed.updatedAt < -10000,
      more: pending.length > 20,
      items: pending
        .slice(0, 20)
        .map((e) => ({
          id: e.id,
          time: e.time,
          title: String(e.title || 'Гермес').slice(0, 160),
          body: String(e.body || '').slice(0, 500),
          level: ['critical', 'warning'].includes(e.level) ? e.level : 'info',
          url: e.key?.startsWith('kanban.')
            ? '/modules/kanban/'
            : e.key?.startsWith('rhythm.')
              ? '/modules/rhythm/'
              : e.category === 'achievements'
                ? '/modules/trophies/'
                : '/modules/signal/?event=' + encodeURIComponent(e.id)
        }))
    });
  }
}
