import {ID, fail} from '../../src/input.mjs';
export {ID, fail} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
import {bounds, dayName, summarize} from './summary.mjs';
const hash = (v) => createHash('sha256').update(v).digest('hex');
const str = (v, n) => {
  if (typeof v !== 'string' || !v.trim() || v.length > n || /[\x00-\x1f]/.test(v))
    throw fail('Некорректная строка');
  return v.trim();
};
const time = (v) => Number.isSafeInteger(v) && v >= 946684800000 && v <= Date.now() + 300000;
const sleepLimits = {
  score: 100,
  efficiency: 100,
  latency: 86400,
  wakeCount: 10000,
  turnOverCount: 10000,
  heartMin: 255,
  heartMax: 255,
  heartAverage: 255,
  oxygenMin: 100,
  oxygenMax: 100,
  oxygenAverage: 100,
  breathMin: 80,
  breathMax: 80,
  breathAverage: 80,
  hrvAverage: 200,
  hrvBaselineMin: 200,
  hrvBaselineMax: 200,
  rdi: 100,
  quality: 100000,
  snoreFrequency: 100000
};
function metrics(value, limits) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw fail('Неверные показатели');
  const out = {};
  for (const [key, max] of Object.entries(limits)) {
    const n = value[key];
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n < 0 || n > max) throw fail('Неверный показатель: ' + key);
    out[key] = n;
  }
  return out;
}
export class Rhythm {
  constructor(directory) {
    this.directory = directory;
  }
  load() {
    if (this.db) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const file = path.join(this.directory, 'rhythm.sqlite');
    fs.closeSync(fs.openSync(file, 'a', 0o600));
    fs.chmodSync(file, 0o600);
    this.db = new DatabaseSync(file);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
 CREATE TABLE IF NOT EXISTS config(id INTEGER PRIMARY KEY CHECK(id=1),zone TEXT NOT NULL,auto INTEGER NOT NULL DEFAULT 0);
 INSERT OR IGNORE INTO config(id,zone) VALUES(1,'Europe/Moscow');
 CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,name TEXT NOT NULL,token TEXT,last_sync INTEGER,revoked INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,device TEXT NOT NULL REFERENCES devices(id),name TEXT NOT NULL,priority INTEGER NOT NULL DEFAULT 100);
 CREATE TABLE IF NOT EXISTS records(device TEXT NOT NULL REFERENCES devices(id),id TEXT NOT NULL,source TEXT NOT NULL REFERENCES sources(id),type TEXT NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,modified INTEGER NOT NULL,data TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(device,id));
 CREATE INDEX IF NOT EXISTS records_time ON records(start,end);
 CREATE TABLE IF NOT EXISTS sleep_confirmations(day TEXT PRIMARY KEY,digest TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS reports(day TEXT PRIMARY KEY,status TEXT NOT NULL,summary TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 1,stale INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS ai_usage(id TEXT PRIMARY KEY,created INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,usage TEXT,low REAL,high REAL,tariff TEXT NOT NULL DEFAULT '') STRICT;
 CREATE INDEX IF NOT EXISTS ai_usage_created ON ai_usage(created);`);
    if (
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gb_imports'").get()
    )
      this.transaction(() => {
        this.db.exec(
          'UPDATE devices SET revoked=1,token=NULL WHERE id IN (SELECT device FROM gb_imports); DROP TABLE gb_imports;'
        );
      });
  }
  transaction(fn) {
    this.load();
    if (this.inTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    } finally {
      this.inTransaction = false;
    }
  }
  config() {
    this.load();
    return this.db.prepare('SELECT zone,auto FROM config WHERE id=1').get();
  }
  configure(v) {
    str(v.zone, 80);
    try {
      new Intl.DateTimeFormat('en', {timeZone: v.zone});
    } catch {
      throw fail('Неизвестный часовой пояс');
    }
    if (typeof v.auto !== 'boolean') throw fail('Некорректная настройка');
    this.load();
    this.transaction(() => {
      const old = this.config();
      this.db.prepare('UPDATE config SET zone=?,auto=? WHERE id=1').run(v.zone, +v.auto);
      if (old.zone !== v.zone) this.db.exec('UPDATE reports SET stale=1');
    });
    return this.config();
  }
  devices() {
    this.load();
    return this.db.prepare('SELECT id,name,last_sync,revoked FROM devices ORDER BY name').all();
  }
  addDevice(name) {
    name = str(name, 100);
    this.load();
    const id = randomUUID(),
      token = randomBytes(32).toString('base64url');
    this.db.prepare('INSERT INTO devices(id,name,token) VALUES(?,?,?)').run(id, name, hash(token));
    return {id, name, token};
  }
  revoke(id) {
    this.load();
    this.db.prepare('UPDATE devices SET revoked=1,token=NULL WHERE id=?').run(str(id, 64));
  }
  authenticate(token) {
    this.load();
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw fail('Неверный ключ моста', 401);
    const row = this.db
      .prepare('SELECT * FROM devices WHERE token=? AND revoked=0')
      .get(hash(token));
    if (!row) throw fail('Ключ моста отозван или неизвестен', 401);
    return row;
  }
  sources() {
    this.load();
    return this.db.prepare('SELECT * FROM sources ORDER BY priority,name').all();
  }
  priority(id, priority) {
    if (!Number.isInteger(priority) || priority < 0 || priority > 1000)
      throw fail('Приоритет: 0–1000');
    this.load();
    this.transaction(() => {
      if (
        !this.db.prepare('UPDATE sources SET priority=? WHERE id=?').run(priority, str(id, 64))
          .changes
      )
        throw fail('Источник не найден', 404);
      this.db.exec('UPDATE reports SET stale=1');
    });
  }
  ingest(device, input) {
    if (
      !input ||
      !Array.isArray(input.records) ||
      input.records.length > 500 ||
      !Array.isArray(input.deleted) ||
      input.deleted.length > 1000
    )
      throw fail('Пакет: до 500 записей и 1000 удалений');
    const ids = new Set(),
      records = input.records.map((r) => {
        if (!r || typeof r !== 'object') throw fail('Некорректная запись');
        const id = str(r.id, 200);
        if (ids.has(id)) throw fail('Повтор ID в пакете');
        ids.add(id);
        const sourceName = str(r.source, 200),
          source = hash(device.id + '\n' + sourceName);
        if (
          ![
            'steps',
            'heart',
            'sleep',
            'activity',
            'spo2',
            'stress',
            'band',
            'movement',
            'sport'
          ].includes(r.type) ||
          !time(r.start) ||
          !time(r.end) ||
          !time(r.modified) ||
          r.end <= r.start ||
          r.end - r.start > 7 * 86400000
        )
          throw fail('Неверные тип или время измерения');
        let data;
        if (r.type === 'steps' || r.type === 'spo2' || r.type === 'stress') {
          if (
            !Number.isFinite(r.value) ||
            r.value < 0 ||
            r.value > (r.type === 'steps' ? 200000 : 100) ||
            (r.type === 'steps' && !Number.isInteger(r.value))
          )
            throw fail('Неверное значение');
          data = {value: r.value};
        } else if (r.type === 'movement') {
          data = {metrics: metrics(r.metrics, {calories: 65534, distance: 65534})};
          if (!Object.keys(data.metrics).length) throw fail('Пустое измерение движения');
        } else if (r.type === 'sport') {
          if (
            !Number.isInteger(r.workout) ||
            r.workout < 0 ||
            r.workout > 65535 ||
            !Array.isArray(r.samples) ||
            !r.samples.length ||
            r.samples.length > 512
          )
            throw fail('Неверная страница тренировки');
          if (
            !Number.isInteger(r.extensionMask ?? 0) ||
            (r.extensionMask ?? 0) < 0 ||
            (r.extensionMask ?? 0) > 0x7fffffff
          )
            throw fail('Маска расширения тренировки');
          let previous = -Infinity;
          data = {
            workout: r.workout,
            extensionMask: r.extensionMask ?? 0,
            samples: r.samples.map((s) => {
              if (!s || !time(s.time) || s.time < r.start || s.time >= r.end || s.time <= previous)
                throw fail('Время отсчёта тренировки');
              previous = s.time;
              const out = {
                time: s.time,
                ...metrics(s, {
                  heart: 254,
                  speed: 6553.4,
                  cadence: 254,
                  swolf: 65534,
                  strokeRate: 65534,
                  calories: 65534,
                  frequency: 65534,
                  power: 65534
                })
              };
              if (s.altitude !== undefined) {
                if (!Number.isFinite(s.altitude) || s.altitude < -12000 || s.altitude > 100000)
                  throw fail('Высота тренировки');
                out.altitude = s.altitude;
              }
              if (s.extensions !== undefined) {
                if (
                  typeof s.extensions !== 'string' ||
                  s.extensions.length > 510 ||
                  !/^([A-Fa-f0-9]{2})*$/.test(s.extensions)
                )
                  throw fail('Расширение тренировки');
                out.extensions = s.extensions;
              }
              return out;
            })
          };
        } else if (r.type === 'band') {
          if (
            !Number.isInteger(r.battery) ||
            r.battery < 0 ||
            r.battery > 100 ||
            !Number.isInteger(r.steps) ||
            r.steps < 0 ||
            r.steps > 1000000 ||
            r.end - r.start !== 1
          )
            throw fail('Неверный снимок браслета');
          data = {battery: r.battery, steps: r.steps};
        } else if (r.type === 'heart') {
          if (!Array.isArray(r.samples) || !r.samples.length || r.samples.length > 10000)
            throw fail('Неверные отсчёты пульса');
          data = {
            samples: r.samples.map((s) => {
              if (
                !s ||
                !time(s.time) ||
                s.time < r.start ||
                s.time >= r.end ||
                !Number.isFinite(s.bpm) ||
                s.bpm < 20 ||
                s.bpm > 300
              )
                throw fail('Неверный отсчёт пульса');
              return {time: s.time, bpm: s.bpm};
            })
          };
        } else if (r.type === 'sleep') {
          if (typeof r.complete !== 'boolean') throw fail('Нужно состояние завершения сна');
          const stages = r.stages ?? [];
          if (!Array.isArray(stages) || stages.length > 2000) throw fail('Неверные стадии сна');
          data = {
            complete: r.complete,
            ...(r.metrics !== undefined ? {metrics: metrics(r.metrics, sleepLimits)} : {}),
            ...(r.detail === 'trusleep' ? {detail: 'trusleep'} : {}),
            stages: stages.map((s) => {
              if (
                !s ||
                !Number.isSafeInteger(s.start) ||
                !Number.isSafeInteger(s.end) ||
                s.start < r.start ||
                s.end > r.end ||
                s.end <= s.start ||
                ![0, 1, 2, 3, 4, 5, 6, 7].includes(s.stage)
              )
                throw fail('Неверная стадия сна');
              return {start: s.start, end: s.end, stage: s.stage};
            })
          };
        } else {
          data = {};
          if (r.workout !== undefined) {
            if (!r.workout || typeof r.workout !== 'object' || Array.isArray(r.workout))
              throw fail('Неверная сводка тренировки');
            data.workout = {};
            const limits = {
              calories: 100000,
              distance: 10000000,
              steps: 1000000,
              duration: 604800,
              kind: 255
            };
            for (const [key, max] of Object.entries(limits)) {
              const value = r.workout[key];
              if (value === undefined) continue;
              if (!Number.isSafeInteger(value) || value < 0 || value > max)
                throw fail('Неверный показатель тренировки');
              data.workout[key] = value;
            }
          }
        }
        if (r.type === 'sleep' && r.dictionary !== undefined) {
          if (
            !r.dictionary ||
            typeof r.dictionary !== 'object' ||
            Array.isArray(r.dictionary) ||
            Object.keys(r.dictionary).length > 128
          )
            throw fail('Словарь сна');
          data.dictionary = {};
          for (const [key, value] of Object.entries(r.dictionary)) {
            if (
              !/^700013[0-9]{3}$/.test(key) ||
              !Number.isFinite(value) ||
              value < 0 ||
              value > Number.MAX_SAFE_INTEGER
            )
              throw fail('Поле словаря сна');
            data.dictionary[key] = value;
          }
        }
        if (['activity', 'stress', 'sleep'].includes(r.type) && r.deviceFields !== undefined) {
          if (
            !r.deviceFields ||
            typeof r.deviceFields !== 'object' ||
            Array.isArray(r.deviceFields) ||
            Object.keys(r.deviceFields).length > 64
          )
            throw fail('Поля устройства');
          data.deviceFields = {};
          let bytes = 0;
          for (const [key, value] of Object.entries(r.deviceFields)) {
            if (
              !/^(?:[0-9a-f]{1,2}|rriV3)$/.test(key) ||
              typeof value !== 'string' ||
              value.length > 2048 ||
              !/^([A-Fa-f0-9]{2})*$/.test(value) ||
              (bytes += value.length) > 8192
            )
              throw fail('Неверное поле устройства');
            data.deviceFields[key] = value;
          }
        }
        return {
          id,
          source,
          sourceName,
          type: r.type,
          start: r.start,
          end: r.end,
          modified: r.modified,
          data: JSON.stringify(data)
        };
      });
    const deleted = input.deleted.map((v) => str(v, 200));
    if (deleted.some((id) => ids.has(id))) throw fail('Запись одновременно удаляется и изменяется');
    return this.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM devices WHERE id=? AND revoked=0').get(device.id))
        throw fail('Ключ отозван', 401);
      if (input.reset === true)
        this.db.prepare('DELETE FROM records WHERE device=?').run(device.id);
      if (input.complete !== true)
        this.db.prepare('UPDATE devices SET last_sync=NULL WHERE id=?').run(device.id);
      let changed = 0;
      for (const r of records) {
        this.db
          .prepare('INSERT OR IGNORE INTO sources(id,device,name) VALUES(?,?,?)')
          .run(r.source, device.id, r.sourceName);
        const old = this.db
          .prepare('SELECT * FROM records WHERE device=? AND id=?')
          .get(device.id, r.id);
        if (old && old.modified >= r.modified) continue;
        this.db
          .prepare(
            `INSERT INTO records VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(device,id) DO UPDATE SET source=excluded.source,type=excluded.type,start=excluded.start,end=excluded.end,modified=excluded.modified,data=excluded.data,deleted=0`
          )
          .run(device.id, r.id, r.source, r.type, r.start, r.end, r.modified, r.data);
        changed++;
      }
      for (const id of deleted)
        changed += this.db
          .prepare('UPDATE records SET deleted=1,modified=? WHERE device=? AND id=? AND deleted=0')
          .run(Date.now(), device.id, id).changes;
      // Mark completion only after the entire submitted batch has been accepted.
      if (input.complete === true)
        this.db.prepare('UPDATE devices SET last_sync=? WHERE id=?').run(Date.now(), device.id);

      return {accepted: records.length, changed, deleted: deleted.length};
    });
  }
  confirmSleep(day) {
    const daily = this.daily(day);
    if (daily.sleepMinutes === null) throw fail('Нет записей сна для подтверждения');
    const rows = this.sleepRows(day);
    this.db
      .prepare('INSERT OR REPLACE INTO sleep_confirmations VALUES(?,?)')
      .run(day, hash(JSON.stringify(rows)));
    return this.daily(day);
  }
  sleepRows(day) {
    return this.db
      .prepare(
        "SELECT id,source,start,end,data FROM records WHERE type='sleep' AND deleted=0 ORDER BY id,source"
      )
      .all()
      .filter((r) => dayName(r.end - 1, this.config().zone) === day);
  }
  exportDay(day) {
    let range;
    try {
      range = bounds(day, this.config().zone);
    } catch {
      throw fail('Некорректная дата');
    }
    const [from, to] = range;
    return this.db
      .prepare(
        'SELECT id,source,type,start,end,modified,data FROM records WHERE deleted=0 AND start<? AND end>? ORDER BY start,id LIMIT 30001'
      )
      .all(to, from)
      .map((r, i) => {
        if (i === 30000) throw fail('Слишком много записей за день');
        return {...r, ...JSON.parse(r.data), data: undefined};
      });
  }
  daily(day, now = Date.now()) {
    const zone = this.config().zone;
    let range;
    try {
      range = bounds(day, zone);
    } catch {
      throw fail('Некорректная дата');
    }
    const [from, to] = range,
      rows = this.db
        .prepare('SELECT * FROM records WHERE deleted=0 AND start<? AND end>?')
        .all(to, from - 7 * 86400000)
        .map((r) => ({...r, data: JSON.parse(r.data)}));
    const result = summarize(day, zone, rows, this.sources(), now);
    if (result.sleepMinutes !== null && !result.sleepComplete) {
      const confirmed = this.db
        .prepare('SELECT digest FROM sleep_confirmations WHERE day=?')
        .get(day);
      if (confirmed?.digest === hash(JSON.stringify(this.sleepRows(day))))
        result.sleepComplete = true;
    }
    const sourceById = new Map(this.sources().map((s) => [s.id, s])),
      deviceById = new Map(this.devices().map((d) => [d.id, d]));
    const relevant = result.sources.map((id) => deviceById.get(sourceById.get(id)?.device));
    result.ready =
      result.closed &&
      result.sleepComplete &&
      result.sleepEnd !== null &&
      now >= result.sleepEnd + 7200000 &&
      relevant.length > 0 &&
      relevant.every((d) => d?.last_sync >= Math.max(to, result.sleepEnd + 7200000));
    result.report = this.db.prepare('SELECT * FROM reports WHERE day=?').get(day) ?? null;
    if (result.report) {
      const stored = JSON.parse(result.report.summary);
      const {report, ready, ...current} = result;
      result.report = {
        ...result.report,
        summary: stored,
        stale: +(JSON.stringify(stored) !== JSON.stringify(current))
      };
    }
    return result;
  }
  history(days = 30, now = Date.now()) {
    const zone = this.config().zone,
      today = dayName(now, zone);
    return Array.from({length: days}, (_, i) =>
      this.daily(new Date(Date.parse(today) - i * 86400000).toISOString().slice(0, 10), now)
    );
  }
}
