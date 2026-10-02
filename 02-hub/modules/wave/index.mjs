import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {WaveStore} from './store.mjs';
import {MusicPhones} from './phone.mjs';
import {nameKey} from './catalog.mjs';
const assets = new Map(
  ['wave.js', 'player.js', 'wave.css', 'catalog.mjs'].map((n) => [
    '/' + n,
    fs.readFileSync(new URL(n, import.meta.url))
  ])
);
const content = `<link rel="stylesheet" href="/modules/wave/wave.css"><script src="/modules/wave/wave.js" type="module"></script>
<section id="wavePage"><div class="wave-layout"><aside class="wave-sidebar"><nav id="waveNav" aria-label="Музыкальная библиотека"></nav><nav id="wavePlaylists" aria-label="Мои плейлисты" hidden></nav></aside>
<div class="wave-main"><div class="wave-toolbar"><input id="waveSearch" type="search" placeholder="Трек, артист, альбом" aria-label="Поиск музыки"><button id="waveUploadButton" title="Загрузить музыку" aria-label="Загрузить музыку">↑ Загрузить</button><input id="waveUpload" type="file" accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.webm" multiple hidden></div>
<p id="waveStatus" role="status"></p><div id="waveHero"></div><div class="wave-toolbar wave-secondary"><span id="waveCount"></span><button id="wavePlay">▶ Слушать</button><button id="waveMix" title="Перемешать" aria-label="Перемешать">⇄</button><select id="waveSort" aria-label="Сортировка музыки"><option value="default">По порядку</option><option value="year">По году релиза</option><option value="name">По названию</option><option value="artist">По артисту</option><option value="duration">По длительности</option></select><button id="waveSelect" type="button">Выбрать</button><button id="waveEditPlaylist" hidden>Изменить</button></div><div id="waveSelection" class="wave-toolbar" hidden><label><input id="waveSelectAll" type="checkbox"> Все в списке</label><span id="waveSelectedCount"></span><button id="waveDeleteSelected" type="button">Удалить</button><button id="waveCancelSelect" type="button">Отмена</button></div><div id="waveBrowse"></div><div id="waveTracks"></div><button id="waveMore" hidden>Показать ещё</button></div></div>
<dialog id="waveUploadDialog" aria-labelledby="waveUploadTitle"><div class="wave-toolbar"><h2 id="waveUploadTitle">Добавить музыку</h2><button id="waveUploadClose" class="dialog-close" type="button" aria-label="Закрыть">×</button></div><div id="waveDropZone"><p>Перетащи сюда папку или аудиофайлы</p><button id="waveChooseFiles" type="button">Выбрать файлы</button><p class="wave-muted">Папка добавляется вместе с подпапками. В очередь попадут только аудиофайлы.</p></div><p id="waveUploadSummary" role="status"></p><ul id="waveUploadList"></ul><progress id="waveUploadProgress" max="100" value="0" aria-label="Прогресс загрузки" hidden></progress><p id="waveUploadMessage" role="status"></p><div class="wave-toolbar"><button id="waveUploadStart" type="button" disabled>Загрузить</button><button id="waveUploadClear" type="button" disabled>Очистить список</button><button id="waveUploadStop" type="button" hidden>Остановить</button></div><p class="wave-muted">Окно можно закрыть — начатая загрузка продолжится в хабе.</p></dialog><dialog id="waveDialog" aria-labelledby="waveDialogTitle"><form id="waveDialogForm"><div class="wave-toolbar"><h2 id="waveDialogTitle"></h2><button id="waveDialogClose" class="dialog-close" type="button" aria-label="Закрыть">×</button></div><div id="waveDialogBody"></div><p id="waveDialogError" role="status"></p><button id="waveDialogSubmit" type="submit">Сохранить</button></form></dialog></section>`;
export function createModule(directory = path.join(process.env.DATA_DIR ?? '/app/data', 'wave')) {
  let instance;
  const store = () => (instance ??= new WaveStore(directory));
  const phones = new MusicPhones(directory, store);
  return {
    publicHandle: async ({request, path}) => {
      try {
        return phones.handle(request, path);
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Музыка недоступна.'},
          {status: e.status || 500}
        );
      }
    },
    uploads: () => {
      const data = store().snapshot();
      return [
        ...data.tracks.map((t) => ({
          id: t.id,
          name: t.title,
          folders: [
            t.albumArtist || t.artist || 'Неизвестный исполнитель',
            t.album || 'Без альбома'
          ],
          size: t.bytes,
          kind: 'Аудио',
          href: '/modules/wave/'
        })),
        ...(data.artistProfiles || [])
          .filter((p) => p.photo)
          .map((p) => ({
            id: 'photo:' + p.photo,
            name: p.key + ' · фото',
            folders: [
              data.tracks
                .map((t) => t.albumArtist || t.artist)
                .find((name) => nameKey(name) === p.key) || p.key,
              'Фото артиста'
            ],
            kind: 'Фото артиста',
            href: '/modules/wave/'
          }))
      ];
    },
    removeUpload: (id) =>
      id.startsWith('photo:')
        ? store().removeArtistPhoto(id.slice(6))
        : store().change({action: 'delete', id}),
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
    async handle({request, path: route, user, searchParams, authorized = () => true, signal}) {
      try {
        if (!authorized() || signal?.aborted)
          return Response.json({error: 'Сессия завершена'}, {status: 401});
        if (['GET', 'HEAD'].includes(request.method)) {
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {'Content-Type': route.endsWith('.css') ? 'text/css' : 'text/javascript'}
            });
          if (route === '/')
            return new Response(modulePage({username: user.username, title: 'Аполлон', content}), {
              headers: {'Content-Type': 'text/html'}
            });
          if (route === '/phone') return Response.json(phones.list());
          if (route === '/library') return Response.json(store().snapshot());
          const photo = /^\/artist-photo\/([a-f0-9-]+)$/.exec(route);
          if (photo) return store().serveArtistPhoto(photo[1], request);
          const match = /^\/(audio|cover|original)\/([a-f0-9-]+)$/.exec(route);
          if (match) return store().serve(match[2], match[1], request);
        }
        if (request.method === 'POST') {
          if (route === '/artist-photo')
            return Response.json(
              await store().artistPhoto(
                request,
                searchParams.get('key'),
                () => authorized() && !signal?.aborted
              )
            );
          if (route === '/upload')
            return Response.json(
              await store().upload(
                request,
                searchParams.get('name') || '',
                () => authorized() && !signal?.aborted
              )
            );
          if (!request.headers['content-type']?.startsWith('application/json'))
            return Response.json({error: 'Нужен JSON.'}, {status: 415});
          const data = JSON.parse(await body(request, 512 * 1024));
          if (!authorized() || signal?.aborted)
            return Response.json({error: 'Сессия завершена'}, {status: 401});
          if (route === '/phone/create') return Response.json(phones.create(data.name));
          if (route === '/phone/revoke') {
            phones.revoke(data.id);
            return Response.json({ok: true});
          }
          if (route === '/change') return Response.json(store().change(data));
          if (route === '/flow')
            return Response.json(
              await store().fromFlow(data.id, () => authorized() && !signal?.aborted)
            );
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

export const {uploads, removeUpload} = instance;

export const publicHandle = instance.publicHandle;
export const settings = {
  title: 'Аполлон',
  content: `<section><h2>Аполлон</h2><p>Музыка воспроизводится в хабе и PWA. Геката передаёт команды браслета системному плееру Android.</p><script src="/legacy-clients.js" defer></script><details data-legacy-clients="/modules/wave/phone" hidden><summary>Ранее выданные ключи APK</summary><p>Эта функция удалена из Гекаты. Старые ключи можно отозвать; данные хаба сохранятся.</p><p role="status"></p><div data-clients-list></div></details></section>`
};
