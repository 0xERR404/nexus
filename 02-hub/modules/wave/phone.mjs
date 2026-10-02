import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID, createHash} from 'node:crypto';
const hash = (value) => createHash('sha256').update(value).digest('hex');
export class MusicPhones {
  constructor(directory, store) {
    this.file = path.join(directory, 'phones.json');
    this.store = store;
  }
  read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  }
  save(items) {
    fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(items), {mode: 0o600});
    fs.renameSync(this.file + '.tmp', this.file);
  }
  list() {
    return this.read().map(({secret, ...item}) => item);
  }
  create(name) {
    name = String(name || 'Телефон')
      .trim()
      .slice(0, 80);
    const items = this.read();
    if (items.length >= 10) throw Object.assign(Error('Не больше 10 подключений.'), {status: 400});
    const token = randomBytes(32).toString('base64url'),
      item = {id: randomUUID(), name, created: Date.now(), secret: hash(token)};
    items.push(item);
    this.save(items);
    return {id: item.id, token};
  }
  revoke(id) {
    this.save(this.read().filter((item) => item.id !== id));
  }
  handle(request, route) {
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization || '')?.[1];
    if (
      request.headers.origin ||
      !token ||
      !this.read().some((item) => item.secret === hash(token))
    )
      return Response.json({error: 'Ключ Аполлона недействителен.'}, {status: 401});
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, {status: 405});
    const store = this.store();
    if (route === '/library')
      return Response.json(
        {
          tracks: store
            .snapshot()
            .tracks.map((t) => ({
              id: t.id,
              title: t.title,
              artist: t.artist,
              album: t.album,
              duration: t.duration,
              bytes: this.bytes(store, t.id)
            }))
            .filter((t) => t.bytes > 0),
          playlists: store.snapshot().playlists
        },
        {headers: {'Cache-Control': 'no-store'}}
      );
    const match = /^\/(audio|cover)\/([a-f0-9-]{36})$/.exec(route);
    if (match) return store.serve(match[2], match[1], request);
    return new Response(null, {status: 404});
  }
  bytes(store, id) {
    try {
      return fs.statSync(path.join(store.directory, id, 'play.mp3')).size;
    } catch {
      return 0;
    }
  }
}
