import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Provider, fail} from './providers.mjs';
import {SteamAuth, qrSVG} from './steam-auth.mjs';
const kinds = ['steam', 'ra'];
export function atomicJSON(file, data) {
  const temporary = file + '.' + randomUUID();
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const dir = fs.openSync(path.dirname(file), 'r');
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, {force: true});
  }
}
const clean = (g) => {
  const {schema, schemaAt, rarity, rarityAt, achievements, ...rest} = g;
  return {
    ...rest,
    soft: achievements?.filter((a) => a.soft).length ?? null,
    hard: achievements?.filter((a) => a.hard).length ?? null,
    total: achievements?.length ?? g.total ?? null,
    available: Array.isArray(achievements)
  };
};
export class TrophiesStore {
  constructor(directory, options = {}) {
    this.dir = directory;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.jobs = new Map();
    this.clients = new Map();
    this.connecting = new Set();
    this.progress = {};
    this.closed = false;
    this.steamAuth = new SteamAuth(options);
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    fs.chmodSync(this.dir, 0o700);
    const file = path.join(this.dir, 'trophies.db');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS games(provider TEXT, account TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(provider,account,id));
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, time INTEGER NOT NULL, data TEXT NOT NULL);`);
  }
  get(key, fallback = null) {
    this.load();
    const r = this.db.prepare('SELECT value FROM state WHERE key=?').get(key);
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO state VALUES(?,?)').run(key, JSON.stringify(value));
  }
  atomic(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = action();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  account(kind) {
    if (!kinds.includes(kind)) throw fail('Неизвестный сервис', 400);
    return this.get(kind);
  }
  config() {
    return Object.fromEntries(
      kinds.map((k) => {
        const a = this.account(k);
        return [
          k,
          a
            ? {
                connected: true,
                hasKey: Boolean(a.key),
                mode: a.refreshToken ? 'qr' : 'api',
                name: a.name,
                lastSync: a.lastSync ?? 0,
                attemptedAt: a.attemptedAt ?? 0,
                nextAttempt: a.nextAttempt ?? 0,
                error: a.error ?? null,
                syncing: this.jobs.has(k),
                progress: this.progress[k] ?? null
              }
            : {connected: false}
        ];
      })
    );
  }
  provider(kind, account) {
    return new Provider(kind, account, {
      ...this.options,
      token:
        kind === 'steam' && account.refreshToken
          ? (force) => this.steamToken(account, force)
          : null,
      budget: () => {
        const key = 'budget:' + kind,
          day = new Date(this.now()).toISOString().slice(0, 10),
          b = this.get(key, {});
        const count = b.day === day ? b.count : 0;
        if (count >= 20000) throw fail('Дневной лимит хаба исчерпан. Продолжим завтра.', 429);
        this.set(key, {day, count: count + 1});
      }
    });
  }
  steamBusy() {
    return this.steamAuth.busy || (this.steamAuth.pending?.expiresAt ?? 0) > this.now();
  }
  async qrBegin() {
    this.load();
    if (this.jobs.has('steam') || this.connecting.has('steam'))
      throw fail('Дождись синхронизации Steam', 409);
    return this.steamAuth.begin();
  }
  qrImage(attempt) {
    return qrSVG(this.steamAuth.require(attempt).url);
  }
  async qrPoll(attempt) {
    const result = await this.steamAuth.poll(attempt);
    if (!result.tokens) return result;
    this.steamAuth.require(attempt);
    const tokens = result.tokens,
      previous = this.account('steam'),
      same = previous?.id === tokens.id;
    const account = {
      ...(same ? previous : {}),
      ...tokens,
      connectedAt: same ? previous.connectedAt : this.now(),
      nextAttempt: 0,
      backgroundAt: 0,
      error: null
    };
    if (!same) delete account.key;
    this.atomic(() => {
      if (previous && !same) {
        this.db.prepare("DELETE FROM games WHERE provider='steam' AND account=?").run(previous.id);
        this.db.prepare("DELETE FROM events WHERE json_extract(data,'$.provider')='steam'").run();
      }
      this.set('steam', account);
    });
    this.steamAuth.cancel(attempt);
    this.publish();
    void this.sync('steam').catch(() => {});
    return {connected: true, name: account.name};
  }
  async steamToken(account, force = false) {
    if (!force && account.accessToken && account.expiresAt > this.now() + 120000)
      return account.accessToken;
    if (!this.tokenJob)
      this.tokenJob = (async () => {
        const next = await this.steamAuth.refresh(account.refreshToken, account.id),
          current = this.account('steam');
        if (current?.id !== account.id) throw fail('Аккаунт Steam изменён', 409);
        Object.assign(account, next);
        this.set('steam', {...current, ...next});
        return next;
      })().finally(() => {
        this.tokenJob = null;
      });
    Object.assign(account, await this.tokenJob);
    return account.accessToken;
  }
  async steamKey(key) {
    const a = this.account('steam');
    if (!a) throw fail('Сначала подключи Steam', 409);
    if (this.closed || this.jobs.has('steam') || this.connecting.has('steam') || this.steamBusy())
      throw fail('Дождись завершения синхронизации или QR-входа', 409);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(key.trim()))
      throw fail('Проверь ключ API', 400);
    this.connecting.add('steam');
    const p = this.provider('steam', {key: key.trim()});
    this.clients.set('key:steam', p);
    try {
      await p.identity(a.id);
      if (this.closed || this.account('steam')?.id !== a.id) throw fail('Аккаунт изменён', 409);
      this.set('steam', {...a, key: key.trim(), error: null, nextAttempt: 0, backgroundAt: 0});
    } finally {
      p.close();
      this.clients.delete('key:steam');
      this.connecting.delete('steam');
    }
    void this.sync('steam').catch(() => {});
    return this.config();
  }
  async connect(kind, input, key) {
    this.account(kind);
    if (kind === 'steam' && this.steamBusy()) throw fail('Сначала заверши или отмени QR-вход', 409);
    if (this.jobs.has(kind) || this.connecting.has(kind))
      throw fail('Дождись текущей синхронизации', 409);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{16,256}$/.test(key.trim()))
      throw fail('Проверь ключ API', 400);
    this.connecting.add(kind);
    const p = this.provider(kind, {key: key.trim()});
    this.clients.set('connect:' + kind, p);
    try {
      const identity = await p.identity(input);
      if (this.closed) throw fail('Модуль остановлен', 503);
      const previous = this.account(kind);
      const account =
        previous?.id === identity.id
          ? {...previous, ...identity, key: key.trim(), error: null, nextAttempt: 0}
          : {...identity, key: key.trim(), connectedAt: this.now(), nextAttempt: 0};
      if (previous?.id !== identity.id) {
        delete account.refreshToken;
        delete account.accessToken;
        delete account.expiresAt;
      }
      this.atomic(() => {
        if (previous && previous.id !== identity.id) {
          this.db
            .prepare('DELETE FROM games WHERE provider=? AND account=?')
            .run(kind, previous.id);
          this.db.prepare("DELETE FROM events WHERE json_extract(data,'$.provider')=?").run(kind);
        }
        this.set(kind, account);
      });
      this.publish();
      void this.sync(kind).catch(() => {});
      return this.config();
    } finally {
      p.close();
      this.clients.delete('connect:' + kind);
      this.connecting.delete(kind);
    }
  }
  disconnect(kind) {
    if (kind === 'steam' && this.steamBusy()) throw fail('Сначала отмени QR-вход', 409);
    const a = this.account(kind);
    if (this.jobs.has(kind) || this.connecting.has(kind))
      throw fail('Дождись текущей синхронизации', 409);
    this.atomic(() => {
      this.set(kind, null);
      if (a) this.db.prepare('DELETE FROM games WHERE provider=? AND account=?').run(kind, a.id);
      this.db.prepare("DELETE FROM events WHERE json_extract(data,'$.provider')=?").run(kind);
    });
    this.publish();
    return this.config();
  }
  rows(kind, account) {
    return this.db
      .prepare('SELECT data FROM games WHERE provider=? AND account=?')
      .all(kind, account)
      .map((r) => JSON.parse(r.data));
  }
  snapshot() {
    const config = this.config(),
      games = [],
      awards = [];
    for (const k of kinds) {
      const a = this.account(k);
      if (!a) continue;
      games.push(
        ...this.rows(k, a.id).map((g) => ({
          ...clean(g),
          provider: k,
          cover: g.cover ? `/modules/trophies/cover/${k}/${g.id}` : ''
        }))
      );
      awards.push(...(a.awards ?? []).map((x) => ({...x, provider: k})));
    }
    return {config, games, awards, hiddenAwards: this.account('ra')?.hiddenAwards ?? 0};
  }
  detail(kind, id) {
    const a = this.account(kind);
    if (!a || !/^\d{1,12}$/.test(id)) throw fail('Игра не найдена', 404);
    const row = this.db
      .prepare('SELECT data FROM games WHERE provider=? AND account=? AND id=?')
      .get(kind, a.id, id);
    if (!row) throw fail('Игра не найдена', 404);
    const g = JSON.parse(row.data);
    return {...clean(g), cover: undefined, achievements: g.achievements ?? [], provider: kind};
  }
  mark(id, beaten) {
    if (typeof beaten !== 'boolean') throw fail('Некорректная отметка', 400);
    this.detail('steam', id);
    const a = this.account('steam');
    this.db
      .prepare(
        "UPDATE games SET data=json_set(data,'$.beaten',json(?)) WHERE provider='steam' AND account=? AND id=?"
      )
      .run(JSON.stringify(beaten), a.id, id);
    return this.detail('steam', id);
  }
  commitGame(kind, account, game) {
    const row = this.db
      .prepare('SELECT data FROM games WHERE provider=? AND account=? AND id=?')
      .get(kind, account.id, game.id);
    const previous = row ? JSON.parse(row.data) : null;
    if (previous)
      for (const field of [
        'reviewPercent',
        'reviewCount',
        'reviewAt',
        'priceUsd',
        'priceAt',
        'metadataError'
      ])
        if (Object.hasOwn(previous, field)) game[field] = previous[field];
    this.atomic(() => {
      for (const a of game.achievements)
        for (const mode of kind === 'ra' ? ['soft', 'hard'] : ['soft']) {
          if (!a[mode]) continue;
          const id = createHash('sha256')
            .update(JSON.stringify([kind, account.id, game.id, a.id, mode]))
            .digest('hex');
          const fresh = this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?)').run(id).changes;
          const date = mode === 'hard' ? a.hardDate : a.date;
          if (
            fresh &&
            previous?.detailAt &&
            (!date || date >= account.connectedAt) &&
            !(
              kind === 'ra' &&
              mode === 'soft' &&
              a.hard &&
              !previous.achievements?.find((x) => x.id === a.id)?.soft
            )
          ) {
            const event = {
              id,
              provider: kind,
              key: 'achievement.' + id,
              title:
                'Новое достижение · ' +
                (kind === 'steam' ? 'Steam' : mode === 'hard' ? 'Hardcore' : 'Softcore'),
              body: `${game.title} · ${a.title}`.slice(0, 500),
              category: 'achievements',
              level: 'info',
              time: this.now()
            };
            this.db
              .prepare('INSERT OR IGNORE INTO events VALUES(?,?,?)')
              .run(id, event.time, JSON.stringify(event));
          }
        }
      game.beaten =
        kind === 'steam'
          ? (previous?.beaten ?? false)
          : (account.awards ?? []).some((a) => a.game === game.id && a.type === 'Game Beaten');
      game.beatenHard =
        kind === 'ra' &&
        (account.awards ?? []).some(
          (a) => a.game === game.id && a.type === 'Game Beaten' && a.hard
        );
      this.db
        .prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?)')
        .run(kind, account.id, game.id, JSON.stringify(game));
    });
  }
  publish() {
    this.load();
    this.db.prepare('DELETE FROM events WHERE time<?').run(this.now() - 86400000);
    const events = this.db
      .prepare('SELECT data FROM events ORDER BY time DESC LIMIT 1000')
      .all()
      .map((x) => JSON.parse(x.data));
    atomicJSON(path.join(this.dir, 'notifications.json'), events);
  }
  sync(kind, mode = 'quick') {
    if (kind === 'steam' && this.steamBusy())
      return Promise.reject(fail('Дождись завершения QR-входа', 409));
    const a = this.account(kind);
    if (!a) return Promise.reject(fail('Подключи аккаунт в настройках', 400));
    if (this.jobs.has(kind)) return this.jobs.get(kind);
    if (this.closed) return Promise.reject(fail('Модуль остановлен', 503));
    if (this.now() < (a.nextAttempt ?? 0))
      return Promise.reject(fail('Повторная синхронизация пока недоступна', 429));
    const job = this.run(kind, a, mode).finally(() => {
      this.jobs.delete(kind);
      delete this.progress[kind];
    });
    this.jobs.set(kind, job);
    return job;
  }
  async run(kind, account, mode) {
    const client = this.provider(kind, account);
    this.clients.set(kind, client);
    account.attemptedAt = this.now();
    account.nextAttempt = this.now() + 60000;
    this.set(kind, account);
    try {
      const list = await client.library();
      account.awards = list.awards;
      account.hiddenAwards = list.hiddenAwards ?? 0;
      const old = new Map(this.rows(kind, account.id).map((g) => [g.id, g]));
      this.atomic(() => {
        for (const game of list.items)
          if (!old.has(game.id))
            this.db
              .prepare('INSERT OR IGNORE INTO games VALUES(?,?,?,?)')
              .run(kind, account.id, game.id, JSON.stringify(game));
      });
      if (kind === 'steam' && !account.key)
        throw fail(
          'Добавь Web API key в настройках «Трофеев» для загрузки достижений. QR-сессия сохранена.',
          409
        );
      const queue = list.items.sort(
        (a, b) =>
          (b.lastPlayed || 0) - (a.lastPlayed || 0) ||
          (old.get(a.id)?.checkedAt || 0) - (old.get(b.id)?.checkedAt || 0)
      );
      let errors = 0,
        count = 0,
        cursor = 0,
        fatal = null;
      const total = queue.length;
      this.progress[kind] = {
        done: 0,
        total,
        metadata: 0,
        metadataTotal: kind === 'steam' ? total : 0
      };
      const recent = (base, cached) => {
        if (mode === 'full' || !cached?.achievements || cached.error) return false;
        const age = this.now() - (cached.detailAt || 0);
        if (kind === 'ra')
          return (
            base.soft === cached.achievements.filter((a) => a.soft).length &&
            base.hard === cached.achievements.filter((a) => a.hard).length &&
            base.total === cached.total &&
            age < 21600000
          );
        if (
          base.minutes == null ||
          base.minutes !== cached.minutes ||
          base.lastPlayed !== cached.lastPlayed
        )
          return false;
        const complete = cached.achievements.every((a) => a.soft);
        return age < (!cached.total ? 30 * 86400000 : complete ? 7 * 86400000 : 0);
      };
      const worker = async () => {
        while (!fatal && cursor < total) {
          const base = queue[cursor++],
            cached = old.get(base.id);
          if (this.closed) {
            fatal = fail('Модуль остановлен', 503);
            break;
          }
          try {
            const game = recent(base, cached)
              ? {...cached, ...base}
              : await client.game(base, mode === 'full' ? {...cached, schema: null} : cached);
            game.checkedAt = this.now();
            this.commitGame(kind, account, game);
          } catch (e) {
            errors++;
            const row = this.db
              .prepare('SELECT data FROM games WHERE provider=? AND account=? AND id=?')
              .get(kind, account.id, base.id);
            const game = {
              ...(row ? JSON.parse(row.data) : (cached ?? base)),
              ...base,
              error: e.status ? e.message : 'Не удалось загрузить достижения',
              checkedAt: this.now()
            };
            this.db
              .prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?)')
              .run(kind, account.id, base.id, JSON.stringify(game));
            if ([401, 409, 429, 503].includes(e.status)) fatal = e;
          }
          this.progress[kind].done = ++count;
        }
      };
      // Metadata uses a separate limiter and never blocks achievement requests.
      let metadataErrors = 0;
      const metadata = async () => {
        if (kind !== 'steam') return;
        for (const base of queue) {
          if (this.closed || fatal) return;
          const cached = old.get(base.id) || {},
            changes = {};
          for (const [method, field] of [
            ['reviews', 'reviewAt'],
            ['price', 'priceAt']
          ]) {
            if (mode !== 'full' && cached[field] && this.now() - cached[field] < 21 * 86400000)
              continue;
            try {
              Object.assign(changes, await client[method](base.id));
            } catch (e) {
              metadataErrors++;
              changes.metadataError = 'Отзывы или цена не обновлены';
              if ([429, 503].includes(e.status)) return;
            }
          }
          const row = this.db
            .prepare('SELECT data FROM games WHERE provider=? AND account=? AND id=?')
            .get(kind, account.id, base.id);
          if (row)
            this.db
              .prepare('UPDATE games SET data=? WHERE provider=? AND account=? AND id=?')
              .run(
                JSON.stringify({...JSON.parse(row.data), metadataError: null, ...changes}),
                kind,
                account.id,
                base.id
              );
          this.progress[kind].metadata++;
        }
      };
      await Promise.all([
        Promise.all(Array.from({length: kind === 'steam' ? 4 : 2}, worker)),
        metadata()
      ]);
      if (fatal) throw fatal;
      this.atomic(() => {
        const active = new Set(list.items.map((g) => g.id));
        for (const id of old.keys())
          if (!active.has(id))
            this.db
              .prepare('DELETE FROM games WHERE provider=? AND account=? AND id=?')
              .run(kind, account.id, id);
        account.error = errors
          ? `Не обновлено игр: ${errors}. Предыдущие данные сохранены.`
          : metadataErrors
            ? 'Достижения обновлены. Часть отзывов или цен недоступна.'
            : null;
        if (!errors) account.lastSync = this.now();
        account.nextAttempt = this.now() + 60000;
        account.backgroundAt = this.now() + (errors ? 900000 : 3600000);
        this.set(kind, account);
      });
    } catch (e) {
      account.error = e.status
        ? e.message
        : 'Не удалось обновить данные. Предыдущий список сохранён.';
      account.backgroundAt = this.now() + 900000;
      account.nextAttempt = this.now() + 60000;
      this.set(kind, account);
    } finally {
      client.close();
      this.clients.delete(kind);
      if (!this.closed) this.publish();
    }
  }
  activity(mode = 'soft', provider = '') {
    const days = {},
      rare = [];
    for (const kind of kinds) {
      if (provider && kind !== provider) continue;
      const a = this.account(kind);
      if (!a) continue;
      for (const g of this.rows(kind, a.id))
        for (const x of g.achievements ?? []) {
          const hard = kind === 'ra' && mode === 'hard',
            unlocked = hard ? x.hard : x.soft,
            date = hard ? x.hardDate : x.date,
            rarity = hard ? x.hardRarity : x.rarity;
          if (!unlocked) continue;
          if (date && this.now() - date < 84 * 86400000 && date <= this.now()) {
            const d = new Date(date).toISOString().slice(0, 10);
            days[d] = (days[d] ?? 0) + 1;
          }
          if (rarity !== null && rarity <= 5)
            rare.push({
              id: x.id,
              game: g.id,
              provider: kind,
              title: x.title,
              gameTitle: g.title,
              rarity
            });
        }
    }
    return {days, rare: rare.sort((a, b) => a.rarity - b.rarity).slice(0, 30)};
  }
  async cover(kind, id) {
    this.detail(kind, id);
    const a = this.account(kind);
    const g = JSON.parse(
      this.db
        .prepare('SELECT data FROM games WHERE provider=? AND account=? AND id=?')
        .get(kind, a.id, id).data
    );
    if (!g.cover) return null;
    const url = new URL(g.cover);
    if (
      ![
        'shared.akamai.steamstatic.com',
        'media.retroachievements.org',
        'retroachievements.org'
      ].includes(url.hostname) ||
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password
    )
      return null;
    this.images ??= new Map();
    this.imageJobs ??= new Map();
    const key = kind + id,
      cached = this.images.get(key);
    if (cached && this.now() - cached.time < 86400000) return cached;
    if (this.imageJobs.has(key)) return this.imageJobs.get(key);
    if (this.imageJobs.size >= 6) {
      await Promise.race(this.imageJobs.values());
      return this.cover(kind, id);
    }
    const task = (async () => {
      const r = await (this.options.fetcher ?? fetch)(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(12000)
      });
      const type = r.headers.get('content-type')?.split(';')[0];
      if (!r.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
        await r.body?.cancel();
        return null;
      }
      const reader = r.body.getReader(),
        chunks = [];
      let size = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          return null;
        }
        chunks.push(Buffer.from(value));
      }
      const image = {data: Buffer.concat(chunks), type, time: this.now()};
      if (this.images.size >= 24) this.images.delete(this.images.keys().next().value);
      this.images.set(key, image);
      return image;
    })()
      .catch(() => null)
      .finally(() => this.imageJobs.delete(key));
    this.imageJobs.set(key, task);
    return task;
  }
  start() {
    this.load();
    this.publish();
    const tick = () => {
      for (const k of kinds) {
        const a = this.account(k);
        if (a && this.now() >= Math.max(a.backgroundAt ?? 0, a.nextAttempt ?? 0))
          void this.sync(k).catch(() => {});
      }
    };
    tick();
    this.timer ??= setInterval(tick, 60000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    this.steamAuth.close();
    clearInterval(this.timer);
    for (const c of this.clients.values()) c.close();
    await Promise.allSettled([...this.jobs.values()]);
    this.db?.close();
    this.db = null;
  }
}
