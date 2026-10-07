import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash, randomUUID} from 'node:crypto';
import {initUsage, startUsage, saveUsage} from '../../src/ai-usage.mjs';
export const models = ['deepseek-flash', 'deepseek-v4-pro'];
export const fail = (message, status = 400) => {
  throw Object.assign(new Error(message), {status});
};
export const uuid = (value) =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;
export class ChatStore {
  constructor(directory) {
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    fs.chmodSync(directory, 0o700);
    this.keyFile = path.join(directory, 'deepseek.json');
    const file = path.join(directory, 'chat.sqlite');
    this.db = new DatabaseSync(file);
    fs.chmodSync(file, 0o600);
    this.db.exec(
      'PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;'
    );
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 2) {
      this.db.close();
      fail('Нужна более новая версия чата.', 503);
    }
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,title TEXT NOT NULL,updated INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY,topic TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,role TEXT NOT NULL,content TEXT NOT NULL DEFAULT '',model TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'done',created INTEGER NOT NULL,usage TEXT,notice TEXT NOT NULL DEFAULT '') STRICT;
      CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,hash TEXT NOT NULL,topic TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,assistant INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,model TEXT NOT NULL,status TEXT NOT NULL) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS one_reply ON requests(topic) WHERE status='running';
      CREATE INDEX IF NOT EXISTS topic_messages ON messages(topic,id);
      `);
    if (version < 2)
      this.transaction(() => {
        this.db.exec(`ALTER TABLE topics ADD COLUMN provider TEXT NOT NULL DEFAULT 'deepseek';
        ALTER TABLE topics ADD COLUMN remote TEXT NOT NULL DEFAULT '';
        ALTER TABLE messages ADD COLUMN audio TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE requests ADD COLUMN state TEXT NOT NULL DEFAULT '{}';
        PRAGMA user_version=2;`);
      });
    this.transaction(() => initUsage(this.db));
    for (const suffix of ['-wal', '-shm'])
      if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
  }
  close() {
    this.db.close();
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  config() {
    try {
      return JSON.parse(fs.readFileSync(this.keyFile, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT')
        return {key: '', model: models[0], thinking: false, maxTokens: 8192};
      throw error;
    }
  }
  publicConfig() {
    const c = this.config();
    return {
      model: c.model,
      thinking: c.thinking,
      maxTokens: c.maxTokens,
      models: c.models ?? models,
      checkedAt: c.checkedAt ?? null,
      configured: Boolean(c.key)
    };
  }
  saveConfig(data) {
    const old = this.config();
    if (
      !(old.models ?? models).includes(data.model) ||
      typeof data.thinking !== 'boolean' ||
      ![4096, 8192, 16384].includes(data.maxTokens)
    )
      fail('Проверь параметры DeepSeek.');
    if (
      data.key !== undefined &&
      (typeof data.key !== 'string' || (data.key && !/^[\x21-\x7e]{8,512}$/.test(data.key)))
    )
      fail('Некорректный API-ключ.');
    const config = {
      key: data.removeKey === true ? '' : data.key || old.key,
      model: data.model,
      thinking: data.thinking,
      maxTokens: data.maxTokens,
      ...(data.removeKey || (data.key && data.key !== old.key)
        ? {}
        : {models: old.models, checkedAt: old.checkedAt})
    };
    const temp = this.keyFile + '.' + randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify(config), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temp, this.keyFile);
    } finally {
      fs.rmSync(temp, {force: true});
    }
    return this.publicConfig();
  }
  saveModels(key, available) {
    const c = this.config();
    if (c.key !== key) fail('Ключ изменился. Проверь подключение ещё раз.', 409);
    if (!available.length) fail('DeepSeek не вернул доступных моделей.', 502);
    c.models = available;
    c.checkedAt = Date.now();
    if (!available.includes(c.model)) c.model = available[0];
    const temp = this.keyFile + '.' + randomUUID();
    try {
      fs.writeFileSync(temp, JSON.stringify(c), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temp, this.keyFile);
    } finally {
      fs.rmSync(temp, {force: true});
    }
    return this.publicConfig();
  }
  provider(data, retry) {
    const id = retry
      ? this.db.prepare('SELECT topic FROM requests WHERE id=?').get(data.requestId)?.topic
      : data.topic;
    return this.topic(id).provider;
  }
  remote(id, value) {
    if (value !== undefined)
      this.db.prepare('UPDATE topics SET remote=? WHERE id=?').run(value, id);
    return this.topic(id).remote;
  }
  flowContext(topic) {
    const row = this.db
      .prepare(
        "SELECT state FROM requests WHERE topic=? AND status='done' ORDER BY assistant DESC LIMIT 1"
      )
      .get(topic);
    const ids = row ? (JSON.parse(row.state).clipIds ?? []) : [];
    return {current_song_id: ids[0], song_queue: ids.map((id) => ({id}))};
  }
  audioIDs(topic) {
    this.topic(topic);
    return this.db
      .prepare('SELECT state FROM requests WHERE topic=?')
      .all(topic)
      .flatMap((r) => Object.values(JSON.parse(r.state).audioIds ?? {}));
  }
  checkpoint(job, state) {
    this.db.prepare('UPDATE requests SET state=? WHERE id=?').run(JSON.stringify(state), job.id);
  }
  recover() {
    this.transaction(() => {
      this.db.exec(
        "UPDATE messages SET status='error',notice='Ответ прерван перезапуском. Можно повторить.' WHERE status='running'; UPDATE requests SET status='error' WHERE status='running'; UPDATE ai_usage SET status='error' WHERE status='running'"
      );
    });
  }
  topic(id) {
    const t = uuid(id) && this.db.prepare('SELECT * FROM topics WHERE id=?').get(id);
    if (!t) fail('Тема не найдена.', 404);
    return t;
  }
  list() {
    return this.db
      .prepare('SELECT id,title,updated,version,provider FROM topics ORDER BY updated DESC,id')
      .all();
  }
  history(id, before = 0) {
    const topic = this.topic(id);
    if (!Number.isSafeInteger(before) || before < 0) fail('Некорректная страница.');
    const rows = this.db
      .prepare('SELECT * FROM messages WHERE topic=? AND (?=0 OR id<?) ORDER BY id DESC LIMIT 51')
      .all(id, before, before);
    const more = rows.length > 50;
    rows.length = Math.min(rows.length, 50);
    return {
      topic: {
        id: topic.id,
        title: topic.title,
        updated: topic.updated,
        version: topic.version,
        provider: topic.provider
      },
      messages: rows.reverse().map((m) => ({
        ...m,
        usage: m.usage ? JSON.parse(m.usage) : null,
        audio: JSON.parse(m.audio)
      })),
      more
    };
  }
  change(data) {
    if (!uuid(data.id)) fail('Некорректная тема.');
    return this.transaction(() => {
      if (data.action === 'create') {
        if (!['deepseek', 'flowmusic'].includes(data.provider ?? 'deepseek'))
          fail('Неизвестный провайдер.');
        if (!text(data.title, 100)) fail('Название — от 1 до 100 символов.');
        const old = this.db.prepare('SELECT * FROM topics WHERE id=?').get(data.id);
        if (old) {
          if (old.title !== data.title.trim() || old.provider !== (data.provider ?? 'deepseek'))
            fail('Тема уже создана с другим названием.', 409);
          const {remote, ...result} = old;
          return result;
        }
        if (this.list().length >= 500) fail('Достигнут лимит 500 тем.');
        this.db
          .prepare('INSERT INTO topics(id,title,updated,provider) VALUES(?,?,?,?)')
          .run(data.id, data.title.trim(), Date.now(), data.provider ?? 'deepseek');
      } else {
        const t = this.topic(data.id);
        if (t.version !== data.version) fail('Тема изменилась. Обнови страницу.', 409);
        if (
          this.db.prepare("SELECT 1 FROM requests WHERE topic=? AND status='running'").get(data.id)
        )
          fail('Сначала останови ответ.', 409);
        if (data.action === 'delete') {
          this.db.prepare('DELETE FROM topics WHERE id=?').run(data.id);
          return {deleted: true};
        }
        if (data.action !== 'rename' || !text(data.title, 100)) fail('Некорректное название.');
        this.db
          .prepare('UPDATE topics SET title=?,version=version+1 WHERE id=?')
          .run(data.title.trim(), data.id);
      }
      const {remote, ...result} = this.topic(data.id);
      return result;
    });
  }
  begin(data, retry = false) {
    if (!uuid(data.requestId)) fail('Некорректный запрос.');
    return this.transaction(() => {
      const old = this.db.prepare('SELECT * FROM requests WHERE id=?').get(data.requestId);
      if (retry) {
        if (!old) fail('Запрос не найден.', 404);
        if (old.status === 'done') return {...old, replay: true};
        const t = this.topic(old.topic);
        if (t.version !== data.version) fail('Тема изменилась. Обнови страницу.', 409);
        if (
          this.db.prepare('SELECT MAX(id) AS id FROM messages WHERE topic=?').get(old.topic).id !==
          old.assistant
        )
          fail('Повтор доступен только для последнего ответа.', 409);
      } else {
        if (
          !uuid(data.topic) ||
          !text(data.text, this.topic(data.topic).provider === 'flowmusic' ? 8000 : 32000) ||
          !(
            this.topic(data.topic).provider === 'flowmusic'
              ? ['producer:standard']
              : (this.config().models ?? models)
          ).includes(data.model)
        )
          fail('Проверь сообщение и модель.');
        const hash = createHash('sha256')
          .update(JSON.stringify([data.topic, data.text, data.model]))
          .digest('hex');
        if (old) {
          if (old.hash !== hash) fail('Этот запрос уже использован.', 409);
          return {...old, replay: true};
        }
        const t = this.topic(data.topic);
        if (t.version !== data.version) fail('Тема изменилась. Обнови страницу.', 409);
        if (
          this.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE topic=?').get(data.topic).n >=
          10000
        )
          fail('Создай новую тему: достигнут лимит сообщений.');
      }
      const topic = old?.topic ?? data.topic;
      if (this.db.prepare("SELECT 1 FROM requests WHERE topic=? AND status='running'").get(topic))
        fail('Ответ уже создаётся.', 409);
      if (this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE status='running'").get().n >= 2)
        fail('Уже создаются два ответа. Дождись завершения.', 429);
      if (retry) {
        this.db.prepare("UPDATE requests SET status='running' WHERE id=?").run(old.id);
        this.db
          .prepare(
            "UPDATE messages SET status='running',content='',notice='',usage=NULL WHERE id=?"
          )
          .run(old.assistant);
      } else {
        this.db
          .prepare("INSERT INTO messages(topic,role,content,created) VALUES(?,'user',?,?)")
          .run(topic, data.text.trim(), Date.now());
        const result = this.db
          .prepare(
            "INSERT INTO messages(topic,role,model,status,created) VALUES(?,'assistant',?,'running',?)"
          )
          .run(topic, data.model, Date.now());
        const hash = createHash('sha256')
          .update(JSON.stringify([topic, data.text, data.model]))
          .digest('hex');
        this.db
          .prepare(
            "INSERT INTO requests(id,hash,topic,assistant,model,status) VALUES(?,?,?,?,?,'running')"
          )
          .run(data.requestId, hash, topic, Number(result.lastInsertRowid), data.model);
      }
      this.db
        .prepare('UPDATE topics SET updated=?,version=version+1 WHERE id=?')
        .run(Date.now(), topic);
      const job = this.db.prepare('SELECT * FROM requests WHERE id=?').get(data.requestId);
      return {...job, usageId: startUsage(this.db, job, this.topic(topic).provider)};
    });
  }
  context(job) {
    const all = this.db
      .prepare(
        "SELECT role,content FROM messages WHERE topic=? AND id<? AND (role='user' OR status='done') ORDER BY id DESC LIMIT 81"
      )
      .all(job.topic, job.assistant);
    let size = 0;
    const messages = [];
    for (const m of all) {
      if (size + m.content.length > 96000 || messages.length >= 80) break;
      size += m.content.length;
      messages.unshift(m);
    }
    while (messages[0]?.role === 'assistant') messages.shift();
    return {messages, limited: messages.length < all.length};
  }
  recordUsage(job, usage) {
    saveUsage(this.db, job.usageId, usage, job.model);
  }
  finish(job, {content = '', status = 'done', notice = '', usage = null, audio = []}) {
    this.transaction(() => {
      this.recordUsage(job, usage);
      if (job.usageId)
        this.db.prepare('UPDATE ai_usage SET status=? WHERE id=?').run(status, job.usageId);
      this.db
        .prepare('UPDATE messages SET content=?,status=?,notice=?,usage=?,audio=? WHERE id=?')
        .run(
          content,
          status,
          notice,
          usage ? JSON.stringify(usage) : null,
          JSON.stringify(audio),
          job.assistant
        );
      this.db.prepare('UPDATE requests SET status=? WHERE id=?').run(status, job.id);
      this.db
        .prepare('UPDATE topics SET updated=?,version=version+1 WHERE id=?')
        .run(Date.now(), job.topic);
    });
  }
  requests(topic) {
    return this.db.prepare('SELECT id,assistant,status FROM requests WHERE topic=?').all(topic);
  }
}
