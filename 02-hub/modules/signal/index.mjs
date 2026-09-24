import {validateSubscription as validateDevice} from '../../src/webpush.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomBytes} from 'node:crypto';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
const assets = new Map(
  ['signal.css', 'signal.js'].map((f) => ['/' + f, fs.readFileSync(new URL(f, import.meta.url))])
);
const categories = {
  resources: 'Ресурсы',
  services: 'Службы и сайт',
  security: 'Безопасность',
  maintenance: 'Обслуживание',
  recovery: 'Восстановление',
  summary: 'Ежедневная сводка'
};
const assetsHTML = `<link rel="stylesheet" href="/modules/signal/signal.css"><script src="/modules/signal/signal.js" defer></script>`;
const statusHTML = `<p id="signalStatus" class="signal-status" role="status" aria-live="polite">Подключение к «Сигналу»…</p>`;
const content = `${assetsHTML}${statusHTML}
<section class="signal-panel"><div class="signal-title"><h2>Журнал событий</h2><select id="eventFilter" aria-label="Фильтр событий"><option value="all">Все события</option><option value="critical">Критические</option><option value="warning">Предупреждения</option><option value="info">Информация</option></select></div><p id="activeCount" class="signal-small"></p><div id="signalEvents"><p class="signal-help">Ожидаем события…</p></div><button type="button" id="moreEvents" hidden>Показать ещё</button></section>`;
const settingsContent = `${assetsHTML}${statusHTML}<div class="signal-settings-grid">
<section class="signal-panel"><div class="signal-title"><h2>Этот телефон</h2><span id="pushState">проверяем</span></div><p class="signal-help" id="pushHelp">Подключи уведомления и разреши их показ в браузере.</p><label class="signal-label" for="deviceName">Имя устройства</label><input id="deviceName" maxlength="60" value="Мой телефон" autocomplete="off"><div class="signal-actions"><button id="enablePush" type="button">Подключить уведомления</button><button id="testPush" type="button" disabled>Проверить</button><button id="disablePush" type="button" disabled>Отключить</button></div><p class="signal-small">Подписка действует при закрытой PWA и после выхода из хаба.</p></section>
<section class="signal-panel"><div class="signal-title"><h2>Что присылать</h2><span>на все устройства</span></div><form id="signalSettings"><div class="signal-options">${Object.entries(
  categories
)
  .map(
    ([id, label]) =>
      `<label><input type="checkbox" name="${id}" checked><span>${label}</span></label>`
  )
  .join(
    ''
  )}</div><div class="signal-time"><label for="dailyTime">Сводка · время сервера</label><input type="time" id="dailyTime" value="09:00" required></div><label class="signal-detail"><input type="checkbox" id="pushDetails"><span>Показывать подробности на экране блокировки</span></label><button type="submit">Сохранить</button></form></section>
<section class="signal-panel signal-devices-panel"><div class="signal-title"><h2>Устройства</h2><span id="deviceCount">0</span></div><div id="signalDevices"><p class="signal-help">Устройства ещё не подключены.</p></div></section></div>
`;
export const settings = {title: 'Уведомления', content: settingsContent};

