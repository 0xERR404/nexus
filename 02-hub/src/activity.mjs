import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ID, fail} from './input.mjs';
const sources = ['wave', 'cinema', 'reader'];
export function mergeCoverage(intervals, start, end) {
  const merged = [];
  for (const pair of [...intervals, [start, end]].sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && pair[0] <= last[1] + 0.2) last[1] = Math.max(last[1], pair[1]);
    else merged.push([...pair]);
  }
  return merged.slice(-2048);
}
export class Activity {
  constructor(directory, now = Date.now) {
    this.directory = directory;
    this.now = now;
  }
  load() {
    if (this.db) return;
    let file = ':memory:';
    if (this.directory) {
      fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
      file = path.join(this.directory, 'activity.sqlite');
      fs.closeSync(fs.openSync(file, 'a', 0o600));
    }
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,source TEXT,item TEXT,seq INTEGER,at INTEGER,position REAL,playing INTEGER);
      CREATE TABLE IF NOT EXISTS items(source TEXT,item TEXT,title TEXT,kind TEXT,position REAL,duration REAL,seconds REAL DEFAULT 0,coverage TEXT DEFAULT '[]',completed INTEGER DEFAULT 0,updated INTEGER,PRIMARY KEY(source,item));
      CREATE TABLE IF NOT EXISTS daily(source TEXT,day TEXT,seconds REAL,PRIMARY KEY(source,day));
      CREATE TABLE IF NOT EXISTS clocks(source TEXT PRIMARY KEY,at INTEGER);
      CREATE TABLE IF NOT EXISTS activity_daily(source TEXT,kind TEXT,item TEXT,day TEXT,seconds REAL DEFAULT 0,completed INTEGER DEFAULT 0,PRIMARY KEY(source,kind,item,day));
      CREATE TABLE IF NOT EXISTS reading_pages(item TEXT,page TEXT,day TEXT,PRIMARY KEY(item,page));`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const columns = new Set(this.db.prepare('PRAGMA table_info(sessions)').all().map(c => c.name));
      for (const [name, definition] of [['seconds', 'REAL NOT NULL DEFAULT 0'], ['counted', 'INTEGER NOT NULL DEFAULT 0'], ['page', 'TEXT']])
        if (!columns.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${definition}`);
      const migrated = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_spans'").get();
      this.db.exec(`CREATE TABLE IF NOT EXISTS activity_spans(source TEXT,start REAL,end REAL,PRIMARY KEY(source,start));
        CREATE TABLE IF NOT EXISTS activity_legacy_clocks(source TEXT PRIMARY KEY,at INTEGER);`);
      // Older totals do not retain their wall-clock intervals. Preserve their cutoff once,
      // rather than inventing coverage or crediting old retries a second time.
      if (!migrated) this.db.exec('INSERT INTO activity_legacy_clocks SELECT source,at FROM clocks');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      this.db.close();
      this.db = null;
      throw error;
    }
  }
  claim(source, start, end) {
    const cutoff = this.db.prepare('SELECT at FROM activity_legacy_clocks WHERE source=?').get(source)?.at;
    if (cutoff != null) start = Math.max(start, cutoff);
    if (start >= end) return [];
    const overlaps = this.db.prepare('SELECT start,end FROM activity_spans WHERE source=? AND start<=? AND end>=? ORDER BY start').all(source,end,start);
    const fresh = [];
    let cursor = start;
    for (const span of overlaps) {
      if (span.start > cursor) fresh.push([cursor, Math.min(end, span.start)]);
      cursor = Math.max(cursor, span.end);
    }
    if (cursor < end) fresh.push([cursor, end]);
    this.db.prepare('DELETE FROM activity_spans WHERE source=? AND start<=? AND end>=?').run(source,end,start);
    this.db.prepare('INSERT INTO activity_spans VALUES(?,?,?)').run(source,
      Math.min(start, overlaps[0]?.start ?? start), Math.max(end, overlaps.at(-1)?.end ?? end));
    return fresh;
  }
  record(v) {
    if (
      !v ||
      !sources.includes(v.source) ||
      !ID.test(v.session) ||
      typeof v.item !== 'string' ||
      !/^[a-f0-9-]{36}(?::\d{1,4})?$/.test(v.item) ||
      !Number.isSafeInteger(v.seq) ||
      v.seq < 1 ||
      typeof v.playing !== 'boolean' ||
      typeof v.title !== 'string' ||
      v.title.length > 300 ||
      !['music', 'cinema', 'anime', 'book'].includes(v.kind) ||
      !Number.isFinite(v.position) ||
      v.position < 0 ||
      v.position > 86400 * 365 ||
      !Number.isFinite(v.duration) ||
      v.duration < 0 ||
      v.duration > 86400 * 365
    )
      throw fail('Некорректное событие активности');
    if (
      (v.source === 'wave' && v.kind !== 'music') ||
      (v.source === 'reader' && v.kind !== 'book') ||
      (v.source === 'cinema' && !['cinema', 'anime'].includes(v.kind))
    )
      throw fail('Некорректный источник');
    if (v.pageKey != null && (v.source !== 'reader' || typeof v.pageKey !== 'string' || v.pageKey.length > 300)) throw fail('Неверная страница');
    this.load();
    const received = this.now(), now = v.at ?? received;
    if (!Number.isSafeInteger(now)) throw fail('Время события некорректно');
    if (now > received + 300000) throw fail('Время события опережает сервер более чем на 5 минут');
    if (now < received - 30 * 86400000) throw fail('Время события старше 30 дней; статистика не начислена');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(v.session);
      if (old && (old.source !== v.source || old.item !== v.item))
        throw fail('Сессия относится к другому объекту', 409);
      if (old && v.seq <= old.seq) {
        this.db.exec('COMMIT');
        return {accepted: false};
      }
      const previous = this.db
        .prepare('SELECT * FROM items WHERE source=? AND item=?')
        .get(v.source, v.item);
      let coverage = JSON.parse(previous?.coverage || '[]'), credited = [],
        seconds = 0;
      if (old && old.playing && now >= old.at && now - old.at <= 45000) {
        const elapsed = (now - old.at) / 1000,
          advance = v.position - old.position;
        if (advance > 0 && advance <= elapsed * 4 + 1) {
          credited = this.claim(v.source, now - Math.min(advance, elapsed) * 1000, now);
          seconds = credited.reduce((sum, [start, end]) => sum + (end - start) / 1000, 0);
          if (seconds > 0 && v.source !== 'reader' && v.duration > 0)
            coverage = mergeCoverage(
              coverage,
              Math.min(old.position, v.duration),
              Math.min(v.position, v.duration)
            );
        }
      }
      const position =
        v.source !== 'reader' && v.duration === 0 && previous ? previous.position : v.position;
      const duration = v.duration || previous?.duration || 0;
      const covered = coverage.reduce((n, [a, b]) => n + b - a, 0);
      const completed =
        previous?.completed ||
        (v.source !== 'reader' && v.duration > 0 && covered / v.duration >= 0.9 ? 1 : 0);
      this.db
        .prepare(
          `INSERT INTO items(source,item,title,kind,position,duration,seconds,coverage,completed,updated) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(source,item) DO UPDATE SET
          title=CASE WHEN excluded.updated>=items.updated THEN excluded.title ELSE items.title END,
          kind=CASE WHEN excluded.updated>=items.updated THEN excluded.kind ELSE items.kind END,
          position=CASE WHEN excluded.updated>=items.updated THEN excluded.position ELSE items.position END,
          duration=CASE WHEN excluded.updated>=items.updated THEN excluded.duration ELSE items.duration END,
          seconds=items.seconds+excluded.seconds,coverage=excluded.coverage,completed=excluded.completed,updated=max(items.updated,excluded.updated)`
        )
        .run(
          v.source,
          v.item,
          v.title,
          v.kind,
          position,
          duration,
          seconds,
          JSON.stringify(coverage),
          completed,
          now
        );
      this.db
        .prepare(
          'INSERT INTO sessions(id,source,item,seq,at,position,playing,seconds,counted,page) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,at=excluded.at,position=excluded.position,playing=excluded.playing,seconds=excluded.seconds,counted=excluded.counted,page=excluded.page'
        )
        .run(v.session, v.source, v.item, v.seq, now, v.position, +v.playing, (old?.seconds ?? 0) + seconds, +(!!old?.counted || (v.source !== 'reader' && duration > 0 && (old?.seconds ?? 0) + seconds >= duration * .9)), v.pageKey ?? null);
      if (seconds > 0) {
        if (v.source === 'reader' && v.pageKey && old?.page === v.pageKey && seconds >= 5)
          this.db.prepare('INSERT OR IGNORE INTO reading_pages VALUES(?,?,?)').run(v.item,v.pageKey,new Date(now+3*3600000).toISOString().slice(0,10));
        for (const [first, last] of credited) {
          let cursor = first;
          while (cursor < last) {
            const date = new Date(cursor + 3 * 3600000).toISOString().slice(0,10);
            const end = Math.min(last, Date.parse(date) + 21 * 3600000);
            this.db.prepare(`INSERT INTO activity_daily(source,kind,item,day,seconds,completed) VALUES(?,?,?,?,?,?)
              ON CONFLICT(source,kind,item,day) DO UPDATE SET seconds=seconds+excluded.seconds,completed=completed+excluded.completed`)
              .run(v.source,v.kind,v.item,date,(end-cursor)/1000,+(!old?.counted && v.source !== 'reader' && duration > 0 && (old?.seconds ?? 0) + seconds >= duration * .9 && end===credited.at(-1)[1]));
            this.db.prepare('INSERT INTO daily VALUES(?,?,?) ON CONFLICT(source,day) DO UPDATE SET seconds=daily.seconds+excluded.seconds')
              .run(v.source, date, (end-cursor)/1000);
            cursor=end;
          }
        }
        this.db
          .prepare(
            'INSERT INTO clocks VALUES(?,?) ON CONFLICT(source) DO UPDATE SET at=max(clocks.at,excluded.at)'
          )
          .run(v.source, now);
      }
      this.db.prepare('DELETE FROM sessions WHERE at<?').run(received - 30 * 86400000);
      this.db.prepare('DELETE FROM activity_spans WHERE end<?').run(received - 31 * 86400000);
      this.db.exec('COMMIT');
      return {accepted: true, seconds, completed: Boolean(completed)};
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  snapshot(days = 30, source = null) {
    this.load();
    days = Math.max(1, Math.min(365, Number(days) || 30));
    if (source && !sources.includes(source)) throw fail('Неизвестный источник');
    const since = new Date(this.now() - (days - 1) * 86400000 + 3 * 3600000)
      .toISOString()
      .slice(0, 10);
    return {
      pages: this.db.prepare('SELECT count(*) count FROM reading_pages WHERE day>=?').get(since).count,
      measured: this.db.prepare('SELECT source,kind,sum(seconds) seconds,count(DISTINCT item) items,sum(completed) completed FROM activity_daily WHERE day>=? GROUP BY source,kind').all(since),
      timeline: this.db.prepare('SELECT kind,day,sum(seconds) seconds FROM activity_daily WHERE day>=? GROUP BY kind,day ORDER BY day').all(since),
      zone: 'Europe/Moscow',
      days,
      daily: this.db
        .prepare('SELECT * FROM daily WHERE day>=? AND (? IS NULL OR source=?) ORDER BY day')
        .all(since, source, source),
      items: this.db
        .prepare(
          'SELECT source,item,title,kind,position,duration,seconds,completed,updated FROM items WHERE (? IS NULL OR source=?) ORDER BY updated DESC LIMIT 500'
        )
        .all(source, source),
      totals: this.db
        .prepare(
          'SELECT source,count(*) AS items,sum(completed) AS completed,sum(seconds) AS seconds FROM items GROUP BY source'
        )
        .all()
    };
  }
  close() {
    this.db?.close();
  }
}
