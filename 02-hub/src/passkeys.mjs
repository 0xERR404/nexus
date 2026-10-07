import {createHash, createPublicKey, verify, timingSafeEqual} from 'node:crypto';
const fail = () => Object.assign(new Error('Не удалось подтвердить ключ доступа.'), {status: 401});
const hash = (value) => createHash('sha256').update(value).digest();
export function decode(value, max = 16384) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value) || value.length > max * 1.34)
    throw fail();
  const data = Buffer.from(value, 'base64url');
  if (data.length > max || data.toString('base64url') !== value) throw fail();
  return data;
}
function cbor(data, start = 0) {
  let offset = start,
    nodes = 0;
  const read = (depth = 0) => {
    if (++nodes > 128 || depth > 6 || offset >= data.length) throw fail();
    const head = data[offset++],
      major = head >> 5,
      size = head & 31;
    if (head === 244) return false;
    if (head === 245) return true;
    let n = size;
    if (size >= 24) {
      const length = {24: 1, 25: 2, 26: 4}[size];
      if (!length || offset + length > data.length) throw fail();
      n = data.readUIntBE(offset, length);
      offset += length;
    }
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      if (offset + n > data.length) throw fail();
      const value = data.subarray(offset, offset + n);
      offset += n;
      return major === 2 ? value : value.toString('utf8');
    }
    if (n > 32) throw fail();
    if (major === 4) return Array.from({length: n}, () => read(depth + 1));
    if (major === 5) {
      const map = new Map();
      for (let i = 0; i < n; i++) {
        const key = read(depth + 1);
        if (!['string', 'number'].includes(typeof key) || map.has(key)) throw fail();
        map.set(key, read(depth + 1));
      }
      return map;
    }
    throw fail();
  };
  return {value: read(), end: offset};
}
function client(value, expected, type) {
  const data = decode(value, 4096);
  let json;
  try {
    json = JSON.parse(data.toString('utf8'));
  } catch {
    throw fail();
  }
  if (
    json.type !== type ||
    json.challenge !== expected.challenge ||
    json.origin !== expected.origin ||
    (json.crossOrigin !== undefined && json.crossOrigin !== false) ||
    json.topOrigin !== undefined
  )
    throw fail();
  return data;
}
function authenticator(data, expected, registration) {
  if (
    !Buffer.isBuffer(data) ||
    data.length < 37 ||
    !timingSafeEqual(data.subarray(0, 32), hash(expected.rpId))
  )
    throw fail();
  const flags = data[32];
  if (
    !(flags & 1) ||
    !(flags & 4) ||
    !!(flags & 64) !== registration ||
    (flags & 16 && !(flags & 8))
  )
    throw fail();
  return {count: data.readUInt32BE(33), backupEligible: !!(flags & 8), flags};
}
function extensionEnd(data, offset, flags) {
  if (flags & 128) {
    const ext = cbor(data, offset);
    if (!(ext.value instanceof Map)) throw fail();
    offset = ext.end;
  }
  if (offset !== data.length) throw fail();
}
export function registerKey(credential, expected) {
  if (credential?.type !== 'public-key' || credential.id !== credential.rawId) throw fail();
  client(credential.response?.clientDataJSON, expected, 'webauthn.create');
  const raw = decode(credential.response?.attestationObject),
    att = cbor(raw);
  if (
    att.end !== raw.length ||
    !(att.value instanceof Map) ||
    att.value.get('fmt') !== 'none' ||
    !(att.value.get('attStmt') instanceof Map) ||
    att.value.get('attStmt').size
  )
    throw fail();
  const data = att.value.get('authData'),
    info = authenticator(data, expected, true);
  if (data.length < 55) throw fail();
  const length = data.readUInt16BE(53),
    id = decode(credential.rawId, 1024);
  if (
    !length ||
    length > 1024 ||
    55 + length >= data.length ||
    !id.equals(data.subarray(55, 55 + length))
  )
    throw fail();
  const key = cbor(data, 55 + length),
    k = key.value;
  if (
    !(k instanceof Map) ||
    k.get(1) !== 2 ||
    k.get(3) !== -7 ||
    k.get(-1) !== 1 ||
    !Buffer.isBuffer(k.get(-2)) ||
    k.get(-2).length !== 32 ||
    !Buffer.isBuffer(k.get(-3)) ||
    k.get(-3).length !== 32
  )
    throw fail();
  extensionEnd(data, key.end, info.flags);
  const publicKey = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: k.get(-2).toString('base64url'),
      y: k.get(-3).toString('base64url')
    },
    format: 'jwk'
  }).export({format: 'pem', type: 'spki'});
  return {id: credential.id, publicKey, count: info.count, backupEligible: info.backupEligible};
}
export function verifyKey(credential, expected, stored) {
  if (
    credential?.type !== 'public-key' ||
    credential.id !== stored.id ||
    credential.rawId !== stored.id
  )
    throw fail();
  const clientData = client(credential.response?.clientDataJSON, expected, 'webauthn.get');
  const data = decode(credential.response?.authenticatorData, 4096),
    info = authenticator(data, expected, false);
  extensionEnd(data, 37, info.flags);
  const handle = credential.response?.userHandle;
  if (
    handle !== undefined &&
    handle !== null &&
    decode(handle, 64).toString('base64url') !== expected.userId
  )
    throw fail();
  if (
    info.backupEligible !== stored.backupEligible ||
    ((info.count || stored.count) && info.count <= stored.count)
  )
    throw fail();
  if (
    !verify(
      'sha256',
      Buffer.concat([data, hash(clientData)]),
      stored.publicKey,
      decode(credential.response?.signature, 1024)
    )
  )
    throw fail();
  return info.count;
}
