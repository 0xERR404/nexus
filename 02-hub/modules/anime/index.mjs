import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {AnimeStore} from './store.mjs';

const assets = new Map(
  ['anime.css', 'anime.js'].map((name) => [
    '/' + name,
    fs.readFileSync(new URL(name, import.meta.url))
  ])
);
const head =
  '<link rel="stylesheet" href="/modules/anime/anime.css"><script src="/modules/anime/anime.js" defer></script>';
const status =
  '<p id="animeStatus" class="anime-status" role="status" aria-live="polite">Загрузка…</p>';
const content = `${head}<section id="animePage">${status}<div class="anime-toolbar"><input id="animeSearch" type="search" maxlength="200" aria-label="Поиск аниме" placeholder="Найти аниме"><select id="animeFilter" aria-label="Статус просмотра"><option value="">Все статусы</option><option value="watching">Смотрю</option><option value="completed">Посмотрел</option><option value="planned">Запланировано</option><option value="on_hold">Отложено</option><option value="dropped">Бросил</option><option value="rewatching">Пересматриваю</option></select><button id="animeSync" type="button">Обновить</button></div><div class="anime-meta"><span id="animeCount"></span><span id="animeTime"></span></div><div id="animeList" class="anime-list"></div></section>`;
export const settings = {
  title: 'Аниме · Shikimori',
  content: `${head}<section id="animeSettings">${status}<div class="anime-panel"><div class="anime-meta"><h2>Аккаунт Shikimori</h2><button id="animeDisconnect" type="button" hidden>Отключить</button></div><p id="animeAccount"></p><details id="animeConnectDetails"><summary>Подключить аккаунт</summary><p class="anime-help">Создай приложение в <a href="https://shikimori.io/oauth/applications" target="_blank" rel="noopener noreferrer">Shikimori</a>. Название — латиницей, например NEXUS404. Redirect URI:</p><input id="animeRedirect" aria-label="Redirect URI" value="urn:ietf:wg:oauth:2.0:oob" readonly><p class="anime-help">Дополнительные разрешения не нужны. Скопируй Application ID и Secret в поля ниже. Список в Shikimori не изменяется.</p><form id="animeSetupForm"><label>Название приложения<input id="animeAppName" required maxlength="80" value="NEXUS404" autocomplete="off"></label><label>Application ID<input id="animeClientId" required maxlength="256" autocomplete="off" spellcheck="false"></label><label>Secret<input id="animeClientSecret" required type="password" maxlength="256" autocomplete="new-password"></label><button type="submit">Получить ссылку</button></form><div id="animeAuthorization" hidden><p class="anime-help"><a id="animeAuthorize" target="_blank" rel="noopener noreferrer">Разрешить доступ в Shikimori ↗</a></p><form id="animeCodeForm"><label>Код авторизации<input id="animeCode" required type="password" maxlength="1024" autocomplete="one-time-code"></label><button type="submit">Подключить</button></form><p class="anime-help">Вернись сюда и вставь выданный код. Ссылка действует 15 минут.</p></div></details><p class="anime-help">Обновление раз в час, даже когда хаб закрыт. На странице «Кадр» можно обновить вручную.</p></div><dialog id="animeDisconnectDialog" aria-labelledby="animeDisconnectTitle"><form id="animeDisconnectForm"><div class="anime-meta"><h2 id="animeDisconnectTitle">Отключить Shikimori?</h2><button class="dialog-close" type="button" id="animeCloseDialog" aria-label="Закрыть">×</button></div><p>Подключение и сохранённый список будут удалены из хаба. Данные в Shikimori останутся.</p><div class="anime-actions"><button type="submit">Отключить</button><button type="button" id="animeCancelDialog">Отмена</button></div></form></dialog></section>`
};

export function createModule(
  directory = path.join(process.env.DATA_DIR ?? '/app/data', 'anime'),
  options = {}
) {
  const store = new AnimeStore(directory, options);
  return {
    store,
    start: () => store.start(),
    close: () => store.close(),
    async summary() {
      store.load();
      const c = store.config(),
        d = store.data;
      return {
        state:
          !c.connected || d.lastError || !d.syncedAt || Date.now() - d.syncedAt > 7200000
            ? 'stale'
            : 'ok',
        covers: d.items
          .filter((x) => x.poster)
          .slice(0, 3)
          .map((x) => x.id),
        items: [
          {label: 'В списке', value: d.items.length},
          {label: 'Смотрю', value: d.items.filter((x) => x.status === 'watching').length},
          {label: 'Посмотрел', value: d.items.filter((x) => x.status === 'completed').length}
        ]
      };
    },
    async handle({request, path: route, user}) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(modulePage({username: user.username, title: 'Кадр', content}), {
              headers: {'Content-Type': 'text/html; charset=utf-8'}
            });
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {
                'Content-Type': route.endsWith('.css')
                  ? 'text/css; charset=utf-8'
                  : 'text/javascript; charset=utf-8'
              }
            });
          if (route === '/api') return Response.json(store.snapshot());
          if (route === '/config') return Response.json(store.config());
          const cover = /^\/cover\/([1-9]\d{0,9})$/.exec(route);
          if (cover) {
            const result = await store.cover(Number(cover[1]));
            return result
              ? new Response(result.data, {headers: {'Content-Type': result.type}})
              : new Response(null, {status: 404});
          }
        }
        if (
          request.method === 'POST' &&
          ['/setup', '/connect', '/disconnect', '/sync'].includes(route)
        ) {
          if (!request.headers['content-type']?.startsWith('application/json'))
            return Response.json({error: 'Ожидается JSON'}, {status: 415});
          let data;
          try {
            data = JSON.parse(await body(request, 8192));
          } catch (error) {
            return Response.json({error: 'Некорректный запрос'}, {status: error.status ?? 400});
          }
          if (!data || Array.isArray(data) || typeof data !== 'object')
            return Response.json({error: 'Некорректный запрос'}, {status: 400});
          if (route === '/setup') return Response.json(store.setup(data));
          if (route === '/disconnect') return Response.json(store.disconnect());
          if (route === '/connect') {
            await store.connect(data.code);
            void store.sync().catch(() => {});
            return Response.json(store.config());
          }
          void store.sync().catch(() => {});
          return Response.json({syncing: true}, {status: 202});
        }
        return Response.json({error: 'Маршрут не найден'}, {status: 404});
      } catch (error) {
        return Response.json(
          {
            error: error.status
              ? error.message
              : 'Не удалось прочитать или сохранить данные «Кадра».'
          },
          {status: error.status ?? 503}
        );
      }
    }
  };
}
const module = createModule();
export const {handle, summary, start, close} = module;
