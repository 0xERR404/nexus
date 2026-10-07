import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveUsage} from '../../src/ai-usage.mjs';
import {complete} from '../../src/deepseek.mjs';
import {fail} from './store.mjs';
import {ANALYSIS_VERSION, ANALYSIS_PROMPT, analysisPayload} from './analysis.mjs';
export class Reports {
  constructor(store, {completeRequest = complete, now = Date.now} = {}) {
    this.store = store;
    this.completeRequest = completeRequest;
    this.now = now;
    this.active = new Set();
  }
  recover() {
    this.store.load();
    this.store.db.exec(
      "UPDATE reports SET status='uncertain',error='Хаб перезапущен во время запроса. Автоматический повтор отключён.' WHERE status='running'; UPDATE report_previews SET status='uncertain',error='Хаб перезапущен во время запроса. Автоматический повтор отключён.' WHERE status='running'; UPDATE ai_usage SET status='uncertain' WHERE status='running'"
    );
  }
  configuration() {
    try {
      const config = JSON.parse(fs.readFileSync(path.join(this.store.directory, '../chat/deepseek.json'), 'utf8'));
      if (typeof config.key === 'string' && config.key.trim() && typeof config.model === 'string' && config.model.trim()) return config;
    } catch {}
    return null;
  }
  availability() {
    const config = this.configuration();
    return {configured: !!config, model: config?.model ?? ''};
  }
  async generate(day, retry = false, preview = false) {
    const s = this.store,
      now = this.now(),
      daily = s.daily(day, now),
      field = preview ? 'previewReport' : 'report',
      table = preview ? 'report_previews' : 'reports',
      activeKey = table + ':' + day,
      existing = daily[field];
    if (existing && !retry) return existing;
    if (this.active.has(activeKey)) throw fail('Отчёт уже формируется', 409);
    const updatedPreview = preview && existing?.status === 'done' && existing.stale;
    if (existing && !updatedPreview && (existing.status === 'done' || existing.attempts >= 3))
      throw fail('Отчёт уже готов либо достигнут лимит трёх попыток', 409);
    if (!preview && !daily.ready)
      throw fail('Нужны закрытые сутки, завершённый сон и полная синхронизация после них', 409);
    if (preview && daily.steps === null && !daily.band && !daily.heart && !daily.spo2 && !daily.stress && !Object.values(daily.movement ?? {}).some(Number.isFinite) && !daily.sleepReceived)
      throw fail('За эту дату ещё нет измерений для сводки ИИ', 409);
    const config = this.configuration();
    if (!config) throw fail('Настрой ключ и модель DeepSeek в Сократе', 409);
    const {report, previewReport, ready, emotion, activityMinutes, workouts, sport, ...data} = daily,
      numbers = preview ? {...data, analysisVersion: ANALYSIS_VERSION} : data,
      usageId = randomUUID();
    const claimed = s.transaction(() => {
      const old = s.db.prepare(`SELECT * FROM ${table} WHERE day=?`).get(day);
      const freshPreview = preview && old?.status === 'done' && old.summary !== JSON.stringify(numbers);
      if (old && (!retry || old.status === 'running' || (!freshPreview && (old.status === 'done' || old.attempts >= 3))))
        return false;
      s.db
        .prepare(
          `INSERT INTO ${table}(day,status,summary,created) VALUES(?,'running',?,?) ON CONFLICT(day) DO UPDATE SET status='running',summary=excluded.summary,text='',error='',created=excluded.created,attempts=CASE WHEN ${table}.status='done' THEN 1 ELSE ${table}.attempts+1 END,stale=0`
        )
        .run(day, JSON.stringify(numbers), now);
      s.db
        .prepare("INSERT INTO ai_usage(id,created,provider,model,status) VALUES(?,?,?,?,'running')")
        .run(usageId, now, 'rhythm-deepseek', config.model);
      return true;
    });
    if (!claimed) return s.daily(day, now)[field];
    this.active.add(activeKey);
    try {
      const result = await this.completeRequest({
        key: config.key,
        model: config.model,
        thinking: false,
        maxTokens: 2048,
        signal: AbortSignal.timeout(90000),
        onDelta: () => {},
        onUsage: (u) => saveUsage(s.db, usageId, u, config.model),
        messages: [
          {
            role: 'system',
            content: ANALYSIS_PROMPT
          },
          {
            role: 'user',
            content: JSON.stringify(analysisPayload(numbers, ready, preview, now,
              numbers.sources.length && s.sources().filter(source => numbers.sources.includes(source.id)).every(source => source.name.startsWith('Huawei Band 11 · '))
                ? 'Huawei Band 11' : undefined))
          }
        ]
      });
      if (typeof result.content !== 'string' || !result.content.trim()) throw Error('Empty report');
      s.transaction(() => {
        saveUsage(s.db, usageId, result.usage, config.model);
        s.db.prepare("UPDATE ai_usage SET status='done' WHERE id=?").run(usageId);
        s.db
          .prepare(`UPDATE ${table} SET status='done',text=?,error='' WHERE day=?`)
          .run(result.content, day);
      });
    } catch {
      s.transaction(() => {
        s.db.prepare("UPDATE ai_usage SET status='uncertain' WHERE id=?").run(usageId);
        s.db
          .prepare(`UPDATE ${table} SET status='uncertain',error=? WHERE day=?`)
          .run('Ответ не получен. Запрос мог быть оплачен; автоматического повтора не будет.', day);
      });
    } finally {
      this.active.delete(activeKey);
    }
    return s.daily(day, this.now())[field];
  }
  async tick() {
    if (!this.store.config().auto || this.active.size) return;
    for (const d of this.store.history(7, this.now()))
      if (d.ready && !d.report) {
        await this.generate(d.day);
        break;
      }
  }
}
