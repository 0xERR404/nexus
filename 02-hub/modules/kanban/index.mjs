import {readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {Kanban, fail} from './store.mjs';
export const store = new Kanban(path.join(process.env.DATA_DIR ?? '/app/data', 'kanban'));
const assets =
  '<link rel="stylesheet" href="/modules/kanban/kanban.css"><script src="/modules/kanban/kanban.js" defer></script>';
const page = `${assets}<section id="kanban"><div class="kb-tools"><select id="kbBoard" aria-label="Доска"></select><button id="kbNewBoard">＋ Доска</button><button id="kbNewColumn">＋ Колонка</button><button id="kbRefresh">Обновить</button></div><div class="kb-tools"><input id="kbSearch" type="search" placeholder="Поиск"><input id="kbTag" placeholder="Метка"><select id="kbPriority"><option value="">Любой приоритет</option><option value="0">Обычный</option><option value="1">Низкий</option><option value="2">Высокий</option><option value="3">Срочный</option></select><label><input id="kbArchive" type="checkbox"> Архив</label></div><p id="kbStatus" role="status"></p><div id="kbColumns"></div></section>
<dialog id="kbEditor"><form id="kbForm"><h2>Задача</h2><label>Заголовок<input id="kbTitle" maxlength="180" required></label><label>Описание<textarea id="kbDescription" maxlength="10000"></textarea></label><label>Колонка<select id="kbColumn"></select></label><label>Приоритет<select id="kbEditPriority"><option value="0">Обычный</option><option value="1">Низкий</option><option value="2">Высокий</option><option value="3">Срочный</option></select></label><label>Срок<input id="kbDue" type="datetime-local"></label><label>Напомнить<input id="kbRemind" type="datetime-local"></label><small>Для напоминаний включи категорию «Обслуживание» в «Гермесе» и подключи устройство.</small><label>Метки через запятую<input id="kbTags"></label><label>Проект<select id="kbProject"></select></label><fieldset class="kb-check-editor"><legend>Чек-лист</legend><div id="kbChecklist"></div><button id="kbAddCheck" type="button">＋ Пункт</button></fieldset><fieldset><legend>Файлы из хранилища</legend><div id="kbFiles"></div></fieldset><label><input id="kbDone" type="checkbox"> Завершено</label><label><input id="kbArchived" type="checkbox"> В архиве</label><p id="kbEditorStatus" role="status"></p><div class="kb-tools"><button type="submit">Сохранить</button><button id="kbCancel" type="button">Закрыть</button></div></form></dialog>
<dialog id="kbColumnEditor"><form id="kbColumnForm"><h2>Колонка</h2><label>Название<input id="kbColumnName" maxlength="80" required></label><p id="kbColumnCount"></p><label id="kbMoveLabel">При удалении перенести задачи в<select id="kbMoveTo"></select></label><p id="kbColumnStatus" role="status"></p><div class="kb-tools"><button type="submit">Сохранить</button><button id="kbColumnCancel" type="button">Закрыть</button><span id="kbColumnRemove"></span></div></form></dialog>`;
export function home() {
  store.load();
  const totals = store.db.prepare('SELECT count(*) total,coalesce(sum(done),0) done FROM cards WHERE archived=0').get();
  const items = store.db.prepare('SELECT c.id,c.board,c.title,c.done,c.version,c.due,c.priority,c.checklist,b.name boardName FROM cards c JOIN boards b ON b.id=c.board WHERE c.archived=0 ORDER BY c.done,CASE WHEN c.due IS NULL THEN 1 ELSE 0 END,c.due,c.priority DESC,c.updated DESC LIMIT 6').all();
  return {...totals,items:items.map(({checklist,...item})=>{let rows=[];try{rows=JSON.parse(checklist);}catch{}return {...item,checks:{done:rows.filter(c=>c.done).length,total:rows.length}};})};
}
export async function summary() {
  store.load();
  const count = store.db
    .prepare('SELECT count(*) AS n FROM cards WHERE done=0 AND archived=0')
    .get().n;
  return {
    state: 'ok',
    items: [
      {label: 'Досок', value: store.boards().length},
      {label: 'Задач', value: count}
    ]
  };
}
export async function handle({request, path: route, user, authorized = () => true, signal}) {
  try {
    if (!authorized()) throw fail('Нужен вход', 401);
    if (request.method === 'GET') {
      if (route === '/')
        return new Response(modulePage({embedded: user.embedded, username: user.username, title: 'Афина', content: page}), {
          headers: {'Content-Type': 'text/html; charset=utf-8'}
        });
      if (['/kanban.js', '/kanban.css'].includes(route))
        return new Response(fs.readFileSync(new URL('.' + route, import.meta.url)), {
          headers: {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css'}
        });
      if (route === '/api') return Response.json(store.boards());
      const board = /^\/api\/board\/([a-f0-9-]+)$/.exec(route);
      if (board) return Response.json(store.snapshot(board[1]));
    }
    if (request.method === 'POST') {
      const v = await readJSON(request, 65536);
      if (!authorized() || signal?.aborted) throw fail('Сессия завершена', 401);
      if (route === '/api/board') return Response.json(store.createBoard(v.name));
      if (route === '/api/columns')
        return Response.json(store.columns(v.board, v.version, v.columns));
      if (route === '/api/card') return Response.json(store.save(v));
      if (route === '/api/move') return Response.json(store.move(v.id, v.column, v.version));
      if (route === '/api/done') return Response.json(store.done(v.id, v.version, v.done));
      if (route === '/api/check') return Response.json(store.check(v.id, v.version, v.index, v.done));
      if (route === '/api/column/remove')
        return Response.json(store.removeColumn(v.board, v.version, v.id, v.destination));
    }
    throw fail('Не найдено', 404);
  } catch (e) {
    return Response.json({error: e.status ? e.message : 'Ошибка Афины'}, {status: e.status ?? 500});
  }
}
