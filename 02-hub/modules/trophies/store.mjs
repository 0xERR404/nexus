import {FileCache} from '../../src/cache.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Provider, fail, steamImage} from './providers.mjs';
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
  const {schema, schemaAt, rarity, rarityAt, achievements, storeCover, ...rest} = g;
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
    this.coverCache = new FileCache(path.join(directory, 'cache-covers'), {now: this.now});
    this.coverCache.prune();
    this.jobs = new Map();
    this.clients = new Map();
    this.connecting = new Set();
    this.progress = {};
    this.closed = false;
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.dir, {recursive: true, mode: 0o700});
    fs.chmodSync(this.dir, 0o700);
    const file = path.join(this.dir, 'trophies.db');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS games(provider TEXT, account TEXT, id TEXT, data TEXT NOT NULL, PRIMARY KEY(provider,account,id));
      CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, time INTEGER NOT NULL, data TEXT NOT NULL);`);
    const steam = this.get('steam');
    if (steam && ('refreshToken' in steam || 'accessToken' in steam)) {
      delete steam.refreshToken;
      delete steam.accessToken;
      delete steam.expiresAt;
      steam.error = steam.key ? null : 'Для ручного обновления подключи Steam через Web API.';
      this.set('steam', steam);
    }
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
                mode: 'api',
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
      budget: () => {
        const key = 'budget:' + kind,
          day = new Date(this.now()).toISOString().slice(0, 10),
          b = this.get(key, {});
        const count = b.day === day ? b.count : 0;
        if (count >= 5000) throw fail('Дневной лимит хаба исчерпан. Продолжим завтра.', 429);
        this.set(key, {day, count: count + 1});
      }
    });
  }
  async connect(kind, input, key) {
    this.account(kind);
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
      {
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
      if (kind !== 'steam') void this.sync(kind).catch(() => {});
      return this.config();
    } finally {
      p.close();
      this.clients.delete('connect:' + kind);
      this.connecting.delete(kind);
    }
  }
  disconnect(kind) {
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
          cover: g.cover
            ? `/modules/trophies/cover/${k}/${g.id}?v=2-${createHash('sha256')
                .update(g.storeCover || g.cover)
                .digest('hex')
                .slice(0, 12)}`
            : ''
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
  commitGame(kind, account, game, metadata = {}) {
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
        'metadataError',
        'storeCover'
      ])
        if (Object.hasOwn(previous, field)) game[field] = previous[field];
    Object.assign(game, metadata);
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
    const a = this.account(kind);
    if (!a) return Promise.reject(fail('Подключи аккаунт в настройках', 400));
    if (kind === 'steam' && !a.key)
      return Promise.reject(fail('Подключи Steam через Web API в настройках Ники', 409));
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
    account.error = null;
    account.attemptedAt = this.now();
    account.nextAttempt = this.now() + 900000;
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
        throw fail('Добавь Web API key в настройках Ники для загрузки достижений.', 409);
      const played = (game) => (game.minutes || 0) > 0 || (game.lastPlayed || 0) > 0;
      const queue = list.items.sort(
        (a, b) =>
          Number(played(b)) - Number(played(a)) ||
          (b.lastPlayed || 0) - (a.lastPlayed || 0) ||
          (old.get(a.id)?.checkedAt || 0) - (old.get(b.id)?.checkedAt || 0)
      );
      const reasons = new Map();
      let errors = 0,
        count = 0,
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
        return age < (!cached.total ? 30 * 86400000 : complete ? 7 * 86400000 : 3600000);
      };
      let keyVerified = false,
        deniedGames = 0,
        metadataErrors = 0,
        storeDenied = false;
      const metadata = async (base, cached = {}) => {
        if (kind !== 'steam') return {};
        if (storeDenied)
          return {metadataError: 'Магазин недоступен; сохранённые цена и отзывы оставлены.'};
        const changes = {metadataError: null};
        for (const [method, field] of [
          ['reviews', 'reviewAt'],
          ['price', 'priceAt']
        ]) {
          if (this.closed || fatal) break;
          if (mode !== 'full' && cached[field] && this.now() - cached[field] < 21 * 86400000)
            continue;
          try {
            Object.assign(changes, await client[method](base.id));
          } catch (e) {
            metadataErrors++;
            changes.metadataError = 'Отзывы или цена не обновлены';
            if (e.publicRequest && [401, 403].includes(e.httpStatus)) {
              storeDenied = true;
              break;
            }
            if ([401, 409, 429, 503].includes(e.status)) {
              fatal = e;
              break;
            }
          }
        }
        return changes;
      };
      for (const base of queue) {
        if (this.closed) {
          fatal = fail('Модуль остановлен', 503);
          break;
        }
        if (fatal) break;
        const cached = old.get(base.id);
        this.progress[kind].phase =
          kind === 'steam' ? (played(base) ? 'played' : 'library') : undefined;
        this.progress[kind].current = base.title;
        const [stats, extra] = await Promise.allSettled([
          recent(base, cached)
            ? Promise.resolve({...cached, ...base})
            : client.game(base, mode === 'full' ? {...cached, schema: null} : cached),
          metadata(base, cached)
        ]);
        const changes =
          extra.status === 'fulfilled'
            ? extra.value
            : {metadataError: 'Данные магазина недоступны'};
        if (extra.status === 'rejected') metadataErrors++;
        let game;
        if (stats.status === 'fulfilled') {
          deniedGames = 0;
          game = {...stats.value, ...changes, checkedAt: this.now()};
        } else {
          const e = stats.reason;
          if (e.gameAccessDenied) {
            if (!keyVerified) {
              try {
                await client.identity(account.id);
                keyVerified = true;
              } catch (checkError) {
                fatal = checkError;
              }
            }
            if (keyVerified) {
              e.status = 422;
              e.message =
                'Steam запретил доступ к достижениям этой игры (403). Ключ сохранён, профиль доступен.';
              if (++deniedGames >= 3)
                fatal = fail(
                  'Steam отклонил три игры подряд. Ключ сохранён; обновление приостановлено.',
                  409
                );
            }
          }
          errors++;
          const reason = e.status ? e.message : 'Не удалось загрузить достижения';
          reasons.set(reason, (reasons.get(reason) || 0) + 1);
          game = {...cached, ...base, ...changes, error: reason, checkedAt: this.now()};
          if ([401, 409, 429, 503].includes(e.status)) fatal = e;
        }
        if (this.closed) {
          fatal = fail('Модуль остановлен', 503);
          break;
        }
        if (game.cover && !fatal) {
          try {
            game.coverError = (await this.cover(kind, base.id, game)) ? null : 'Обложка недоступна';
          } catch {
            game.coverError = 'Обложка недоступна';
          }
        }
        if (stats.status === 'fulfilled') this.commitGame(kind, account, game, changes);
        else
          this.db
            .prepare('INSERT OR REPLACE INTO games VALUES(?,?,?,?)')
            .run(kind, account.id, base.id, JSON.stringify(game));
        this.progress[kind].done = ++count;
        if (kind === 'steam') this.progress[kind].metadata = count;
      }
      if (fatal) throw fatal;
      this.atomic(() => {
        const active = new Set(list.items.map((g) => g.id));
        for (const id of old.keys())
          if (!active.has(id))
            this.db
              .prepare('DELETE FROM games WHERE provider=? AND account=? AND id=?')
              .run(kind, account.id, id);
        account.error = errors
          ? `Библиотека обработана. Достижения не обновлены у ${errors} из ${total} игр. ${[
              ...reasons
            ]
              .sort((a, b) => b[1] - a[1])
              .slice(0, 2)
              .map(([reason, n]) => `${reason} (${n})`)
              .join('; ')}. Предыдущие данные сохранены.`
          : metadataErrors
            ? 'Достижения обновлены. Часть отзывов или цен недоступна.'
            : null;
        if (!errors) account.lastSync = this.now();
        account.nextAttempt = this.now() + 900000;
        account.backgroundAt = this.now() + (errors ? 900000 : 3600000);
        this.set(kind, account);
      });
    } catch (e) {
      account.error = e.status
        ? e.message
        : 'Не удалось обновить данные. Предыдущий список сохранён.';
      account.nextAttempt = Math.max(this.now() + 900000, e.retryAt || 0);
      account.backgroundAt = account.nextAttempt;
      this.set(kind, account);
    } finally {
      client.close();
      this.clients.delete(kind);
      if (!this.closed) this.publish();
    }
  }
  recent() {
    this.load();
    const played = [],
      achievements = [];
    for (const provider of kinds) {
      const account = this.account(provider);
      if (!account) continue;
      for (const game of this.rows(provider, account.id)) {
        const href =
          '/modules/trophies/?provider=' + provider + '&game=' + encodeURIComponent(game.id);
        if (
          Number.isFinite(game.lastPlayed) &&
          game.lastPlayed > 0 &&
          game.lastPlayed <= this.now()
        )
          played.push({
            id: provider + ':' + game.id,
            title: game.title,
            detail: 'Последний запуск · ' + (provider === 'steam' ? 'Steam' : 'RetroAchievements'),
            date: game.lastPlayed,
            href
          });
        for (const achievement of game.achievements || []) {
          const date = achievement.soft
            ? achievement.date
            : achievement.hard
              ? achievement.hardDate
              : null;
          if (Number.isFinite(date) && date > 0 && date <= this.now())
            achievements.push({
              id: provider + ':' + game.id + ':' + achievement.id,
              title: game.title,
              detail: 'Достижение · ' + achievement.title,
              date,
              href
            });
        }
      }
    }
    const latest = (rows) => rows.sort((a, b) => b.date - a.date).slice(0, 20);
    return {played: latest(played), achievements: latest(achievements)};
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
          if (date && this.now() - date < 366 * 86400000 && date <= this.now()) {
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
  async cover(kind, id, prepared = null) {
    this.detail(kind, id);
    const a = this.account(kind);
    const g =
      prepared ??
      JSON.parse(
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
    const storeCover = kind === 'steam' ? steamImage(g.storeCover, id) : '';
    const key = 'v2:' + kind + ':' + a.id + ':' + id + ':' + url.href + ':' + storeCover,
      cached = this.images.get(key);
    const disk = this.coverCache.get(key);
    if (disk && !disk.stale) return disk;
    if (cached && this.now() - cached.time < 86400000) return cached;
    if (this.imageJobs.has(key)) return disk ?? this.imageJobs.get(key);
    if (this.imageJobs.size >= 6) {
      await Promise.race(this.imageJobs.values());
      return this.cover(kind, id, prepared);
    }
    const task = (async () => {
      const sources =
        kind === 'steam'
          ? storeCover
            ? [storeCover]
            : [
                ...new Set(
                  [
                    steamImage(g.storeCover, id),
                    url.href,
                    `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`
                  ].filter(Boolean)
                )
              ]
          : [url.href];
      const fetchImage = async (source) => {
        let response;
        try {
          response = await (this.options.fetcher ?? fetch)(new URL(source), {
            redirect: 'error',
            signal: AbortSignal.timeout(8000)
          });
          const type = response.headers.get('content-type')?.split(';')[0];
          if (!response.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) {
            await response.body?.cancel();
            return null;
          }
          const reader = response.body.getReader(),
            chunks = [];
          let size = 0;
          while (true) {
            const {done, value} = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 2 * 1024 * 1024) {
              await reader.cancel();
              return null;
            }
            chunks.push(Buffer.from(value));
          }
          return size ? {data: Buffer.concat(chunks), type, time: this.now()} : null;
        } catch {
          return null;
        }
      };
      let image;
      for (const source of sources) {
        image = await fetchImage(source);
        if (image) break;
      }
      if (!image && kind === 'steam' && !this.closed && !prepared) {
        this.coverProvider ??= this.provider('steam', {});
        const info = await this.coverProvider.storeInfo(id);
        if (info.storeCover && !sources.includes(info.storeCover)) {
          image = await fetchImage(info.storeCover);
          if (image && !this.closed && this.account(kind)?.id === a.id)
            this.db
              .prepare(
                "UPDATE games SET data=json_set(data,'$.storeCover',?) WHERE provider=? AND account=? AND id=?"
              )
              .run(info.storeCover, kind, a.id, id);
        }
      }
      if (!image) return null;
      while (
        this.images.size &&
        (this.images.size >= 128 ||
          [...this.images.values()].reduce((n, x) => n + x.data.length, 0) + image.data.length >
            24 * 1024 * 1024)
      )
        this.images.delete(this.images.keys().next().value);
      this.images.set(key, image);
      this.coverCache.put(key, image);
      return image;
    })()
      .catch(() => null)
      .finally(() => this.imageJobs.delete(key));
    this.imageJobs.set(key, task);
    return disk ?? task;
  }
  start() {
    this.load();
    this.publish();
    const tick = () => {
      for (const k of kinds) {
        const a = this.account(k);
        if (k !== 'steam' && a && this.now() >= Math.max(a.backgroundAt ?? 0, a.nextAttempt ?? 0))
          void this.sync(k).catch(() => {});
      }
    };
    tick();
    this.timer ??= setInterval(tick, 60000);
    this.timer.unref();
  }
  async close() {
    this.closed = true;
    this.coverProvider?.close();
    clearInterval(this.timer);
    for (const c of this.clients.values()) c.close();
    await Promise.allSettled([...this.jobs.values()]);
    await Promise.allSettled(this.imageJobs?.values() ?? []);
    this.db?.close();
    this.db = null;
  }
}
