import {randomBytes, scrypt, timingSafeEqual, createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import path from 'node:path';
const derive = promisify(scrypt);
const digest = (value) => createHash('sha256').update(value).digest('hex');
export const SESSION_TTL = 30 * 24 * 60 * 60;

export async function passwordHash(password, salt = randomBytes(16).toString('hex')) {
  const key = await derive(password, salt, 32, {N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024});
  return {salt, hash: key.toString('hex')};
}
export function validateAuth(config) {
  if (
    !/^[A-Za-z0-9_.@-]{1,64}$/.test(config.username ?? '') ||
    !/^[a-f0-9]{32}$/.test(config.salt ?? '') ||
    !/^[a-f0-9]{64}$/.test(config.hash ?? '')
  )
    throw new Error('Invalid auth configuration');
  const origin = new URL(config.origin);
  if (
    origin.origin !== config.origin ||
    origin.username ||
    origin.password ||
    !(
      origin.protocol === 'https:' ||
      (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))
    )
  )
    throw new Error('HTTPS origin required');
  return config;
}
export async function checkPassword(config, username, password) {
  const computed = await passwordHash(password, config.salt);
  return (
    timingSafeEqual(Buffer.from(computed.hash, 'hex'), Buffer.from(config.hash, 'hex')) &&
    timingSafeEqual(
      Buffer.from(digest(username), 'hex'),
      Buffer.from(digest(config.username), 'hex')
    )
  );
}
export class Sessions {
  constructor(file, authIdentity) {
    this.file = file;
    this.identity = authIdentity;
    this.entries = new Map();
    this.lastSave = 0;
    if (!file) return;
    mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.identity === authIdentity && Array.isArray(saved.entries)) {
        for (const [key, value] of saved.entries.slice(-64)) {
          const item =
            typeof value === 'number'
              ? {
                  expires: value,
                  created: null,
                  seen: null,
                  device: 'Ранее созданная сессия',
                  epoch: 0
                }
              : value;
          if (
            /^[a-f0-9]{64}$/.test(key) &&
            item &&
            Number.isFinite(item.expires) &&
            item.expires > Date.now()
          )
            this.entries.set(key, item);
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot read session storage');
    }
  }
  commit(entries) {
    if (this.file) {
      const temporary = this.file + '.tmp';
      writeFileSync(temporary, JSON.stringify({identity: this.identity, entries: [...entries]}), {
        mode: 0o600
      });
      renameSync(temporary, this.file);
    }
    this.entries = entries;
    this.lastSave = Date.now();
  }
  create(meta = {}, ttl = SESSION_TTL, epoch = 0) {
    const token = randomBytes(32).toString('hex'),
      now = Date.now();
    const entries = new Map(
      [...this.entries].filter(([, item]) => item.expires > now && item.epoch === epoch)
    );
    while (entries.size >= 64) entries.delete(entries.keys().next().value);
    entries.set(digest(token), {
      device: deviceName(meta.agent),
      ip: meta.ip || '',
      recovery: meta.recovery === true,
      created: now,
      seen: now,
      expires: now + ttl * 1000,
      epoch
    });
    this.commit(entries);
    return token;
  }
  get(token, epoch = 0) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const item = this.entries.get(digest(token));
    return item?.expires > Date.now() && item.epoch === epoch ? item : null;
  }
  valid(token, epoch = 0) {
    return !!this.get(token, epoch);
  }
  touch(token, epoch = 0) {
    const item = this.get(token, epoch);
    if (!item) return;
    item.seen = Date.now();
    if (Date.now() - this.lastSave > 60000) this.commit(new Map(this.entries));
  }
  list(token, epoch = 0) {
    return [...this.entries]
      .filter(([, item]) => item.expires > Date.now() && item.epoch === epoch)
      .map(([id, item]) => ({
        id,
        device: item.device,
        ip: item.ip,
        created: item.created,
        seen: item.seen,
        expires: item.expires,
        current: id === digest(token)
      }));
  }
  revokeId(id) {
    const entries = new Map(this.entries);
    if (!entries.delete(id)) return false;
    this.commit(entries);
    return true;
  }
  revoke(token) {
    if (typeof token === 'string' && /^[a-f0-9]{64}$/.test(token)) this.revokeId(digest(token));
  }
  others(token) {
    this.commit(new Map([...this.entries].filter(([id]) => id === digest(token))));
  }
  shorten(ttl) {
    const now = Date.now();
    this.commit(
      new Map(
        [...this.entries].map(([id, item]) => [
          id,
          {...item, expires: Math.min(item.expires, (item.created ?? now) + ttl * 1000)}
        ])
      )
    );
  }
}
export function deviceName(agent = '') {
  const os = /Android/i.test(agent)
    ? 'Android'
    : /iPhone|iPad/i.test(agent)
      ? 'iOS'
      : /Windows/i.test(agent)
        ? 'Windows'
        : /Macintosh/i.test(agent)
          ? 'macOS'
          : /Linux/i.test(agent)
            ? 'Linux'
            : 'Устройство';
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Firefox\//.test(agent)
      ? 'Firefox'
      : /Chrome\//.test(agent)
        ? 'Chrome'
        : /Safari\//.test(agent)
          ? 'Safari'
          : 'Браузер';
  return os + ' · ' + browser;
}
export function authIdentity(config) {
  return digest(config.username + ':' + config.salt + ':' + config.hash);
}
