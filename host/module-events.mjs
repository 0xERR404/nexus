import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
export function kanbanEvents(file, state, now = Date.now()) {
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const rows = db
      .prepare('SELECT id,title,remind,done,archived FROM cards WHERE remind IS NOT NULL')
      .all();
    state.kanbanSeen ??= {};
    const live = new Set(rows.map((r) => `${r.id}:${r.remind}`));
    for (const key of Object.keys(state.kanbanSeen))
      if (!live.has(key)) delete state.kanbanSeen[key];
    const events = [];
    for (const r of rows) {
      const key = `${r.id}:${r.remind}`;
      if (r.done || r.archived || r.remind > now || state.kanbanSeen[key]) continue;
      state.kanbanSeen[key] = true;
      const id = createHash('sha256').update(key).digest('hex');
      events.push({
        id,
        key: 'kanban.' + id,
        title: 'Напоминание о задаче',
        body: r.title,
        category: 'maintenance',
        level: 'info',
        time: now
      });
    }
    return events;
  } finally {
    db.close();
  }
}

export function rhythmEvents(file, state, now = Date.now()) {
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    db.exec('PRAGMA busy_timeout=1000');
    state.rhythmSeen ??= {};
    const rows = db
        .prepare("SELECT day FROM reports WHERE status='done' ORDER BY day DESC LIMIT 60")
        .all(),
      keys = new Set(rows.map((r) => r.day));
    for (const day of Object.keys(state.rhythmSeen))
      if (!keys.has(day)) delete state.rhythmSeen[day];
    return rows
      .filter((r) => !state.rhythmSeen[r.day])
      .map((r) => {
        state.rhythmSeen[r.day] = true;
        const id = createHash('sha256')
          .update('rhythm:' + r.day)
          .digest('hex');
        return {
          id,
          key: 'rhythm.' + r.day,
          title: 'Асклепий · отчёт готов',
          body: 'Сводка за ' + r.day + ' доступна в хабе.',
          category: 'maintenance',
          level: 'info',
          time: now
        };
      });
  } finally {
    db.close();
  }
}


export function hubNotices(file, state, now = Date.now()) {
  if (!fs.existsSync(file)) return [];
  if (fs.statSync(file).size > 262144) return [];
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  if (data.schema !== 1 || !Array.isArray(data.events)) return [];
  const events = data.events.slice(0,200).filter(e => typeof e.id==='string' && /^hub\.[a-z0-9-]+\.[a-z]+$/.test(e.key) && e.category==='services' && e.level==='warning' && Number.isFinite(e.time) && e.time<=now && e.time>=now-86400000 && typeof e.title==='string' && e.title.length<=160 && typeof e.body==='string' && e.body.length<=500);
  const seen = new Set(state.hubNoticesSeen || []);
  state.hubNoticesSeen = events.map(e=>e.id);
  return events.filter(e=>!seen.has(e.id));
}
