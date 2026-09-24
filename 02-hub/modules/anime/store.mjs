import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';

const ORIGIN = 'https://shikimori.io';
export const REDIRECT = 'urn:ietf:wg:oauth:2.0:oob';
export const STATUSES = {
  watching: 'Смотрю',
  completed: 'Посмотрел',
  planned: 'Запланировано',
  on_hold: 'Отложено',
  dropped: 'Бросил',
  rewatching: 'Пересматриваю'
};
const HOUR = 3600000;
const fail = (message, status = 502) => Object.assign(new Error(message), {status});
const empty = () => ({
  connection: null,
  pending: null,
  items: [],
  syncedAt: null,
  lastError: '',
  nextAttempt: 0
});

export function save(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  const temp = file + '.' + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, {force: true});
  }
}

export function posterURL(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return '';
  try {
    const url = new URL(value, ORIGIN);
    const hosts = [
      'shikimori.io',
      'shikimori.one',
      'desu.shikimori.one',
      'desu.shikimori.io',
      'kawai.shikimori.one',
      'nyaa.shikimori.one'
    ];
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      hosts.includes(url.hostname)
      ? url.href
      : '';
  } catch {
    return '';
  }
}

async function bytes(response, max = 4 * 1024 * 1024) {
  if (!response.body) throw fail('Shikimori вернул пустой ответ.');
  const reader = response.body.getReader(),
    chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw fail('Ответ Shikimori слишком большой.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function normalize(rate) {
  const anime = rate?.anime;
  const integer = (value, max) => Number.isSafeInteger(value) && value >= 0 && value <= max;
  if (
    !anime ||
    !integer(anime.id, 2147483647) ||
    !anime.id ||
    !Object.hasOwn(STATUSES, rate.status) ||
    !integer(rate.score, 10) ||
    !integer(rate.episodes, 1000000) ||
    !integer(anime.episodes, 1000000) ||
    typeof anime.name !== 'string' ||
    !anime.name.trim()
  )
    throw fail('Неожиданный формат списка Shikimori. Предыдущие данные сохранены.');
  return {
    id: anime.id,
    name: anime.name.slice(0, 300),
    title: (anime.russian || anime.name).slice(0, 300),
    status: rate.status,
    score: rate.score,
    watched: rate.episodes,
    episodes: anime.episodes,
    poster: posterURL(anime.image?.preview || anime.image?.original)
  };
}

export class AnimeStore {
  constructor(directory, {fetcher = fetch, now = Date.now, wait = sleep, write = save} = {}) {
    this.file = path.join(directory, 'shikimori.json');
    this.fetcher = fetcher;
    this.now = now;
    this.wait = wait;
    this.write = write;
    this.loaded = false;
    this.data = empty();
    this.nextRequest = 0;
    this.job = null;
    this.timer = null;
    this.images = new Map();
    this.imageJobs = new Map();
    this.imageQueue = Promise.resolve();
  }
  load() {
    if (this.loaded) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (
        !data ||
        !Array.isArray(data.items) ||
        data.items.length > 100000 ||
        (data.connection && (!data.connection.user?.id || !data.connection.access_token))
      )
        throw new Error('storage');
      this.data = {...empty(), ...data};
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('Не удалось прочитать данные «Кадра».', 503);
    }
    this.loaded = true;
  }
  commit(next) {
    this.write(this.file, next);
    this.data = next;
  }
  config() {
    this.load();
    const c = this.data.connection,
      p = this.data.pending;
    const pending = p && p.until > this.now();
    const authorize = pending
      ? ORIGIN +
        '/oauth/authorize?' +
        new URLSearchParams({
          client_id: p.clientId,
          redirect_uri: REDIRECT,
          response_type: 'code',
          scope: ''
        })
      : '';
    return {
      connected: !!c,
      user: c?.user ?? null,
      appName: c?.appName ?? '',
      needsReconnect: !!(c?.refreshing || c?.reauth),
      pending: !!pending,
      authorize,
      redirect: REDIRECT,
      busy: !!this.job,
      syncedAt: this.data.syncedAt
    };
  }
  snapshot() {
    this.load();
    return {
      ...this.config(),
      items: this.data.items.map(({poster, ...item}) => ({
        ...item,
        cover: poster ? '/modules/anime/cover/' + item.id : ''
      })),
      error: this.data.lastError,
      syncing: !!this.job,
      stale:
        !!this.data.lastError || !this.data.syncedAt || this.now() - this.data.syncedAt > 2 * HOUR,
      nextAttempt: this.data.nextAttempt
    };
  }
  busy() {
    if (this.job) throw fail('Дождись завершения текущей операции.', 409);
  }
  setup(data) {
    this.load();
    this.busy();
    if (
      ['appName', 'clientId', 'clientSecret'].some((key) => typeof data[key] !== 'string') ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,79}$/.test(data.appName ?? '') ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(data.clientId ?? '') ||
      !/^[A-Za-z0-9_-]{16,256}$/.test(data.clientSecret ?? '')
    )
      throw fail('Укажи название приложения латиницей, Application ID и Secret из Shikimori.', 400);
    this.commit({
      ...this.data,
      pending: {
        appName: data.appName,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        until: this.now() + 15 * 60000
      }
    });
    return this.config();
  }
  exclusive(fn) {
    this.busy();
    this.job = Promise.resolve()
      .then(fn)
      .finally(() => {
        this.job = null;
      });
    return this.job;
  }
  async remote(route, {connection, payload, token = true, retry = true} = {}) {
    for (let attempt = 0; ; attempt++) {
      if (this.nextRequest - this.now() > 60000)
        throw fail('Лимит Shikimori. Повторим синхронизацию позже.', 429);
      await this.wait(Math.max(0, this.nextRequest - this.now()));
      this.nextRequest = this.now() + 1100;
      let response;
      try {
        response = await this.fetcher(ORIGIN + route, {
          method: payload ? 'POST' : 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            'User-Agent': connection.appName,
            Accept: 'application/json',
            ...(token ? {Authorization: 'Bearer ' + connection.access_token} : {}),
            ...(payload ? {'Content-Type': 'application/json'} : {})
          },
          ...(payload ? {body: JSON.stringify(payload)} : {})
        });
      } catch {
        throw fail('Shikimori недоступен или не ответил вовремя.');
      }
      if (response.status === 429 || response.status >= 500) {
        const value = response.headers.get('retry-after');
        let delay = value
          ? /^\d+(\.\d+)?$/.test(value)
            ? Number(value) * 1000
            : Date.parse(value) - this.now()
          : (attempt + 1) * 3000;
        if (!Number.isFinite(delay)) delay = 5000;
        delay = Math.max(1100, Math.min(delay, 86400000));
        this.nextRequest = Math.max(this.nextRequest, this.now() + delay);
        await response.body?.cancel();
        if (retry && attempt < 2 && delay <= 60000) continue;
        throw fail(
          response.status === 429
            ? 'Лимит Shikimori. Повторим синхронизацию позже.'
            : 'Сбой Shikimori. Предыдущие данные сохранены.'
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw fail(
          response.status === 401
            ? 'Подключение Shikimori требует обновления.'
            : response.status === 403
              ? 'Shikimori отклонил доступ. Проверь разрешение приложения.'
              : 'Shikimori не выполнил запрос.',
          response.status === 401 ? 401 : 502
        );
      }
      try {
        return JSON.parse((await bytes(response)).toString('utf8'));
      } catch (error) {
        if (error.status) throw error;
        throw fail('Shikimori вернул некорректный ответ.');
      }
    }
  }
  async tokens(connection, fields) {
    const result = await this.remote('/oauth/token', {
      connection,
      token: false,
      retry: false,
      payload: {
        client_id: connection.clientId,
        client_secret: connection.clientSecret,
        ...fields
      }
    });
    if (
      !/^[\x21-\x7e]{16,8192}$/.test(result?.access_token ?? '') ||
      !/^[\x21-\x7e]{16,8192}$/.test(result?.refresh_token ?? '') ||
      !Number.isFinite(result.expires_in) ||
      result.expires_in < 60 ||
      result.expires_in > 31536000
    )
      throw fail('Неожиданный ответ авторизации Shikimori.');
    return {
      ...connection,
      access_token: result.access_token,
      refresh_token: result.refresh_token,
      expiresAt: this.now() + result.expires_in * 1000,
      refreshing: false,
      reauth: false
    };
  }
  connect(code) {
    this.load();
    if (!/^[A-Za-z0-9_-]{16,1024}$/.test(code ?? ''))
      throw fail('Вставь код авторизации Shikimori.', 400);
    const pending = this.data.pending;
    if (!pending || pending.until <= this.now())
      throw fail('Создай новую ссылку подключения.', 400);
    return this.exclusive(async () => {
      const c = await this.tokens(pending, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT
      });
      const user = await this.remote('/api/users/whoami', {connection: c});
      if (!Number.isSafeInteger(user?.id) || user.id <= 0 || typeof user.nickname !== 'string')
        throw fail('Не удалось определить аккаунт Shikimori.');
      delete c.until;
      c.user = {id: user.id, nickname: user.nickname.slice(0, 100)};
      const same = this.data.connection?.user.id === user.id;
      this.commit({
        ...empty(),
        ...(same ? this.data : {}),
        connection: c,
        pending: null,
        nextAttempt: 0
      });
      this.images.clear();
      return this.config();
    });
  }
  disconnect() {
    this.load();
    this.busy();
    this.commit(empty());
    this.images.clear();
    return this.config();
  }
  async refresh() {
    const c = this.data.connection;
    if (!c || c.reauth || c.refreshing) throw fail('Подключи Shikimori заново в настройках.', 401);
    this.commit({...this.data, connection: {...c, refreshing: true}});
    try {
      const next = await this.tokens(c, {
        grant_type: 'refresh_token',
        refresh_token: c.refresh_token
      });
      this.commit({...this.data, connection: next});
    } catch (error) {
      this.data = {...this.data, connection: {...this.data.connection, reauth: true}};
      try {
        this.commit(this.data);
      } catch {}
      throw error;
    }
  }
  async api(route, payload) {
    let c = this.data.connection;
    if (c.reauth || c.refreshing) throw fail('Подключи Shikimori заново в настройках.', 401);
    if (c.expiresAt <= this.now() + 60000) await this.refresh();
    try {
      return await this.remote(route, {connection: this.data.connection, payload});
    } catch (error) {
      if (error.status !== 401) throw error;
      await this.refresh();
      return this.remote(route, {connection: this.data.connection, payload});
    }
  }
  sync() {
    this.load();
    if (this.job) return this.job;
    if (!this.data.connection) throw fail('Подключи Shikimori в общих настройках.', 400);
    if (this.now() < this.data.nextAttempt)
      throw fail('Повторная синхронизация пока недоступна. Попробуй позже.', 429);
    return this.exclusive(async () => {
      const items = [],
        ids = new Set();
      let expectedNext = null;
      try {
        this.commit({...this.data, nextAttempt: this.now() + 60000});
        for (let page = 1; ; page++) {
          if (page > 1001)
            throw fail('Список превышает предел загрузки. Предыдущие данные сохранены.');
          const list = await this.api(
            '/api/users/' +
              this.data.connection.user.id +
              '/anime_rates?page=' +
              page +
              '&limit=100'
          );
          // Shikimori returns limit + 1 records; a page past the end can be null.
          if (list === null && page > 1 && expectedNext === null) break;
          if (!Array.isArray(list) || list.length > 101)
            throw fail('Неожиданный формат списка Shikimori.');
          if (expectedNext !== null && (!list.length || normalize(list[0]).id !== expectedNext))
            throw fail('Список изменился во время загрузки. Повторим позже.');
          if (!list.length) break;
          for (const rate of list.slice(0, 100)) {
            const item = normalize(rate);
            if (ids.has(item.id)) throw fail('Список изменился во время загрузки. Повторим позже.');
            ids.add(item.id);
            items.push(item);
          }
          if (items.length > 100000)
            throw fail('Список слишком большой. Предыдущие данные сохранены.');
          expectedNext = list.length === 101 ? normalize(list[100]).id : null;
          if (expectedNext !== null && ids.has(expectedNext))
            throw fail('Список изменился во время загрузки. Повторим позже.');
          if (list.length < 100) break;
        }
        for (let offset = 0; offset < items.length; offset += 50) {
          const batch = items.slice(offset, offset + 50);
          const result = await this.api('/api/graphql', {
            query:
              '{ animes(ids: "' +
              batch.map((x) => x.id).join(',') +
              '", limit: 50) { id poster { mainUrl } } }'
          });
          if (result.errors?.length || !Array.isArray(result.data?.animes))
            throw fail('Не удалось получить обложки Shikimori. Предыдущие данные сохранены.');
          if (result.data.animes.some((x) => !x || !Number.isSafeInteger(Number(x.id))))
            throw fail('Неожиданный формат обложек Shikimori.');
          const posters = new Map(
            result.data.animes.map((x) => [Number(x.id), posterURL(x.poster?.mainUrl)])
          );
          for (const item of batch) if (posters.get(item.id)) item.poster = posters.get(item.id);
        }
        this.commit({
          ...this.data,
          items,
          syncedAt: this.now(),
          lastError: '',
          nextAttempt: this.now() + 60000
        });
        this.images.clear();
        return true;
      } catch (error) {
        const next = {
          ...this.data,
          lastError: error.status
            ? error.message
            : 'Не удалось сохранить список. Проверь свободное место и права на данные.',
          nextAttempt: Math.max(this.now() + 5 * 60000, this.nextRequest)
        };
        this.data = next;
        try {
          this.commit(next);
        } catch {}
        return false;
      }
    });
  }
  tick() {
    this.load();
    if (this.data.pending && this.data.pending.until <= this.now())
      this.commit({...this.data, pending: null});
    if (
      !this.job &&
      this.data.connection &&
      !this.data.connection.reauth &&
      !this.data.connection.refreshing &&
      this.now() >= this.data.nextAttempt &&
      (!this.data.syncedAt || this.data.lastError || this.now() - this.data.syncedAt >= HOUR)
    )
      return this.sync();
  }
  start() {
    this.load();
    if (this.timer) return;
    const run = () =>
      Promise.resolve()
        .then(() => this.tick())
        .catch(() => {});
    void run();
    this.timer = setInterval(run, 60000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
  cover(id) {
    this.load();
    const url = posterURL(this.data.items.find((x) => x.id === id)?.poster);
    if (!url) return Promise.resolve(null);
    if (this.images.has(url)) return Promise.resolve(this.images.get(url));
    if (this.imageJobs.has(url)) return this.imageJobs.get(url);
    if (this.imageJobs.size >= 64) return Promise.resolve(null);
    const job = this.imageQueue
      .then(async () => {
        try {
          const res = await this.fetcher(url, {
            redirect: 'error',
            signal: AbortSignal.timeout(6000),
            headers: {'User-Agent': 'NEXUS404', Accept: 'image/webp,image/png,image/jpeg'}
          });
          const type = res.headers.get('content-type')?.split(';')[0];
          if (!res.ok || !['image/webp', 'image/png', 'image/jpeg', 'image/avif'].includes(type)) {
            await res.body?.cancel();
            return null;
          }
          const image = {type, data: await bytes(res, 524288)};
          if (this.images.size >= 48) this.images.delete(this.images.keys().next().value);
          this.images.set(url, image);
          return image;
        } catch {
          return null;
        }
      })
      .finally(() => this.imageJobs.delete(url));
    this.imageQueue = job.catch(() => {});
    this.imageJobs.set(url, job);
    return job;
  }
}
