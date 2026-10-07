import fs from 'node:fs';
import path from 'node:path';
import {BlockList, isIP} from 'node:net';
import {Resolver} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import bencode from 'bencode';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {imageType} from '../../src/content-store.mjs';
import {ID, fail} from '../../src/input.mjs';
const MAX = 8 * 1024 ** 3;
export function validateTorrent(t) {
  if (
    !t.files?.length ||
    t.files.length > 1000 ||
    !Number.isSafeInteger(t.length) ||
    t.length < 1 ||
    t.length > MAX ||
    t.pieceLength > 16 * 1024 ** 2 ||
    t.pieces?.length > 131072
  )
    throw fail('Раздача: до 8 ГиБ и 1000 файлов', 413);
  for (const f of t.files)
    if (
      !Number.isSafeInteger(f.length) ||
      f.length < 0 ||
      typeof f.path !== 'string' ||
      f.path.length > 1024 ||
      /\\|\0|(^|\/)\.\.(\/|$)|^\//.test(f.path) ||
      /^[A-Za-z]:/.test(f.path)
    )
      throw fail('Небезопасные пути раздачи');
  if (t.private) throw fail('В этой версии поддерживаются публичные раздачи через DHT');
}
export class PieceStore {
  constructor(size, options) {
    this.size = size;
    this.length = options.length;
    this.directory = options.path;
    this.file = path.join(this.directory, 'pieces.bin');
    this.present = new Set();
    this.closed = false;
  }
  put(index, buffer, cb) {
    try {
      if (
        this.closed ||
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index * this.size >= this.length ||
        this.length > MAX ||
        buffer.length !== Math.min(this.size, this.length - index * this.size)
      )
        throw Error('Invalid piece');
      fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
      const disk = fs.statfsSync(this.directory);
      if (disk.bavail * disk.bsize < buffer.length + 128 * 1024 ** 2) throw Error('Disk full');
      const fd = fs.openSync(this.file, fs.existsSync(this.file) ? 'r+' : 'w+', 0o600);
      try {
        if (fs.writeSync(fd, buffer, 0, buffer.length, index * this.size) !== buffer.length)
          throw Error('Incomplete piece write');
      } finally {
        fs.closeSync(fd);
      }
      this.present.add(index);
      queueMicrotask(() => cb(null));
    } catch (e) {
      queueMicrotask(() => cb(e));
    }
  }
  get(index, options, cb) {
    if (typeof options === 'function') {
      cb = options;
      options = {};
    }
    try {
      if (this.closed || !this.present.has(index)) throw Error('Piece not available');
      const offset = options.offset || 0,
        length = options.length ?? Math.min(this.size, this.length - index * this.size) - offset;
      if (offset < 0 || length < 0 || offset + length > this.size) throw Error('Invalid range');
      const b = Buffer.alloc(length),
        fd = fs.openSync(this.file, 'r');
      try {
        if (fs.readSync(fd, b, 0, length, index * this.size + offset) !== length)
          throw Error('Incomplete piece');
      } finally {
        fs.closeSync(fd);
      }
      queueMicrotask(() => cb(null, b));
    } catch (e) {
      queueMicrotask(() => cb(e));
    }
  }
  close(cb = () => {}) {
    this.closed = true;
    queueMicrotask(cb);
  }
  destroy(cb = () => {}) {
    this.closed = true;
    try {
      fs.rmSync(this.directory, {recursive: true, force: true});
      queueMicrotask(cb);
    } catch (e) {
      queueMicrotask(() => cb(e));
    }
  }
}
const blocked = [
  ['0.0.0.0', '0.255.255.255'],
  ['10.0.0.0', '10.255.255.255'],
  ['100.64.0.0', '100.127.255.255'],
  ['127.0.0.0', '127.255.255.255'],
  ['169.254.0.0', '169.254.255.255'],
  ['172.16.0.0', '172.31.255.255'],
  ['192.168.0.0', '192.168.255.255'],
  ['224.0.0.0', '255.255.255.255'],
  ['::', '::ffff:ffff:ffff'],
  ['fc00::', 'fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'],
  ['fe80::', 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff']
].map(([start, end]) => ({start, end}));
export function trackerURLs(values) {
  return [
    ...new Set(
      (values || []).filter((value) => {
        try {
          const u = new URL(value);
          return (
            u.protocol === 'udp:' &&
            u.port &&
            Number(u.port) > 0 &&
            Number(u.port) <= 65535 &&
            !u.username &&
            !u.password &&
            value.length <= 2048
          );
        } catch {
          return false;
        }
      })
    )
  ].slice(0, 12);
}
export async function resolveTrackers(values, lookup) {
  const deny = new BlockList();
  for (const {start, end} of blocked)
    deny.addRange(start, end, start.includes(':') ? 'ipv6' : 'ipv4');
  const resolver = new Resolver({timeout: 2000, tries: 1});
  const results = await Promise.all(
    trackerURLs(values).map(async (value) => {
      try {
        const u = new URL(value),
          host = u.hostname.replace(/^\[|\]$/g, ''),
          addresses = isIP(host) ? [host] : await (lookup || ((h) => resolver.resolve4(h)))(host);
        const ip = addresses.find((a) => isIP(a) === 4 && !deny.check(a, 'ipv4'));
        if (!ip) return null;
        u.hostname = ip;
        return u.href;
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}
export function webTrackerURLs(values) {
  return [
    ...new Set(
      (values || []).filter((value) => {
        try {
          const u = new URL(value);
          return (
            ['http:', 'https:'].includes(u.protocol) &&
            !u.username &&
            !u.password &&
            value.length <= 2048
          );
        } catch {
          return false;
        }
      })
    )
  ].slice(0, 12);
}
export async function announceHTTP(value, stats, {lookup, transport, signal} = {}) {
  const u = new URL(value),
    port = u.port || (u.protocol === 'https:' ? '443' : '80');
  const pinned = await resolveTrackers(['udp://' + u.hostname + ':' + port + '/announce'], lookup);
  if (!pinned.length) throw Error('DNS: нет доступного публичного IPv4 трекера');
  const ip = new URL(pinned[0]).hostname;
  for (const key of [
    'info_hash',
    'peer_id',
    'port',
    'uploaded',
    'downloaded',
    'left',
    'compact',
    'numwant',
    'event'
  ])
    u.searchParams.delete(key);
  const binary = (hex) =>
    hex
      .match(/../g)
      .map((x) => '%' + x)
      .join('');
  const query = new URLSearchParams({
    port: String(stats.port),
    uploaded: String(stats.uploaded || 0),
    downloaded: String(stats.downloaded || 0),
    left: String(stats.left),
    compact: '1',
    numwant: '50'
  });
  if (stats.started) query.set('event', 'started');
  const suffix =
    (u.search ? '&' : '?') +
    'info_hash=' +
    binary(stats.hash) +
    '&peer_id=' +
    binary(stats.peerId) +
    '&' +
    query;
  const body = await new Promise((resolve, reject) => {
    const send = transport || (u.protocol === 'https:' ? https.request : http.request);
    const req = send(
      u,
      {
        method: 'GET',
        path: u.pathname + u.search + suffix,
        agent: false,
        signal,
        lookup: (host, opts, cb) => cb(null, opts?.all ? [{address: ip, family: 4}] : ip, 4),
        headers: {'User-Agent': 'NEXUS404', Accept: '*/*'}
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          reject(Error('HTTP ' + res.statusCode + ' от трекера'));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy(Error('Слишком большой ответ трекера'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(Error('Трекер не ответил за 12 секунд')));
    req.end();
  });
  let data;
  try {
    data = bencode.decode(body);
  } catch {
    throw Error('Некорректный ответ трекера');
  }
  if (data['failure reason']) throw Error('Трекер отклонил запрос');
  const peers = [];
  if (ArrayBuffer.isView(data.peers)) {
    const b = Buffer.from(data.peers);
    if (b.length % 6) throw Error('Некорректный список пиров');
    for (let i = 0; i < b.length; i += 6)
      peers.push({ip: [...b.subarray(i, i + 4)].join('.'), port: b.readUInt16BE(i + 4)});
  } else if (Array.isArray(data.peers))
    for (const p of data.peers) peers.push({ip: Buffer.from(p.ip || []).toString(), port: p.port});
  const deny = new BlockList();
  for (const {start, end} of blocked)
    deny.addRange(start, end, start.includes(':') ? 'ipv6' : 'ipv4');
  return {
    peers: peers
      .filter(
        (p) =>
          isIP(p.ip) === 4 &&
          !deny.check(p.ip, 'ipv4') &&
          Number.isInteger(p.port) &&
          p.port > 0 &&
          p.port <= 65535
      )
      .slice(0, 200),
    interval: Math.max(60, Math.min(3600, Number(data.interval) || 300))
  };
}
export function downloadOnly(wire) {
  // WebTorrent also unchokes on interested; uploads:0 alone does not stop pieces.
  wire.unchoke = () => wire.choke();
  wire.piece = (index, offset, buffer) => {
    if (wire.hasFast) wire.reject(index, offset, buffer.length);
  };
  wire.allowedFastSet = [];
  wire.allowedFast = () => {};
  wire.choke();
}
export class Cinema {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.options = options;
    this.active = null;
    this.job = null;
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const file = path.join(this.directory, 'cinema.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    this.db = new DatabaseSync(file);
    this.db.exec(
      `PRAGMA busy_timeout=3000;DROP TABLE IF EXISTS settings;CREATE TABLE IF NOT EXISTS titles(id TEXT PRIMARY KEY,title TEXT,kind TEXT,hash TEXT UNIQUE,metadata BLOB,created INTEGER,files TEXT DEFAULT '[]');`
    );
    if (
      !this.db
        .prepare('PRAGMA table_info(titles)')
        .all()
        .some((c) => c.name === 'trackers')
    )
      this.db.exec("ALTER TABLE titles ADD COLUMN trackers TEXT NOT NULL DEFAULT '[]'");
    for (const [name, type] of [
      ['cover', 'BLOB'],
      ['coverType', 'TEXT'],
      ['coverVersion', 'TEXT']
    ])
      if (
        !this.db
          .prepare('PRAGMA table_info(titles)')
          .all()
          .some((c) => c.name === name)
      )
        this.db.exec(`ALTER TABLE titles ADD COLUMN ${name} ${type}`);
  }
  edit(id, {title, removeCover = false}) {
    this.item(id);
    if (
      typeof title !== 'string' ||
      !title.trim() ||
      title.trim().length > 160 ||
      /[\x00-\x1f\x7f]/.test(title) ||
      typeof removeCover !== 'boolean'
    )
      throw fail('Укажи название до 160 символов');
    this.db.prepare('UPDATE titles SET title=? WHERE id=?').run(title.trim(), id);
    if (removeCover)
      this.db
        .prepare('UPDATE titles SET cover=NULL,coverType=NULL,coverVersion=NULL WHERE id=?')
        .run(id);
  }
  cover(id) {
    this.item(id);
    return this.db.prepare('SELECT cover,coverType FROM titles WHERE id=?').get(id);
  }
  setCover(id, bytes) {
    this.item(id);
    if (!bytes.length || bytes.length > 2 * 1024 ** 2) throw fail('Обложка до 2 МиБ', 413);
    const [type] = imageType(bytes);
    const used = this.db
      .prepare('SELECT coalesce(sum(length(cover)),0) n FROM titles WHERE id!=?')
      .get(id).n;
    if (used + bytes.length > 64 * 1024 ** 2) throw fail('Место для обложек заполнено', 507);
    this.db
      .prepare('UPDATE titles SET cover=?,coverType=?,coverVersion=? WHERE id=?')
      .run(bytes, type, randomUUID(), id);
  }
  item(id) {
    this.load();
    const item =
      ID.test(id) &&
      this.db
        .prepare(
          'SELECT id,title,kind,hash,metadata,created,files,trackers,coverVersion FROM titles WHERE id=?'
        )
        .get(id);
    if (!item) throw fail('Фильм не найден', 404);
    return item;
  }
  list() {
    this.load();
    return this.db
      .prepare('SELECT id,title,kind,created,files,coverVersion FROM titles ORDER BY created DESC')
      .all()
      .map((r) => ({...r, files: JSON.parse(r.files)}));
  }
  async add(input) {
    const title = String(input.title || '').trim(),
      kind = input.kind;
    if (!title || title.length > 160 || !['cinema', 'anime'].includes(kind))
      throw fail('Укажи название и тип');
    const {default: parse} = await import('parse-torrent');
    let parsed,
      metadata = null,
      trackers = [];
    if (input.bytes) {
      if (input.bytes.length > 4 * 1024 ** 2) throw fail('Torrent-файл до 4 МиБ', 413);
      metadata = Buffer.from(input.bytes);
      try {
        parsed = await parse(metadata);
      } catch {
        throw fail('Некорректный torrent-файл');
      }
      validateTorrent(parsed);
    } else {
      const value = String(input.magnet || '');
      if (value.length > 8192) throw fail('Слишком длинная ссылка');
      let u;
      try {
        u = new URL(value);
      } catch {
        throw fail('Нужна magnet-ссылка');
      }
      const xt = u.searchParams.get('xt');
      if (u.protocol !== 'magnet:' || !/^urn:btih:[a-f0-9]{40}$/i.test(xt || ''))
        throw fail('Нужна magnet-ссылка BitTorrent v1 с 40-значным хешем');
      parsed = {infoHash: xt.slice(9).toLowerCase()};
      trackers = [
        ...trackerURLs(u.searchParams.getAll('tr')),
        ...webTrackerURLs(u.searchParams.getAll('tr'))
      ];
    }
    this.load();
    if (this.db.prepare('SELECT count(*) n FROM titles').get().n >= 500)
      throw fail('Не больше 500 раздач', 409);
    const old = this.db.prepare('SELECT id FROM titles WHERE hash=?').get(parsed.infoHash);
    if (old) {
      if (trackers.length)
        this.db
          .prepare('UPDATE titles SET trackers=? WHERE id=?')
          .run(JSON.stringify(trackers), old.id);
      return {id: old.id, duplicate: true};
    }
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO titles(id,title,kind,hash,metadata,created,trackers) VALUES(?,?,?,?,?,?,?)'
      )
      .run(id, title, kind, parsed.infoHash, metadata, Date.now(), JSON.stringify(trackers));
    return {id};
  }
  async client() {
    if (this.engine) return this.engine;
    const {default: WebTorrent} = await import('webtorrent');
    this.engine = new WebTorrent({
      dht: {
        bootstrap: ['dht.libtorrent.org:25401', 'dht.anacrolix.link:42069', 'dht.aelitis.com:6881']
      },
      tracker: {udp: true, http: false, ws: false},
      lsd: false,
      webSeeds: false,
      utp: false,
      natUpnp: false,
      natPmp: false,
      maxConns: 30,
      blocklist: blocked,
      ...this.options.client
    });
    this.engine.on('error', () => {
      this.error = 'Ошибка торрент-соединения';
    });
    return this.engine;
  }
  async open(id) {
    if (this.active?.id === id && this.active.torrent.ready && !this.active.torrent.destroyed)
      return this.status();
    if (this.job) throw fail('Дождись получения метаданных текущей раздачи', 409);
    this.job = this.prepare(id);
    try {
      return await this.job;
    } finally {
      this.job = null;
    }
  }
  async prepare(id) {
    const item = this.item(id);
    await this.stop();
    const engine = await this.client();
    let source = item.hash,
      trackers = JSON.parse(item.trackers);
    if (item.metadata) {
      const {default: parse} = await import('parse-torrent');
      source = await parse(Buffer.from(item.metadata));
      trackers = source.announce || [];
      source.announce = [];
      source.urlList = [];
    }
    const announce = await resolveTrackers(trackers, this.options.lookup),
      webTrackers = webTrackerURLs(trackers);
    const cache = path.join(this.directory, 'cache');
    fs.mkdirSync(cache, {recursive: true, mode: 0o700});
    const disk = fs.statfsSync(cache);
    if (disk.bavail * disk.bsize < 256 * 1024 ** 2) throw fail('Недостаточно места на диске', 507);
    this.error = null;
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        err ? reject(err) : resolve(this.status());
      };
      const torrent = engine.add(source, {
        path: cache,
        store: PieceStore,
        deselect: true,
        storeCacheSlots: 2,
        announce,
        uploads: 0
      });
      torrent.on('wire', downloadOnly);
      this.active = {
        id,
        torrent,
        started: Date.now(),
        lastData: null,
        selected: null,
        trackers: announce.length + webTrackers.length,
        trackerReplies: 0,
        dhtReplies: 0,
        warnings: 0,
        warning: null,
        webTimers: new Set(),
        controller: new AbortController()
      };
      const active = this.active;
      const poll = async (url, started = true) => {
        let interval = 60;
        try {
          const result = await announceHTTP(
            url,
            {
              hash: item.hash,
              peerId: engine.peerId,
              port: engine.torrentPort,
              uploaded: torrent.uploaded,
              downloaded: torrent.downloaded,
              left: torrent.length ? Math.max(0, torrent.length - (torrent.downloaded || 0)) : 1,
              started
            },
            {lookup: this.options.lookup, signal: active.controller.signal}
          );
          if (this.active !== active) return;
          active.trackerReplies++;
          interval = result.interval;
          for (const peer of result.peers) torrent.addPeer(peer.ip + ':' + peer.port);
        } catch (e) {
          if (this.active !== active) return;
          active.warnings++;
          active.warning = /HTTP \d+|DNS:|12 секунд|Некорректный|отклонил|большой ответ/.test(
            e.message
          )
            ? e.message
            : 'Ошибка подключения к HTTP-трекеру';
        }
        if (this.active === active) {
          const timer = setTimeout(() => {
            active.webTimers.delete(timer);
            void poll(url, false);
          }, interval * 1000);
          timer.unref?.();
          active.webTimers.add(timer);
        }
      };
      if (item.metadata)
        torrent.once('ready', () => {
          for (const url of webTrackers) void poll(url);
        });
      if (!item.metadata && webTrackers.length) {
        const start = () => {
          if (this.active === active) for (const url of webTrackers) void poll(url);
        };
        if (engine.listening) start();
        else engine.once('listening', start);
      }
      for (const [event, key] of [
        ['trackerAnnounce', 'trackerReplies'],
        ['dhtAnnounce', 'dhtReplies'],
        ['warning', 'warnings']
      ])
        torrent.on(event, () => {
          if (this.active?.torrent === torrent) this.active[key]++;
        });
      torrent.on('download', () => {
        if (this.active?.torrent === torrent) this.active.lastData = Date.now();
      });
      const timer = setTimeout(() => {
        this.error = 'Не удалось получить метаданные за 90 секунд. Проверь наличие пиров.';
        finish(fail(this.error, 504));
        torrent.destroy();
        this.active = null;
      }, 90000);
      timer.unref?.();
      torrent.once('close', () => finish(fail('Раздача остановлена', 409)));
      torrent.on('error', () => {
        this.error = 'Раздача остановлена: ошибка сети, данных или диска';
        finish(fail(this.error, 503));
      });
      torrent.on('metadata', () => {
        try {
          validateTorrent(torrent);
          const available = fs.statfsSync(cache);
          if (available.bavail * available.bsize < torrent.length + 128 * 1024 ** 2)
            throw fail('Для раздачи недостаточно свободного места', 507);
        } catch (e) {
          torrent.destroy();
          this.active = null;
          finish(e);
        }
      });
      torrent.once('ready', () => {
        const files = torrent.files.map((f, index) => ({
          index,
          name: f.name,
          length: f.length,
          type: f.type,
          playable: /\.(mp4|m4v|webm|mkv|mov|ogg|ogv)$/i.test(f.name)
        }));
        this.db.prepare('UPDATE titles SET files=? WHERE id=?').run(JSON.stringify(files), id);
        finish();
      });
    });
  }
  status() {
    const a = this.active,
      t = a?.torrent;
    return {
      id: a?.id ?? null,
      ready: Boolean(t?.ready && !t.destroyed),
      elapsed: a ? Math.floor((Date.now() - a.started) / 1000) : 0,
      stage: this.error
        ? 'error'
        : !t
          ? 'stopped'
          : !t.ready
            ? 'metadata'
            : a.selected === null
              ? 'ready'
              : t.downloadSpeed > 0
                ? 'downloading'
                : t.numPeers
                  ? 'waiting'
                  : 'peers',
      lastData: a?.lastData ?? null,
      trackers: a?.trackers ?? 0,
      trackerReplies: a?.trackerReplies ?? 0,
      dhtReplies: a?.dhtReplies ?? 0,
      dhtNodes: this.engine?.dht?.toJSON?.().nodes.length ?? 0,
      warnings: a?.warnings ?? 0,
      warning: a?.warning ?? null,
      progress: t?.progress || 0,
      downloaded: t?.downloaded || 0,
      speed: t?.downloadSpeed || 0,
      peers: t?.numPeers || 0,
      error: this.error || null,
      files: t?.ready ? JSON.parse(this.item(a.id).files) : []
    };
  }
  file(id, index) {
    if (this.active?.id !== id || !this.active.torrent.ready || this.active.torrent.destroyed)
      throw fail('Сначала открой раздачу', 409);
    if (!Number.isInteger(index) || index < 0) throw fail('Некорректный файл');
    const f = this.active.torrent.files[index];
    if (!f || !f.length || !/\.(mp4|m4v|webm|mkv|mov|ogg|ogv)$/i.test(f.name))
      throw fail('Видеофайл не найден', 404);
    this.active.selected = index;
    return f;
  }
  async stop() {
    this.converter?.();
    this.converter = null;
    if (this.active) {
      this.active.controller?.abort();
      for (const timer of this.active.webTimers || []) clearTimeout(timer);
      const t = this.active.torrent;
      this.active = null;
      if (!t.destroyed) await new Promise((r) => t.destroy(r));
    }
    fs.rmSync(path.join(this.directory, 'cache'), {recursive: true, force: true});
  }
  async remove(id) {
    if (this.job) throw fail('Дождись открытия раздачи', 409);
    this.item(id);
    if (this.active?.id === id) await this.stop();
    this.db.prepare('DELETE FROM titles WHERE id=?').run(id);
  }
  async close() {
    await this.stop();
    if (this.engine && !this.engine.destroyed) await new Promise((r) => this.engine.destroy(r));
    this.db?.close();
  }
}
