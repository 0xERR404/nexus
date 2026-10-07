import {PhoneUploads} from './phone.mjs';
import {contentStore} from '../../src/content-store.mjs';
import {readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {modulePage} from '../../src/views.mjs';
import {Storage, ID, fail} from './store.mjs';

const directory = path.join(process.env.DATA_DIR ?? '/app/data', 'storage');
export const storage = new Storage(directory);
const phone = new PhoneUploads(storage, contentStore);
export const publicHandle = ({request}) => phone.handle(request);
const page = `<link rel="stylesheet" href="/modules/storage/storage.css"><script src="/modules/storage/storage.js" defer></script>
<section class="storage-app"><div class="storage-toolbar"><input id="storageSearch" type="search" placeholder="Найти файл или папку" aria-label="Поиск"><button id="storageRefresh" title="Обновить" aria-label="Обновить">↻</button><button id="storageFolder">＋ Папка</button><label class="storage-upload">＋ Загрузить<input id="storageInput" type="file" multiple hidden></label></div><p id="storageStatus" role="status"></p><div id="storageProgress"></div><nav id="storageBreadcrumb" aria-label="Папки"></nav><div id="storageFolders" class="storage-folder-grid"></div><div id="storageFiles"></div><button id="storageMore" hidden>Показать ещё</button><details class="storage-trash"><summary>Корзина загрузок</summary><div id="storageTrash"></div></details></section>`;

const downloadName = (label) =>
  `attachment; filename="file"; filename*=UTF-8''${encodeURIComponent(label).replace(/'/g, '%27')}`;

export function home() {
  storage.load();
  return {items:storage.db.prepare('SELECT id,folder,name,type,size,created FROM files WHERE deleted=0 ORDER BY created DESC,id LIMIT 6').all(),total:storage.stats().files};
}
export async function summary() {
  const {files, used} = storage.stats();
  return {
    state: 'ok',
    items: [
      {label: 'Файлов', value: files},
      {label: 'Занято', value: Math.round(used / 1048576) + ' МБ'}
    ]
  };
}

export const settings = {
  title: 'Мнемосина',
  content: `<section><h2>Общее хранилище</h2><p id="storageSettingsUsage">Загрузка…</p><script src="/legacy-clients.js" defer></script><details data-legacy-clients="/modules/storage/api/phone" hidden><summary>Ранее выданные ключи APK</summary><p>Эта функция удалена из Талоса. Старые ключи можно отозвать; данные хаба сохранятся.</p><p role="status"></p><div data-clients-list></div></details><script src="/modules/storage/storage.js" defer></script></section>`
};

export async function handle({
  request,
  path: route,
  user,
  searchParams,
  signal,
  authorized = () => true,
  modules = new Map()
}) {
  try {
    if (!authorized()) throw fail('Нужен вход', 401);
    if (['GET', 'HEAD'].includes(request.method)) {
      if (route === '/')
        return new Response(modulePage({embedded: user.embedded, username: user.username, title: 'Мнемосина', content: page}), {
          headers: {'Content-Type': 'text/html; charset=utf-8'}
        });
      if (route === '/storage.js' || route === '/storage.css')
        return new Response(fs.readFileSync(new URL('.' + route, import.meta.url)), {
          headers: {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css'}
        });
      if (route === '/api/phone') return Response.json({items: phone.list()});
      if (route === '/api') return Response.json(storage.list(searchParams?.get('q') ?? ''));
      if (route === '/api/modules') {
        const files = [],
          errors = [];
        for (const [source, module] of modules) {
          if (!module.uploads) continue;
          try {
            for (const file of await module.uploads())
              files.push({...file, source, sourceTitle: module.title});
          } catch {
            errors.push(module.title);
          }
        }
        return Response.json({files, errors});
      }
      if (route === '/api/trash') return Response.json(storage.trash());
      const match = /^\/file\/([a-f0-9-]+)$/.exec(route);
      if (match) {
        const item = storage.file(match[1]);
        const filename = path.join(directory, 'blobs', item.id);
        const preview =
          searchParams?.get('preview') === '1' &&
          /^(image\/(?:jpeg|png|webp|gif)|application\/pdf|text\/plain)$/.test(item.type);
        const headers = {
          'Content-Type': item.type,
          'Content-Length': String(item.size),
          'Content-Disposition': preview ? 'inline' : downloadName(item.name),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'private, no-store',
          'X-Frame-Options': preview ? 'SAMEORIGIN' : 'DENY',
          'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'self'"
        };
        if (request.method === 'HEAD') return new Response(null, {headers});
        const stream = fs.createReadStream(filename);
        signal?.addEventListener('abort', () => stream.destroy(), {once: true});
        return new Response(Readable.toWeb(stream), {headers});
      }
    }
    if (request.method === 'POST') {
      if (route === '/api/upload') {
        const raw = request.headers['x-file-name'];
        let filename;
        try {
          filename = decodeURIComponent(raw ?? '');
        } catch {
          throw fail('Некорректное имя файла');
        }
        return Response.json(
          await storage.upload(
            request,
            filename,
            searchParams?.get('folder') || null,
            () => authorized() && !signal?.aborted
          ),
          {status: 201}
        );
      }
      const value = await readJSON(request, route === '/api/modules/delete-many' ? 131072 : 8192);
      if (!authorized() || signal?.aborted) throw fail('Сессия завершена', 401);
      if (route === '/api/phone/create') return Response.json(phone.create(value));
      if (route === '/api/phone/revoke') return Response.json(phone.revoke(value.id));
      if (route === '/api/modules/delete-many') {
        const module = modules.get(value.source);
        if (!module?.uploads || !module.removeUpload) throw fail('Источник не найден', 404);
        if (
          !Array.isArray(value.ids) ||
          !value.ids.length ||
          value.ids.length > 1000 ||
          value.ids.some((id) => typeof id !== 'string' || id.length > 300)
        )
          throw fail('Некорректный список файлов');
        const available = new Set((await module.uploads()).map((f) => f.id));
        const removed = [],
          errors = [];
        for (const id of new Set(value.ids)) {
          if (!authorized() || signal?.aborted) throw fail('Сессия завершена', 401);
          if (!available.has(id)) {
            removed.push(id);
            continue;
          }
          try {
            await module.removeUpload(id);
            removed.push(id);
          } catch (error) {
            if (error.status === 404) removed.push(id);
            else errors.push({id, error: error.status ? error.message : 'Не удалось удалить файл'});
          }
        }
        return Response.json({removed, errors});
      }
      if (route === '/api/modules/delete') {
        const module = modules.get(value.source);
        if (!module?.removeUpload || typeof value.id !== 'string')
          throw fail('Источник не найден', 404);
        const files = await module.uploads();
        if (!files.some((f) => f.id === value.id)) throw fail('Файл не найден', 404);
        if (!authorized() || signal?.aborted) throw fail('Сессия завершена', 401);
        await module.removeUpload(value.id);
        return Response.json({ok: true});
      }
      if (route === '/api/folder')
        return Response.json(storage.createFolder(value.name, value.parent ?? null), {status: 201});
      if (route === '/api/folder/delete') {
        return Response.json(storage.deleteFolder(value.id));
      }
      if (route === '/api/folder/rename') {
        storage.renameFolder(value.id, value.name);
        return Response.json({ok: true});
      }
      if (route === '/api/rename') {
        storage.rename(value.id, value.name, value.version);
        return Response.json({ok: true});
      }
      if (route === '/api/move') {
        storage.move(value.id, value.folder ?? null, value.version);
        return Response.json({ok: true});
      }
      if (route === '/api/trash') {
        storage.delete(value.id);
        return Response.json({ok: true});
      }
      if (route === '/api/restore') {
        storage.restore(value.id);
        return Response.json({ok: true});
      }
      if (route === '/api/purge') {
        storage.purge(value.id);
        return Response.json({ok: true});
      }
      if (route === '/api/attach') {
        storage.attach(value.id, value.kind, value.object);
        return Response.json({ok: true});
      }
      if (route === '/api/detach') {
        storage.detach(value.id, value.kind, value.object);
        return Response.json({ok: true});
      }
    }
    const refs = /^\/api\/refs\/([a-f0-9-]+)$/.exec(route);
    if (request.method === 'GET' && refs && ID.test(refs[1]))
      return Response.json(storage.references(refs[1]));
    throw fail('Не найдено', 404);
  } catch (error) {
    return Response.json(
      {error: error.status ? error.message : 'Ошибка хранилища'},
      {status: error.status ?? (error.code === 'ENOSPC' ? 507 : 500)}
    );
  }
}
