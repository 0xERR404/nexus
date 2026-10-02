import {readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {Kanban, fail} from './store.mjs';
export const store = new Kanban(path.join(process.env.DATA_DIR ?? '/app/data', 'kanban'));
const assets =
  '<link rel="stylesheet" href="/modules/kanban/kanban.css"><script src="/modules/kanban/kanban.js" defer></script>';
const page = `${assets}<section id="kanban"><div class="kb-tools"><select id="kbBoard" aria-label="Доска"></select><button id="kbNewBoard">＋ Доска</button><button id="kbNewColumn">＋ Колонка</button><button id="kbNewCard">＋ Задача</button><button id="kbRefresh">Обновить</button></div><div class="kb-tools"><input id="kbSearch" type="search" placeholder="Поиск"><input id="kbTag" placeholder="Метка"><select id="kbPriority"><option value="">Любой приоритет</option><option value="0">Обычный</option><option value="1">Низкий</option><option value="2">Высокий</option><option value="3">Срочный</option></select><label><input id="kbArchive" type="checkbox"> Архив</label></div><p id="kbStatus" role="status"></p><div id="kbColumns"></div></section>
<dialog id="kbEditor"><form id="kbForm"><h2>Задача</h2><label>Заголовок<input id="kbTitle" maxlength="180" required></label><label>Описание<textarea id="kbDescription" maxlength="10000"></textarea></label><label>Колонка<select id="kbColumn"></select></label><label>Приоритет<select id="kbEditPriority"><option value="0">Обычный</option><option value="1">Низкий</option><option value="2">Высокий</option><option value="3">Срочный</option></select></label><label>Срок<input id="kbDue" type="datetime-local"></label><label>Напомнить<input id="kbRemind" type="datetime-local"></label><small>Для напоминаний включи категорию «Обслуживание» в «Гермесе» и подключи устройство.</small><label>Метки через запятую<input id="kbTags"></label><label>Проект<select id="kbProject"></select></label><label>Чек-лист: строка на пункт, [x] — выполнен<textarea id="kbChecklist"></textarea></label><fieldset><legend>Файлы из хранилища</legend><div id="kbFiles"></div></fieldset><label><input id="kbDone" type="checkbox"> Завершено</label><label><input id="kbArchived" type="checkbox"> В архиве</label><p id="kbEditorStatus" role="status"></p><div class="kb-tools"><button type="submit">Сохранить</button><button id="kbCancel" type="button">Закрыть</button></div></form></dialog>`;
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
        return new Response(modulePage({username: user.username, title: 'Афина', content: page}), {
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
    }
    throw fail('Не найдено', 404);
  } catch (e) {
    return Response.json({error: e.status ? e.message : 'Ошибка Афины'}, {status: e.status ?? 500});
  }
}
