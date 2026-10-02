import {fail} from './input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, createHash, timingSafeEqual} from 'node:crypto';
import {checkPassword, passwordHash, authIdentity, SESSION_TTL} from './auth.mjs';
import {registerKey, verifyKey} from './passkeys.mjs';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
export class Security {
  constructor(config, file, {now = Date.now} = {}) {
    this.config = {...config};
    this.file = file;
    this.now = now;
    this.identity = authIdentity(config);
    this.rpId = new URL(config.origin).hostname;
    this.userId = Buffer.from(this.identity, 'hex').toString('base64url');
    this.state = {
      identity: this.identity,
      password: null,
      epoch: 0,
      ttl: SESSION_TTL,
      keys: [],
      recovery: [],
      attempts: {}
    };
    if (file) {
      try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.identity === this.identity) {
          if (
            !Array.isArray(saved.keys) ||
            saved.keys.length > 10 ||
            !Array.isArray(saved.recovery) ||
            !Number.isSafeInteger(saved.epoch) ||
            saved.epoch < 0 ||
            !Number.isFinite(saved.ttl) ||
            saved.ttl < 3600 ||
            saved.ttl > SESSION_TTL ||
            typeof saved.attempts !== 'object'
          )
            throw Error();
          if (
            saved.password &&
            (!/^[a-f0-9]{32}$/.test(saved.password.salt) ||
              !/^[a-f0-9]{64}$/.test(saved.password.hash))
          )
            throw Error();
          this.state = saved;
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw Error('Cannot read security storage');
      }
    }
    this.pending = new Map();
    this.challenges = new Map();
    this.grants = new Map();
    this.checking = 0;
  }
  save(next) {
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), {recursive: true, mode: 0o700});
      const temp = this.file + '.' + randomBytes(8).toString('hex');
      let fd;
      try {
        fd = fs.openSync(temp, 'wx', 0o600);
        fs.writeFileSync(fd, JSON.stringify(next));
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(temp, this.file);
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(temp, {force: true});
      }
    }
    this.state = next;
  }
  limit(address) {
    const now = this.now(),
      attempts = Object.fromEntries(
        Object.entries(this.state.attempts).filter(([, v]) => v.until > now)
      );
    const key = hash(address),
      item = attempts[key] || {count: 0, until: now + 300000};
    const global = attempts.global || {count: 0, until: now + 300000};
    if (
      item.count >= 10 ||
      global.count >= 100 ||
      Object.keys(attempts).length >= 1024 ||
      this.checking >= 2
    )
      throw fail('Слишком много попыток. Попробуй через 5 минут.', 429);
    attempts[key] = {...item, count: item.count + 1};
    attempts.global = {...global, count: global.count + 1};
    this.save({...this.state, attempts});
  }
  success(address) {
    const attempts = {...this.state.attempts};
    delete attempts[hash(address)];
    this.save({...this.state, attempts});
  }
  async password(username, value, address) {
    this.limit(address);
    if (
      typeof value !== 'string' ||
      Buffer.byteLength(value) > 1024 ||
      typeof username !== 'string' ||
      username.length > 64
    )
      return false;
    const config = {...this.config, ...(this.state.password || {})},
      epoch = this.state.epoch;
    this.checking++;
    try {
      return (await checkPassword(config, username, value)) && epoch === this.state.epoch;
    } finally {
      this.checking--;
    }
  }
  temporary(map, value, ttl = 300000) {
    for (const [key, item] of map) if (item.until <= this.now()) map.delete(key);
    if (map.size >= 64) throw fail('Слишком много незавершённых запросов.', 429);
    const token = random();
    map.set(hash(token), {...value, epoch: this.state.epoch, until: this.now() + ttl});
    return token;
  }
  get(map, token, consume = false) {
    const key = hash(typeof token === 'string' ? token : ''),
      value = map.get(key);
    if (consume) map.delete(key);
    if (!value || value.until <= this.now() || value.epoch !== this.state.epoch)
      throw fail('Подтверждение истекло. Повтори вход или действие.', 401);
    return value;
  }
  beginLogin(address, agent, method = 'password') {
    return this.temporary(this.pending, {address, agent: hash(agent), method});
  }
  loginPending(token, address, agent, consume = false, method = 'password') {
    const item = this.get(this.pending, token, consume);
    if (item.address !== address || item.agent !== hash(agent) || item.method !== method)
      throw fail('Повтори вход.', 401);
    return item;
  }
  challenge(purpose, binding, extra = {}) {
    const challenge = random(),
      id = this.temporary(this.challenges, {purpose, binding: hash(binding), challenge, ...extra});
    return {
      id,
      publicKey: {
        challenge,
        rpId: this.rpId,
        timeout: 120000,
        userVerification: 'required',
        allowCredentials: this.state.keys.map((key) => ({type: 'public-key', id: key.id}))
      }
    };
  }
  expected(id, purpose, binding) {
    const item = this.get(this.challenges, id, true);
    if (item.purpose !== purpose || item.binding !== hash(binding))
      throw fail('Неверное подтверждение.', 401);
    return {...item, origin: this.config.origin, rpId: this.rpId, userId: this.userId};
  }
  assertion(id, purpose, binding, credential) {
    const expected = this.expected(id, purpose, binding),
      key = this.state.keys.find((k) => k.id === credential?.id);
    if (!key) throw fail('Ключ не найден.', 401);
    const count = verifyKey(credential, expected, key);
    this.save({
      ...this.state,
      keys: this.state.keys.map((k) => (k.id === key.id ? {...k, count, used: this.now()} : k))
    });
    return expected;
  }
  grant(token, action) {
    return this.temporary(this.grants, {binding: hash(token), action}, 120000);
  }
  consumeGrant(grant, token, action) {
    const value = this.get(this.grants, grant, true);
    if (value.binding !== hash(token) || value.action !== action)
      throw fail('Подтверди действие заново.', 401);
  }
  registration(token) {
    if (this.state.keys.length >= 10) throw fail('Можно сохранить до 10 ключей.');
    const {id, publicKey} = this.challenge('register', token);
    return {
      id,
      publicKey: {
        challenge: publicKey.challenge,
        rp: {id: this.rpId, name: 'NEXUS404'},
        user: {id: this.userId, name: this.config.username, displayName: this.config.username},
        pubKeyCredParams: [{type: 'public-key', alg: -7}],
        timeout: 120000,
        attestation: 'none',
        authenticatorSelection: {residentKey: 'required', userVerification: 'required'},
        excludeCredentials: publicKey.allowCredentials
      }
    };
  }
  addKey(id, token, credential, label) {
    const expected = this.expected(id, 'register', token),
      key = registerKey(credential, expected);
    if (this.state.keys.length >= 10 || this.state.keys.some((k) => k.id === key.id))
      throw fail('Этот ключ уже добавлен или достигнут лимит.');
    const first = !this.state.keys.length;
    const codes = first ? this.codes() : null;
    this.save({
      ...this.state,
      keys: [
        ...this.state.keys,
        {
          ...key,
          label: String(label || 'Ключ доступа')
            .replace(/[\x00-\x1f]/g, '')
            .slice(0, 60),
          created: this.now(),
          used: null
        }
      ],
      ...(first ? {recovery: codes.map(hash), epoch: this.state.epoch + 1} : {})
    });
    return {codes, first};
  }
  codes() {
    return Array.from({length: 10}, () => randomBytes(16).toString('hex'));
  }
  recovery(value) {
    const code = typeof value === 'string' ? value.replace(/[\s-]/g, '').toLowerCase() : '';
    if (!/^[a-f0-9]{32}$/.test(code)) throw fail('Неверный код восстановления.', 401);
    const digest = hash(code),
      index = this.state.recovery.findIndex(
        (item) =>
          /^[a-f0-9]{64}$/.test(item) &&
          timingSafeEqual(Buffer.from(item, 'hex'), Buffer.from(digest, 'hex'))
      );
    if (index < 0) throw fail('Неверный или уже использованный код.', 401);
    this.save({
      ...this.state,
      recovery: this.state.recovery.filter((_, i) => i !== index),
      epoch: this.state.epoch + 1
    });
  }
  async changePassword(value, epoch, allowed = () => true) {
    if (
      typeof value !== 'string' ||
      Array.from(value).length < 12 ||
      Buffer.byteLength(value) > 1024 ||
      /[\r\n\0]/.test(value)
    )
      throw fail('Пароль: от 12 символов, до 1024 байт.');
    const password = await passwordHash(value);
    if (epoch !== this.state.epoch || !allowed())
      throw fail('Настройки или сессия изменились. Повтори вход.', 409);
    this.save({...this.state, password, epoch: this.state.epoch + 1});
  }
}
