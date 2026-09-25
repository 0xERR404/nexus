import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Readable} from 'node:stream';
const run = promisify(execFile);
const limit = 256 * 1024 * 1024;
const valid = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const clean = (v, n = 180) =>
  String(v ?? '')
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .slice(0, n);
function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}
const inputs = [
  '-protocol_whitelist',
  'file,pipe',
  '-format_whitelist',
  'mp3,wav,mov,ogg,flac,matroska,webm,aac'
];
export class WaveStore {
  constructor(directory) {
    this.directory = directory;
    this.busy = false;
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    this.file = path.join(directory, 'library.json');
    this.data = {tracks: [], playlists: []};
    try {
      this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  persist() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data), {mode: 0o600});
    fs.renameSync(temp, this.file);
  }
  snapshot() {
    return structuredClone(this.data);
  }
  async upload(request, name) {
    if (this.busy) fail('Загрузка уже идёт. Дождись её завершения.', 429);
    if (this.data.tracks.length >= 10000) fail('Лимит библиотеки — 10 000 треков.', 409);
    this.busy = true;
    const temp = path.join(this.directory, randomUUID() + '.upload');
    try {
      let size = 0;
      const fd = fs.openSync(temp, 'wx', 0o600);
      try {
        for await (const chunk of request) {
          size += chunk.length;
          if (size > limit) fail('Максимум 256 МБ на трек.', 413);
          fs.writeFileSync(fd, chunk);
        }
      } finally {
        fs.closeSync(fd);
      }
      if (!size) fail('Пустой файл.');
      return await this.importFile(temp, name);
    } finally {
      fs.rmSync(temp, {force: true});
      this.busy = false;
    }
  }
  async fromFlow(id) {
    if (!valid(id)) fail('Некорректный трек.');
    if (this.busy) fail('Загрузка уже идёт.', 429);
    if (this.data.tracks.length >= 10000) fail('Лимит библиотеки — 10 000 треков.', 409);
    this.busy = true;
    const temp = path.join(this.directory, randomUUID() + '.upload');
    try {
      const source = path.join(path.dirname(this.directory), 'chat', 'audio', id);
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(source + '.json', 'utf8'));
        if (fs.statSync(source).size > limit) fail('Слишком большой файл.', 413);
        fs.copyFileSync(source, temp);
      } catch (e) {
        if (e.status) throw e;
        fail('Трек FlowMusic не найден.', 404);
      }
      return await this.importFile(
        temp,
        (meta.title || 'FlowMusic') + '.' + meta.extension,
        'FlowMusic'
      );
    } finally {
      fs.rmSync(temp, {force: true});
      this.busy = false;
    }
  }
  async importFile(source, name, artist = '') {
    const extension = path.extname(String(name)).toLowerCase();
    if (!['.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus', '.webm'].includes(extension))
      fail('Поддерживаются MP3, M4A, AAC, WAV, FLAC, OGG, Opus и WebM.');
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(source)) hash.update(chunk);
    const digest = hash.digest('hex');
    const duplicate = this.data.tracks.find((t) => t.hash === digest);
    if (duplicate) return {track: duplicate, duplicate: true};
    let info;
    try {
      info = JSON.parse(
        (
          await run(
            'ffprobe',
            ['-v', 'error', ...inputs, '-show_format', '-show_streams', '-of', 'json', source],
            {timeout: 30000, maxBuffer: 1024 * 1024}
          )
        ).stdout
      );
    } catch {
      fail('Не удалось прочитать аудио. Проверь файл и установку FFmpeg.');
    }
    const stream = info.streams?.find((s) => s.codec_type === 'audio'),
      duration = Number(info.format?.duration ?? stream?.duration);
    if (!stream || !Number.isFinite(duration) || duration <= 0 || duration > 14400)
      fail('Нужен аудиотрек длительностью до 4 часов.');
    const tags = Object.fromEntries(
      Object.entries({...info.format?.tags, ...stream.tags}).map(([k, v]) => [k.toLowerCase(), v])
    );
    const id = randomUUID(),
      dir = path.join(this.directory, id);
    fs.mkdirSync(dir, {mode: 0o700});
    try {
      fs.copyFileSync(source, path.join(dir, 'original' + extension));
      fs.chmodSync(path.join(dir, 'original' + extension), 0o600);
      if (stream.codec_name === 'mp3' && info.format.format_name === 'mp3')
        fs.copyFileSync(source, path.join(dir, 'play.mp3'));
      else
        await run(
          'ffmpeg',
          [
            '-nostdin',
            '-v',
            'error',
            ...inputs,
            '-i',
            source,
            '-map',
            '0:a:0',
            '-vn',
            '-map_metadata',
            '-1',
            '-threads',
            '1',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '192k',
            '-fs',
            String(limit + 2097152),
            path.join(dir, 'play.mp3')
          ],
          {timeout: 180000, maxBuffer: 65536}
        );
      if (fs.statSync(path.join(dir, 'play.mp3')).size > limit)
        fail('Слишком большой трек после преобразования.', 413);
      fs.chmodSync(path.join(dir, 'play.mp3'), 0o600);
      let cover = false;
      const art = info.streams.find(
        (s) => s.codec_type === 'video' && s.disposition?.attached_pic === 1
      );
      if (art && (art.width || 0) * (art.height || 0) <= 25000000) {
        try {
          await run(
            'ffmpeg',
            [
              '-nostdin',
              '-v',
              'error',
              ...inputs,
              '-i',
              source,
              '-map',
              '0:' + art.index,
              '-frames:v',
              '1',
              '-vf',
              'scale=512:512:force_original_aspect_ratio=decrease',
              '-threads',
              '1',
              path.join(dir, 'cover.jpg')
            ],
            {timeout: 15000, maxBuffer: 65536}
          );
          cover = fs.statSync(path.join(dir, 'cover.jpg')).size <= 2 * 1024 * 1024;
          if (!cover) fs.rmSync(path.join(dir, 'cover.jpg'), {force: true});
          else fs.chmodSync(path.join(dir, 'cover.jpg'), 0o600);
        } catch {
          fs.rmSync(path.join(dir, 'cover.jpg'), {force: true});
        }
      }
      const track = {
        id,
        hash: digest,
        title:
          clean(tags.title) || clean(path.basename(name).replace(/\.[^.]+$/, '')) || 'Без названия',
        artist: clean(tags.artist) || artist || 'Неизвестный исполнитель',
        album: clean(tags.album),
        albumArtist: clean(tags.album_artist || tags.albumartist),
        trackNumber: Math.max(0, Math.min(9999, parseInt(tags.track, 10) || 0)),
        discNumber: Math.max(0, Math.min(999, parseInt(tags.disc, 10) || 0)),
        year: clean(tags.date || tags.year, 4),
        duration,
        extension,
        cover,
        favorite: false,
        added: Date.now(),
        bytes: fs.statSync(source).size
      };
      this.data.tracks.push(track);
      try {
        this.persist();
      } catch (e) {
        this.data.tracks.pop();
        throw e;
      }
      return {track, duplicate: false};
    } catch (e) {
      fs.rmSync(dir, {recursive: true, force: true});
      if (e.status) throw e;
      fail('Не удалось подготовить аудио. Проверь свободное место и FFmpeg.', 503);
    }
  }
  change(data) {
    const track = this.data.tracks.find((t) => t.id === data.id),
      playlist = this.data.playlists.find((p) => p.id === data.id);
    switch (data.action) {
      case 'track.edit': {
        if (!track) fail('Трек не найден.', 404);
        const title = clean(data.title);
        if (!title) fail('Укажи название трека.');
        const previous = {...track};
        Object.assign(track, {
          title,
          artist: clean(data.artist) || 'Неизвестный исполнитель',
          album: clean(data.album),
          albumArtist: clean(data.albumArtist),
          trackNumber: Math.max(0, Math.min(9999, parseInt(data.trackNumber, 10) || 0))
        });
        try {
          this.persist();
        } catch (e) {
          Object.assign(track, previous);
          throw e;
        }
        return this.snapshot();
      }
      case 'favorite':
        if (!track) fail('Трек не найден.', 404);
        track.favorite = Boolean(data.favorite);
        break;
      case 'delete':
        if (!track) fail('Трек не найден.', 404);
        this.data.tracks = this.data.tracks.filter((t) => t !== track);
        this.data.playlists.forEach((p) => (p.tracks = p.tracks.filter((id) => id !== track.id)));
        this.persist();
        fs.rmSync(path.join(this.directory, track.id), {recursive: true, force: true});
        return this.snapshot();
      case 'playlist.create': {
        const name = clean(data.name, 80);
        if (!name) fail('Укажи название.');
        if (this.data.playlists.length >= 200) fail('Лимит — 200 плейлистов.');
        this.data.playlists.push({id: randomUUID(), name, tracks: []});
        break;
      }
      case 'playlist.rename':
        if (!playlist) fail('Плейлист не найден.', 404);
        if (!clean(data.name, 80)) fail('Укажи название.');
        playlist.name = clean(data.name, 80);
        break;
      case 'playlist.delete':
        if (!playlist) fail('Плейлист не найден.', 404);
        this.data.playlists = this.data.playlists.filter((p) => p !== playlist);
        break;
      case 'playlist.add':
      case 'playlist.remove':
        if (!playlist || !this.data.tracks.some((t) => t.id === data.track))
          fail('Трек или плейлист не найден.', 404);
        playlist.tracks = playlist.tracks.filter((id) => id !== data.track);
        if (data.action === 'playlist.add') playlist.tracks.push(data.track);
        break;
      default:
        fail('Неизвестное действие.');
    }
    this.persist();
    return this.snapshot();
  }
  serve(id, kind, request) {
    if (!valid(id)) fail('Файл не найден.', 404);
    const track = this.data.tracks.find((t) => t.id === id);
    if (
      !track ||
      !['audio', 'cover', 'original'].includes(kind) ||
      (kind === 'cover' && !track.cover)
    )
      fail('Файл не найден.', 404);
    const file = path.join(
      this.directory,
      id,
      kind === 'cover'
        ? 'cover.jpg'
        : kind === 'original'
          ? 'original' + track.extension
          : 'play.mp3'
    );
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      fail('Файл не найден.', 404);
    }
    const headers = {
      'Content-Type':
        kind === 'cover'
          ? 'image/jpeg'
          : kind === 'audio'
            ? 'audio/mpeg'
            : 'application/octet-stream',
      'Accept-Ranges': 'bytes'
    };
    if (kind === 'original')
      headers['Content-Disposition'] = 'attachment; filename="wave-' + id + track.extension + '"';
    let start = 0,
      end = size - 1,
      status = 200;
    if (request.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!match || (!match[1] && !match[2]))
        return new Response(null, {status: 416, headers: {'Content-Range': 'bytes */' + size}});
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
      } else start = Math.max(0, size - Number(match[2]));
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start > end ||
        start >= size
      )
        return new Response(null, {status: 416, headers: {'Content-Range': 'bytes */' + size}});
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = String(end - start + 1);
    return new Response(
      request.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file, {start, end})),
      {status, headers}
    );
  }
}
