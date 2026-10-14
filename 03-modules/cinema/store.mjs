import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {BlockList, isIP} from 'node:net';
import {Resolver} from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import bencode from 'bencode';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {imageType} from '#hub/content-store.mjs';
import {ID, fail} from '#hub/input.mjs';
const MAX = 8 * 1024 ** 3;
export function isVideo(file) {
  return file?.length > 0 && /\.(mp4|m4v|webm|mkv|mov|ogv)$/i.test(file.name);
}
export function videoFiles(files = []) {
  return files.map((f, index) => ({index, name: f.name, length: f.length,
    type: f.type, playable: isVideo(f)})).filter(f => f.playable);
}
export function videoPiece(torrent, file, index) {
  return isVideo(file) && Number.isInteger(index) &&
    index >= Math.floor(file.offset / torrent.pieceLength) &&
    index <= Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
}
export function videoDownloaded(torrent, file) {
  if (!isVideo(file)) return 0;
  let bytes = 0;
  const end = file.offset + file.length;
  for (let i = Math.floor(file.offset / torrent.pieceLength); i * torrent.pieceLength < end; i++)
    if (torrent.bitfield.get(i)) bytes += Math.min(end, (i + 1) * torrent.pieceLength) -
      Math.max(file.offset, i * torrent.pieceLength);
  return bytes;
}
// WebTorrent 3.0.21 can request allowed-fast pieces outside selections. Gate its
// scheduler before reservations, including before the user chooses a video.
export function restrictVideo(torrent, selected) {
  const request = torrent._request;
  torrent._request = function(wire, index, hotswap) {
    return videoPiece(this, selected(), index) ? request.call(this, wire, index, hotswap) : false;
  };
}
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
  if (!t.files.some(isVideo)) throw fail('В раздаче нет поддерживаемого видео: MP4, M4V, WebM, MKV, MOV или OGV');
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
  // Keep metadata requests/downloads for magnets, but never serve metadata.
  if (wire.ut_metadata) {
    wire.ut_metadata._onRequest = piece => wire.ut_metadata._reject(piece);
    wire.ut_metadata._data = piece => wire.ut_metadata._reject(piece);
  }
  wire.choke();
}
export class Cinema {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.options = options;
    this.active = null;
    this.job = null;
    this.generation = 0;
    this.closed = false;
    this.streams = new Set();
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
      .map((r) => ({...r, files: JSON.parse(r.files).filter(isVideo)}));
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
    if (this.closed) throw fail('Дионис остановлен', 409);
    if (this.engine) return this.engine;
    const {default: WebTorrent} = await import('webtorrent');
    if (this.closed) throw fail('Дионис остановлен', 409);
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
    if (this.closed) throw fail('Дионис остановлен', 409);
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
    const stopping = this.stop(), generation = this.generation;
    const current = () => {
      if (this.closed || generation !== this.generation) throw fail('Раздача остановлена', 409);
    };
    await stopping;
    current();
    const engine = await this.client();
    current();
    let source = item.hash,
      trackers = JSON.parse(item.trackers);
    if (item.metadata) {
      const {default: parse} = await import('parse-torrent');
      source = await parse(Buffer.from(item.metadata));
      trackers = source.announce || [];
      source.announce = [];
      source.urlList = [];
    }
    current();
    const announce = await resolveTrackers(trackers, this.options.lookup),
      webTrackers = webTrackerURLs(trackers);
    current();
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
      restrictVideo(torrent, () => this.active === active && torrent.files?.[active.selected]);
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
          if (this.active !== active || active.controller.signal.aborted) return;
          active.trackerReplies++;
          interval = result.interval;
          for (const peer of result.peers) torrent.addPeer(peer.ip + ':' + peer.port);
        } catch (e) {
          if (this.active !== active || active.controller.signal.aborted) return;
          active.warnings++;
          active.warning = /HTTP \d+|DNS:|12 секунд|Некорректный|отклонил|большой ответ/.test(
            e.message
          )
            ? e.message
            : 'Ошибка подключения к HTTP-трекеру';
        }
        if (this.active === active && !active.controller.signal.aborted) {
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
        active.controller.abort();
        for (const pending of active.webTimers) clearTimeout(pending);
        active.teardown = new Promise(resolve => torrent.destroy(resolve));
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
        } catch (e) {
          this.error = e.message;
          finish(e);
          active.controller.abort();
          for (const pending of active.webTimers) clearTimeout(pending);
          active.teardown = new Promise(resolve => torrent.destroy(resolve));
        }
      });
      torrent.once('ready', () => {
        if (this.active !== active || torrent.destroyed) return;
        const files = videoFiles(torrent.files);
        this.db.prepare('UPDATE titles SET files=? WHERE id=?').run(JSON.stringify(files), id);
        finish();
      });
    });
  }
  status() {
    const a = this.active,
      t = a?.torrent,
      selected = t?.files?.[a?.selected],
      downloaded = selected && !t.destroyed ? videoDownloaded(t, selected) : 0;
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
      progress: selected ? downloaded / selected.length : 0,
      downloaded,
      total: selected?.length || 0,
      speed: t?.downloadSpeed || 0,
      peers: t?.numPeers || 0,
      error: this.error || null,
      files: t?.ready && !t.destroyed ? videoFiles(t.files) : []
    };
  }
  file(id, index) {
    if (this.active?.id !== id || !this.active.torrent.ready || this.active.torrent.destroyed)
      throw fail('Сначала открой раздачу', 409);
    if (!Number.isInteger(index) || index < 0) throw fail('Некорректный файл');
    const f = this.active.torrent.files[index];
    if (!isVideo(f))
      throw fail('Видеофайл не найден', 404);
    if (this.active.selected !== index) {
      // Close old readers before admitting requests for a different video.
      this.active.selected = null;
      this.stopStreams();
      for (const wire of this.active.torrent.wires || [])
        for (const r of [...wire.requests]) wire.cancel(r.piece, r.offset, r.length);
      this.active.selected = index;
    }
    return f;
  }
  stopStreams() {
    for (const abort of this.streams) abort();
    this.streams.clear();
    this.converter?.();
    this.converter = null;
  }
  stream(file, {start = 0, end = file.length - 1} = {}) {
    const t = this.active?.torrent;
    if (!t || t.files[this.active.selected] !== file || !isVideo(file))
      throw fail('Видеофайл не выбран', 409);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 ||
        end < start || end >= file.length) throw fail('Некорректный диапазон', 416);
    const controller = new AbortController(), {signal} = controller;
    // Explicit bounds also fix WebTorrent's end=0 fallback to the entire file.
    const chunks = async function* () {
      const first = Math.floor((file.offset + start) / t.pieceLength),
        last = Math.floor((file.offset + end) / t.pieceLength);
      // Stream selections are separate: overlapping browser ranges must not
      // deselect each other (pinned WebTorrent 3.0.21 selection API).
      if (signal.aborted || t.destroyed) return;
      t._select(first, last, 1, null, true);
      try {
        for (let index = first; index <= last; index++) {
          if (signal.aborted || t.destroyed) return;
          if (!t.bitfield.get(index)) await new Promise((resolve, reject) => {
            const cleanup = () => {
              t.removeListener('verified', verified);
              t.removeListener('close', stopped);
              t.removeListener('error', failed);
              signal.removeEventListener('abort', stopped);
            };
            const stopped = () => { cleanup(); resolve(); };
            const failed = error => { cleanup(); reject(error); };
            const verified = piece => { if (piece === index) stopped(); };
            t.on('verified', verified); t.once('close', stopped); t.once('error', failed);
            signal.addEventListener('abort', stopped, {once: true});
            t.critical(index, Math.min(last, index + 2));
          });
          if (signal.aborted || t.destroyed) return;
          const offset = Math.max(0, file.offset + start - index * t.pieceLength),
            length = Math.min((index + 1) * t.pieceLength, file.offset + end + 1) -
              (index * t.pieceLength + offset);
          const buffer = await new Promise((resolve, reject) =>
            t.store.get(index, {offset, length}, (err, data) => err ? reject(err) : resolve(data)));
          if (signal.aborted || t.destroyed) return;
          yield buffer;
        }
      } finally {
        if (!t.destroyed) t._deselect(first, last, true);
      }
    };
    const stream = Readable.from(chunks()), destroy = stream.destroy;
    // Wake pending piece waits before Readable.from waits for iterator.return().
    stream.destroy = function(error) { controller.abort(); return destroy.call(this, error); };
    const abort = () => stream.destroy();
    this.streams.add(abort);
    stream.once('close', () => { controller.abort(); this.streams.delete(abort); });
    return stream;
  }
  stop() {
    this.generation++;
    // Serialize teardown so an earlier stop cannot delete a newer torrent's cache.
    const job = (this.stopping ?? Promise.resolve()).catch(() => {}).then(() => this.clearActive());
    this.stopping = job;
    return job.finally(() => { if (this.stopping === job) this.stopping = null; });
  }
  async clearActive() {
    this.stopStreams();
    if (this.active) {
      this.active.controller?.abort();
      for (const timer of this.active.webTimers || []) clearTimeout(timer);
      const {torrent: t, teardown} = this.active;
      this.active = null;
      if (teardown) await teardown;
      else if (!t.destroyed) await new Promise((r) => t.destroy(r));
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
    this.closed = true;
    await this.stop();
    await this.job?.catch(() => {});
    if (this.engine && !this.engine.destroyed) await new Promise((r) => this.engine.destroy(r));
    this.db?.close();
    this.db = null;
  }
}
