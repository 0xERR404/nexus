// Shared projections for the dashboard: never synthesize progress or connectivity.
export function dayWindow(now = Date.now()) {
  const day = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
  const start = Date.parse(day + 'T00:00:00+03:00');
  return {day, start, end: start + 86400000, zone: 'Europe/Moscow'};
}
export function mediaRows(kind, library, history = []) {
  const map = new Map(library.map(t => [t.id, t]));
  const rows = [];
  for (const h of [...history].filter(h => h.source === kind).sort((a,b) => b.updated - a.updated)) {
    if (h.completed || !Number.isFinite(h.position) || !Number.isFinite(h.duration) || h.position <= 0 || h.duration <= 0 || h.position >= h.duration - 1) continue;
    const split = kind === 'cinema' ? /^(.*):(\d+)$/.exec(h.item) : null;
    if (kind === 'cinema' && !split) continue;
    const id = split ? split[1] : h.item, item = map.get(id);
    if (!item || rows.some(r => r.id === id)) continue;
    const file = split ? Number(split[2]) : undefined;
    if (file !== undefined && !Number.isSafeInteger(file)) continue;
    rows.push({...item, kind, file, position: h.position, duration: h.duration,
      progress: Math.min(100, h.position / h.duration * 100), updatedAt: h.updated,
      href: item.href + (file !== undefined ? '&file=' + file + '&resume=1' : '')});
    if (rows.length === 6) break;
  }
  return rows;
}
export function safeSearch(rows, query) {
  const q = query.toLocaleLowerCase('ru');
  return rows.filter(r => [r.title, r.detail].filter(Boolean).join(' ').toLocaleLowerCase('ru').includes(q)).slice(0,20);
}
