import {modulePage} from '../../src/views.mjs';
import {moduleSummary} from '../../src/modules.mjs';
import {Activity} from '../../src/activity.mjs';
const activity = new Activity(process.env.DATA_DIR || '/app/data');
const content = `<link rel="stylesheet" href="/activity.css"><script src="/activity-views.js" defer></script><section id="statisticsPage"><div class="statistics-heading"><h2>Моё время</h2><select id="statisticsDays" aria-label="Период"><option value="7">7 дней</option><option value="14" selected>14 дней</option><option value="30">30 дней</option><option value="90">90 дней</option></select><button id="statisticsRefresh" type="button">Обновить</button></div><p id="statisticsStatus" role="status"></p><p id="statisticsTotal"></p><p id="statisticsDelivery" role="status"></p><button id="statisticsRejected" type="button" hidden>Скачать отклонённые события</button><div id="statisticsTimeline" class="statistics-timeline"></div><p class="trophy-muted">Время в хабе учитывается по воспроизведению и открытому чтению. Параллельные занятия могут пересекаться. Новые счётчики собираются после обновления; старые данные не пересчитываются приблизительно.</p><div id="statisticsSources" class="activity-grid"></div><div id="statisticsTabs" class="activity-tabs" role="group" aria-label="Раздел активности"></div><h3 id="statisticsRecentTitle">Последняя активность</h3><div id="statisticsRecent"></div></section>`;
const categories = [
  ['anime', 'Аниме'],
  ['cinema', 'Кино'],
  ['wave', 'Музыка'],
  ['reader', 'Книги'],
  ['trophies', 'Игры']
];
export async function summary() {
  const data = activity.snapshot();
  return {
    state: 'ok',
    items: data.totals.map((r) => ({
      label: {wave: 'Музыка', cinema: 'Видео', reader: 'Чтение'}[r.source],
      value: Math.round(r.seconds / 60) + ' мин'
    }))
  };
}
export async function handle({
  request,
  path: route,
  user,
  modules = new Map(),
  activity: store = activity,
  searchParams,
  authorized = () => true
}) {
  if (!authorized()) return Response.json({error: 'Нужен вход'}, {status: 401});
  if (request.method === 'GET' && route === '/')
    return new Response(modulePage({embedded: user.embedded, username: user.username, title: 'Хронос', content}), {
      headers: {'Content-Type': 'text/html; charset=utf-8'}
    });
  if (request.method === 'GET' && route === '/api') {
    const data = store.snapshot(searchParams?.get('days'));
    const sources = await Promise.all(
      categories.map(async ([id, title]) => {
        const m = modules.get(id);
        const info = (m ? await moduleSummary(m) : null) ?? {state: 'missing', items: []};
        return {
          id,
          title,
          ...info,
          items: (info.items || []).filter((item) => id !== 'cinema' || item.label !== 'Раздача')
        };
      })
    );
    const recent = {};
    for (const id of ['anime', 'trophies']) {
      const module = modules.get(id);
      if (!module?.recent) continue;
      try {
        recent[id] = await module.recent();
      } catch {
        recent[id] = {error: 'Не удалось прочитать сохранённую историю.'};
      }
    }
    let games = null;
    try { games = await modules.get('trophies')?.statistics?.(); } catch {}
    return Response.json({items: data.items, sources, recent, measured:data.measured, timeline:data.timeline, pages:data.pages, days:data.days, games});
  }
  return Response.json({error: 'Не найдено'}, {status: 404});
}
export const close = () => activity.close();
