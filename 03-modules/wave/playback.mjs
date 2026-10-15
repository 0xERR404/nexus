import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

const invalid = () => Object.assign(new Error('Некорректное состояние плеера.'), {status: 400});
const uuid = /^[a-f0-9-]{36}$/;

// Separate from the shared library: each account has its own listening position.
export class PlaybackStore {
  constructor(directory, tracks) {
    this.directory = path.join(directory, 'playback');
    this.tracks = tracks;
  }
  file(username) {
    if (typeof username !== 'string' || !username) throw invalid();
    return path.join(this.directory, createHash('sha256').update(username).digest('hex') + '.json');
  }
  read(username) {
    try { return JSON.parse(fs.readFileSync(this.file(username), 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {revision: 0, state: null}; throw e; }
  }
  normalize(state) {
    if (!state || !Array.isArray(state.queue) || !Array.isArray(state.order) ||
        state.queue.length > 10000 || state.order.length > 10000 ||
        !Number.isInteger(state.index) || state.index < 0 || state.index >= state.queue.length ||
        !Number.isFinite(state.position) || state.position < 0 ||
        !['off', 'one', 'all'].includes(state.repeat) ||
        typeof state.shuffle !== 'boolean' || typeof state.playing !== 'boolean') throw invalid();
    const tracks = new Map(this.tracks().map(t => [t.id, t]));
    const current = state.queue[state.index];
    if (!tracks.has(current)) throw invalid();
    const queue = [...new Set(state.queue.filter(id => typeof id === 'string' && tracks.has(id)))];
    const ids = new Set(queue);
    const order = [...new Set([...state.order.filter(id => ids.has(id)), ...queue])];
    const duration = tracks.get(current).duration;
    return {queue, order, index: queue.indexOf(current),
      position: Math.min(state.position, Number.isFinite(duration) && duration > 0 ? duration : 604800),
      repeat: state.repeat, shuffle: state.shuffle, playing: state.playing};
  }
  view(record) {
    let state = null;
    try { if (record.state) state = this.normalize(record.state); } catch {}
    const {epoch, sequence, ...visible} = record;
    return {...visible, state};
  }
  get(username, since) {
    const record = this.read(username);
    return String(record.revision) === since ? {revision: record.revision, unchanged: true} : this.view(record);
  }
  update(username, input) {
    if (!input || !uuid.test(input.client || '')) throw invalid();
    const old = this.read(username);
    const conflict = () => ({status: 409, data: this.view(old)});
    let epoch, sequence;
    if (input.action === 'claim') {
      if (!Number.isSafeInteger(input.revision) || input.revision !== old.revision) return conflict();
      epoch = randomUUID(); sequence = 0;
    } else if (input.action === 'save') {
      if (old.client !== input.client || old.epoch !== input.epoch) return conflict();
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) throw invalid();
      if (input.sequence <= old.sequence) return {status: 200, data: this.view(old)};
      epoch = old.epoch; sequence = input.sequence;
    } else throw invalid();
    const state = this.normalize(input.action === 'claim' ? input.state : {...old.state, ...input.state});
    const record = {revision: old.revision + 1, epoch, sequence, client: input.client,
      updated: Date.now(), state};
    const file = this.file(username);
    fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
    fs.writeFileSync(file + '.tmp', JSON.stringify(record), {mode: 0o600});
    fs.renameSync(file + '.tmp', file);
    return {status: 200, data: {...this.view(record), ...(input.action === 'claim' ? {epoch} : {})}};
  }
}
