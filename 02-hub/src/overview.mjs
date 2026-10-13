import {groupFor,selectedGroup} from './groups.mjs';
import {fail} from './input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
export class Overview {
  constructor(directory, modules) {
    this.directory = directory;
    this.modules = modules;
  }
  load() {
    if (this.db) return;
    if (this.directory) fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const file = this.directory ? path.join(this.directory, 'home.sqlite') : ':memory:';
    if (this.directory) {
      fs.closeSync(fs.openSync(file, 'a', 0o600));
      fs.chmodSync(file, 0o600);
    }
    this.db = new DatabaseSync(file);
    this.db.exec(
      `PRAGMA busy_timeout=3000;CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,data TEXT NOT NULL);INSERT OR IGNORE INTO preferences VALUES(1,1,'{"order":[],"hidden":[]}');`
    );
    const row = this.db.prepare('SELECT data FROM preferences WHERE id=1').get(),
      old = JSON.parse(row.data),
      clean = JSON.stringify({order: old.order, hidden: old.hidden});
    if (row.data !== clean)
      this.db.prepare('UPDATE preferences SET data=?,version=version+1 WHERE id=1').run(clean);
  }
  config() {
    this.load();
    const r = this.db.prepare('SELECT * FROM preferences WHERE id=1').get();
    return {version: r.version, ...JSON.parse(r.data)};
  }
  save(v) {
    this.load();
    if (
      !v ||
      !['order', 'hidden'].every(
        (k) => Array.isArray(v[k]) && v[k].length <= 100 && new Set(v[k]).size === v[k].length
      )
    )
      throw fail('Некорректный список карточек');
    if ([...v.order, ...v.hidden].some((id) => typeof id !== 'string' || !this.modules.has(id)))
      throw fail('Неизвестный модуль');
    const data = JSON.stringify({order: v.order, hidden: v.hidden});
    const r = this.db
      .prepare('UPDATE preferences SET version=version+1,data=? WHERE id=1 AND version=?')
      .run(data, Number.isSafeInteger(v.version) ? v.version : -1);
    if (!r.changes) throw fail('Настройки изменились в другой вкладке. Обнови страницу.', 409);
    return this.config();
  }
  ordered(includeHidden = false) {
    const c = this.config(),
      defaults = ['balance', 'pulse', 'signal', 'chat', 'anime', 'trophies'],
      order = [...c.order, ...defaults.filter((id) => !c.order.includes(id))];
    return [...this.modules.values()]
      .filter((m) => includeHidden || !c.hidden.includes(m.id))
      .sort(
        (a, b) =>
          (order.indexOf(a.id) < 0 ? 100 : order.indexOf(a.id)) -
          (order.indexOf(b.id) < 0 ? 100 : order.indexOf(b.id))
      );
  }
  query(id, sql, args = []) {
    if (!this.directory || !this.modules.has(id)) return [];
    const file = path.join(this.directory, id, id + '.sqlite');
    if (!fs.existsSync(file)) return [];
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      db.exec('PRAGMA busy_timeout=1000');
      db.function('fold', {deterministic: true}, (s) => String(s ?? '').toLocaleLowerCase('ru'));
      return db.prepare(sql).all(...args);
    } finally {
      db.close();
    }
  }
  search(value) {
    const q = String(value ?? '')
      .trim()
      .toLocaleLowerCase('ru');
    if (q.length < 2 || q.length > 100) throw fail('Введи от 2 до 100 символов');
    const results = [],
      errors = [];
    const read = (id, fn) => {
      if (!this.modules.has(id)) return;
      try {
        fn();
      } catch {
        errors.push({id, message: 'Источник поиска временно недоступен'});
      }
    };
    read('projects', () => {
      for (const r of this.query(
        'projects',
        'SELECT id,name,description FROM projects WHERE instr(fold(name || char(10) || description),?)>0 ORDER BY created DESC LIMIT 20',
        [q]
      ))
        results.push({
          kind: 'projects',
          title: r.name,
          snippet: r.description.slice(0, 180),
          url: '/modules/projects/?project=' + r.id
        });
    });
    read('kanban', () => {
      for (const r of this.query(
        'kanban',
        'SELECT id,board,title,description,archived FROM cards WHERE instr(fold(title || char(10) || description || char(10) || tags || char(10) || checklist),?)>0 ORDER BY updated DESC LIMIT 20',
        [q]
      ))
        results.push({
          kind: 'kanban',
          title: r.title,
          snippet: (r.archived ? 'Архив · ' : '') + r.description.slice(0, 180),
          url: '/modules/kanban/?board=' + r.board + '&card=' + r.id
        });
    });
    read('articles', () => {
      if (!this.directory) return;
      const file = path.join(this.directory, 'content/catalog.json');
      if (!fs.existsSync(file)) return;
      if (fs.statSync(file).size > 64 * 1024 * 1024) throw Error();
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const a of data.articles
        .filter((a) => [a.title, a.body, ...a.tags].join(' ').toLocaleLowerCase('ru').includes(q))
        .sort((a, b) => b.updated - a.updated)
        .slice(0, 20))
        results.push({
          kind: 'articles',
          title: a.title,
          snippet: a.body.slice(0, 180),
          url: '/modules/articles/?article=' + encodeURIComponent(a.id)
        });
    });
    return {results, errors, limitPerModule: 20};
  }
  status(cache, version, now = Date.now()) {
    const entries = [...this.modules.values()].map((m) => {
      const r = cache.modules.find((x) => x.id === m.id);
      return {
        id: m.id,
        title: m.title,
        version: m.version ?? null,
        state: m.summary ? (r?.stale ? 'stale' : (r?.summary?.state ?? 'unknown')) : 'loaded',
        checkedAt: r?.updatedAt ?? null,
        error: r?.stale ? 'Сводка не обновлена; причина может быть в подключении или данных' : null
      };
    });
    const syncs = [];
    try {
      for (const r of this.query('rhythm', 'SELECT name,last_sync,revoked FROM devices'))
        syncs.push({
          module: 'rhythm',
          name: r.name,
          time: r.last_sync,
          state: r.revoked ? 'revoked' : r.last_sync ? 'synced' : 'waiting'
        });
    } catch {
      syncs.push({module: 'rhythm', name: 'Асклепий', state: 'error', time: null});
    }
    const readSync = (id, file, extract) => {
      if (!this.directory || !this.modules.has(id)) return;
      try {
        const full = path.join(this.directory, file);
        if (!fs.existsSync(full)) return;
        if (fs.statSync(full).size > 64 * 1024 * 1024) throw Error();
        extract(JSON.parse(fs.readFileSync(full, 'utf8')));
      } catch {
        syncs.push({module: id, name: this.modules.get(id).title, state: 'error', time: null});
      }
    };
    readSync('anime', 'anime/shikimori.json', (data) =>
      syncs.push({
        module: 'anime',
        name: 'Талия · Shikimori',
        time: data.syncedAt ?? null,
        state: data.lastError ? 'error' : data.syncedAt ? 'synced' : 'waiting'
      })
    );
    readSync('balance', 'balance/rates.json', (data) => {
      for (const kind of ['fiat', 'crypto'])
        syncs.push({
          module: 'balance',
          name: 'Плутос · ' + (kind === 'fiat' ? 'валюты' : 'криптовалюты'),
          time: data[kind]?.fetchedAt ?? null,
          state: data[kind]?.failed ? 'error' : data[kind]?.fetchedAt ? 'synced' : 'waiting'
        });
    });
    if (this.directory && this.modules.has('trophies')) {
      const file = path.join(this.directory, 'trophies/trophies.db');
      if (fs.existsSync(file)) {
        let db;
        try {
          db = new DatabaseSync(file, {readOnly: true});
          for (const provider of ['steam', 'ra']) {
            const r = db.prepare('SELECT value FROM state WHERE key=?').get(provider);
            if (r) {
              const a = JSON.parse(r.value);
              syncs.push({
                module: 'trophies',
                name: 'Ника · ' + provider,
                time: a.lastSync ?? null,
                state: a.error ? 'error' : a.lastSync ? 'synced' : 'waiting'
              });
            }
          }
        } catch {
          syncs.push({module: 'trophies', name: 'Ника', state: 'error', time: null});
        } finally {
          db?.close();
        }
      }
    }
    return {
      version,
      checkedAt: now,
      modules: [...entries, ...(this.modules.diagnostics ?? [])],
      syncs,
      note: 'Обновление сводки и синхронизация устройства — разные события. Показаны Асклепий, Талия, Ника и курсы Плутоса; локальным модулям внешняя синхронизация не требуется.'
    };
  }
  async home(activity, groupId) {
    const group=selectedGroup(groupId);
    const visible = new Set(this.ordered(group.id!=='overview').filter(m=>group.id==='overview'||groupFor(m.id)===group.id).map(m => m.id)), result = {updatedAt: Date.now(), errors: []};
    await Promise.all([...visible].filter(id=>this.modules.get(id)?.home).map(async id => {
      const provider = this.modules.get(id)?.home;
      if (!provider) return;
      try { result[id] = await provider(); } catch { result.errors.push(id); }
    }));
    if (visible.has('statistics')) {
      try {
        const day = activity.snapshot(1);
        const enabled=new Set(this.ordered().map(m=>m.id));
        result.statistics = {zone:day.zone,measured:day.measured.filter(r => enabled.has(r.source)),pages:day.pages};
      } catch { result.errors.push('statistics'); }
    }
    return result;
  }
  close() {
    this.db?.close();
  }
}
