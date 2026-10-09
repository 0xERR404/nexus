import {Diagnostics} from './diagnostics.mjs';
import {Agents} from './agents.mjs';
import {Notices, noticeCodes} from './notices.mjs';
import {Maintenance} from './maintenance.mjs';
import {Activity} from './activity.mjs';
import {readJSON as parseJSON} from './input.mjs';
import http from 'node:http';
import {Overview} from './overview.mjs';
import {statusView, searchView} from './overview-views.mjs';
import {createHash} from 'node:crypto';
import {readFileSync, appendFileSync, statSync, writeFileSync, renameSync} from 'node:fs';
import {isIP} from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {validateAuth, Sessions, authIdentity} from './auth.mjs';
import {login, factorLogin, dashboard, settingsPage, playerShell, modulePage} from './views.mjs';
import {Security} from './security.mjs';
import {loadModules, DashboardCache} from './modules.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const types = {
  '.mp3': 'audio/mpeg',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/manifest+json',
  '.html': 'text/html',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};
const assets = [
  'servers.js',
  'servers.css',
  'card-layout.css',
  'settings.css',
  'settings.js',
  'backgrounds/code-reference.webp',
  'backgrounds/network-reference.webp',
  'backgrounds/scanner-reference.webp',

  'app.css',
  'overview.css',
  'workspace.css',
  'workspace.js',
  'appearance.js',
  'pulse-history.js',
  'install.js',
  'home.js',
  'overview.js',
  'activity.js',
  'activity-views.js',
  'activity.css',
  'app.js',
  'performance.js',
  'ui.js',
  'legacy-clients.js',
  'maintenance.js',
  'maintenance.css',
  'security.js',
  'security.css',
  'content.js',
  'markdown-edit.js',
  'content.css',
  'intro.js',
  'intro.css',
  'intro-voice.mp3',
  'manifest.json',
  'offline.html',
  'sw.js',
  'icon-192.png',
  'icon.svg',
  'mark.svg',
  'icon-512.png',
  'apple-touch-icon.png',
  'fonts/jetbrains-mono.woff2',
  'fonts/space-grotesk.woff2'
];
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
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
  securityFile,
  dashboardFile,
  dataDirectory,
  modules = new Map(),
  trustProxy = false,
  publicDir = path.join(root, 'public'),
  auditFile,
  maintenance = new Maintenance()
}) {
  validateAuth(config);
  const security = new Security(
    config,
    securityFile ?? (sessionsFile ? path.join(path.dirname(sessionsFile), 'security.json') : null)
  );
  const noticeDirectory = dataDirectory ?? (dashboardFile ? path.dirname(dashboardFile) : null);
  const agents = new Agents(noticeDirectory);
  const agentSweep=setInterval(()=>{try{agents.sweep();}catch{console.error('Cannot persist agent link status');}},30000);agentSweep.unref();
  let registrationWindow=0,registrationCount=0;
  const notices = new Notices(noticeDirectory ? path.join(noticeDirectory, 'hub-notices.json') : null);
  const reportNotice = (source, code, active = true) => {
    if (source === 'signal' || (!modules.has(source) && source !== 'hub')) return;
    try { notices.report(source, modules.get(source)?.title || 'NEXUS404', code, active); }
    catch { console.error('Cannot persist hub notice'); }
  };
  const dashboardCache = new DashboardCache(modules, {
    file: dashboardFile,
    identity: authIdentity(config),
    onSummary: (module, summary) => reportNotice(module.id, 'summary', summary?.state !== 'ok')
  });
  const activity = new Activity(
    dataDirectory ?? (dashboardFile ? path.dirname(dashboardFile) : null)
  );
  const overview = new Overview(
    dataDirectory ?? (dashboardFile ? path.dirname(dashboardFile) : null),
    modules
  );
  const hubVersion = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const diagnostics=new Diagnostics(noticeDirectory);
  const collectDiagnostics=()=>{try{diagnostics.collect(agents,notices.events);}catch{console.error('Cannot collect server diagnostics');}};
  collectDiagnostics();const diagnosticsTimer=setInterval(collectDiagnostics,60000);diagnosticsTimer.unref();
  const sessions = new Sessions(sessionsFile, authIdentity(config));
  const secure = new URL(config.origin).protocol === 'https:';
  const cookieName = secure ? '__Host-nexus_session' : 'nexus_dev_session';
  const pendingName = secure ? '__Host-nexus_pending' : 'nexus_dev_pending';
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
  function audit(type, address, detail = '') {
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
        JSON.stringify({
          type,
          time: new Date().toISOString(),
          details: 'ip=' + ip + (detail ? ' ' + detail : '')
        }) + '\n',
        {mode: 0o600}
      );
    } catch {
      console.error('Cannot record auth event');
    }
  }
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
      if (url.pathname === '/api/agents/register' || url.pathname === '/api/agents/exchange') {
        if(request.method!=='POST')return send(405,'{}','application/json');
        if(!secure || request.headers.origin)return send(403,'{}','application/json');
        if(!request.headers['content-type']?.startsWith('application/json'))return send(415,'{}','application/json');
        const registration=url.pathname.endsWith('/register');
        if(registration){if(Date.now()-registrationWindow>60000){registrationWindow=Date.now();registrationCount=0;}if(++registrationCount>30)return send(429,'{}','application/json');}
        else {const row=agents.get(request.headers['x-nexus-agent']);if(row.revoked)return send(401,'{}','application/json');}
        const raw=await body(request,registration?4096:262144);
        if(!registration && JSON.parse(raw).id!==request.headers['x-nexus-agent'])return send(401,'{}','application/json');
        // Signature and revocation are checked after the awaited body, never via a hub cookie.
        const result=registration?agents.register(raw,request.headers):agents.exchange(raw,request.headers);
        if(!registration&&modules.get('vpn')?.agentExchange){const data=JSON.parse(raw);try{result.vpn=modules.get('vpn').agentExchange(data.id,data.vpn);}catch{result.vpnError='VPN: отчёт отклонён; разрешение не продлено';}}
        return send(200,JSON.stringify(result),'application/json');
      }
      if(url.pathname.startsWith('/subscriptions/vpn/')){
        const handler=modules.get('vpn')?.publicHandle;
        const result=handler?await handler({request,path:url.pathname.slice('/subscriptions/vpn'.length)}):new Response(null,{status:404});
        response.setHeader('Cache-Control','no-store');response.setHeader('Referrer-Policy','no-referrer');
        for(const [key,value] of result.headers)response.setHeader(key,value);
        return send(result.status,await result.text(),result.headers.get('content-type')??'text/plain');
      }
      if (url.pathname === '/api/balance/notifications') {
        const handler = modules.get('balance')?.publicHandle;
        const result = handler
          ? await handler({request})
          : Response.json({error: 'Модуль не найден'}, {status: 404});
        return send(result.status, await result.text(), 'application/json');
      }
      if (url.pathname === '/api/signal/phone') {
        const handler = modules.get('signal')?.publicHandle;
        const result = handler
          ? await handler({request})
          : Response.json({error: 'Гермес не установлен'}, {status: 404});
        return send(result.status, await result.text(), 'application/json');
      }
      if (url.pathname.startsWith('/api/wave/phone/')) {
        const handler = modules.get('wave')?.publicHandle;
        const result = handler
          ? await handler({request, path: url.pathname.slice('/api/wave/phone'.length)})
          : new Response(null, {status: 404});
        for (const [key, value] of result.headers) response.setHeader(key, value);
        response.statusCode = result.status;
        if (!result.body || request.method === 'HEAD') return response.end();
        const stream = Readable.fromWeb(result.body);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        stream.pipe(response);
        return;
      }
      if (url.pathname === '/api/storage/phone') {
        const handler = modules.get('storage')?.publicHandle;
        const result = handler
          ? await handler({request})
          : Response.json({error: 'Модуль не найден'}, {status: 404});
        return send(result.status, await result.text(), 'application/json');
      }
      if (url.pathname === '/api/rhythm/sync') {
        const handler = modules.get('rhythm')?.publicHandle;
        const result = handler
          ? await handler({request})
          : new Response('Не найдено', {status: 404});
        if (result.headers.get('Content-Type') === 'application/x-ndjson') {
          response.writeHead(result.status, Object.fromEntries(result.headers));
          response.flushHeaders();
          const stream = Readable.fromWeb(result.body);
          stream.on('error', () => response.destroy());
          response.on('close', () => stream.destroy());
          stream.pipe(response);
          return;
        }
        if (result.headers.has('Retry-After'))
          response.setHeader('Retry-After', result.headers.get('Retry-After'));
        return send(result.status, await result.text(), 'application/json');
      }
      const publicInstall = /^\/install\/([A-Za-z0-9_-]{43})\/(script|archive)$/.exec(url.pathname);
      if (publicInstall && ['GET', 'HEAD'].includes(request.method)) {
        const handler = modules.get('projects')?.publicHandle;
        const result = handler
          ? await handler({
              token: publicInstall[1],
              action: publicInstall[2],
              method: request.method,
              origin: config.origin
            })
          : new Response('Не найдено', {status: 404});
        for (const [key, value] of result.headers) response.setHeader(key, value);
        response.statusCode = result.status;
        if (!result.body || request.method === 'HEAD') return response.end();
        const stream = Readable.fromWeb(result.body);
        stream.on('error', () => response.destroy());
        response.on('close', () => stream.destroy());
        return stream.pipe(response);
      }
      const token = cookie(request, cookieName);
      const authenticated = sessions.valid(token, security.state.epoch);
      const agent = String(request.headers['user-agent'] || '').slice(0, 300);
      const address = trustProxy
        ? String(request.headers['x-forwarded-for'] ?? request.socket.remoteAddress)
            .split(',')[0]
            .trim()
        : request.socket.remoteAddress;
      const pending = cookie(request, pendingName);
      const json = (value, status = 200) => send(status, JSON.stringify(value), 'application/json');
      const readJSON = () => parseJSON(request, 32768);
      const pendingCookie = (value, age) =>
        `${pendingName}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
      const issueSession = (recovery = false) => {
        sessions.revoke(token);
        const next = sessions.create(
          {agent, ip: isIP(address) ? address : '', recovery},
          security.state.ttl,
          security.state.epoch
        );
        response.setHeader('Set-Cookie', [
          sessionCookie(next, security.state.ttl),
          pendingCookie('', 0)
        ]);
      };
      const completeLogin = (method, recovery = false) => {
        security.success(address);
        rememberIP(address);
        audit('security.hub.login_succeeded', address, 'method=' + method);
        issueSession(recovery);
      };
      if (authenticated) sessions.touch(token, security.state.epoch);
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
        if (authenticated) return redirect('/');
        if (url.searchParams.has('factor')) {
          try {
            security.loginPending(pending, address, agent);
            return send(200, factorLogin());
          } catch {}
        }
        return send(
          200,
          login('', '', !!security.state.keys.length, !url.searchParams.has('password'))
        );
      }
      if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        if (!request.headers['content-type']?.startsWith('application/x-www-form-urlencoded'))
          return send(
            415,
            login('Неверный формат запроса.', '', !!security.state.keys.length, false)
          );
        const fields = new URLSearchParams(await body(request));
        const username = fields.get('username') ?? '',
          password = fields.get('password') ?? '';
        let valid;
        try {
          valid = await security.password(username, password, address);
        } catch (e) {
          if (e.status !== 429) throw e;
          response.setHeader('Retry-After', '300');
          return send(429, login(e.message, '', !!security.state.keys.length, false));
        }
        if (!valid) {
          audit('security.hub.login_failed', address);
          return send(
            401,
            login('Неверный логин или пароль.', username, !!security.state.keys.length, false)
          );
        }
        if (security.state.keys.length) {
          if (pending) security.pending.delete(createHash('sha256').update(pending).digest('hex'));
          const nextPending = security.beginLogin(address, agent);
          sessions.revoke(token);
          response.setHeader('Set-Cookie', [sessionCookie('', 0), pendingCookie(nextPending, 300)]);
          return redirect('/login?factor=1');
        }
        completeLogin('password');
        return redirect('/');
      }
      if (url.pathname.startsWith('/api/auth/passkey/') && request.method === 'POST') {
        const data = await readJSON();
        if (!security.state.keys.length) return json({error: 'Ключ доступа не настроен.'}, 404);
        if (url.pathname === '/api/auth/passkey/options') {
          security.limit(address);
          if (pending) security.pending.delete(createHash('sha256').update(pending).digest('hex'));
          const next = security.beginLogin(address, agent, 'passkey');
          const options = security.challenge('passwordless', next);
          options.publicKey.allowCredentials = [];
          response.setHeader('Set-Cookie', pendingCookie(next, 300));
          return json(options);
        }
        if (url.pathname !== '/api/auth/passkey/verify') return json({error: 'Не найдено'}, 404);
        security.loginPending(pending, address, agent, false, 'passkey');
        security.limit(address);
        try {
          if (!data.credential?.response?.userHandle)
            throw Object.assign(new Error('Ключ не подтвердил аккаунт.'), {status: 401});
          security.assertion(data.id, 'passwordless', pending, data.credential);
        } catch (e) {
          audit('security.hub.login_failed', address, 'passkey=failed');
          throw e;
        }
        security.loginPending(pending, address, agent, true, 'passkey');
        completeLogin('passkey');
        return json({ok: true});
      }
      if (url.pathname.startsWith('/api/auth/factor/') && request.method === 'POST') {
        security.loginPending(pending, address, agent);
        const data = await readJSON();
        security.loginPending(pending, address, agent);
        if (url.pathname.endsWith('/options')) return json(security.challenge('login', pending));
        security.limit(address);
        try {
          if (url.pathname.endsWith('/verify'))
            security.assertion(data.id, 'login', pending, data.credential);
          else if (url.pathname.endsWith('/recovery')) {
            security.recovery(data.code);
            audit('security.hub.recovery_used', address);
          } else return json({error: 'Не найдено'}, 404);
        } catch (e) {
          audit('security.hub.login_failed', address, 'factor=failed');
          throw e;
        }
        security.pending.delete(createHash('sha256').update(pending).digest('hex'));
        completeLogin(
          url.pathname.endsWith('/recovery') ? 'recovery' : 'passkey',
          url.pathname.endsWith('/recovery')
        );
        return json({ok: true});
      }
      if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        sessions.revoke(token);
        if (pending) security.pending.delete(createHash('sha256').update(pending).digest('hex'));
        response.setHeader('Set-Cookie', [sessionCookie('', 0), pendingCookie('', 0)]);
        return redirect('/login');
      }
      if (!authenticated) {
        if (url.pathname.startsWith('/api/') || !['GET', 'HEAD'].includes(request.method))
          return send(401, JSON.stringify({error: 'Требуется вход'}), 'application/json');
        return redirect('/login');
      }
      if (url.pathname === '/api/security' && request.method === 'GET') {
        return json({
          ttl: security.state.ttl,
          enabled: !!security.state.keys.length,
          recoveryLeft: security.state.recovery.length,
          recovered: sessions.get(token, security.state.epoch)?.recovery === true,
          keys: security.state.keys.map(({id, label, created, used}) => ({
            id,
            label,
            created,
            used
          })),
          sessions: sessions.list(token, security.state.epoch)
        });
      }
      if (url.pathname.startsWith('/api/security/') && request.method === 'POST') {
        const data = await readJSON(),
          route = url.pathname.slice('/api/security/'.length);
        if (!sessions.valid(token, security.state.epoch))
          return json({error: 'Войди заново.'}, 401);
        const actions = ['password', 'ttl', 'add-key', 'remove-key', 'recovery'];
        if (route === 'authorize') {
          if (!actions.includes(data.action)) return json({error: 'Неизвестное действие.'}, 400);
          if (!(await security.password(config.username, data.password, address))) {
            audit('security.hub.reauth_failed', address);
            return json({error: 'Неверный текущий пароль.'}, 401);
          }
          if (!sessions.valid(token, security.state.epoch))
            return json({error: 'Войди заново.'}, 401);
          if (security.state.keys.length && !sessions.get(token, security.state.epoch).recovery)
            return json(security.challenge('authorize', token, {action: data.action}));
          return json({grant: security.grant(token, data.action)});
        }
        if (route === 'authorize/verify') {
          security.limit(address);
          try {
            const grant = security.assertion(data.id, 'authorize', token, data.credential);
            return json({grant: security.grant(token, grant.action)});
          } catch (e) {
            audit('security.hub.reauth_failed', address);
            throw e;
          }
        }
        if (route === 'sessions/revoke') {
          if (typeof data.id !== 'string' || !/^[a-f0-9]{64}$/.test(data.id))
            return json({error: 'Неверная сессия.'}, 400);
          const current = sessions
            .list(token, security.state.epoch)
            .find((s) => s.id === data.id)?.current;
          if (sessions.revokeId(data.id)) audit('security.hub.session_revoked', address);
          if (current) response.setHeader('Set-Cookie', sessionCookie('', 0));
          return json({ok: true, logout: !!current});
        }
        if (route === 'sessions/others') {
          sessions.others(token);
          audit('security.hub.sessions_revoked', address);
          return json({ok: true});
        }
        if (route === 'password') {
          security.consumeGrant(data.grant, token, 'password');
          await security.changePassword(data.password, security.state.epoch, () =>
            sessions.valid(token, security.state.epoch)
          );
          issueSession(
            sessions.entries.get(createHash('sha256').update(token).digest('hex'))?.recovery ===
              true
          );
          audit('security.hub.password_changed', address);
          return json({ok: true});
        }
        if (route === 'ttl') {
          security.consumeGrant(data.grant, token, 'ttl');
          if (![3600, 86400, 604800, 2592000].includes(data.ttl))
            return json({error: 'Выбери срок из списка.'}, 400);
          security.save({...security.state, ttl: data.ttl});
          sessions.shorten(data.ttl);
          const remaining = Math.max(
            0,
            Math.floor(
              ((sessions.get(token, security.state.epoch)?.expires || 0) - Date.now()) / 1000
            )
          );
          response.setHeader('Set-Cookie', sessionCookie(token, remaining));
          audit('security.hub.ttl_changed', address);
          return json({ok: true, logout: remaining === 0});
        }
        if (route === 'keys/options') {
          security.consumeGrant(data.grant, token, 'add-key');
          return json(security.registration(token));
        }
        if (route === 'keys/register') {
          const result = security.addKey(data.id, token, data.credential, data.label);
          if (result.first) issueSession();
          audit('security.hub.passkey_added', address);
          return json({ok: true, codes: result.codes});
        }
        if (route === 'keys/remove') {
          security.consumeGrant(data.grant, token, 'remove-key');
          if (!security.state.keys.some((k) => k.id === data.id))
            return json({error: 'Ключ не найден.'}, 404);
          const keys = security.state.keys.filter((k) => k.id !== data.id);
          security.save({
            ...security.state,
            keys,
            recovery: keys.length ? security.state.recovery : [],
            epoch: security.state.epoch + 1
          });
          issueSession();
          audit(
            keys.length ? 'security.hub.passkey_removed' : 'security.hub.factor_disabled',
            address
          );
          return json({ok: true});
        }
        if (route === 'recovery') {
          security.consumeGrant(data.grant, token, 'recovery');
          if (!security.state.keys.length)
            return json({error: 'Сначала добавь ключ доступа.'}, 400);
          const codes = security.codes();
          security.save({
            ...security.state,
            recovery: codes.map((code) => createHash('sha256').update(code).digest('hex'))
          });
          audit('security.hub.recovery_changed', address);
          return json({codes});
        }
        return json({error: 'Не найдено'}, 404);
      }
      if(url.pathname==='/api/servers'||url.pathname.startsWith('/api/servers/')) {
        const action=url.pathname.slice('/api/servers'.length),id=url.searchParams.get('server');
        if(request.method==='GET'){
          if(!action)return json({servers:agents.list()});
          if(action==='/diagnostics')return json(diagnostics.status(id||'all',url.searchParams.get('hours')||24));
          if(action==='/report'){
            const report=diagnostics.report(id||'all',url.searchParams.get('hours')||24);
            response.setHeader('Content-Disposition','attachment; filename="nexus404-server-report-'+new Date().toISOString().slice(0,10)+'.txt"');
            return send(200,report,'text/plain');
          }
          if(action==='/events')return json({events:agents.events(id)});
          if(action==='/metrics')return json(agents.metrics(id));
          if(action==='/history')return json(agents.history(id,url.searchParams.get('hours')));
          return json({error:'Не найдено'},404);
        }
        if(request.method!=='POST')return json({error:'Метод не поддержан'},405);
        const data=await readJSON();if(!sessions.valid(token,security.state.epoch))return json({error:'Требуется вход'},401);
        if(action==='/registration'){if(!secure)return json({error:'Для агентов нужен HTTPS'},400);return json(agents.issue(data.name));}
        if(action==='/settings')return json(agents.configure(data.id,data),202);
        if(action==='/revoke')return json(agents.revoke(data.id));
        return json({error:'Не найдено'},404);
      }
      if (url.pathname === '/api/maintenance') {
        if (request.method === 'GET') return json(maintenance.status());
        if (request.method !== 'POST') return json({error:'Метод не поддержан'},405);
        const value=await readJSON();
        if(!sessions.valid(token,security.state.epoch))return json({error:'Требуется вход'},401);
        const result=maintenance.save(value);
        audit('system.maintenance.requested',address);
        return json(result,202);
      }
      const embedded = url.searchParams.get('_view') === '1' || request.headers['sec-fetch-dest'] === 'iframe';
      if (modules.has('wave')) {
        response.setHeader(
          'Content-Security-Policy',
          CSP.replace("frame-ancestors 'none'", "frame-ancestors 'self'")
        );
        response.setHeader('X-Frame-Options', 'SAMEORIGIN');
        const pageRoute = /^\/(?:$|(?:settings|status|search)\/?$|modules\/[a-z-]+\/?$)/.test(
          url.pathname
        );
        if (
          pageRoute &&
          request.method === 'GET' &&
          url.searchParams.get('_view') !== '1' &&
          request.headers['sec-fetch-dest'] !== 'iframe'
        )
          return send(200, playerShell(url.href, {username:config.username, modules:[...modules.values()]}));
      }
      if (url.pathname === '/' && ['GET', 'HEAD'].includes(request.method))
        return send(200, dashboard(config.username, overview.ordered(url.searchParams.get('group') && url.searchParams.get('group')!=='overview'), url.searchParams.get('group'), embedded));
      if (
        ['/settings', '/settings/'].includes(url.pathname) &&
        ['GET', 'HEAD'].includes(request.method)
      )
        return send(
          200,
          settingsPage(config.username, [...modules.values()], url.searchParams.get('module'), embedded)
        );
      if (
        ['/status', '/status/', '/search', '/search/'].includes(url.pathname) &&
        request.method === 'GET'
      )
        return send(
          200,
          modulePage({
            embedded,
            username: config.username,
            title: url.pathname.startsWith('/status') ? 'Состояние хаба' : 'Общий поиск',
            content: url.pathname.startsWith('/status') ? statusView : searchView
          })
        );
      if (url.pathname === '/api/activity' && request.method === 'GET')
        return json(
          activity.snapshot(url.searchParams.get('days'), url.searchParams.get('source'))
        );
      if (url.pathname === '/api/activity' && request.method === 'POST') {
        const value = await parseJSON(request, 8192);
        if (!sessions.valid(token, security.state.epoch))
          return json({error: 'Сессия завершена'}, 401);
        if (!modules.has(value.source)) return json({error: 'Модуль не установлен'}, 404);
        try {return json(activity.record(value));}
        catch (error) {
          if ([400,409,422].includes(error.status)) return json({error:error.message,rejected:true},error.status);
          throw error;
        }
      }
      if (url.pathname === '/api/notices' && request.method === 'POST') {
        const value = await parseJSON(request,4096);
        if (!sessions.valid(token, security.state.epoch)) return json({error:'Требуется вход'},401);
        if (!value || (value.active !== undefined && typeof value.active !== 'boolean') || !Object.hasOwn(noticeCodes,value.code) || (!modules.has(value.source) && value.source !== 'hub'))
          return json({error:'Неизвестное оповещение'},400);
        // Only fixed diagnostic codes are accepted: no tokens, URLs or raw error messages.
        try { notices.report(value.source, modules.get(value.source)?.title || 'NEXUS404', value.code, value.active !== false); }
        catch { return json({error:'Оповещение не сохранено'},503); }
        return json({ok:true});
      }
      if (url.pathname === '/api/home/overview' && request.method === 'GET') {
        const value = await overview.home(activity, url.searchParams.get('group'));
        if (!sessions.valid(token, security.state.epoch)) return json({error:'Сессия завершена'},401);
        for (const id of overview.ordered(true).map(m=>m.id)) {
          if (id in value || value.errors.includes(id))
            reportNotice(id, 'home', value.errors.includes(id) || value[id]?.available === false || value[id]?.stale === true);
        }
        return json(value);
      }
      if (url.pathname === '/api/home' && request.method === 'GET')
        return json({
          config: overview.config(),
          modules: overview.ordered(true).map((m) => ({id: m.id, title: m.title}))
        });
      if (url.pathname === '/api/home' && request.method === 'POST') {
        const value = await readJSON();
        if (!sessions.valid(token, security.state.epoch))
          return json({error: 'Сессия завершена'}, 401);
        return json(overview.save(value));
      }
      if (url.pathname === '/api/search' && request.method === 'GET')
        return json(overview.search(url.searchParams.get('q')));
      if (url.pathname === '/api/status' && request.method === 'GET')
        return json(overview.status(JSON.parse(dashboardCache.read()), hubVersion));
      if (url.pathname === '/api/modules' && request.method === 'GET')
        return send(200, dashboardCache.read(), 'application/json');
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
          user: {username: config.username, embedded},
          authorized: () => sessions.valid(token, security.state.epoch),
          signal: controller.signal,
          modules,
          activity,
          agents,
          origin: config.origin
        });
        if (!(result instanceof Response)) throw new Error('Invalid module response');
        if (result.ok && !['GET', 'HEAD'].includes(request.method)) {
          dashboardCache.invalidate(match[1]);
          if (
            match[1] === 'storage' &&
            ['/api/modules/delete', '/api/modules/delete-many'].includes(match[2])
          )
            for (const id of modules.keys()) dashboardCache.invalidate(id);
        }
        const cacheable =
          request.method === 'GET' &&
          result.status === 200 &&
          ((/^\/(?:cover|artist-photo)\//.test(match[2]) &&
            /^image\/(?:jpeg|png|webp|avif)$/.test(
              result.headers.get('content-type')?.split(';')[0] ?? ''
            )) ||
            (/^\/[a-z0-9-]+\.(?:css|js)$/.test(match[2]) &&
              /^(?:text\/(?:css|javascript)|application\/javascript)(?:;|$)/.test(
                result.headers.get('content-type') ?? ''
              )));
        if (cacheable) {
          const data = Buffer.from(await result.arrayBuffer());
          const etag =
            '"' +
            createHash('sha256').update(authIdentity(config)).update(data).digest('hex') +
            '"';
          response.setHeader('Cache-Control', 'private, no-cache');
          response.setHeader('Vary', 'Cookie');
          response.setHeader('ETag', etag);
          const tags = (request.headers['if-none-match'] ?? '')
            .split(',')
            .map((value) => value.trim().replace(/^W\//, ''));
          if (tags.includes(etag) || tags.includes('*')) {
            response.writeHead(304);
            response.end();
          } else {
            response.writeHead(200, {
              'Content-Type': result.headers.get('content-type'),
              'Content-Length': data.length
            });
            response.end(data);
          }
          return;
        }
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
      if (!response.headersSent) {
        if (error.status === 429) response.setHeader('Retry-After', '300');
        if (
          request.url?.startsWith('/api/security') ||
          request.url?.startsWith('/api/auth/factor/') ||
          request.url?.startsWith('/api/auth/passkey/')
        )
          send(
            error.status ?? 500,
            JSON.stringify({error: error.status ? error.message : 'Не удалось выполнить запрос.'}),
            'application/json'
          );
        else
          send(
            error.status ?? 500,
            error.status === 413 ? 'Слишком большой запрос' : 'Не удалось выполнить запрос'
          );
      } else response.destroy();
      if (error.status !== 413) console.error('Request failed:', request.method);
    }
  });
  server.once('listening', () => {
    void dashboardCache.start();
  });
  server.once('close', () => {
    clearInterval(diagnosticsTimer);diagnostics.close();
    clearInterval(agentSweep);agents.close();
    dashboardCache.close();
    overview.close();
    activity.close();
  });
  server.requestTimeout = 300000;
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
    dashboardFile: path.join(process.env.DATA_DIR ?? '/app/data', 'dashboard.json'),
    trustProxy: process.env.TRUST_PROXY === '1',
    auditFile: path.join(process.env.DATA_DIR ?? '/app/data', 'auth-events.jsonl')
  });
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, process.env.HOST ?? '0.0.0.0', () =>
    console.log(`NEXUS404 listening on ${port}; modules: ${modules.size}`)
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => process.exit(1), 25000);
    app.close();
    await Promise.allSettled(
      [...modules.values()].map((module) => Promise.resolve().then(() => module.close?.()))
    );
    app.closeAllConnections();
    clearTimeout(deadline);
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error('Cannot start: check auth, data and modules.');
    process.exit(1);
  });
