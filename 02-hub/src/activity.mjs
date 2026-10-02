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
      CREATE TABLE IF NOT EXISTS clocks(source TEXT PRIMARY KEY,at INTEGER);`);
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
    this.load();
    const now = this.now();
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
      let coverage = JSON.parse(previous?.coverage || '[]'),
        seconds = 0;
      if (old && old.playing && now >= old.at && now - old.at <= 45000) {
        const elapsed = (now - old.at) / 1000,
          advance = v.position - old.position;
        if (advance > 0 && advance <= elapsed * 4 + 1) {
          const clock =
            this.db.prepare('SELECT at FROM clocks WHERE source=?').get(v.source)?.at ?? old.at;
          seconds = Math.max(0, Math.min(advance, elapsed, (now - Math.max(old.at, clock)) / 1000));
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
        ON CONFLICT(source,item) DO UPDATE SET title=excluded.title,kind=excluded.kind,position=excluded.position,duration=excluded.duration,seconds=items.seconds+excluded.seconds,coverage=excluded.coverage,completed=excluded.completed,updated=excluded.updated`
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
          'INSERT INTO sessions VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq,at=excluded.at,position=excluded.position,playing=excluded.playing'
        )
        .run(v.session, v.source, v.item, v.seq, now, v.position, +v.playing);
      if (seconds > 0) {
        const day = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
        this.db
          .prepare(
            'INSERT INTO daily VALUES(?,?,?) ON CONFLICT(source,day) DO UPDATE SET seconds=daily.seconds+excluded.seconds'
          )
          .run(v.source, day, seconds);
        this.db
          .prepare(
            'INSERT INTO clocks VALUES(?,?) ON CONFLICT(source) DO UPDATE SET at=excluded.at'
          )
          .run(v.source, now);
      }
      this.db.prepare('DELETE FROM sessions WHERE at<?').run(now - 30 * 86400000);
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
