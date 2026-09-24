import http from 'node:http';
import {createHash} from 'node:crypto';
import {readFileSync, appendFileSync, statSync, writeFileSync, renameSync} from 'node:fs';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {validateAuth, checkPassword, Sessions, SESSION_TTL, authIdentity} from './auth.mjs';
import {login, dashboard, settingsPage} from './views.mjs';
import {loadModules, moduleSummary} from './modules.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/manifest+json',
  '.html': 'text/html',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};
const assets = [
  'app.css',
  'app.js',
  'manifest.json',
  'offline.html',
  'sw.js',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'fonts/jetbrains-mono.woff2',
  'fonts/space-grotesk.woff2'
];
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export async function body(request, limit = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0,
      done = false;
    const chunks = [];
    request.on('data', (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > limit) {
        done = true;
        reject(Object.assign(new Error('Body too large'), {status: 413}));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('Request aborted')));
  });
}
function cookie(request, name) {
  return (request.headers.cookie ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(name + '='))
    ?.slice(name.length + 1);
}
export function createApp({
  config,
  sessionsFile,
  modules = new Map(),
  trustProxy = false,
  publicDir = path.join(root, 'public'),
  auditFile
}) {
  validateAuth(config);
  const sessions = new Sessions(sessionsFile, authIdentity(config));
  const secure = new URL(config.origin).protocol === 'https:';
  const cookieName = secure ? '__Host-nexus_session' : 'nexus_dev_session';
  const attempts = new Map();
  const knownFile = auditFile ? path.join(path.dirname(auditFile), 'known-ips.json') : null;
  let seenIPs = new Set();
  try {
    const saved = JSON.parse(readFileSync(knownFile, 'utf8'));
    if (saved.identity === authIdentity(config) && Array.isArray(saved.addresses))
      seenIPs = new Set(saved.addresses.filter(isIP).slice(-256));
  } catch {}
  function rememberIP(address) {
    if (seenIPs.has(address)) return;
    audit('security.hub.login_new', address);
    if (seenIPs.size >= 256) seenIPs.delete(seenIPs.values().next().value);
    seenIPs.add(address);
    if (knownFile)
      try {
        writeFileSync(
          knownFile + '.tmp',
          JSON.stringify({identity: authIdentity(config), addresses: [...seenIPs]}),
          {mode: 0o600}
        );
        renameSync(knownFile + '.tmp', knownFile);
      } catch {
        console.error('Cannot save known addresses');
      }
  }
  function audit(type, address) {
    if (!auditFile) return;
    try {
      try {
        if (statSync(auditFile).size > 1048576) writeFileSync(auditFile, '', {mode: 0o600});
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const ip = isIP(address) ? address : 'unknown';
      appendFileSync(
        auditFile,
        JSON.stringify({type, time: new Date().toISOString(), details: 'ip=' + ip}) + '\n',
        {mode: 0o600}
      );
    } catch {
      console.error('Cannot record auth event');
    }
  }
  let checking = 0;
  const staticFiles = new Map(
    assets.map((name) => ['/' + name, readFileSync(path.join(publicDir, name))])
  );
  const fingerprint = createHash('sha256');
  for (const [name, data] of staticFiles) fingerprint.update(name).update(data);
  staticFiles.set(
    '/sw.js',
    Buffer.from(
      staticFiles
        .get('/sw.js')
        .toString()
        .replace('__ASSET_HASH__', fingerprint.digest('hex').slice(0, 20))
    )
  );
  const sessionCookie = (token, age) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  const server = http.createServer(async (request, response) => {
    const send = (status, content, type = 'text/html') => {
      response.writeHead(status, {
        'Content-Type':
          type + (type.startsWith('text/') || type === 'application/json' ? '; charset=utf-8' : '')
      });
      response.end(request.method === 'HEAD' ? undefined : content);
    };
    const redirect = (location) => {
      response.writeHead(303, {Location: location});
      response.end();
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', CSP);
    response.setHeader('X-Frame-Options', 'DENY');
    try {
      if (!request.url?.startsWith('/') || request.url.startsWith('//'))
        return send(400, 'Некорректный адрес');
      const url = new URL(request.url, config.origin);
      const token = cookie(request, cookieName);
      const authenticated = sessions.valid(token);
      if (staticFiles.has(url.pathname)) {
        if (!['GET', 'HEAD'].includes(request.method)) return send(405, 'Метод не поддерживается');
        response.setHeader(
          'Cache-Control',
          url.pathname.endsWith('.png') ||
            url.pathname.endsWith('.webp') ||
            url.pathname.endsWith('.woff2')
            ? 'public, max-age=86400'
            : 'no-cache'
        );
        return send(200, staticFiles.get(url.pathname), types[path.extname(url.pathname)]);
      }
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
        request.headers.origin !== config.origin
      )
        return send(403, 'Запрос отклонён');
      if (url.pathname === '/login' && ['GET', 'HEAD'].includes(request.method)) {
        return authenticated ? redirect('/') : send(200, login());
      }
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
          return send(415, login('Неверный формат запроса.'));
        const now = Date.now();
        for (const [key, value] of attempts) if (value.until < now) attempts.delete(key);
        const address = trustProxy
          ? String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress)
              .split(',')[0]
              .trim()
          : request.socket.remoteAddress;
        const attempt = attempts.get(address) ?? {count: 0, until: now + 5 * 60 * 1000};
        if (
          attempt.count >= 10 ||
          checking >= 2 ||
          (attempts.size >= 1024 && !attempts.has(address))
        ) {
          response.setHeader('Retry-After', '300');
          return send(429, login('Слишком много попыток. Попробуйте через 5 минут.'));
        }
        attempt.count++;
        attempts.set(address, attempt);
        const fields = new URLSearchParams(await body(request));
        const username = fields.get('username') ?? '',
          password = fields.get('password') ?? '';
        if (username.length > 64 || Buffer.byteLength(password) > 1024)
          return send(401, login('Неверный логин или пароль.'));
        if (checking >= 2) {
          response.setHeader('Retry-After', '5');
          return send(429, login('Сервер занят. Попробуйте через несколько секунд.'));
        }
        checking++;
        let valid;
        try {
          valid = await checkPassword(config, username, password);
        } finally {
          checking--;
        }
        if (!valid) {
          audit('security.hub.login_failed', address);
          return send(401, login('Неверный логин или пароль.', username));
        }
        rememberIP(address);
        attempts.delete(address);
        sessions.revoke(token);
        response.setHeader('Set-Cookie', sessionCookie(sessions.create(), SESSION_TTL));
        return redirect('/');
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        sessions.revoke(token);
        response.setHeader('Set-Cookie', sessionCookie('', 0));
        return redirect('/login');
      }
      if (!authenticated) {
        if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method))
          return send(401, JSON.stringify({error: 'Требуется вход'}), 'application/json');
        return redirect('/login');
      }
      if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method))
        return send(200, dashboard(config.username, [...modules.values()]));
      if (
        ['/settings', '/settings/'].includes(url.pathname) &&
        ['GET', 'HEAD'].includes(request.method)
      )
        return send(
          200,
          settingsPage(config.username, [...modules.values()], url.searchParams.get('module'))
        );
      if (url.pathname === '/api/modules' && request.method === 'GET')
        return send(
          200,
          JSON.stringify({
            modules: await Promise.all(
              [...modules.values()].map(async (module) => ({
                id: module.id,
                title: module.title,
                description: module.description,
                summary: await moduleSummary(module)
              }))
            )
          }),
          'application/json'
        );
      if (url.pathname === '/api/health' && request.method === 'GET')
        return send(200, '{"status":"ok"}', 'application/json');
      const match = /^\/modules\/([a-z][a-z0-9-]{0,31})(\/.*)?$/.exec(url.pathname);
      if (match && modules.has(match[1])) {
        if (!match[2]) return redirect(url.pathname + '/' + url.search);
        const controller = new AbortController();
        response.on('close', () => controller.abort());
        const result = await modules.get(match[1]).handle({
          request,
          path: match[2],
          searchParams: url.searchParams,
          user: {username: config.username},
          signal: controller.signal
        });
        if (!(result instanceof Response)) throw new Error('Invalid module response');
        for (const [key, value] of result.headers) {
          if (
            ![
              'set-cookie',
              'cache-control',
              'content-security-policy',
              'connection',
              'transfer-encoding',
              'content-length'
            ].includes(key)
          )
            response.setHeader(key, value);
        }
        response.writeHead(result.status);
        if (request.method === 'HEAD' || !result.body) {
          await result.body?.cancel();
          response.end();
        } else {
          const stream = Readable.fromWeb(result.body);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
        }
        return;
      }
      return send(404, 'Страница не найдена');
    } catch (error) {
      if (!response.headersSent)
        send(
          error.status ?? 500,
          error.status === 413 ? 'Слишком большой запрос' : 'Не удалось выполнить запрос'
        );
      else response.destroy();
      if (error.status !== 413) console.error('Request failed:', request.method);
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  return server;
}
async function main() {
  const config = JSON.parse(readFileSync(process.env.AUTH_FILE ?? '/app/config/auth.json', 'utf8'));
  const modules = await loadModules(process.env.MODULES_DIR ?? path.join(root, 'modules'), {
    start: true
  });
  const app = createApp({
    config,
    modules,
    sessionsFile: path.join(process.env.DATA_DIR ?? '/app/data', 'sessions.json'),
    trustProxy: process.env.TRUST_PROXY === '1',
    auditFile: path.join(process.env.DATA_DIR ?? '/app/data', 'auth-events.jsonl')
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, process.env.HOST ?? '0.0.0.0', () =>
    console.log(`NEXUS404 listening on ${port}; modules: ${modules.size}`)
  );
  const stop = () => app.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Cannot start: check auth, data and modules.');
    process.exit(1);
  });
