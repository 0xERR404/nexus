import fs from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {fail, uuid} from './store.mjs';
const formats = new Map([
  ['audio/mpeg', 'mp3'],
  ['audio/mp3', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
  ['audio/ogg', 'ogg'],
  ['audio/mp4', 'm4a'],
  ['audio/flac', 'flac'],
  ['audio/webm', 'webm']
]);
export function audioURL(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('FlowMusic не передал адрес аудио.', 502);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname !== 'storage.googleapis.com'
  )
    fail('Новый адрес хранения FlowMusic. Требуется обновить адаптер.', 502);
  return url.href;
}
export class FlowAudio {
  constructor(directory, fetcher = fetch) {
    this.directory = path.join(directory, 'audio');
    this.fetcher = fetcher;
  }
  async save(clip, id, signal) {
    if (!uuid(id)) fail('Некорректный файл.');
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    const file = path.join(this.directory, id);
    if (fs.existsSync(file + '.json') && fs.existsSync(file)) return this.public(id);
    const response = await this.fetcher(audioURL(clip.audio_url), {signal, redirect: 'error'});
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    const extension = formats.get(type);
    if (!response.ok || !response.body || !extension) {
      await response.body?.cancel();
      fail('FlowMusic не вернул поддерживаемый аудиофайл.', 502);
    }
    const temp = file + '.' + randomUUID();
    let fd,
      size = 0;
    const reader = response.body.getReader();
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      while (true) {
        const {value, done} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 64 * 1024 * 1024) fail('Аудиофайл больше 64 МБ.', 502);
        let offset = 0;
        while (offset < value.length) offset += fs.writeSync(fd, value, offset);
      }
      if (!size) fail('Получен пустой аудиофайл.', 502);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, file);
      const meta = {
        title: typeof clip.title === 'string' ? clip.title.slice(0, 200) : 'Трек',
        type,
        extension
      };
      fs.writeFileSync(temp, JSON.stringify(meta), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temp, file + '.json');
      return this.public(id);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      fs.rmSync(temp, {force: true});
    }
  }
  public(id) {
    const meta = JSON.parse(fs.readFileSync(path.join(this.directory, id + '.json'), 'utf8'));
    return {id, title: meta.title, src: '/modules/chat/audio/' + id, extension: meta.extension};
  }
  remove(ids) {
    for (const id of ids)
      if (uuid(id))
        for (const suffix of ['', '.json'])
          fs.rmSync(path.join(this.directory, id + suffix), {force: true});
  }
  serve(id, request, download) {
    if (!uuid(id)) fail('Файл не найден.', 404);
    const file = path.join(this.directory, id);
    let meta, size;
    try {
      meta = JSON.parse(fs.readFileSync(file + '.json', 'utf8'));
      size = fs.statSync(file).size;
    } catch {
      fail('Файл не найден.', 404);
    }
    const headers = {
      'Content-Type': meta.type,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size)
    };
    if (download)
      headers['Content-Disposition'] = `attachment; filename="flowmusic-${id}.${meta.extension}"`;
    let start = 0,
      end = size - 1,
      status = 200;
    if (request.headers.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!m || (!m[1] && !m[2]))
        return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
      if (!m[1]) {
        start = Math.max(0, size - Number(m[2]));
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), end) : end;
      }
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${size}`}});
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      headers['Content-Length'] = String(end - start + 1);
    }
    return new Response(
      request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file, {start, end})),
      {status, headers}
    );
  }
}
