import {randomUUID} from 'node:crypto';
import {bounds, dayName, summarize} from './summary.mjs';
import {fail} from './store.mjs';
import {ANALYSIS_VERSION, ANALYSIS_PROMPT, analysisPayload} from './analysis.mjs';
import {saveUsage} from '../../src/ai-usage.mjs';

export class WakeReports {
  constructor(store, reports, now = Date.now) {
    this.store = store;
    this.reports = reports;
    this.now = now;
    this.active = false;
  }
  load() {
    this.store.load();
    this.store.db.exec(`CREATE TABLE IF NOT EXISTS wake_reports(
      id TEXT PRIMARY KEY,day TEXT NOT NULL,status TEXT NOT NULL,summary TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL,
      attempts INTEGER NOT NULL,automatic INTEGER NOT NULL,replaces TEXT);
      CREATE INDEX IF NOT EXISTS wake_reports_day ON wake_reports(day,created);
      CREATE UNIQUE INDEX IF NOT EXISTS wake_reports_running ON wake_reports(day) WHERE status='running';`);
  }
  recover() {
    this.load();
    this.store.db.exec("UPDATE wake_reports SET status='uncertain',error='Запрос прерван перезапуском. Автоматический повтор отключён.' WHERE status='running'");
  }
  sessions(now = this.now()) {
    this.load();
    const zone = this.store.config().zone;
    const rows = this.store.db.prepare(`SELECT r.*,s.priority FROM records r JOIN sources s ON s.id=r.source
      JOIN devices d ON d.id=r.device WHERE r.type='sleep' AND r.deleted=0 AND d.revoked=0 ORDER BY r.end DESC`).all();
    const days = new Map();
    for (const row of rows) {
      const data = JSON.parse(row.data), window = data.window;
      if (!window && !data.complete) continue;
      const start = window?.start ?? row.start, end = window?.end ?? row.end;
      if (end > now || end <= start) continue;
      const day = dayName(end, zone);
      const candidate = {day, start, end, source: row.source, priority: row.priority, detail: data.detail === 'trusleep'};
      const old = days.get(day);
      if (!old || candidate.priority < old.priority || (candidate.priority === old.priority &&
          (+candidate.detail > +old.detail || (candidate.detail === old.detail && end - start > old.end - old.start)))) days.set(day, candidate);
    }
    return [...days.values()].sort((a, b) => b.end - a.end);
  }
  summary(day) {
    const s = this.store, now = this.now(), zone = s.config().zone;
    bounds(day, zone);
    const sessions = this.sessions(now), current = sessions.find(session => session.day === day);
    if (!current) return null;
    const previous = sessions.find(session => session.source === current.source && session.end <= current.start && current.end - session.end <= 48 * 3600000);
    const from = previous?.end ?? current.end - 86400000, to = current.end;
    const rows = s.db.prepare('SELECT * FROM records WHERE deleted=0 AND start<? AND end>?')
      .all(to, from).map(row => ({...row, data: JSON.parse(row.data)}));
    const {emotion, activityMinutes, workouts, sport, ...numbers} = summarize(day, zone, rows, s.sources(), now, [from, to]);
    return {...numbers, analysisVersion: ANALYSIS_VERSION, reportPeriod: {start: from, end: to, previousWakeKnown: !!previous}, boundary: 'wake'};
  }
  state(day) {
    this.load();
    bounds(day, this.store.config().zone);
    const rows = this.store.db.prepare('SELECT rowid,* FROM wake_reports WHERE day=? ORDER BY rowid DESC').all(day);
    const parse = row => row && ({...row, summary: JSON.parse(row.summary)});
    const latest = parse(rows[0]) ?? null, done = rows.filter(row => row.status === 'done');
    const report = parse(done[0]) ?? null;
    const live = this.summary(day);
    return {ready: !!live, period: report?.summary.reportPeriod ?? live?.reportPeriod ?? null,
      report, attempt: latest, versions: done.slice(1).map(parse), automatic: this.automaticState(live,latest)};
  }
  automaticState(numbers, attempt=null) {
    if(attempt) return {state:attempt.status==='done'?'saved':attempt.status};
    const config=this.store.config();
    if(!config.auto)return {state:'disabled'};
    if(!this.reports.configuration())return {state:'need_key'};
    if(!numbers)return {state:'need_sleep'};
    if(numbers.to<config.auto_since)return {state:'before_enabled'};
    const devices=new Map(this.store.devices().map(d=>[d.id,d]));
    const sources=new Map(this.store.sources().map(s=>[s.id,s]));
    const pending=new Set(numbers.sources.filter(id=>{
      const d=devices.get(sources.get(id)?.device);
      return !d || d.revoked || !(d.read_finished>=numbers.to);
    }).map(id=>sources.get(id)?.device??id));
    return pending.size || !numbers.sources.length ? {state:'waiting_read',pendingDevices:pending.size} : {state:'ready'};
  }
  previousPeriods(numbers) {
    return this.sessions().filter(session => session.end <= numbers.from && session.end >= numbers.from - 7 * 86400000)
      .slice(0, 7).map(session => this.summary(session.day)).filter(Boolean).map(previous => ({
        day: previous.day, from: previous.from, to: previous.to,
        previousWakeKnown: previous.reportPeriod.previousWakeKnown,
        sameSources: [...previous.sources].sort().join(',') === [...numbers.sources].sort().join(','),
        comparableDuration: previous.reportPeriod.previousWakeKnown && numbers.reportPeriod.previousWakeKnown &&
          Math.abs((previous.to - previous.from) - (numbers.to - numbers.from)) <= 3600000,
        steps: previous.steps, stepsEstimated: previous.stepsEstimated, stepCoverageMinutes: previous.stepCoverageMinutes,
        movement: previous.movement, heart: previous.heart, spo2: previous.spo2, stress: previous.stress,
        sleepMinutes: previous.sleepMinutes, sleepWindowMinutes: previous.sleepWindowMinutes,
        sleepComplete: previous.sleepComplete, sleepEstimated: previous.sleepEstimated,
        unknownSleepMinutes: previous.unknownSleepMinutes, sleepStages: previous.sleepStages,
        sleepAccounting: previous.sleepAccounting
      }));
  }
  async generate(day, {manual = false, expected = null, confirmation = ''} = {}) {
    this.load();
    const s = this.store, current = this.state(day), latest = current.attempt;
    if (!manual && latest) return current;
    if (manual && (latest?.id ?? null) !== expected) throw fail('Отчёт уже изменился. Обнови страницу перед повтором.', 409);
    if (latest && confirmation !== 'ПЕРЕСОЗДАТЬ') throw fail('Для нового запроса введи ПЕРЕСОЗДАТЬ', 409);
    if (latest?.status === 'running') throw fail('Отчёт уже формируется', 409);
    if (latest?.status === 'uncertain' && latest.attempts >= 3) throw fail('Достигнут лимит трёх неопределённых попыток', 409);
    const numbers = this.summary(day);
    if (!numbers) throw fail('Браслет ещё не передал границы завершившегося сна', 409);
    const config = this.reports.configuration();
    if (!config) throw fail('Настрой ключ и модель DeepSeek в Сократе', 409);
    numbers.previousPeriods = this.previousPeriods(numbers);
    const id = randomUUID(), now = this.now(), attempts = latest?.status === 'uncertain' ? latest.attempts + 1 : 1;
    const claimed = s.transaction(() => {
      const last = s.db.prepare('SELECT id FROM wake_reports WHERE day=? ORDER BY rowid DESC LIMIT 1').get(day);
      if ((last?.id ?? null) !== (latest?.id ?? null)) return false;
      s.db.prepare("INSERT INTO wake_reports(id,day,status,summary,created,attempts,automatic,replaces) VALUES(?,?,'running',?,?,?,?,?)")
        .run(id, day, JSON.stringify(numbers), now, attempts, +!manual, current.report?.id ?? null);
      s.db.prepare("INSERT INTO ai_usage(id,created,provider,model,status) VALUES(?,?,?,?,'running')").run(id, now, 'rhythm-deepseek', config.model);
      return true;
    });
    if (!claimed) return this.state(day);
    try {
      const payload = analysisPayload(numbers, true, false, now,
        numbers.sources.length && s.sources().filter(source => numbers.sources.includes(source.id)).every(source => source.name.startsWith('Huawei Band 11 · ')) ? 'Huawei Band 11' : undefined);
      payload.kind = 'wake';
      payload.context.period = {start: new Date(numbers.from).toISOString(), end: new Date(numbers.to).toISOString(),
        description: numbers.reportPeriod.previousWakeKnown ? 'От предыдущего пробуждения до текущего.' : 'Предыдущее пробуждение неизвестно: первый отчёт охватывает 24 часа до текущего. Это приблизительная граница начала.'};
      const result = await this.reports.completeRequest({key: config.key, model: config.model, thinking: false, maxTokens: 2048,
        signal: AbortSignal.timeout(90000), onDelta: () => {}, onUsage: usage => saveUsage(s.db, id, usage, config.model),
        messages: [{role: 'system', content: ANALYSIS_PROMPT},
          {role: 'user', content: JSON.stringify(payload)}]});
      if (typeof result.content !== 'string' || !result.content.trim()) throw Error('Empty report');
      s.transaction(() => {
        saveUsage(s.db, id, result.usage, config.model);
        s.db.prepare("UPDATE ai_usage SET status='done' WHERE id=?").run(id);
        s.db.prepare("UPDATE wake_reports SET status='done',text=? WHERE id=?").run(result.content, id);
      });
    } catch {
      s.transaction(() => {
        s.db.prepare("UPDATE ai_usage SET status='uncertain' WHERE id=?").run(id);
        s.db.prepare("UPDATE wake_reports SET status='uncertain',error=? WHERE id=?")
          .run('Ответ не получен; запрос мог быть оплачен. Повтор только вручную. Предыдущий готовый отчёт сохранён.', id);
      });
    }
    return this.state(day);
  }
  async tick() {
    this.load();
    const config = this.store.config();
    if (!config.auto || this.active || !this.reports.configuration()) return;
    this.active = true;
    try {
      for (const session of this.sessions()) {
        if (session.end < config.auto_since) continue;
        if (this.store.db.prepare('SELECT 1 FROM wake_reports WHERE day=? LIMIT 1').get(session.day)) continue;
        const numbers = this.summary(session.day);
        if (this.automaticState(numbers).state!=='ready') continue;
        await this.generate(session.day);
        break;
      }
    } finally { this.active = false; }
  }
}
