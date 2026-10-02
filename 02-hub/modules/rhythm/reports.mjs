import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveUsage} from '../../src/ai-usage.mjs';
import {complete} from '../../src/deepseek.mjs';
import {fail} from './store.mjs';
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
      "UPDATE reports SET status='uncertain',error='Хаб перезапущен во время запроса. Автоматический повтор отключён.' WHERE status='running'; UPDATE ai_usage SET status='uncertain' WHERE status='running'"
    );
  }
  async generate(day, retry = false) {
    const s = this.store,
      now = this.now(),
      daily = s.daily(day, now),
      existing = daily.report;
    if (existing && !retry) return existing;
    if (this.active.has(day)) throw fail('Отчёт уже формируется', 409);
    if (existing && (existing.status === 'done' || existing.attempts >= 3))
      throw fail('Отчёт уже готов либо достигнут лимит трёх попыток', 409);
    if (!daily.ready)
      throw fail('Нужны закрытые сутки, завершённый сон и полная синхронизация после них', 409);
    let config;
    try {
      config = JSON.parse(fs.readFileSync(path.join(s.directory, '../chat/deepseek.json'), 'utf8'));
    } catch {
      throw fail('Настрой DeepSeek в модуле чата', 409);
    }
    if (!config.key || typeof config.model !== 'string')
      throw fail('Настрой ключ и модель DeepSeek в чате', 409);
    const {report, ready, ...numbers} = daily,
      usageId = randomUUID();
    const claimed = s.transaction(() => {
      const old = s.db.prepare('SELECT * FROM reports WHERE day=?').get(day);
      if (old && (!retry || old.status === 'running' || old.status === 'done' || old.attempts >= 3))
        return false;
      s.db
        .prepare(
          "INSERT INTO reports(day,status,summary,created) VALUES(?,'running',?,?) ON CONFLICT(day) DO UPDATE SET status='running',summary=excluded.summary,error='',created=excluded.created,attempts=reports.attempts+1,stale=0"
        )
        .run(day, JSON.stringify(numbers), now);
      s.db
        .prepare("INSERT INTO ai_usage(id,created,provider,model,status) VALUES(?,?,?,?,'running')")
        .run(usageId, now, 'rhythm-deepseek', config.model);
      return true;
    });
    if (!claimed) return s.daily(day, now).report;
    this.active.add(day);
    try {
      const result = await this.completeRequest({
        key: config.key,
        model: config.model,
        thinking: false,
        maxTokens: 1024,
        signal: AbortSignal.timeout(90000),
        onDelta: () => {},
        onUsage: (u) => saveUsage(s.db, usageId, u, config.model),
        messages: [
          {
            role: 'system',
            content:
              'Ты составляешь короткую русскую сводку активности по числам. До 150 слов. Отметь пропуски и оценочные значения. Не ставь диагнозы, не назначай лечение, не выдумывай нормы, измерения и причины. Это дневник активности. Сравнения с прошлыми днями недопустимы: их здесь нет.'
          },
          {
            role: 'user',
            content: JSON.stringify({
              ...numbers,
              sources: undefined,
              sourceCount: numbers.sources.length
            })
          }
        ]
      });
      s.transaction(() => {
        saveUsage(s.db, usageId, result.usage, config.model);
        s.db.prepare("UPDATE ai_usage SET status='done' WHERE id=?").run(usageId);
        s.db
          .prepare("UPDATE reports SET status='done',text=?,error='' WHERE day=?")
          .run(result.content, day);
      });
    } catch {
      s.transaction(() => {
        s.db.prepare("UPDATE ai_usage SET status='uncertain' WHERE id=?").run(usageId);
        s.db
          .prepare("UPDATE reports SET status='uncertain',error=? WHERE day=?")
          .run('Ответ не получен. Запрос мог быть оплачен; автоматического повтора не будет.', day);
      });
    } finally {
      this.active.delete(day);
    }
    return s.daily(day, this.now()).report;
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
