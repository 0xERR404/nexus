import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';

export const tariffDate = '2026-09-23';
const tariffs = {
  'deepseek-flash': [0.003, 0.15, 0.6],
  'deepseek-v4-flash': [0.003, 0.15, 0.6],
  'deepseek-v4-flash-vision-exp': [0.003, 0.15, 0.6],
  'deepseek-v4-pro': [0.022, 0.66, 1.98]
};
const count = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 100000000;
export function normalizeUsage(value) {
  if (
    !value ||
    !['prompt_tokens', 'completion_tokens', 'total_tokens'].every((k) => count(value[k]))
  )
    return null;
  const result = Object.fromEntries(
    ['prompt_tokens', 'completion_tokens', 'total_tokens'].map((k) => [k, value[k]])
  );
  if (count(value.prompt_cache_hit_tokens) && value.prompt_cache_hit_tokens <= result.prompt_tokens)
    result.prompt_cache_hit_tokens = value.prompt_cache_hit_tokens;
  return result;
}
export function estimate(model, usage) {
  const rate = tariffs[model];
  if (!rate || !usage) return null;
  const hit = usage.prompt_cache_hit_tokens;
  const known = Number.isSafeInteger(hit);
  const price = (cached) =>
    (cached * rate[0] +
      (usage.prompt_tokens - cached) * rate[1] +
      usage.completion_tokens * rate[2]) /
    1000000;
  // Диапазон учитывает пик, праздники и неизвестный кэш.
  return {low: price(known ? hit : usage.prompt_tokens), high: price(known ? hit : 0) * 2};
}
export function initUsage(db) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_usage'").get()) return;
  db.exec(`CREATE TABLE ai_usage(id TEXT PRIMARY KEY,created INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,status TEXT NOT NULL,usage TEXT,low REAL,high REAL,tariff TEXT NOT NULL DEFAULT '') STRICT;
    CREATE INDEX ai_usage_created ON ai_usage(created);`);
  const insert = db.prepare(
    'INSERT INTO ai_usage(id,created,provider,model,status,usage) VALUES(?,?,?,?,?,?)'
  );
  for (const row of db
    .prepare(
      "SELECT m.created,m.model,m.status,m.usage,t.provider,r.id AS requestId FROM messages m JOIN topics t ON t.id=m.topic LEFT JOIN requests r ON r.assistant=m.id WHERE m.role='assistant'"
    )
    .iterate()) {
    let usage;
    try {
      usage = normalizeUsage(JSON.parse(row.usage));
    } catch {}
    insert.run(
      row.provider === 'flowmusic' && row.requestId
        ? 'flow:' + row.requestId
        : 'legacy:' + randomUUID(),
      row.created,
      row.provider,
      row.model,
      row.status,
      usage ? JSON.stringify(usage) : null
    );
  }
}
export function startUsage(db, job, provider) {
  const id = provider === 'flowmusic' ? 'flow:' + job.id : randomUUID();
  db.prepare(
    "INSERT INTO ai_usage(id,created,provider,model,status) VALUES(?,?,?,?,'running') ON CONFLICT(id) DO UPDATE SET status='running'"
  ).run(id, Date.now(), provider, job.model);
  return id;
}
export function saveUsage(db, id, value, model) {
  const usage = normalizeUsage(value);
  if (!usage || !id) return;
  const price = estimate(model, usage);
  db.prepare('UPDATE ai_usage SET usage=?,low=?,high=?,tariff=? WHERE id=?').run(
    JSON.stringify(usage),
    price?.low ?? null,
    price?.high ?? null,
    price ? tariffDate : '',
    id
  );
}
export function usageSnapshot(file, now = Date.now()) {
  const empty = {available: false, tariffDate, periods: []};
  if (!fs.existsSync(file)) return empty;
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    db.exec('PRAGMA busy_timeout=3000');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='ai_usage'").get()) return empty;
    const periods = [
      ['hour', 3600000],
      ['day', 86400000],
      ['month', 30 * 86400000],
      ['all', Infinity]
    ].map(([id, duration]) => {
      const rows = db
        .prepare(
          `SELECT provider,COUNT(*) AS requests,
        COALESCE(SUM(json_extract(usage,'$.total_tokens')),0) AS tokens,
        COUNT(usage) AS measured,COUNT(low) AS priced,COALESCE(SUM(low),0) AS low,COALESCE(SUM(high),0) AS high,
        SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running
        FROM ai_usage WHERE created>=? AND created<=? GROUP BY provider`
        )
        .all(Number.isFinite(duration) ? now - duration : 0, now);
      return {id, providers: rows};
    });
    return {available: true, tariffDate, periods};
  } finally {
    db.close();
  }
}
