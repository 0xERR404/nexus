import {marked} from './vendor/marked.mjs';
import {ID, fail} from './input.mjs';
export {ID, fail} from './input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const MB = 1024 * 1024;
function imageReferences(body) {
  const ids = new Set();
  marked.walkTokens(marked.lexer(body), (token) => {
    if (token.type === 'image' && token.href.startsWith('media:')) ids.add(token.href.slice(6));
  });
  return ids;
}
const text = (v, max, trim = true) => {
  if (typeof v !== 'string' || v.length > max || /\0/.test(v)) throw fail('Некорректный текст.');
  return trim ? v.trim() : v;
};
const tags = (v) => {
  if (!Array.isArray(v) || v.length > 20) throw fail('Не больше 20 тегов.');
  return [...new Set(v.map((t) => text(t, 32)).filter(Boolean))];
};
export function imageType(data) {
  if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return ['image/jpeg', 'jpg'];
  if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return ['image/png', 'png'];
  if (/^GIF8[79]a$/.test(data.subarray(0, 6).toString())) return ['image/gif', 'gif'];
  if (data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP')
    return ['image/webp', 'webp'];
  throw fail('Поддерживаются JPEG, PNG, WebP и GIF.', 415);
}
const snapshot = ({id, title, body, tags, status, version, updated}) => ({
  id,
  title,
  body,
  tags,
  status,
  version,
  updated
});
export class ContentStore {
  constructor(directory) {
    this.directory = directory;
    this.busy = false;
  }
  load() {
    if (this.data) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    fs.mkdirSync(path.join(this.directory, 'files'), {recursive: true, mode: 0o700});
    try {
      const file = path.join(this.directory, 'catalog.json');
      if (fs.statSync(file).size > 64 * MB) throw Error();
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (
        data.schema !== 1 ||
        !Array.isArray(data.images) ||
        !Array.isArray(data.articles) ||
        !Array.isArray(data.albums)
      )
        throw Error();
      this.data = data;
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw fail('Не удалось прочитать хранилище. Данные не перезаписаны.', 503);
      this.data = {schema: 1, images: [], articles: [], albums: []};
    }
  }
  commit(next) {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 64 * MB) throw fail('Гестия текстов заполнено.', 507);
    const temp = path.join(this.directory, '.' + randomUUID());
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, path.join(this.directory, 'catalog.json'));
      this.data = next;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, {force: true});
    }
  }
  file(id, thumb = false) {
    this.image(id);
    return path.join(this.directory, 'files', id + (thumb ? '.webp' : '.original'));
  }
  image(id) {
    this.load();
    const item = ID.test(id) && this.data.images.find((x) => x.id === id);
    if (!item) throw fail('Изображение не найдено.', 404);
    return item;
  }
  images() {
    this.load();
    return {images: this.data.images, albums: this.data.albums};
  }
  album(name) {
    this.load();
    name = text(name, 80);
    if (!name || this.data.albums.length >= 200)
      throw fail('Укажи название; максимум 200 альбомов.');
    this.commit({...this.data, albums: [...new Set([...this.data.albums, name])]});
    return this.images();
  }
  async upload(data, name, allowed = () => true, album = '') {
    this.load();
    if (this.busy) throw fail('Дождись завершения предыдущей загрузки.', 429);
    if (!data.length || data.length > 20 * MB) throw fail('Изображение — до 20 МБ.', 413);
    if (album && !this.data.albums.includes(album)) throw fail('Альбом не найден');
    const [type, extension] = imageType(data),
      digest = createHash('sha256').update(data).digest('hex');
    const existing = this.data.images.find((x) => x.digest === digest);
    if (existing) return existing;
    if (this.data.images.length >= 10000) throw fail('Достигнут лимит 10 000 изображений.', 507);
    const id = randomUUID(),
      base = path.join(this.directory, 'files', id),
      original = base + '.original',
      thumb = base + '.webp';
    this.busy = true;
    try {
      fs.writeFileSync(original, data, {mode: 0o600, flag: 'wx'});
      const args = [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,pipe',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        original
      ];
      const info = JSON.parse(
        (await exec('ffprobe', args, {timeout: 10000, maxBuffer: 65536})).stdout
      ).streams?.[0];
      if (
        !info?.width ||
        !info.height ||
        info.width * info.height > 40000000 ||
        Math.max(info.width, info.height) > 16000
      )
        throw fail('Изображение слишком большое: максимум 40 мегапикселей.');
      await exec(
        'ffmpeg',
        [
          '-v',
          'error',
          '-nostdin',
          '-threads',
          '1',
          '-protocol_whitelist',
          'file,pipe',
          '-i',
          original,
          '-frames:v',
          '1',
          '-vf',
          'scale=480:480:force_original_aspect_ratio=decrease',
          '-threads',
          '1',
          '-c:v',
          'libwebp',
          '-quality',
          '78',
          thumb
        ],
        {timeout: 15000, maxBuffer: 65536}
      );
      fs.chmodSync(thumb, 0o600);
      if (!allowed()) throw fail('Вход завершён или загрузка отменена.', 401);
      const item = {
        id,
        name: text(name || 'Изображение', 180),
        type,
        extension,
        digest,
        size: data.length,
        width: info.width,
        height: info.height,
        created: Date.now(),
        album,
        tags: []
      };
      this.commit({...this.data, images: [item, ...this.data.images]});
      return item;
    } catch (e) {
      fs.rmSync(original, {force: true});
      fs.rmSync(thumb, {force: true});
      if (e.status) throw e;
      throw fail('Изображение повреждено или не удалось создать миниатюру.', 422);
    } finally {
      this.busy = false;
    }
  }
  editImage(id, input) {
    const old = this.image(id),
      album = text(input.album ?? '', 80);
    if (album && !this.data.albums.includes(album)) throw fail('Альбом не найден.');
    const item = {...old, name: text(input.name, 180), tags: tags(input.tags), album};
    if (!item.name) throw fail('Укажи название.');
    this.commit({...this.data, images: this.data.images.map((x) => (x.id === id ? item : x))});
    return item;
  }
  deleteImage(id) {
    this.image(id);
    if (
      this.data.articles.some((a) => [a, ...a.history].some((r) => imageReferences(r.body).has(id)))
    )
      throw fail('Изображение используется в статье или её редакциях.', 409);
    this.commit({...this.data, images: this.data.images.filter((x) => x.id !== id)});
    for (const suffix of ['.original', '.webp'])
      fs.rmSync(path.join(this.directory, 'files', id + suffix), {force: true});
  }
  articles() {
    this.load();
    return this.data.articles.map(({history, body, ...a}) => ({...a, excerpt: body.slice(0, 140)}));
  }
  article(id) {
    this.load();
    const a = ID.test(id) && this.data.articles.find((x) => x.id === id);
    if (!a) throw fail('Статья не найдена.', 404);
    return a;
  }
  saveArticle(input) {
    this.load();
    const old = input.id ? this.article(input.id) : null;
    if (old && input.version !== old.version)
      throw fail(
        'Статья изменена в другой вкладке. Скопируй свой текст перед повторным открытием.',
        409
      );
    if (!old && this.data.articles.length >= 1000) throw fail('Достигнут лимит 1000 статей.', 507);
    const item = {
      title: text(input.title, 160),
      body: text(input.body, 262144, false),
      tags: tags(input.tags),
      status: input.status
    };
    if (!['draft', 'ready'].includes(item.status)) throw fail('Некорректный статус.');
    for (const id of imageReferences(item.body)) this.image(id);
    if (
      old &&
      ['title', 'body', 'tags', 'status'].every(
        (k) => JSON.stringify(old[k]) === JSON.stringify(item[k])
      )
    )
      return old;
    const saved = {
      ...item,
      id: old?.id ?? randomUUID(),
      created: old?.created ?? Date.now(),
      updated: Date.now(),
      version: (old?.version ?? 0) + 1,
      history: old ? [snapshot(old), ...old.history].slice(0, 50) : []
    };
    this.commit({
      ...this.data,
      articles: old
        ? this.data.articles.map((a) => (a.id === old.id ? saved : a))
        : [saved, ...this.data.articles]
    });
    return saved;
  }
  restore(id, version, currentVersion) {
    const a = this.article(id),
      revision = a.history.find((r) => r.version === version);
    if (!revision) throw fail('Редакция не найдена.', 404);
    return this.saveArticle({...revision, id, version: currentVersion});
  }
}
const stores = new Map();
export function contentStore(
  directory = path.join(process.env.DATA_DIR ?? '/app/data', 'content')
) {
  if (!stores.has(directory)) stores.set(directory, new ContentStore(directory));
  return stores.get(directory);
}
