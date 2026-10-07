import {ID, fail} from '../../src/input.mjs';
export {ID, fail} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {validateZip} from './zip.mjs';

export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const clean = (value, max) => {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    throw fail('Некорректный текст');
  return value.trim();
};
const digest = (value) => createHash('sha256').update(value).digest('hex');

export class Projects {
  constructor(directory) {
    this.directory = directory;
    this.reserved = 0;
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    for (const name of ['releases', 'tmp'])
      fs.mkdirSync(path.join(this.directory, name), {recursive: true, mode: 0o700});
    const file = path.join(this.directory, 'projects.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        selected TEXT, enabled INTEGER NOT NULL DEFAULT 0, token TEXT, token_hash TEXT UNIQUE, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY, project TEXT NOT NULL, version TEXT NOT NULL,
        notes TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, expanded INTEGER NOT NULL,
        entries INTEGER NOT NULL, created INTEGER NOT NULL, UNIQUE(project,version),
        FOREIGN KEY(project) REFERENCES projects(id));
      CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL,
        release TEXT, time INTEGER NOT NULL, result TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS deliveries_project ON deliveries(project,time);`);
    if (
      !this.db
        .prepare('PRAGMA table_info(releases)')
        .all()
        .some((column) => column.name === 'entrypoint')
    )
      this.db.exec("ALTER TABLE releases ADD COLUMN entrypoint TEXT NOT NULL DEFAULT 'install.sh'");
    if (
      !this.db
        .prepare('PRAGMA table_info(releases)')
        .all()
        .some((column) => column.name === 'runner')
    )
      this.db.exec("ALTER TABLE releases ADD COLUMN runner TEXT NOT NULL DEFAULT 'sh'");
    for (const name of fs.readdirSync(path.join(this.directory, 'tmp')))
      if (ID.test(name)) fs.rmSync(path.join(this.directory, 'tmp', name), {force: true});
    for (const name of fs.readdirSync(path.join(this.directory, 'releases')))
      if (ID.test(name) && !this.db.prepare('SELECT 1 FROM releases WHERE id=?').get(name))
        fs.rmSync(path.join(this.directory, 'releases', name), {force: true});
  }
  project(id) {
    this.load();
    if (!ID.test(id)) throw fail('Проект не найден', 404);
    const item = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id);
    if (!item) throw fail('Проект не найден', 404);
    return item;
  }
  list() {
    this.load();
    return this.db
      .prepare(
        'SELECT id,name,description,selected,enabled,created FROM projects ORDER BY created DESC'
      )
      .all();
  }
  detail(id) {
    const project = this.project(id);
    return {
      project: {...project, token_hash: undefined},
      releases: this.db
        .prepare('SELECT * FROM releases WHERE project=? ORDER BY created DESC')
        .all(id),
      deliveries: this.db
        .prepare(
          'SELECT release,time,result FROM deliveries WHERE project=? ORDER BY id DESC LIMIT 100'
        )
        .all(id)
    };
  }
  create(label, description = '') {
    this.load();
    const project = {
      id: randomUUID(),
      name: clean(label, 120),
      description: description ? clean(description, 500) : '',
      created: Date.now()
    };
    this.db
      .prepare('INSERT INTO projects(id,name,description,created) VALUES(?,?,?,?)')
      .run(project.id, project.name, project.description, project.created);
    return project;
  }
  edit(id, name, description = '') {
    this.project(id);
    name = clean(name, 120);
    if (typeof description !== 'string') throw fail('Некорректное описание');
    description = description.trim() ? clean(description, 500) : '';
    this.db
      .prepare('UPDATE projects SET name=?,description=? WHERE id=?')
      .run(name, description, id);
  }
  remove(id) {
    this.project(id);
    const files = this.db.prepare('SELECT id FROM releases WHERE project=?').all(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM deliveries WHERE project=?').run(id);
      this.db.prepare('DELETE FROM releases WHERE project=?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    let cleanupPending = false;
    for (const file of files) {
      try {
        fs.rmSync(this.releasePath(file.id), {force: true});
      } catch {
        cleanupPending = true;
      }
    }
    return {deleted: true, cleanupPending};
  }
  removeRelease(id) {
    this.load();
    if (!ID.test(id)) throw fail('Версия не найдена', 404);
    const release = this.db.prepare('SELECT project FROM releases WHERE id=?').get(id);
    if (!release) throw fail('Версия не найдена', 404);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'UPDATE projects SET selected=NULL,enabled=0,token=NULL,token_hash=NULL WHERE selected=?'
        )
        .run(id);
      this.db.prepare('DELETE FROM releases WHERE id=?').run(id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    fs.rmSync(this.releasePath(id), {force: true});
  }
  select(id, release) {
    this.project(id);
    if (
      !ID.test(release) ||
      !this.db.prepare('SELECT 1 FROM releases WHERE id=? AND project=?').get(release, id)
    )
      throw fail('Версия не найдена', 404);
    this.db.prepare('UPDATE projects SET selected=? WHERE id=?').run(release, id);
  }
  notes(id, release, notes) {
    this.project(id);
    if (!ID.test(release) || typeof notes !== 'string' || notes.length > 4000 || /\0/.test(notes))
      throw fail('Некорректные заметки');
    if (!this.db.prepare('SELECT 1 FROM releases WHERE id=? AND project=?').get(release, id))
      throw fail('Версия не найдена', 404);
    this.db.prepare('UPDATE releases SET notes=? WHERE id=?').run(notes, release);
  }
  async launch(id, release, entrypoint, runner) {
    this.project(id);
    if (
      !ID.test(release) ||
      !this.db.prepare('SELECT 1 FROM releases WHERE id=? AND project=?').get(release, id)
    )
      throw fail('Версия не найдена', 404);
    if (
      typeof entrypoint !== 'string' ||
      typeof runner !== 'string' ||
      !/^[a-zA-Z0-9_+.-]{1,64}$/.test(runner) ||
      runner.startsWith('-')
    )
      throw fail('Укажи имя интерпретатора без аргументов');
    const {files} = await validateZip(this.releasePath(release));
    if (entrypoint && !files.includes(entrypoint))
      throw fail('Стартовый файл отсутствует в архиве', 422);
    this.db
      .prepare('UPDATE releases SET entrypoint=?,runner=? WHERE id=?')
      .run(entrypoint, runner, release);
  }
  async files(id, release) {
    this.project(id);
    if (
      !ID.test(release) ||
      !this.db.prepare('SELECT 1 FROM releases WHERE id=? AND project=?').get(release, id)
    )
      throw fail('Версия не найдена', 404);
    return (await validateZip(this.releasePath(release))).files;
  }
  access(id, enabled) {
    const project = this.project(id);
    if (typeof enabled !== 'boolean') throw fail('Неверный переключатель');
    if (enabled && !project.selected) throw fail('Сначала выбери релиз');
    if (!enabled) {
      this.db
        .prepare('UPDATE projects SET enabled=0,token=NULL,token_hash=NULL WHERE id=?')
        .run(id);
      return {enabled: false};
    }
    if (project.enabled) return {enabled: true, token: project.token};
    const token = randomBytes(32).toString('base64url');
    this.db
      .prepare('UPDATE projects SET enabled=1,token=?,token_hash=? WHERE id=?')
      .run(token, digest(token), id);
    return {enabled: true, token};
  }
  async upload(request, projectId, version, notes, allowed = () => true) {
    this.project(projectId);
    if (typeof version !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(version))
      throw fail('Некорректный номер версии');
    if (notes && (typeof notes !== 'string' || notes.length > 4000 || /\0/.test(notes)))
      throw fail('Некорректное описание изменений');
    if (
      this.db
        .prepare('SELECT 1 FROM releases WHERE project=? AND version=?')
        .get(projectId, version)
    )
      throw fail('Версия уже существует', 409);
    const length = Number(request.headers['content-length']);
    if (!Number.isSafeInteger(length) || length < 22 || length > 128 * 1024 * 1024)
      throw fail('ZIP — не более 128 МБ', 413);
    const used = this.db.prepare('SELECT coalesce(sum(size),0) AS n FROM releases').get().n;
    if (used + this.reserved + length > 2 * 1024 * 1024 * 1024)
      throw fail('Место для релизов заполнено', 507);
    this.reserved += length;
    const id = randomUUID(),
      temp = path.join(this.directory, 'tmp', id),
      target = path.join(this.directory, 'releases', id);
    let fd,
      size = 0,
      moved = false,
      committed = false;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      for await (const chunk of request) {
        size += chunk.length;
        if (size > length || !allowed()) throw fail('Загрузка прервана', 400);
        fs.writeFileSync(fd, chunk);
      }
      if (size !== length || !allowed()) throw fail('Загрузка прервана', 400);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      const verified = await validateZip(temp);
      if (!allowed()) throw fail('Загрузка прервана', 400);
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(temp)) hash.update(chunk);
      if (!allowed()) throw fail('Загрузка прервана', 400);
      if (
        this.db
          .prepare('SELECT 1 FROM releases WHERE project=? AND version=?')
          .get(projectId, version)
      )
        throw fail('Версия уже существует', 409);
      this.project(projectId);
      fs.renameSync(temp, target);
      moved = true;
      const release = {
        id,
        version,
        notes: notes ?? '',
        sha256: hash.digest('hex'),
        size,
        entrypoint: '',
        expanded: verified.expanded,
        entries: verified.entries,
        created: Date.now()
      };
      this.db
        .prepare(
          `INSERT INTO releases(id,project,version,notes,sha256,size,expanded,entries,created,entrypoint)
        VALUES(?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          id,
          projectId,
          version,
          release.notes,
          release.sha256,
          size,
          release.expanded,
          release.entries,
          release.created,
          release.entrypoint
        );
      committed = true;
      return release;
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
  resolve(token) {
    this.load();
    if (!TOKEN.test(token)) throw fail('Ссылка отозвана', 404);
    const project = this.db
      .prepare('SELECT * FROM projects WHERE token_hash=? AND enabled=1')
      .get(digest(token));
    if (!project || project.token !== token || !project.selected)
      throw fail('Ссылка отозвана', 404);
    const release = this.db
      .prepare('SELECT * FROM releases WHERE id=? AND project=?')
      .get(project.selected, project.id);
    if (!release) throw fail('Версия не найдена', 404);
    return {project, release};
  }
  log(project, release, result) {
    this.load();
    if (!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(project)) return;
    this.db
      .prepare('INSERT INTO deliveries(project,release,time,result) VALUES(?,?,?,?)')
      .run(project, release, Date.now(), result);
  }
  releasePath(id) {
    return path.join(this.directory, 'releases', id);
  }
}
