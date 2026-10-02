import {ID, fail} from '../../src/input.mjs';
export {fail} from '../../src/input.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec = promisify(execFile);
const clean = (s, max) => {
  if (typeof s !== 'string' || s.length > max || /[\x00-\x1f]/.test(s))
    throw fail('Некорректный текст.');
  return s.trim();
};
const weight = (b) => (b.type === 'image' ? 300 : Math.max(1, b.text.length));
export function parseAsync(bytes, name) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./parse.mjs', import.meta.url), {
      workerData: {bytes, name},
      resourceLimits: {maxOldGenerationSizeMb: 384}
    });
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void worker.terminate();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(fail('Импорт занял слишком много времени.', 422)), 30000);
    worker.once('message', (r) => finish(r.error ? fail(r.error, 422) : null, r.book));
    worker.once('error', () => finish(fail('Не удалось обработать книгу.', 422)));
    worker.once('exit', () => {
      if (!done) finish(fail('Обработка книги прервана.', 422));
    });
  });
}
export class ReaderStore {
  constructor(directory) {
    this.directory = directory;
    this.busy = false;
  }
  load() {
    if (this.data) return;
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    try {
      const f = path.join(this.directory, 'library.json');
      if (fs.statSync(f).size > 16 * 1024 * 1024) throw Error();
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (data.schema !== 1 || !Array.isArray(data.books) || !data.settings) throw Error();
      this.data = data;
    } catch (e) {
      if (e.code !== 'ENOENT')
        throw fail('Не удалось прочитать библиотеку. Данные не перезаписаны.', 503);
      this.data = {
        schema: 1,
        books: [],
        settings: {size: 20, line: 1.7, font: 'serif', theme: 'hub', width: 'normal'}
      };
    }
  }
  commit(next) {
    const bytes = JSON.stringify(next);
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024)
      throw fail('Каталог библиотеки заполнен.', 507);
    const temp = path.join(this.directory, '.' + randomUUID());
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, path.join(this.directory, 'library.json'));
      this.data = next;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temp, {force: true});
    }
  }
  book(id) {
    this.load();
    const b = ID.test(id) && this.data.books.find((b) => b.id === id);
    if (!b) throw fail('Книга не найдена.', 404);
    return b;
  }
  library() {
    this.load();
    return this.data.books.map(({chapters, assets, bookmarks, ...b}) => ({
      ...b,
      chapterCount: chapters.length,
      bookmarkCount: bookmarks.length
    }));
  }
  async upload(bytes, name, allowed = () => true) {
    this.load();
    if (this.busy) throw fail('Дождись завершения импорта.', 429);
    if (!bytes.length || bytes.length > 64 * 1024 * 1024) throw fail('Книга — до 64 МБ.', 413);
    name = clean(name, 200);
    if (!/\.(epub|txt)$/i.test(name)) throw fail('Поддерживаются EPUB и TXT.', 415);
    const digest = createHash('sha256').update(bytes).digest('hex'),
      existing = this.data.books.find((b) => b.digest === digest);
    if (existing) return existing;
    if (this.data.books.length >= 1000) throw fail('Достигнут лимит 1000 книг.', 507);
    this.busy = true;
    const id = randomUUID(),
      stage = path.join(this.directory, '.import-' + id),
      target = path.join(this.directory, id);
    let committed = false;
    try {
      const parsed = await parseAsync(bytes, name);
      if (!allowed()) throw fail('Сессия завершена или загрузка отменена.', 401);
      await fsp.mkdir(stage, {mode: 0o700});
      await fsp.mkdir(path.join(stage, 'assets'), {mode: 0o700});
      await fsp.writeFile(path.join(stage, 'original'), bytes, {mode: 0o600});
      const chapters = [];
      let total = 0;
      for (let i = 0; i < parsed.chapters.length; i++) {
        const c = parsed.chapters[i],
          size = c.blocks.reduce((sum, b) => sum + weight(b), 0);
        chapters.push({title: c.title, blocks: c.blocks.length, start: total, weight: size});
        total += size;
        await fsp.writeFile(path.join(stage, i + '.json'), JSON.stringify(c), {mode: 0o600});
      }
      const assets = {};
      for (const a of parsed.assets) {
        await fsp.writeFile(path.join(stage, 'assets', a.id), a.data, {mode: 0o600});
        assets[a.id] = a.type;
      }
      let cover = false;
      if (parsed.cover)
        try {
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
              path.join(stage, 'assets', parsed.cover),
              '-frames:v',
              '1',
              '-vf',
              'scale=300:450:force_original_aspect_ratio=decrease',
              '-threads',
              '1',
              '-c:v',
              'libwebp',
              path.join(stage, 'cover.webp')
            ],
            {timeout: 10000, maxBuffer: 65536}
          );
          await fsp.chmod(path.join(stage, 'cover.webp'), 0o600);
          cover = true;
        } catch {}
      if (!allowed()) throw fail('Сессия завершена или загрузка отменена.', 401);
      const book = {
        id,
        digest,
        title: parsed.title,
        author: parsed.author,
        format: parsed.format,
        cover,
        created: Date.now(),
        total,
        chapters,
        assets,
        bookmarks: [],
        position: {chapter: 0, block: 0, offset: 0},
        progress: 0,
        positionVersion: 0,
        readAt: null
      };
      await fsp.rename(stage, target);
      this.commit({...this.data, books: [book, ...this.data.books]});
      committed = true;
      return book;
    } finally {
      this.busy = false;
      if (!committed) {
        await fsp.rm(stage, {recursive: true, force: true});
        await fsp.rm(target, {recursive: true, force: true});
      }
    }
  }
  chapter(id, index) {
    const b = this.book(id);
    if (!Number.isInteger(index) || index < 0 || index >= b.chapters.length)
      throw fail('Глава не найдена.', 404);
    return JSON.parse(fs.readFileSync(path.join(this.directory, id, index + '.json'), 'utf8'));
  }
  validatePosition(id, p) {
    const b = this.book(id);
    if (
      !p ||
      !Number.isInteger(p.chapter) ||
      !Number.isInteger(p.block) ||
      p.chapter < 0 ||
      p.chapter >= b.chapters.length ||
      p.block < 0 ||
      p.block >= b.chapters[p.chapter].blocks ||
      !Number.isFinite(p.offset) ||
      p.offset < 0 ||
      p.offset > 1
    )
      throw fail('Некорректная позиция.');
    return {chapter: p.chapter, block: p.block, offset: p.offset};
  }
  position(id, p, version) {
    const b = this.book(id),
      position = this.validatePosition(id, p);
    if (version !== b.positionVersion)
      throw fail('Позиция уже изменена на другом устройстве.', 409);
    const blocks = this.chapter(id, p.chapter).blocks,
      inside =
        blocks.slice(0, p.block).reduce((n, b) => n + weight(b), 0) +
        weight(blocks[p.block]) * p.offset;
    const next = {
      ...b,
      position,
      positionVersion: b.positionVersion + 1,
      progress: Math.min(
        p.chapter === b.chapters.length - 1 && p.block === blocks.length - 1 && p.offset === 1
          ? 100
          : 99.9,
        Math.round(((b.chapters[p.chapter].start + inside) / b.total) * 1000) / 10
      ),
      readAt: Date.now()
    };
    this.commit({...this.data, books: this.data.books.map((x) => (x.id === id ? next : x))});
    return next;
  }
  bookmark(id, p, label) {
    const b = this.book(id),
      position = this.validatePosition(id, p);
    if (b.bookmarks.length >= 200) throw fail('Не больше 200 закладок на книгу.');
    const item = {
      id: randomUUID(),
      position,
      label: clean(label || b.chapters[p.chapter].title, 120),
      created: Date.now()
    };
    const next = {...b, bookmarks: [...b.bookmarks, item]};
    this.commit({...this.data, books: this.data.books.map((x) => (x.id === id ? next : x))});
    return next;
  }
  removeBookmark(id, mark) {
    const b = this.book(id);
    if (!b.bookmarks.some((m) => m.id === mark)) throw fail('Закладка не найдена.', 404);
    const next = {...b, bookmarks: b.bookmarks.filter((m) => m.id !== mark)};
    this.commit({...this.data, books: this.data.books.map((x) => (x.id === id ? next : x))});
    return next;
  }
  metadata(id, input) {
    const b = this.book(id),
      next = {...b, title: clean(input.title, 180), author: clean(input.author, 180)};
    if (!next.title) throw fail('Укажи название.');
    this.commit({...this.data, books: this.data.books.map((x) => (x.id === id ? next : x))});
    return next;
  }
  remove(id) {
    this.book(id);
    this.commit({...this.data, books: this.data.books.filter((b) => b.id !== id)});
    fs.rmSync(path.join(this.directory, id), {recursive: true, force: true});
  }
  settings(input) {
    this.load();
    if (input === undefined) return this.data.settings;
    if (
      ![16, 18, 20, 22, 24, 28, 32].includes(input.size) ||
      ![1.4, 1.7, 2].includes(input.line) ||
      !['serif', 'sans', 'mono'].includes(input.font) ||
      !['hub', 'paper', 'sepia'].includes(input.theme) ||
      !['normal', 'wide'].includes(input.width)
    )
      throw fail('Некорректные настройки чтения.');
    const settings = {
      size: input.size,
      line: input.line,
      font: input.font,
      theme: input.theme,
      width: input.width
    };
    this.commit({...this.data, settings});
    return settings;
  }
}
