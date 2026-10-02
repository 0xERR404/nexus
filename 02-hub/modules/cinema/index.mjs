import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {spawn} from 'node:child_process';
import {Cinema} from './store.mjs';
import {modulePage} from '../../src/views.mjs';
import {readJSON, readBytes, fail} from '../../src/input.mjs';
const content = `<link rel="stylesheet" href="/modules/cinema/cinema.css"><script src="/modules/cinema/cinema.js" defer></script><section><p id="cinemaStatus" role="status"></p><section id="cinemaCatalog" data-cinema-catalog><div class="cinema-toolbar"><button id="cinemaAdd" type="button" aria-label="Добавить фильм" title="Добавить фильм">+</button></div><div id="cinemaList" class="cinema-grid"></div><p id="cinemaEmpty" hidden>Здесь появятся твои фильмы. Добавь torrent-файл или magnet-ссылку.</p></section><section id="cinemaDetail" class="cinema-player" data-cinema-detail><div class="cinema-toolbar"><a class="cinema-back" href="/modules/cinema/">← Все фильмы</a><button id="cinemaEdit">Изменить</button><button id="cinemaRemove">Удалить фильм</button></div><h2 id="cinemaTitle">Выбери фильм</h2><div class="cinema-file-controls"><select id="cinemaFiles" aria-label="Видеофайл"></select><button id="cinemaPlay" disabled>Смотреть</button></div><video id="cinemaVideo" controls playsinline preload="metadata"></video><div class="cinema-transfer"><p id="cinemaTransfer" role="status"></p><progress id="cinemaProgress" max="1" value="0" aria-label="Загружено раздачи"></progress><p id="cinemaPlayback" role="status">Выбери раздачу в библиотеке</p></div><button id="cinemaStop">Остановить раздачу и очистить кеш</button></section></section><dialog id="cinemaDialog"><form id="cinemaForm"><div class="cinema-toolbar"><h2>Новая раздача</h2><button id="cinemaCancel" type="button">Закрыть</button></div><label>Название<input id="cinemaName" maxlength="160" required></label><label>Тип<select id="cinemaKind"><option value="cinema">Кино</option><option value="anime">Аниме</option></select></label><label>Magnet-ссылка<input id="cinemaMagnet" maxlength="8192" autocomplete="off"></label><label>Или файл .torrent<input id="cinemaTorrent" type="file" accept=".torrent"></label><p id="cinemaError" role="alert"></p><button type="submit">Добавить</button></form></dialog><dialog id="cinemaEditDialog"><form id="cinemaEditForm"><div class="cinema-toolbar"><h2>Фильм</h2><button id="cinemaEditCancel" type="button">Закрыть</button></div><label>Название<input id="cinemaEditName" maxlength="160" required></label><label>Обложка · до 2 МиБ<input id="cinemaCover" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label><label><input id="cinemaCoverRemove" type="checkbox"> Удалить обложку</label><p id="cinemaEditError" role="alert"></p><button id="cinemaEditSave" type="submit">Сохранить</button></form></dialog>`;
export function byteRange(value, size) {
  if (!value) return {start: 0, end: size - 1, status: 200};
  const m = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!m || (!m[1] && !m[2])) throw fail('Некорректный диапазон', 416);
  const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2])),
    end = m[1] && m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    throw fail('Некорректный диапазон', 416);
  return {start, end, status: 206};
}
export function createModule(
  directory = path.join(process.env.DATA_DIR || '/app/data', 'cinema'),
  options = {}
) {
  const store = new Cinema(directory, options);
  return {
    uploads: () => {
      store.load();
      return store.db
        .prepare('SELECT id,title,length(metadata) bytes,length(cover) coverBytes FROM titles')
        .all()
        .flatMap((t) => [
          ...(t.bytes
            ? [
                {
                  id: t.id,
                  name: t.title + '.torrent',
                  folders: [t.title],
                  size: t.bytes,
                  kind: 'Раздача и её кеш',
                  href: '/modules/cinema/?id=' + t.id
                }
              ]
            : []),
          ...(t.coverBytes
            ? [
                {
                  id: 'cover:' + t.id,
                  name: t.title + ' · обложка',
                  folders: [t.title],
                  size: t.coverBytes,
                  kind: 'Обложка',
                  href: '/modules/cinema/?id=' + t.id
                }
              ]
            : [])
        ]);
    },
    removeUpload: async (id) => {
      if (id.startsWith('cover:')) {
        const key = id.slice(6),
          item = store.item(key);
        store.edit(key, {title: item.title, removeCover: true});
      } else await store.remove(id);
    },
    store,
    close: () => store.close(),
    summary: () => ({
      state: 'ok',
      items: [
        {label: 'Видеотека', value: store.list().length},
        {label: 'Раздача', value: store.status().ready ? 'Открыта' : 'Остановлена'}
      ]
    }),
    async handle({request, path: route, user, searchParams, authorized = () => true, signal}) {
      try {
        if (!authorized()) throw fail('Нужен вход', 401);
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(
              modulePage({
                username: user.username,
                title: 'Гипнос',
                content: content
                  .replace('data-cinema-catalog', searchParams?.get('id') ? 'hidden' : '')
                  .replace('data-cinema-detail', searchParams?.get('id') ? '' : 'hidden')
              }),
              {headers: {'Content-Type': 'text/html; charset=utf-8'}}
            );
          if (['/cinema.js', '/cinema.css'].includes(route))
            return new Response(fs.readFileSync(new URL('.' + route, import.meta.url)), {
              headers: {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css'}
            });
          if (route === '/api')
            return Response.json({items: store.list(), transfer: store.status()});
          const cover = /^\/cover\/([a-f0-9-]+)$/.exec(route);
          if (cover) {
            const item = store.cover(cover[1]);
            if (!item.cover) throw fail('Обложка не найдена', 404);
            return new Response(request.method === 'HEAD' ? null : item.cover, {
              headers: {
                'Content-Type': item.coverType,
                'Content-Length': String(item.cover.length),
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff'
              }
            });
          }
          const match = /^\/stream\/([a-f0-9-]+)\/(\d{1,4})$/.exec(route);
          if (match) {
            const file = store.file(match[1], Number(match[2]));
            if (/\.mkv$/i.test(file.name)) {
              const headers = {
                'Content-Type': 'video/mp4',
                'Cache-Control': 'private, no-store',
                'X-Content-Type-Options': 'nosniff'
              };
              if (request.method === 'HEAD') return new Response(null, {headers});
              if (store.converter)
                throw fail('Преобразование уже запущено. Останови текущее видео.', 409);
              const input = Readable.from(file[Symbol.asyncIterator]()),
                child = spawn(
                  'ffmpeg',
                  [
                    '-nostdin',
                    '-v',
                    'error',
                    '-i',
                    'pipe:0',
                    '-map',
                    '0:v:0',
                    '-map',
                    '0:a:0?',
                    '-c:v',
                    'libx264',
                    '-preset',
                    'veryfast',
                    '-crf',
                    '23',
                    '-pix_fmt',
                    'yuv420p',
                    '-threads',
                    '2',
                    '-c:a',
                    'aac',
                    '-profile:a',
                    'aac_low',
                    '-ac',
                    '2',
                    '-ar',
                    '48000',
                    '-af',
                    'aresample=48000:rematrix_maxval=1',
                    '-b:a',
                    '160k',
                    '-movflags',
                    'frag_keyframe+empty_moov+default_base_moof',
                    '-f',
                    'mp4',
                    'pipe:1'
                  ],
                  {stdio: ['pipe', 'pipe', 'ignore']}
                );
              const abort = () => {
                input.destroy();
                child.kill('SIGKILL');
              };
              store.converter = abort;
              const timer = setInterval(() => {
                if (!authorized()) abort();
              }, 5000);
              timer.unref?.();
              input.on('error', () => {
                store.error = 'Не удалось прочитать MKV';
                abort();
              });
              child.stdin.on('error', () => {});
              child.on('error', () => {
                store.error = 'FFmpeg недоступен';
                child.stdout.destroy();
                abort();
              });
              child.on('close', (code) => {
                clearInterval(timer);
                signal?.removeEventListener('abort', abort);
                if (store.converter === abort) store.converter = null;
                if (code && code !== null) store.error = 'Не удалось преобразовать MKV';
              });
              child.stdout.once('close', abort);
              signal?.addEventListener('abort', abort, {once: true});
              input.pipe(child.stdin);
              if (signal?.aborted) abort();
              return new Response(Readable.toWeb(child.stdout), {headers});
            }
            let r;
            try {
              r = byteRange(request.headers.range, file.length);
            } catch {
              return new Response(null, {
                status: 416,
                headers: {'Content-Range': 'bytes */' + file.length}
              });
            }
            const headers = {
              'Content-Type': file.type,
              'Content-Length': String(r.end - r.start + 1),
              'Accept-Ranges': 'bytes',
              'Cache-Control': 'private, no-store',
              'X-Content-Type-Options': 'nosniff'
            };
            if (r.status === 206)
              headers['Content-Range'] = `bytes ${r.start}-${r.end}/${file.length}`;
            if (request.method === 'HEAD') return new Response(null, {status: r.status, headers});
            const stream = Readable.from(file[Symbol.asyncIterator]({start: r.start, end: r.end})),
              abort = () => stream.destroy();
            signal?.addEventListener('abort', abort, {once: true});
            const timer = setInterval(() => {
              if (!authorized()) abort();
            }, 5000);
            timer.unref?.();
            stream.once('close', () => {
              clearInterval(timer);
              signal?.removeEventListener('abort', abort);
            });
            if (signal?.aborted) abort();
            return new Response(Readable.toWeb(stream), {status: r.status, headers});
          }
        }
        if (request.method === 'POST') {
          if (route === '/cover') {
            const bytes = await readBytes(request, 2 * 1024 ** 2);
            if (!authorized() || signal?.aborted) throw fail('Нужен вход', 401);
            store.setCover(searchParams?.get('id'), bytes);
            return Response.json({ok: true});
          }
          const data =
            route === '/upload'
              ? {
                  bytes: await readBytes(request, 4 * 1024 ** 2),
                  title: searchParams?.get('title'),
                  kind: searchParams?.get('kind')
                }
              : await readJSON(request, 16384);
          if (!authorized()) throw fail('Сессия завершена', 401);
          if (route === '/edit') {
            store.edit(data.id, data);
            return Response.json({ok: true});
          }
          if (route === '/add' || route === '/upload') return Response.json(await store.add(data));
          if (route === '/open') return Response.json(await store.open(data.id));
          if (route === '/stop') {
            if (store.job) throw fail('Дождись получения метаданных', 409);
            await store.stop();
            return Response.json({ok: true});
          }
          if (route === '/remove') {
            await store.remove(data.id);
            return Response.json({ok: true});
          }
        }
        throw fail('Не найдено', 404);
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Не удалось выполнить действие Гипноса'},
          {status: e.status || 503}
        );
      }
    }
  };
}
const instance = createModule();
export const {handle, summary, close, uploads, removeUpload} = instance;
