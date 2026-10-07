import {ID, fail} from '../../src/input.mjs';
export {ID, fail} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const MAX_FILE = 64 * 1024 * 1024;
export const MAX_TOTAL = 2 * 1024 * 1024 * 1024;
const name = (value, max = 180) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f\\/]/.test(value)
  )
    throw fail('Некорректное название');
  return value.trim();
};
const inspect = (bytes, filename) => {
  const starts = (...values) => values.every((v, i) => bytes[i] === v);
  if (starts(0xff, 0xd8, 0xff)) return {type: 'image/jpeg', ext: 'jpg'};
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return {type: 'image/png', ext: 'png'};
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
    return {type: 'image/webp', ext: 'webp'};
  if (/^GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return {type: 'image/gif', ext: 'gif'};
  if (bytes.toString('ascii', 0, 5) === '%PDF-') return {type: 'application/pdf', ext: 'pdf'};
  if (starts(0x50, 0x4b, 0x03, 0x04)) return {type: 'application/zip', ext: 'zip'};
  if (bytes.toString('ascii', 0, 3) === 'ID3' || starts(0xff, 0xfb))
    return {type: 'audio/mpeg', ext: 'mp3'};
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return {type: 'video/mp4', ext: 'mp4'};
  if (/\.txt$/i.test(filename)) return {type: 'text/plain', ext: 'txt'};
  throw fail('Тип файла не поддерживается', 415);
};

export class Storage {
  constructor(directory) {
    this.directory = directory;
    this.reserved = 0;
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    fs.mkdirSync(path.join(this.directory, 'blobs'), {recursive: true, mode: 0o700});
    fs.mkdirSync(path.join(this.directory, 'tmp'), {recursive: true, mode: 0o700});
    const file = path.join(this.directory, 'storage.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS folders(id TEXT PRIMARY KEY, parent TEXT, name TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, folder TEXT, name TEXT NOT NULL,
        type TEXT NOT NULL, size INTEGER NOT NULL, created INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS refs(file TEXT NOT NULL, kind TEXT NOT NULL, object TEXT NOT NULL,
        PRIMARY KEY(file,kind,object), FOREIGN KEY(file) REFERENCES files(id) ON DELETE CASCADE);`);
    for (const entry of fs.readdirSync(path.join(this.directory, 'tmp')))
      if (ID.test(entry)) fs.rmSync(path.join(this.directory, 'tmp', entry), {force: true});
    for (const entry of fs.readdirSync(path.join(this.directory, 'blobs')))
      if (ID.test(entry) && !this.db.prepare('SELECT 1 FROM files WHERE id=?').get(entry))
        fs.rmSync(path.join(this.directory, 'blobs', entry), {force: true});
  }
  stats() {
    this.load();
    return {
      ...this.db
        .prepare('SELECT count(*) AS files, coalesce(sum(size),0) AS used FROM files')
        .get(),
      limit: MAX_TOTAL
    };
  }
  folder(id) {
    if (id === null) return null;
    if (!ID.test(id)) throw fail('Папка не найдена', 404);
    const item = this.db.prepare('SELECT * FROM folders WHERE id=? AND deleted=0').get(id);
    if (!item) throw fail('Папка не найдена', 404);
    return item;
  }
  list(query = '') {
    this.load();
    const q =
      '%' +
      String(query)
        .slice(0, 100)
        .replace(/[%_\\]/g, '\\$&') +
      '%';
    return {
      stats: this.stats(),
      folders: this.db
        .prepare(
          "SELECT * FROM folders WHERE deleted=0 AND name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 500"
        )
        .all(q),
      files: this.db
        .prepare(
          "SELECT * FROM files WHERE deleted=0 AND name LIKE ? ESCAPE '\\' ORDER BY created DESC LIMIT 1000"
        )
        .all(q)
    };
  }
  trash() {
    this.load();
    return this.db
      .prepare('SELECT * FROM files WHERE deleted>0 ORDER BY deleted DESC LIMIT 1000')
      .all();
  }
  createFolder(label, parent = null) {
    this.load();
    this.folder(parent);
    const folder = {id: randomUUID(), parent, name: name(label)};
    this.db
      .prepare('INSERT INTO folders(id,parent,name) VALUES(?,?,?)')
      .run(folder.id, parent, folder.name);
    return folder;
  }
  renameFolder(id, label) {
    this.load();
    this.folder(id);
    this.db.prepare('UPDATE folders SET name=? WHERE id=?').run(name(label), id);
  }
  deleteFolder(id) {
    this.load();
    this.folder(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const ids = this.db
        .prepare(
          `WITH RECURSIVE tree(id) AS (SELECT id FROM folders WHERE id=? AND deleted=0 UNION SELECT f.id FROM folders f JOIN tree t ON f.parent=t.id WHERE f.deleted=0) SELECT id FROM tree`
        )
        .all(id);
      let files = 0;
      for (const folder of ids) {
        files += this.db
          .prepare('UPDATE files SET deleted=?,version=version+1 WHERE folder=? AND deleted=0')
          .run(Date.now(), folder.id).changes;
        this.db.prepare('UPDATE folders SET deleted=1 WHERE id=?').run(folder.id);
      }
      this.db.exec('COMMIT');
      return {ok: true, files};
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  file(id, deleted = false) {
    this.load();
    if (!ID.test(id)) throw fail('Файл не найден', 404);
    const item = this.db.prepare('SELECT * FROM files WHERE id=?').get(id);
    if (!item || Boolean(item.deleted) !== deleted) throw fail('Файл не найден', 404);
    return item;
  }
  async upload(request, filename, folder, allowed = () => true, complete = () => {}) {
    this.load();
    filename = name(filename);
    this.folder(folder);
    const length = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 1 || length > MAX_FILE)
      throw fail('Размер файла — от 1 байта до 64 МБ', 413);
    if (this.stats().used + this.reserved + length > MAX_TOTAL)
      throw fail('В хранилище нет свободного места', 507);
    this.reserved += length;
    const id = randomUUID(),
      temp = path.join(this.directory, 'tmp', id),
      target = path.join(this.directory, 'blobs', id);
    let fd,
      moved = false,
      committed = false,
      size = 0,
      head = Buffer.alloc(0);
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      for await (const chunk of request) {
        size += chunk.length;
        if (size > length || size > MAX_FILE || !allowed()) throw fail('Загрузка прервана', 400);
        if (head.length < 512) head = Buffer.concat([head, chunk.subarray(0, 512 - head.length)]);
        fs.writeFileSync(fd, chunk);
      }
      if (size !== length || !allowed()) throw fail('Загрузка прервана', 400);
      const {type} = inspect(head, filename);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (type === 'text/plain') {
        const decoder = new TextDecoder('utf-8', {fatal: true});
        try {
          for await (const chunk of fs.createReadStream(temp)) {
            if (chunk.includes(0)) throw Error();
            decoder.decode(chunk, {stream: true});
          }
          decoder.decode();
        } catch {
          throw fail('Текст должен быть UTF-8 без нулевых байтов', 415);
        }
      }
      if (!allowed()) throw fail('Загрузка прервана', 400);
      this.folder(folder);
      if (this.stats().used + size > MAX_TOTAL) throw fail('В хранилище нет свободного места', 507);
      fs.renameSync(temp, target);
      moved = true;
      const created = Date.now();
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db
          .prepare('INSERT INTO files(id,folder,name,type,size,created) VALUES(?,?,?,?,?,?)')
          .run(id, folder, filename, type, size, created);
        complete(id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
      committed = true;
      return {id, folder, name: filename, type, size, created};
    } catch (e) {
      if (e.code === 'ENOSPC') throw fail('Недостаточно места на диске', 507);
      throw e;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, {force: true});
      if (moved && !committed) fs.rmSync(target, {force: true});
      this.reserved -= length;
    }
  }
  rename(id, label, version) {
    const item = this.file(id);
    if (item.version !== version) throw fail('Файл изменён в другой вкладке', 409);
    if (
      !this.db
        .prepare('UPDATE files SET name=?,version=version+1 WHERE id=? AND version=? AND deleted=0')
        .run(name(label), id, version).changes
    )
      throw fail('Файл изменён в другой вкладке', 409);
  }
  move(id, folder, version) {
    const item = this.file(id);
    this.folder(folder);
    if (item.version !== version) throw fail('Файл изменён в другой вкладке', 409);
    if (
      !this.db
        .prepare(
          'UPDATE files SET folder=?,version=version+1 WHERE id=? AND version=? AND deleted=0'
        )
        .run(folder, id, version).changes
    )
      throw fail('Файл изменён в другой вкладке', 409);
  }
  delete(id) {
    this.file(id);
    this.db.prepare('UPDATE files SET deleted=?,version=version+1 WHERE id=?').run(Date.now(), id);
  }
  restore(id) {
    const item = this.file(id, true);
    if (
      item.folder &&
      !this.db.prepare('SELECT 1 FROM folders WHERE id=? AND deleted=0').get(item.folder)
    )
      this.db.prepare('UPDATE files SET folder=NULL WHERE id=?').run(id);
    this.db.prepare('UPDATE files SET deleted=0,version=version+1 WHERE id=?').run(id);
  }
  purge(id) {
    this.file(id, true);
    const blob = path.join(this.directory, 'blobs', id),
      temp = path.join(this.directory, 'tmp', id);
    const exists = fs.existsSync(blob);
    if (exists) fs.renameSync(blob, temp);
    try {
      this.db.prepare('DELETE FROM files WHERE id=?').run(id);
    } catch (e) {
      if (exists) fs.renameSync(temp, blob);
      throw e;
    }
    fs.rmSync(temp, {force: true});
  }
  attach(id, kind, object) {
    this.file(id);
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(kind) || typeof object !== 'string' || !ID.test(object))
      throw fail('Некорректная привязка');
    this.db.prepare('INSERT OR IGNORE INTO refs VALUES(?,?,?)').run(id, kind, object);
  }
  detach(id, kind, object) {
    this.file(id);
    this.db.prepare('DELETE FROM refs WHERE file=? AND kind=? AND object=?').run(id, kind, object);
  }
  references(id) {
    this.file(id);
    return this.db.prepare('SELECT kind,object FROM refs WHERE file=?').all(id);
  }
}
