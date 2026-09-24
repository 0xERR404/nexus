import {
  createECDH,
  createHmac,
  createCipheriv,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  createHash
} from 'node:crypto';
export const subscriptionId = (sub) =>
  createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 32);
export function validateSubscription(sub) {
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 2048)
    throw new Error('Некорректная подписка');
  const u = new URL(sub.endpoint),
    allowed = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
  if (
    u.protocol !== 'https:' ||
    u.port ||
    u.username ||
    u.password ||
    u.hash ||
    (!allowed.includes(u.hostname) && !/^([a-z0-9-]+\.)?notify\.windows\.com$/.test(u.hostname))
  )
    throw new Error('Служба Push не поддерживается');
  for (const [key, size] of [
    ['p256dh', 65],
    ['auth', 16]
  ]) {
    const s = sub.keys?.[key];
    if (
      typeof s !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(s) ||
      Buffer.from(s, 'base64url').length !== size
    )
      throw new Error('Некорректный ключ подписки');
  }
  const curve = createECDH('prime256v1');
  curve.generateKeys();
  curve.computeSecret(Buffer.from(sub.keys.p256dh, 'base64url'));
  return {endpoint: u.href, keys: {p256dh: sub.keys.p256dh, auth: sub.keys.auth}};
}
export function vapidKeys() {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const j = publicKey.export({format: 'jwk'});
  return {
    privateKey: privateKey.export({format: 'pem', type: 'pkcs8'}),
    publicKey: Buffer.concat([
      Buffer.from([4]),
      Buffer.from(j.x, 'base64url'),
      Buffer.from(j.y, 'base64url')
    ]).toString('base64url')
  };
}
export function authorization(endpoint, keys, subject, now = Date.now()) {
  const u = new URL(subject);
  if (!['https:', 'mailto:'].includes(u.protocol)) throw new Error('Некорректный VAPID subject');
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const value =
    enc({typ: 'JWT', alg: 'ES256'}) +
    '.' +
    enc({aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 3600, sub: subject});
  const signature = sign('sha256', Buffer.from(value), {
    key: createPrivateKey(keys.privateKey),
    dsaEncoding: 'ieee-p1363'
  }).toString('base64url');
  return `vapid t=${value}.${signature}, k=${keys.publicKey}`;
}
// RFC 8291: ECDH → HKDF-SHA256 → AES-128-GCM, один record.
export function encrypt(payload, sub, {salt = randomBytes(16), privateKey} = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > 3993) throw new Error('Push слишком большой');
  const curve = createECDH('prime256v1');
  if (privateKey) curve.setPrivateKey(privateKey);
  else curve.generateKeys();
  const server = curve.getPublicKey(),
    client = Buffer.from(sub.keys.p256dh, 'base64url'),
    auth = Buffer.from(sub.keys.auth, 'base64url');
  const hmac = (key, data) => createHmac('sha256', key).update(data).digest();
  const prkKey = hmac(auth, curve.computeSecret(client));
  const ikm = hmac(
    prkKey,
    Buffer.concat([Buffer.from('WebPush: info\0'), client, server, Buffer.from([1])])
  );
  const prk = hmac(salt, ikm),
    key = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16),
    nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', key, nonce),
    encrypted = Buffer.concat([
      cipher.update(Buffer.concat([body, Buffer.from([2])])),
      cipher.final(),
      cipher.getAuthTag()
    ]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(4096, 16);
  header[20] = server.length;
  return Buffer.concat([header, server, encrypted]);
}
export async function sendPush(
  subscription,
  payload,
  keys,
  subject,
  {fetcher = fetch, now = Date.now(), ttl = 86400} = {}
) {
  const sub = validateSubscription(subscription),
    body = encrypt(JSON.stringify(payload), sub);
  const response = await fetcher(sub.endpoint, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: authorization(sub.endpoint, keys, subject, now),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: payload.level === 'critical' ? 'high' : 'normal'
    },
    body,
    signal: AbortSignal.timeout(10000)
  });
  const result = {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    gone: [404, 410].includes(response.status),
    retryAfter: Math.min(86400, Math.max(30, Number(response.headers.get('retry-after')) || 60))
  };
  await response.body?.cancel();
  return result;
}
