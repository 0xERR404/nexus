import {randomBytes} from 'node:crypto';
const problem = (text, status = 502) => Object.assign(new Error(text), {status});
const varint = (value) => {
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw Error('Invalid uint64');
  const out = [];
  do {
    let b = Number(n & 127n);
    n >>= 7n;
    out.push(b | (n ? 128 : 0));
  } while (n);
  return Buffer.from(out);
};
export function message(fields) {
  return Buffer.concat(
    fields.map(([id, type, value]) => {
      const tag = varint(id * 8 + type);
      if (type === 0) return Buffer.concat([tag, varint(value)]);
      if (type === 1) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64LE(BigInt(value));
        return Buffer.concat([tag, b]);
      }
      if (type === 2) {
        const b = Buffer.from(value);
        return Buffer.concat([tag, varint(b.length), b]);
      }
      throw Error('Unsupported field');
    })
  );
}
export function fields(buffer) {
  const out = new Map();
  let pos = 0;
  const read = () => {
    let n = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (pos >= buffer.length) throw Error('Truncated protobuf');
      const b = buffer[pos++];
      n |= BigInt(b & 127) << shift;
      if (!(b & 128)) return n;
    }
    throw Error('Invalid protobuf');
  };
  while (pos < buffer.length) {
    const tag = Number(read()),
      id = tag >>> 3,
      type = tag & 7;
    let value;
    if (!id) throw Error('Invalid field');
    if (type === 0) value = read().toString();
    else if (type === 2) {
      const size = Number(read());
      if (!Number.isSafeInteger(size) || pos + size > buffer.length) throw Error('Invalid size');
      value = buffer.subarray(pos, pos + size);
      pos += size;
    } else if (type === 1 || type === 5) {
      const size = type === 1 ? 8 : 4;
      if (pos + size > buffer.length) throw Error('Truncated value');
      value = type === 1 ? buffer.readBigUInt64LE(pos).toString() : buffer.readFloatLE(pos);
      pos += size;
    } else throw Error('Invalid wire type');
    out.set(id, value);
  }
  return out;
}
export function tokenInfo(token, refresh = false) {
  try {
    if (
      typeof token !== 'string' ||
      token.length > 16000 ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
    )
      throw Error();
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    if (
      !/^\d{17}$/.test(claims.sub) ||
      !Number.isFinite(claims.exp) ||
      !Array.isArray(claims.aud) ||
      !claims.aud.includes('mobile') ||
      claims.aud.includes('derive') !== refresh
    )
      throw Error();
    return {id: claims.sub, expiresAt: claims.exp * 1000};
  } catch {
    throw problem('Steam вернул неподдерживаемую сессию. Повтори вход.', 502);
  }
}
export function challenge(value) {
  const text = Buffer.isBuffer(value) ? value.toString() : value;
  if (typeof text !== 'string' || !/^https:\/\/s\.team\/q\/\d{1,3}\/\d{1,20}$/.test(text))
    throw problem('Steam изменил формат QR. Требуется обновление хаба.');
  return text;
}
export class SteamAuth {
  constructor({fetcher = fetch, now = Date.now} = {}) {
    this.fetcher = fetcher;
    this.now = now;
    this.pending = null;
    this.busy = false;
    this.nextBegin = 0;
    this.controller = new AbortController();
  }
  async call(method, data) {
    const form = new FormData();
    form.set('input_protobuf_encoded', data.toString('base64'));
    let response;
    try {
      response = await this.fetcher(
        `https://api.steampowered.com/IAuthenticationService/${method}/v1/`,
        {
          method: 'POST',
          body: form,
          redirect: 'error',
          signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(20000)]),
          headers: {
            'User-Agent': 'NEXUS404 personal hub',
            Accept: 'application/octet-stream',
            Cookie: 'mobileClient=android; mobileClientVersion=777777 3.10.3'
          }
        }
      );
    } catch {
      throw problem('Нет ответа от Steam. Попробуй ещё раз.', 503);
    }
    const result = Number(response.headers.get('x-eresult'));
    if (!response.ok || result !== 1) {
      await response.body?.cancel();
      if (response.status === 429 || result === 84)
        throw problem('Steam ограничил попытки входа. Подожди немного.', 429);
      if ([5, 15, 27, 65].includes(result) || response.status === 401)
        throw problem('Сессия Steam истекла или отозвана. Войди по QR снова.', 401);
      throw problem('Steam не подтвердил запрос. Повтори вход.', 502);
    }
    try {
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 65536) {
          await reader.cancel();
          throw Error();
        }
        chunks.push(Buffer.from(value));
      }
      return fields(Buffer.concat(chunks));
    } catch {
      throw problem('Неожиданный ответ авторизации Steam.');
    }
  }
  async begin() {
    if (this.busy || this.now() < this.nextBegin)
      throw problem('Подожди перед повторным созданием QR.', 429);
    this.busy = true;
    this.nextBegin = this.now() + 30000;
    this.pending = null;
    try {
      const details = message([
        [1, 2, 'NEXUS404 · personal VPS'],
        [2, 0, 3]
      ]);
      const f = await this.call(
        'BeginAuthSessionViaQR',
        message([
          [3, 2, details],
          [4, 2, 'Mobile']
        ])
      );
      const url = challenge(f.get(2)),
        request = f.get(3),
        client = f.get(1);
      if (
        !/^\d{1,20}$/.test(client ?? '') ||
        !Buffer.isBuffer(request) ||
        !request.length ||
        request.length > 256
      )
        throw problem('Неполный ответ Steam.');
      const interval = Number(f.get(4));
      this.pending = {
        id: randomBytes(24).toString('hex'),
        client,
        request,
        url,
        interval: Number.isFinite(interval)
          ? Math.max(5000, Math.min(2147483647, Math.ceil(interval * 1000)))
          : 5000,
        next: this.now(),
        expiresAt: this.now() + 120000,
        revision: 0
      };
      return this.status();
    } finally {
      this.busy = false;
    }
  }
  status() {
    const p = this.pending;
    return p
      ? {attempt: p.id, expiresAt: p.expiresAt, interval: p.interval, revision: p.revision}
      : null;
  }
  require(id) {
    const p = this.pending;
    if (!p || p.id !== id || this.now() >= p.expiresAt)
      throw problem('QR истёк. Создай новый.', 410);
    return p;
  }
  async poll(id) {
    const p = this.require(id);
    if (this.busy || this.now() < p.next) return {waiting: true, ...this.status()};
    this.busy = true;
    p.next = this.now() + p.interval;
    try {
      const f = await this.call(
        'PollAuthSessionStatus',
        message([
          [1, 0, p.client],
          [2, 2, p.request]
        ])
      );
      if (this.pending !== p) throw problem('Вход отменён.', 410);
      if (f.get(1)) p.client = f.get(1);
      if (f.get(2)) {
        p.url = challenge(f.get(2));
        p.revision++;
      }
      if (f.get(3)) {
        const refreshToken = f.get(3).toString(),
          info = tokenInfo(refreshToken, true);
        let accessToken = f.get(4)?.toString();
        if (!accessToken) accessToken = (await this.refresh(refreshToken, info.id)).accessToken;
        const access = tokenInfo(accessToken);
        if (access.id !== info.id || access.expiresAt <= this.now())
          throw problem('Steam вернул разные аккаунты. Повтори вход.');
        return {
          tokens: {
            id: info.id,
            name: (f.get(6)?.toString() || info.id).slice(0, 100),
            accessToken,
            refreshToken,
            expiresAt: access.expiresAt
          }
        };
      }
      return {waiting: true, scanned: f.get(5) === '1', ...this.status()};
    } catch (e) {
      if ([401, 410].includes(e.status)) this.pending = null;
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async refresh(refreshToken, id) {
    const info = tokenInfo(refreshToken, true);
    if (info.id !== id || info.expiresAt <= this.now())
      throw problem('Сессия истекла. Войди в Steam по QR снова.', 401);
    const f = await this.call(
      'GenerateAccessTokenForApp',
      message([
        [1, 2, refreshToken],
        [2, 1, id],
        [3, 0, 1]
      ])
    );
    const accessToken = f.get(1)?.toString(),
      next = f.get(2)?.toString() || refreshToken,
      access = tokenInfo(accessToken),
      refreshed = tokenInfo(next, true);
    if (access.id !== id || refreshed.id !== id || access.expiresAt <= this.now())
      throw problem('Некорректная новая сессия Steam.');
    return {accessToken, refreshToken: next, expiresAt: access.expiresAt};
  }
  cancel(id) {
    if (this.pending?.id === id) this.pending = null;
  }
  close() {
    this.pending = null;
    this.controller.abort();
  }
}

// QR version 4-L, byte mode; sufficient for Steam's challenge URL.
export function qrSVG(text) {
  const bytes = Buffer.from(text);
  if (bytes.length > 78) throw Error('QR input too long');
  const bits = [];
  const push = (n, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((n >>> i) & 1);
  };
  push(4, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, 640 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));
  for (let i = 0; data.length < 80; i++) data.push(i % 2 ? 17 : 236);
  const multiply = (x, y) => {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  };
  let polynomial = [1],
    root = 1;
  for (let i = 0; i < 20; i++) {
    const next = Array(polynomial.length + 1).fill(0);
    for (let j = 0; j < polynomial.length; j++) {
      next[j] ^= polynomial[j];
      next[j + 1] ^= multiply(polynomial[j], root);
    }
    polynomial = next;
    root = multiply(root, 2);
  }
  const remainder = Array(20).fill(0);
  for (const b of data) {
    const factor = b ^ remainder.shift();
    remainder.push(0);
    for (let i = 0; i < 20; i++) remainder[i] ^= multiply(polynomial[i + 1], factor);
  }
  const stream = [];
  for (const b of [...data, ...remainder]) for (let i = 7; i >= 0; i--) stream.push((b >>> i) & 1);
  const size = 33,
    grid = Array.from({length: size}, () => Array(size).fill(false)),
    fixed = grid.map((r) => r.slice());
  const set = (x, y, value) => {
    if (x >= 0 && y >= 0 && x < size && y < size) {
      grid[y][x] = !!value;
      fixed[y][x] = true;
    }
  };
  for (const [cx, cy] of [
    [3, 3],
    [29, 3],
    [3, 29]
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++)
      set(26 + dx, 26 + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  const format = (mask) => {
    const value = 8 | mask;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((value << 10) | rem) ^ 0x5412,
      bit = (i) => (b >>> i) & 1;
    for (let i = 0; i < 6; i++) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  format(0);
  let cursor = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (!fixed[y][x]) {
          grid[y][x] = !!((stream[cursor++] ?? 0) ^ ((x + y) % 2 === 0 ? 1 : 0));
        }
      }
    }
  }
  const cells = [];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) if (grid[y][x]) cells.push(`M${x + 4},${y + 4}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 41 41" shape-rendering="crispEdges"><rect width="41" height="41" fill="white"/><path fill="black" d="${cells.join('')}"/></svg>`;
}
