import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {WaveStore} from './store.mjs';
const assets = new Map(
  ['wave.js', 'player.js', 'wave.css'].map((n) => [
    '/' + n,
    fs.readFileSync(new URL(n, import.meta.url))
  ])
);
const content = `<link rel="stylesheet" href="/modules/wave/wave.css"><script src="/modules/wave/wave.js" defer></script><section id="wavePage"><div class="wave-toolbar"><input id="waveSearch" type="search" placeholder="Трек, исполнитель, альбом" aria-label="Поиск музыки"><select id="waveFilter" aria-label="Библиотека"><option value="all">Все треки</option><option value="favorite">Избранное</option></select><label class="wave-button">Загрузить<input id="waveUpload" type="file" accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.webm" multiple hidden></label><button id="waveCreate" aria-label="Создать плейлист" title="Создать плейлист">+</button></div><div class="wave-toolbar wave-secondary"><span id="waveCount"></span><button id="wavePlay">Слушать</button><button id="waveEditPlaylist" hidden>Изменить плейлист</button></div><p id="waveStatus" role="status"></p><div id="waveTracks"></div><dialog id="waveDialog" aria-labelledby="waveDialogTitle"><form id="waveDialogForm"><div class="wave-toolbar"><h2 id="waveDialogTitle"></h2><button id="waveDialogClose" class="dialog-close" type="button" aria-label="Закрыть">×</button></div><div id="waveDialogBody"></div><p id="waveDialogError" role="status"></p><button id="waveDialogSubmit" type="submit">Сохранить</button></form></dialog></section>`;
export function createModule(directory = path.join(process.env.DATA_DIR ?? '/app/data', 'wave')) {
  let instance;
  const store = () => (instance ??= new WaveStore(directory));
  return {
    summary: () => {
      const data = store().snapshot();
      return {
        state: 'ok',
        items: [
          {label: 'Треков', value: data.tracks.length},
          {label: 'Избранное', value: data.tracks.filter((t) => t.favorite).length},
          {label: 'Плейлисты', value: data.playlists.length}
        ]
      };
    },
    async handle({request, path: route, user, searchParams}) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {'Content-Type': route.endsWith('.css') ? 'text/css' : 'text/javascript'}
            });
          if (route === '/')
            return new Response(modulePage({username: user.username, title: 'Волна', content}), {
              headers: {'Content-Type': 'text/html'}
            });
          if (route === '/library') return Response.json(store().snapshot());
          const match = /^\/(audio|cover|original)\/([a-f0-9-]+)$/.exec(route);
          if (match) return store().serve(match[2], match[1], request);
        }
        if (request.method === 'POST') {
          if (route === '/upload')
            return Response.json(await store().upload(request, searchParams.get('name') || ''));
          if (!request.headers['content-type']?.startsWith('application/json'))
            return Response.json({error: 'Нужен JSON.'}, {status: 415});
          const data = JSON.parse(await body(request, 16384));
          if (route === '/change') return Response.json(store().change(data));
          if (route === '/flow') return Response.json(await store().fromFlow(data.id));
        }
        return Response.json({error: 'Не найдено.'}, {status: 404});
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Не удалось выполнить действие.'},
          {status: e.status ?? 500}
        );
      }
    }
  };
}
const instance = createModule();
export const handle = instance.handle;
export const summary = instance.summary;
