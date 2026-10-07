import {readBytes, readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {modulePage} from '../../src/views.mjs';
import {ReaderStore, fail} from './store.mjs';
const assets = new Map(
  ['reader.js', 'engine.js', 'reader.css'].map((n) => [
    '/' + n,
    fs.readFileSync(new URL(n, import.meta.url))
  ])
);
const head =
  '<link rel="stylesheet" href="/modules/reader/reader.css"><script src="/modules/reader/engine.js" defer></script><script src="/modules/reader/reader.js" defer></script>';
const close =
  '<button class="dialog-close" type="button" data-reader-close aria-label="Закрыть">×</button>';
const content = `${head}<section id="readerPage"><p id="readerStatus" role="status"></p><section id="readerLibrary"><div class="reader-toolbar"><input id="readerSearch" type="search" placeholder="Название или автор" aria-label="Поиск книги"><label class="reader-upload">＋ Книги<input id="readerUpload" type="file" accept=".epub,.txt" multiple hidden></label></div><div id="readerBooks" class="reader-grid"></div><button type="button" id="readerMore" hidden>Показать ещё</button></section><dialog id="readerReading" aria-label="Чтение книги"><div id="readerControls"><div class="reader-toolbar"><button type="button" id="readerBack">‹ Библиотека</button><h2 id="readerBookTitle"></h2><button type="button" id="readerEdit" aria-label="Название и автор">✎</button></div><div class="reader-toolbar"><button id="readerPrev" type="button" aria-label="Назад">←</button><select id="readerChapter" aria-label="Глава"></select><button id="readerNext" type="button" aria-label="Вперёд">→</button><select id="readerLiveSize" aria-label="Размер шрифта книги"><option value="16">16 px</option><option value="18">18 px</option><option value="20">20 px</option><option value="22">22 px</option><option value="24">24 px</option><option value="28">28 px</option><option value="32">32 px</option></select><select id="readerMode" aria-label="Режим чтения"><option value="scroll">Свиток</option><option value="pages">Страницы</option></select><button id="readerAddMark" type="button">＋ Закладка</button><button id="readerMarks" type="button">Закладки</button></div><div id="readerConflict" hidden><p>Позиция изменилась на другом устройстве.</p><button id="readerRemote" type="button">Перейти к ней</button><button id="readerLocal" type="button">Продолжить здесь</button></div></div><div id="readerViewport" tabindex="0" aria-label="Текст книги"><article id="readerText" class="reader-text"></article></div><div id="readerHUD" class="reader-footer"><span id="readerProgress"></span><span id="readerSaved" role="status"></span></div><p id="readerReadStatus" role="status"></p></dialog></section><dialog id="readerMarksDialog" class="reader-dialog"><div class="reader-heading"><h2>Закладки</h2>${close}</div><div id="readerMarksList"></div></dialog><dialog id="readerEditDialog" class="reader-dialog"><div class="reader-heading"><h2>Книга</h2>${close}</div><form id="readerMetaForm"><label>Автор<input id="readerAuthorInput" maxlength="180"></label><label>Название<input id="readerTitleInput" maxlength="180" required></label><div class="reader-toolbar"><button type="submit">Сохранить</button><button type="button" id="readerDelete">Удалить книгу</button></div></form></dialog><dialog id="readerDeleteDialog" class="reader-dialog"><div class="reader-heading"><h2>Удалить книгу?</h2>${close}</div><p>Книга, позиция и закладки будут удалены.</p><button type="button" id="readerDeleteConfirm">Удалить</button></dialog>`;
export const settings = {
  title: 'Александрия',
  content: `${head}<section id="readerSettings"><p id="readerStatus" role="status"></p><form id="readerSettingsForm" class="reader-settings"><label>Размер текста<select id="readerSize">${[16, 18, 20, 22, 24, 28, 32].map((n) => `<option value="${n}">${n}</option>`).join('')}</select></label><label>Межстрочный интервал<select id="readerLine"><option value="1.4">Компактный</option><option value="1.7">Обычный</option><option value="2">Свободный</option></select></label><label>Шрифт<select id="readerFont"><option value="serif">С засечками</option><option value="sans">Без засечек</option><option value="mono">Моноширинный</option></select></label><label>Фон чтения<select id="readerTheme"><option value="hub">Как в хабе</option><option value="paper">Светлый</option><option value="sepia">Сепия</option></select></label><label>Ширина текста<select id="readerWidth"><option value="normal">Обычная</option><option value="wide">Широкая</option></select></label><button type="submit">Сохранить</button></form></section>`
};
export function createModule(directory = path.join(process.env.DATA_DIR ?? '/app/data', 'reader')) {
  const store = new ReaderStore(directory);
  return {
    store,
    uploads: () =>
      store
        .library()
        .map((b) => ({
          id: b.id,
          name: b.title,
          folders: [b.author || 'Без автора'],
          kind: 'Книга · ' + b.format,
          href: '/modules/reader/?book=' + b.id
        })),
    removeUpload: (id) => store.remove(id),
    home() {
      const all=store.library(),reading=all.filter(b => b.progress > 0 && b.progress < 100);
      return {total:all.length,reading:reading.length,items:reading
        .sort((a,b) => (b.readAt || b.created || 0) - (a.readAt || a.created || 0))
        .slice(0,6).map(b => ({id:b.id,title:b.title,author:b.author,progress:b.progress,cover:!!b.cover}))};
    },
    async summary() {
      const books = store.library();
      return {
        state: 'ok',
        items: [
          {label: 'Книг', value: books.length},
          {label: 'Читаю', value: books.filter((b) => b.progress > 0 && b.progress < 100).length},
          {label: 'Прочитано', value: books.filter((b) => b.progress >= 100).length}
        ]
      };
    },
    async handle({request, path: route, user, signal, authorized = () => true}) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(modulePage({embedded: user.embedded, username: user.username, title: 'Александрия', content}), {
              headers: {'Content-Type': 'text/html; charset=utf-8'}
            });
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css'}
            });
          if (route === '/library') return Response.json(store.library());
          if (route === '/settings') return Response.json(store.settings());
          const match = /^\/book\/([a-f0-9-]+)(?:\/(chapter|asset)\/([a-f0-9]+))?$/.exec(route),
            cover = /^\/cover\/([a-f0-9-]+)$/.exec(route);
          if (match || cover) {
            const book = store.book((match || cover)[1]);
            if (match && !match[2]) {
              const {assets, ...view} = book;
              return Response.json(view);
            }
            if (match?.[2] === 'chapter')
              return Response.json(store.chapter(book.id, Number(match[3])));
            const isCover = !!cover,
              type = isCover ? 'image/webp' : book.assets[match[3]];
            if (!type || (isCover && !book.cover) || (!isCover && !/^[a-f0-9]{64}$/.test(match[3])))
              throw fail('Изображение не найдено.', 404);
            const file = path.join(
              store.directory,
              book.id,
              isCover ? 'cover.webp' : 'assets/' + match[3]
            );
            const size = fs.statSync(file).size;
            const stream = request.method === 'HEAD' ? null : fs.createReadStream(file);
            if (stream) {
              const abort = () => stream.destroy();
              signal?.addEventListener('abort', abort, {once: true});
              stream.on('close', () => signal?.removeEventListener('abort', abort));
            }
            return new Response(stream ? Readable.toWeb(stream) : null, {
              headers: {
                'Content-Type': type,
                'Content-Length': String(size),
                'X-Content-Type-Options': 'nosniff'
              }
            });
          }
        }
        if (request.method === 'POST') {
          const data = await (route === '/upload'
              ? readBytes(request, 64 * 1024 * 1024)
              : readJSON(request)),
            allowed = () => authorized() && !signal?.aborted;
          if (!allowed()) throw fail('Сессия завершена.', 401);
          if (route === '/upload') {
            let name;
            try {
              name = decodeURIComponent(request.headers['x-file-name'] || '');
            } catch {
              throw fail('Некорректное имя.');
            }
            return Response.json(await store.upload(data, name, allowed));
          }
          if (route === '/position') {
            const {position, positionVersion, progress, readAt} = store.position(
              data.id,
              data.position,
              data.version
            );
            return Response.json({position, positionVersion, progress, readAt});
          }
          if (route === '/bookmark')
            return Response.json(store.bookmark(data.id, data.position, data.label));
          if (route === '/bookmark/remove')
            return Response.json(store.removeBookmark(data.id, data.mark));
          if (route === '/metadata') return Response.json(store.metadata(data.id, data));
          if (route === '/delete') {
            store.remove(data.id);
            return Response.json({ok: true});
          }
          if (route === '/settings') return Response.json(store.settings(data));
        }
        return Response.json({error: 'Не найдено.'}, {status: 404});
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Не удалось прочитать или сохранить библиотеку.'},
          {status: e.status || 503}
        );
      }
    }
  };
}
export const {handle, summary, uploads, removeUpload, home} = createModule();
