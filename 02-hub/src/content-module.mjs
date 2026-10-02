import {Marked} from './vendor/marked.mjs';
import {readBytes, readJSON} from './input.mjs';
import fs from 'node:fs';
import {Readable} from 'node:stream';
import {modulePage, escape} from './views.mjs';
import {contentStore, fail, ID} from './content-store.mjs';
const header =
  '<link rel="stylesheet" href="/content.css"><script src="/content.js" defer></script>';
const button = (id, label) => `<button type="button" id="${id}">${label}</button>`;
const dialog = (id, title, content, cls = '') =>
  `<dialog id="${id}" class="content-dialog ${cls}"><div class="content-heading"><h2>${title}</h2><button type="button" class="dialog-close" data-close aria-label="Закрыть">×</button></div>${content}</dialog>`;
const gallery = `${header}<section id="contentPage" data-kind="gallery"><div class="content-toolbar"><input id="contentSearch" type="search" placeholder="Найти изображение" aria-label="Поиск"><select id="albumFilter" aria-label="Альбом"><option value="">Все альбомы</option></select><select id="tagFilter" aria-label="Тег"><option value="">Все теги</option></select>${button('newAlbum', '＋ Альбом')}<label class="content-upload">＋ Загрузить<input id="imageUpload" type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" hidden></label></div><p id="contentStatus" role="status"></p><div id="contentList" class="gallery-grid"></div>${button('galleryMore', 'Показать ещё')}</section>${dialog('imageViewer', '<span id="imageTitle"></span>', `<div class="content-toolbar">${button('imagePrev', '←')}${button('imageNext', '→')}${button('zoomOut', '−')}${button('zoomReset', '100%')}${button('zoomIn', '＋')}<a id="imageDownload" download>Скачать оригинал</a>${button('imageEdit', 'Изменить')}</div><div id="imageStage"><img id="imageFull" alt="" draggable="false"></div>`, 'image-viewer')}${dialog('imageEditor', 'Изображение', '<form id="imageMetaForm"><label>Название<input id="imageName" maxlength="180" required></label><label>Альбом<select id="imageAlbum"></select></label><label>Теги через запятую<input id="imageTags" maxlength="660"></label><div class="content-toolbar"><button type="submit">Сохранить</button><button type="button" id="imageDelete">Удалить</button></div></form>')}${dialog('albumEditor', 'Новый альбом', '<form id="albumForm"><label>Название<input id="albumName" maxlength="80" required></label><button type="submit">Создать</button></form>')}${dialog('deleteConfirm', 'Удалить изображение?', '<p>Оригинал и миниатюра будут удалены.</p>' + button('confirmDelete', 'Удалить'))}`;
const articles = `${header}<section id="contentPage" data-kind="articles"><div class="content-toolbar"><input id="contentSearch" type="search" placeholder="Найти статью" aria-label="Поиск статей"><select id="articleFilter" aria-label="Статус"><option value="">Все статьи</option><option value="draft">Черновики</option><option value="ready">Готовые</option></select><select id="tagFilter" aria-label="Тег"><option value="">Все теги</option></select>${button('articleNew', '＋ Статья / заметка')}<label class="content-upload">Импорт .md<input id="articleImport" type="file" accept=".md,.markdown,text/markdown" hidden></label></div><p id="contentStatus" role="status"></p><div id="articleLayout"><div id="contentList" class="article-list"></div><section id="articleReading" hidden><div class="content-heading"><h2 id="articleReadTitle"></h2><button id="articleEdit" type="button">Редактировать</button></div><article id="articleReadBody" class="article-prose"></article></section><section id="articleEditor" hidden><div class="content-toolbar"><input id="articleTitle" placeholder="Название статьи" aria-label="Название статьи" maxlength="160"><select id="articleState" aria-label="Статус статьи"><option value="draft">Черновик</option><option value="ready">Готова</option></select></div><input id="articleTags" placeholder="Теги через запятую" aria-label="Теги статьи" maxlength="660"><div class="content-toolbar editor-tools">${button('formatHeading', 'H2')}${button('formatBold', 'Ж')}${button('formatList', '≡')}${button('formatCode', 'Код')}${button('formatTask', '☑')}${button('insertFile', 'Из Гестии')}${button('articleExport', 'Скачать .md')}${button('insertImage', 'Из Ириды')}${button('articlePreview', 'Предпросмотр')}${button('articleHistory', 'Редакции')}${button('articleSave', 'Сохранить')}${button('articleRead', 'Читать')}${button('articleExpand', 'Развернуть')}</div><textarea id="articleBody" aria-label="Текст статьи" placeholder="Текст в Markdown…" maxlength="262144" spellcheck="true"></textarea><p id="articleSaveState" role="status"></p></section></div></section>${dialog('articleWorkspace', 'Редактор статьи', '<div id="articleWorkspaceBody"></div>')}${dialog('articleViewer', '<span id="previewTitle"></span>', '<article id="articleRendered" class="article-prose"></article>')}${dialog('imagePicker', '<span id="pickerTitle">Изображения Ириды</span>', '<input id="pickerSearch" type="search" placeholder="Найти изображение" aria-label="Найти изображение"><div id="pickerList" class="gallery-grid"></div>')}${dialog('historyViewer', 'Редакции', '<div id="historyList"></div>')}${dialog('revisionViewer', 'Предыдущая редакция', '<p id="revisionDate"></p><article id="revisionText" class="article-prose"></article>' + button('revisionRestore', 'Восстановить'))}`;
export function renderArticle(body, kind = 'articles') {
  const base = '/modules/' + (kind === 'gallery' ? 'gallery' : 'articles');
  const markdown = new Marked({
    gfm: true,
    breaks: false,
    renderer: {
      html(token) {
        return escape(token.text);
      },
      image(token) {
        const id = token.href.startsWith('media:') ? token.href.slice(6) : '';
        return ID.test(id)
          ? `<img loading="lazy" src="${base}/file/${id}" alt="${escape(token.text)}">`
          : escape(token.raw);
      },
      link(token) {
        const label = this.parser.parseInline(token.tokens);
        const id = token.href.startsWith('file:') ? token.href.slice(5) : '';
        if (ID.test(id)) return `<a href="/modules/storage/file/${id}">${label}</a>`;
        let url;
        try {
          url = new URL(token.href);
        } catch {
          return label;
        }
        if (!['https:', 'http:', 'mailto:'].includes(url.protocol)) return label;
        return `<a href="${escape(url.href)}" rel="noreferrer noopener">${label}</a>`;
      }
    }
  });
  return markdown.parse(body);
}
export function createContentModule(kind, store = contentStore()) {
  const title = kind === 'gallery' ? 'Ирида' : 'Каллиопа';
  return {
    store,
    async summary() {
      store.load();
      return {
        state: 'ok',
        items:
          kind === 'gallery'
            ? [
                {label: 'Изображений', value: store.data.images.length},
                {label: 'Альбомов', value: store.data.albums.length},
                {
                  label: 'МБ',
                  value: Math.round(store.data.images.reduce((n, i) => n + i.size, 0) / 1048576)
                }
              ]
            : [
                {label: 'Статей', value: store.data.articles.length},
                {
                  label: 'Черновиков',
                  value: store.data.articles.filter((a) => a.status === 'draft').length
                },
                {
                  label: 'Готово',
                  value: store.data.articles.filter((a) => a.status === 'ready').length
                }
              ]
      };
    },
    async handle({request, path: route, user, searchParams, signal, authorized = () => true}) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(
              modulePage({
                username: user.username,
                title,
                content: kind === 'gallery' ? gallery : articles
              }),
              {headers: {'Content-Type': 'text/html; charset=utf-8'}}
            );
          if (route === '/images') return Response.json(store.images());
          const file = /^\/(file|thumb)\/([a-f0-9-]+)$/.exec(route);
          if (file) {
            const item = store.image(file[2]),
              thumb = file[1] === 'thumb',
              filename = store.file(item.id, thumb);
            const headers = {
              'Content-Type': thumb ? 'image/webp' : item.type,
              'Content-Length': String(fs.statSync(filename).size),
              'X-Content-Type-Options': 'nosniff'
            };
            if (searchParams?.has('download'))
              headers['Content-Disposition'] =
                `attachment; filename="image.${item.extension}"; filename*=UTF-8''${encodeURIComponent(item.name.replace(/[\r\n\\/]/g, '_') + '.' + item.extension).replace(/'/g, '%27')}`;
            const stream = request.method === 'HEAD' ? null : fs.createReadStream(filename);
            if (stream) {
              const abort = () => stream.destroy();
              signal?.addEventListener('abort', abort, {once: true});
              stream.on('close', () => signal?.removeEventListener('abort', abort));
            }
            return new Response(stream ? Readable.toWeb(stream) : null, {headers});
          }
          if (kind === 'articles' && route === '/articles') {
            const q = (searchParams?.get('q') || '').toLocaleLowerCase().slice(0, 200);
            let list = store.articles();
            if (q)
              list = list.filter((a) =>
                [a.title, a.tags.join(' '), store.article(a.id).body]
                  .join(' ')
                  .toLocaleLowerCase()
                  .includes(q)
              );
            return Response.json(list);
          }
          const download = /^\/article\/([a-f0-9-]+)\/export$/.exec(route);
          if (kind === 'articles' && download) {
            const item = store.article(download[1]);
            const name =
              (item.title || 'Заметка').replace(/[\x00-\x1f\x7f\\/]/g, '_').slice(0, 120) + '.md';
            return new Response(item.body, {
              headers: {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Content-Disposition': `attachment; filename="note.md"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, '%27')}`,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'no-store'
              }
            });
          }
          const article = /^\/article\/([a-f0-9-]+)$/.exec(route);
          if (kind === 'articles' && article) return Response.json(store.article(article[1]));
        }
        if (request.method === 'POST') {
          const data = await (kind === 'gallery' && route === '/upload'
            ? readBytes(request, 20 * 1024 * 1024)
            : readJSON(request, 2 * 1024 * 1024));
          const allowed = () => authorized() && !signal?.aborted;
          if (!allowed()) throw fail('Сессия завершена. Войди заново.', 401);
          if (kind === 'gallery') {
            if (route === '/upload') {
              let name;
              try {
                name = decodeURIComponent(request.headers['x-file-name'] || 'Изображение');
              } catch {
                throw fail('Некорректное имя файла.');
              }
              return Response.json(await store.upload(data, name, allowed));
            }
            if (route === '/album') return Response.json(store.album(data.name));
            if (route === '/image/edit') return Response.json(store.editImage(data.id, data));
            if (route === '/image/delete') {
              store.deleteImage(data.id);
              return Response.json({ok: true});
            }
          }
          if (kind === 'articles') {
            if (route === '/save') return Response.json(store.saveArticle(data));
            if (route === '/restore')
              return Response.json(store.restore(data.id, data.revision, data.version));
            if (route === '/preview') {
              if (typeof data.body !== 'string' || data.body.length > 262144)
                throw fail('Слишком большой текст.');
              return Response.json({html: renderArticle(data.body)});
            }
          }
        }
        return Response.json({error: 'Не найдено.'}, {status: 404});
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Не удалось прочитать или сохранить данные.'},
          {status: e.status || 503}
        );
      }
    }
  };
}