const digest = (value) => createHash('sha256').update(value).digest('hex');
const readJSON = (file, fallback, limit = 2 * 1024 * 1024) => {
  try {
    if (fs.statSync(file).size > limit) throw new Error('Файл слишком большой');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return fallback;
    throw e;
  }
};
export {validateSubscription as validateDevice} from '../../src/webpush.mjs';
export function createHandler({
  file = path.join(process.env.DATA_DIR ?? '/app/data', 'signal.json'),
  feed = process.env.SIGNAL_FEED ?? '/app/signal/feed.json',
  publicFile = process.env.SIGNAL_PUBLIC ?? '/app/signal/public.json',
  authFile = process.env.AUTH_FILE ?? '/app/config/auth.json',
  now = Date.now
} = {}) {
  const defaults = () => ({
    categories: Object.fromEntries(Object.keys(categories).map((k) => [k, true])),
    dailyTime: '09:00',
    detailOnLockScreen: false,
    devices: []
  });
  function load() {
    const auth = readJSON(authFile, {}),
      identity = digest((auth.username ?? '') + ':' + (auth.salt ?? '') + ':' + (auth.hash ?? ''));
    const saved = readJSON(file, null, 256 * 1024);
    return saved?.identity === identity ? saved : {...defaults(), identity};
  }
  function save(data) {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    const temp = file + '.' + randomBytes(6).toString('hex');
    try {
      fs.writeFileSync(temp, JSON.stringify(data), {mode: 0o600, flag: 'wx'});
      fs.renameSync(temp, file);
    } finally {
      fs.rmSync(temp, {force: true});
    }
  }
  return async ({request, path: route, user}) => {
    if (['GET', 'HEAD'].includes(request.method)) {
      if (route === '/settings/' || route === '/settings')
        return new Response(null, {status: 303, headers: {Location: '/settings/?module=signal'}});
      if (route === '/')
        return new Response(
          modulePage({
            username: user.username,
            title: 'Сигнал',
            content
          }),
          {
            headers: {'Content-Type': 'text/html; charset=utf-8'}
          }
        );
      if (assets.has(route))
        return new Response(assets.get(route), {
          headers: {
            'Content-Type': route.endsWith('.css')
              ? 'text/css; charset=utf-8'
              : 'text/javascript; charset=utf-8'
          }
        });
      if (route === '/api') {
        const settings = load(),
          data = readJSON(feed, {updatedAt: 0, events: [], active: [], devices: []}),
          key = readJSON(publicFile, {});
        return Response.json({
          ...data,
          stale:
            !Number.isFinite(data.updatedAt) ||
            now() - data.updatedAt > 90000 ||
            now() - data.updatedAt < -10000,
          settings: {
            categories: settings.categories,
            dailyTime: settings.dailyTime,
            detailOnLockScreen: settings.detailOnLockScreen
          },
          devices: settings.devices.map((d) => ({
            id: d.id,
            name: d.name,
            ...(data.devices.find((v) => v.id === d.id) ?? {})
          })),
          publicKey: key.publicKey ?? null
        });
      }
      return new Response('Не найдено', {status: 404});
    }
    if (
      request.method !== 'POST' ||
      !['/subscribe', '/unsubscribe', '/settings', '/test'].includes(route)
    )
      return new Response('Метод не поддерживается', {status: 405});
    if (!request.headers['content-type']?.startsWith('application/json'))
      return Response.json({error: 'Нужен JSON'}, {status: 415});
    try {
      const input = JSON.parse(await body(request, 16384)),
        settings = load();
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('Нужен JSON-объект');
      if (route === '/subscribe') {
        const subscription = validateDevice(input.subscription),
          id = digest(subscription.endpoint).slice(0, 32);
        if (settings.devices.length >= 20 && !settings.devices.some((d) => d.id === id))
          throw new Error('Можно подключить до 20 устройств');
        settings.devices = settings.devices.filter((d) => d.id !== id);
        settings.devices.push({
          id,
          name: String(input.name ?? 'Устройство')
            .replace(/[\x00-\x1f\x7f]/g, ' ')
            .slice(0, 60),
          subscription,
          updatedAt: now(),
          testAt: 0
        });
        save(settings);
        return Response.json({ok: true, id});
      }
      if (route === '/unsubscribe') {
        settings.devices = settings.devices.filter((d) => d.id !== input.id);
      }
      if (route === '/test') {
        const d = settings.devices.find((d) => d.id === input.id);
        if (!d) throw new Error('Устройство не подключено');
        if (d.testAt && now() - d.testAt < 30000)
          return Response.json({error: 'Повтори проверку через 30 секунд'}, {status: 429});
        d.testAt = now();
      }
      if (route === '/settings') {
        for (const key of Object.keys(categories)) {
          if (typeof input.categories?.[key] !== 'boolean')
            throw new Error('Некорректные категории');
        }
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(input.dailyTime ?? ''))
          throw new Error('Некорректное время');
        settings.categories = Object.fromEntries(
          Object.keys(categories).map((k) => [k, input.categories[k]])
        );
        settings.dailyTime = input.dailyTime;
        settings.detailOnLockScreen = input.detailOnLockScreen === true;
      }
      save(settings);
      return Response.json({ok: true});
    } catch (e) {
      return Response.json(
        {
          error:
            e.status === 413
              ? 'Запрос слишком большой'
              : e instanceof SyntaxError
                ? 'Некорректный JSON'
                : e.message
        },
        {status: e.status ?? 400}
      );
    }
  };
}
export const handle = createHandler();

export function createSummary(handler) {
  return async () => {
    const response = await handler({request: {method: 'GET'}, path: '/api'});
    if (!response.ok) return {state: 'stale', items: []};
    const data = await response.json();
    return {
      state: data.stale ? 'stale' : data.active.length ? 'warning' : 'ok',
      items: [
        {label: 'Тревоги', value: String(data.active.length)},
        {label: 'Устройства', value: String(data.devices.filter((d) => !d.expired).length)}
      ]
    };
  };
}
export const summary = createSummary(handle);
