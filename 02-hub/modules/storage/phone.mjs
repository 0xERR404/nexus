import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readJSON, readBytes, fail} from '../../src/input.mjs';
const hash = (data) => createHash('sha256').update(data).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
export class PhoneUploads {
  constructor(storage, gallery) {
    this.storage = storage;
    this.gallery = gallery;
    this.busy = new Set();
  }
  load() {
    this.storage.load();
    this.db = this.storage.db;
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS phone_sources(id TEXT PRIMARY KEY,name TEXT NOT NULL,target TEXT NOT NULL,destination TEXT NOT NULL,token TEXT UNIQUE,created INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS phone_receipts(source TEXT NOT NULL,digest TEXT NOT NULL,file TEXT NOT NULL,PRIMARY KEY(source,digest));`
    );
  }
  list() {
    this.load();
    return this.db
      .prepare(
        'SELECT id,name,target,destination,created,token IS NOT NULL AS enabled FROM phone_sources ORDER BY created DESC'
      )
      .all();
  }
  create(data) {
    this.load();
    if (
      typeof data.name !== 'string' ||
      !data.name.trim() ||
      data.name.length > 80 ||
      /[\x00-\x1f\\/]/.test(data.name) ||
      !['storage', 'gallery'].includes(data.target)
    )
      throw fail('Укажи название и назначение');
    if (this.list().filter((s) => s.enabled).length >= 10)
      throw fail('Не более 10 подключённых папок');
    const name = data.name.trim(),
      destination = data.target === 'storage' ? this.storage.createFolder(name).id : name;
    if (data.target === 'gallery') this.gallery().album(name);
    const token = randomBytes(32).toString('base64url'),
      id = randomUUID();
    this.db
      .prepare('INSERT INTO phone_sources VALUES(?,?,?,?,?,?)')
      .run(id, name, data.target, destination, hash(token), Date.now());
    return {id, token};
  }
  revoke(id) {
    this.load();
    this.db.prepare('UPDATE phone_sources SET token=NULL WHERE id=?').run(String(id));
    return {ok: true};
  }
  auth(header) {
    this.load();
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header ?? '');
    const source =
      token && this.db.prepare('SELECT * FROM phone_sources WHERE token=?').get(hash(token[1]));
    if (!source) throw fail('Ключ папки отозван или неверен', 401);
    return source;
  }
  receipt(source, digest) {
    return this.db
      .prepare('SELECT file FROM phone_receipts WHERE source=? AND digest=?')
      .get(source.id, digest);
  }
  async handle(request) {
    try {
      if (request.method !== 'POST' || request.headers.origin) throw fail('Метод недоступен', 405);
      const source = this.auth(request.headers.authorization),
        allowed = () => {
          try {
            return this.auth(request.headers.authorization).id === source.id;
          } catch {
            return false;
          }
        };
      if (request.headers['content-type']?.split(';')[0] === 'application/json') {
        const data = await readJSON(request, 8192);
        if (!allowed()) throw fail('Ключ отозван', 401);
        if (data.type === 'hello')
          return Response.json({
            state: 'ready',
            name: source.name,
            target: source.target,
            maxBytes: (source.target === 'gallery' ? 20 : 64) * 1048576
          });
        if (data.type === 'probe' && digestPattern.test(data.hash))
          return Response.json({received: !!this.receipt(source, data.hash)});
        throw fail('Неизвестная команда');
      }
      if (request.headers['content-type'] !== 'application/octet-stream')
        throw fail('Нужен файл', 415);
      const digest = request.headers['x-content-sha256'];
      if (!digestPattern.test(digest ?? '')) throw fail('Нужна SHA-256');
      if (this.busy.size >= 3) throw fail('Дождись завершения загрузок', 429);
      const key = source.id + ':' + digest;
      if (this.busy.has(key)) throw fail('Этот файл уже загружается', 409);
      const previous = this.receipt(source, digest);
      if (previous) return Response.json({id: previous.file, duplicate: true});
      if (this.db.prepare('SELECT COUNT(*) n FROM phone_receipts').get().n >= 100000)
        throw fail('Достигнут лимит автозагрузок', 507);
      let relative;
      try {
        relative = decodeURIComponent(request.headers['x-file-name'] ?? '');
      } catch {
        throw fail('Некорректное имя');
      }
      const parts = relative.split('/');
      if (
        parts.length > 16 ||
        parts.some(
          (p) => !p || p === '.' || p === '..' || p.length > 180 || /[\x00-\x1f\\]/.test(p)
        )
      )
        throw fail('Некорректный путь');
      const filename = parts.pop();
      this.busy.add(key);
      try {
        const record = (id) => {
          if (!allowed()) throw fail('Ключ отозван', 401);
          this.db.prepare('INSERT INTO phone_receipts VALUES(?,?,?)').run(source.id, digest, id);
        };
        let item;
        if (source.target === 'gallery') {
          const size = Number(request.headers['content-length']);
          if (!Number.isSafeInteger(size) || size < 1 || size > 20 * 1048576)
            throw fail('Изображение — до 20 МБ', 413);
          const bytes = await readBytes(request, 20 * 1048576);
          if (bytes.length !== size || hash(bytes) !== digest)
            throw fail('Файл изменён или передан не полностью');
          if (!allowed()) throw fail('Ключ отозван', 401);
          const gallery = this.gallery(),
            images = gallery.images().images;
          if (
            !images.some((i) => i.digest === digest) &&
            images.reduce((n, i) => n + i.size, 0) + size > 2 * 1024 * 1048576
          )
            throw fail('Лимит Пинакотеки для автозагрузки — 2 ГБ', 507);
          item = await gallery.upload(bytes, filename, allowed, source.destination);
          record(item.id);
        } else {
          let folder = source.destination;
          this.storage.folder(folder);
          for (const name of parts) {
            const found = this.db
              .prepare('SELECT id FROM folders WHERE parent=? AND name=? AND deleted=0')
              .get(folder, name);
            folder = found?.id ?? this.storage.createFolder(name, folder).id;
          }
          const stream = {
            headers: request.headers,
            async *[Symbol.asyncIterator]() {
              const checksum = createHash('sha256');
              for await (const chunk of request) {
                checksum.update(chunk);
                yield chunk;
              }
              if (checksum.digest('hex') !== digest) throw fail('Контрольная сумма не совпала');
            }
          };
          item = await this.storage.upload(stream, filename, folder, allowed, record);
        }
        return Response.json({id: item.id, duplicate: false}, {status: 201});
      } finally {
        this.busy.delete(key);
      }
    } catch (e) {
      return Response.json(
        {error: e.status ? e.message : 'Автозагрузка временно недоступна'},
        {status: e.status ?? 503}
      );
    }
  }
}
