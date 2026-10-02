import {ID, fail} from '../../src/input.mjs';
export {ID, fail} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
const text = (s, max, empty = false) => {
  if (typeof s !== 'string' || s.length > max || /\0/.test(s) || (!empty && !s.trim()))
    throw fail('Некорректный текст');
  return s.trim();
};
export class Kanban {
  constructor(directory) {
    this.directory = directory;
    this.attached = new Set();
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const file = path.join(this.directory, 'kanban.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS boards(id TEXT PRIMARY KEY,name TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS columns(id TEXT PRIMARY KEY,board TEXT NOT NULL REFERENCES boards(id),name TEXT NOT NULL,position INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS cards(id TEXT PRIMARY KEY,board TEXT NOT NULL REFERENCES boards(id),column_id TEXT NOT NULL REFERENCES columns(id),title TEXT NOT NULL,description TEXT NOT NULL,checklist TEXT NOT NULL,tags TEXT NOT NULL,priority INTEGER NOT NULL,due INTEGER,remind INTEGER,project TEXT,attachments TEXT NOT NULL,done INTEGER NOT NULL DEFAULT 0,archived INTEGER NOT NULL DEFAULT 0,version INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL);`);
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  attach(kind) {
    this.load();
    if (this.attached.has(kind)) return;
    const file = path.join(this.directory, '..', kind, kind + '.sqlite');
    if (!fs.existsSync(file))
      throw fail(kind === 'storage' ? 'Сначала загрузи файл в хранилище' : 'Проект не найден', 404);
    this.db.prepare(`ATTACH DATABASE ? AS ${kind}`).run(file);
    this.attached.add(kind);
  }
  board(id) {
    this.load();
    const b = ID.test(id) && this.db.prepare('SELECT * FROM boards WHERE id=?').get(id);
    if (!b) throw fail('Доска не найдена', 404);
    return b;
  }
  boards() {
    this.load();
    return this.db.prepare('SELECT * FROM boards ORDER BY name').all();
  }
  createBoard(name) {
    this.load();
    name = text(name, 100);
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO boards(id,name) VALUES(?,?)').run(id, name);
      for (const [position, label] of ['Планы', 'В работе', 'Готово'].entries())
        this.db
          .prepare('INSERT INTO columns VALUES(?,?,?,?)')
          .run(randomUUID(), id, label, position);
    });
    return this.snapshot(id);
  }
  snapshot(id) {
    return {
      board: this.board(id),
      columns: this.db.prepare('SELECT * FROM columns WHERE board=? ORDER BY position,id').all(id),
      cards: this.db
        .prepare('SELECT * FROM cards WHERE board=? ORDER BY updated DESC,id')
        .all(id)
        .map((c) => ({
          ...c,
          checklist: JSON.parse(c.checklist),
          tags: JSON.parse(c.tags),
          attachments: JSON.parse(c.attachments)
        }))
    };
  }
  columns(id, version, input) {
    this.board(id);
    if (!Array.isArray(input) || input.length < 1 || input.length > 30)
      throw fail('Нужно от 1 до 30 колонок');
    const columns = input.map((c) => ({id: c.id || randomUUID(), name: text(c.name, 80)}));
    if (
      new Set(columns.map((c) => c.id)).size !== columns.length ||
      columns.some((c) => !ID.test(c.id))
    )
      throw fail('Неверные колонки');
    this.transaction(() => {
      if (this.board(id).version !== version)
        throw fail('Доска изменилась в другой вкладке. Обнови её.', 409);
      const old = this.db
        .prepare('SELECT id FROM columns WHERE board=?')
        .all(id)
        .map((c) => c.id);
      if (old.some((key) => !columns.some((c) => c.id === key)))
        throw fail('Удаление колонок пока не поддерживается');
      for (const [position, c] of columns.entries()) {
        const existing = this.db.prepare('SELECT board FROM columns WHERE id=?').get(c.id);
        if (existing && existing.board !== id) throw fail('Колонка принадлежит другой доске');
        this.db
          .prepare(
            'INSERT INTO columns VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,position=excluded.position'
          )
          .run(c.id, id, c.name, position);
      }
      this.db.prepare('UPDATE boards SET version=version+1 WHERE id=?').run(id);
    });
    return this.snapshot(id);
  }
  card(id) {
    this.load();
    const c = ID.test(id) && this.db.prepare('SELECT * FROM cards WHERE id=?').get(id);
    if (!c) throw fail('Задача не найдена', 404);
    return c;
  }
  save(input) {
    this.board(input.board);
    const title = text(input.title, 180),
      description = text(input.description ?? '', 10000, true);
    if (
      !Array.isArray(input.checklist) ||
      input.checklist.length > 100 ||
      !Array.isArray(input.tags) ||
      input.tags.length > 20 ||
      !Array.isArray(input.attachments) ||
      input.attachments.length > 30
    )
      throw fail('Слишком много элементов задачи');
    const checklist = input.checklist.map((c) => ({
      text: text(c.text, 300),
      done: c.done === true
    }));
    const tags = [...new Set(input.tags.map((t) => text(t, 40)))];
    const attachments = [...new Set(input.attachments)];
    if (attachments.some((id) => !ID.test(id))) throw fail('Неверное вложение');
    if (![0, 1, 2, 3].includes(input.priority)) throw fail('Неверный приоритет');
    for (const v of [input.due, input.remind])
      if (v !== null && (!Number.isSafeInteger(v) || v < 0 || v > 4102444800000))
        throw fail('Неверная дата');
    if (input.project !== null && !ID.test(input.project)) throw fail('Неверный проект');
    if (attachments.length || fs.existsSync(path.join(this.directory, '../storage/storage.sqlite')))
      this.attach('storage');
    if (input.project) this.attach('projects');
    const id = input.id || randomUUID();
    if (!ID.test(id)) throw fail('Неверная задача');
    this.transaction(() => {
      const old = input.id ? this.card(input.id) : null;
      if (old && (old.version !== input.version || old.board !== input.board))
        throw fail('Задача изменилась в другой вкладке. Твой текст сохранён в редакторе.', 409);
      if (
        !this.db
          .prepare('SELECT 1 FROM columns WHERE id=? AND board=?')
          .get(input.column, input.board)
      )
        throw fail('Колонка не найдена');
      if (
        input.project &&
        !this.db.prepare('SELECT 1 FROM projects.projects WHERE id=?').get(input.project)
      )
        throw fail('Проект не найден');
      for (const file of attachments)
        if (!this.db.prepare('SELECT 1 FROM storage.files WHERE id=? AND deleted=0').get(file))
          throw fail('Вложение удалено или находится в корзине');
      if (input.archived && !input.done) throw fail('Архивировать можно завершённую задачу');
      this.db
        .prepare(
          `INSERT INTO cards VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        column_id=excluded.column_id,title=excluded.title,description=excluded.description,checklist=excluded.checklist,tags=excluded.tags,priority=excluded.priority,due=excluded.due,remind=excluded.remind,project=excluded.project,attachments=excluded.attachments,done=excluded.done,archived=excluded.archived,version=cards.version+1,updated=excluded.updated`
        )
        .run(
          id,
          input.board,
          input.column,
          title,
          description,
          JSON.stringify(checklist),
          JSON.stringify(tags),
          input.priority,
          input.due,
          input.remind,
          input.project,
          JSON.stringify(attachments),
          +!!input.done,
          +!!input.archived,
          1,
          Date.now()
        );
      if (this.attached.has('storage')) {
        this.db.prepare("DELETE FROM storage.refs WHERE kind='kanban' AND object=?").run(id);
        for (const file of attachments)
          this.db.prepare("INSERT INTO storage.refs VALUES(?,'kanban',?)").run(file, id);
      }
    });
    return this.snapshot(input.board);
  }
  move(id, column, version) {
    const card = this.card(id);
    this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM columns WHERE id=? AND board=?').get(column, card.board))
        throw fail('Колонка не найдена');
      if (
        !this.db
          .prepare(
            'UPDATE cards SET column_id=?,version=version+1,updated=? WHERE id=? AND version=?'
          )
          .run(column, Date.now(), id, version).changes
      )
        throw fail('Задача изменилась в другой вкладке. Обнови её.', 409);
    });
    return this.snapshot(card.board);
  }
}
