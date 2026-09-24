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
    if (!file) return;
    mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    try {
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      if (saved.identity === authIdentity && Array.isArray(saved.entries)) {
        this.entries = new Map(
          saved.entries
            .filter(
              ([key, expires]) =>
                /^[a-f0-9]{64}$/.test(key) && Number.isFinite(expires) && expires > Date.now()
            )
            .slice(-64)
        );
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
  }
  create() {
    const token = randomBytes(32).toString('hex');
    const entries = new Map([...this.entries].filter(([, expires]) => expires > Date.now()));
    while (entries.size >= 64) entries.delete(entries.keys().next().value);
    entries.set(digest(token), Date.now() + SESSION_TTL * 1000);
    this.commit(entries);
    return token;
  }
  valid(token) {
    return (
      typeof token === 'string' &&
      /^[a-f0-9]{64}$/.test(token) &&
      (this.entries.get(digest(token)) ?? 0) > Date.now()
    );
  }
  revoke(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return;
    const entries = new Map(this.entries);
    if (!entries.delete(digest(token))) return;
    this.commit(entries);
  }
}
export function authIdentity(config) {
  return digest(config.username + ':' + config.salt + ':' + config.hash);
}
