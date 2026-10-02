import {companion} from '../../src/companion.mjs';
import {readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {Rhythm, fail} from './store.mjs';
import {Reports} from './reports.mjs';
import {dayName} from './summary.mjs';
const assetsHTML = `<link rel="stylesheet" href="/modules/rhythm/rhythm.css"><script src="/modules/rhythm/rhythm.js" defer></script>`;
const html = `${assetsHTML}<section id="rhythm"><div class="rt-toolbar"><input type="date" id="rtDate" aria-label="Дата"><button id="rtRefresh">Обновить</button><a id="rtExport" download>Скачать измерения</a><button id="rtReport">Сформировать отчёт</button></div><p id="rtStatus" role="status"></p><div id="rtCards"></div><p id="rtCoverage"></p><section class="rt-panel"><h2>Суточный отчёт</h2><p id="rtReportState"></p><button id="rtConfirmSleep" hidden>Подтвердить завершение сна</button><div id="rtReportText"></div><button id="rtRetry" hidden>Повторить платный запрос</button></section></section>`;
export const settings = {
  title: 'Асклепий',
  content: `${assetsHTML}<section id="rhythmSettings"><p id="rtStatus" role="status"></p><section class="rt-panel"><h3>Band 11 · Геката 0.1.38</h3><p>Создай ключ ниже и сохрани в Геката → Band 11 → Настройки подключения вместе с HTTPS-адресом хаба. Подтверди сопряжение на телефоне и браслете.</p><p>Снимок: 5 минут · история: 15 минут · подробный сон, стресс и сводки тренировок: час, при поддержке формата. Отправка автоматическая; Android может задерживать работу. Полный экспорт всех данных не поддерживается.</p><p>Счётчик шагов не прибавляется к истории. Неизвестные стадии сна не угадываются. Перед включением автоматических отчётов проверь реальный сон. Huawei-аккаунт и Health Connect не нужны.</p></section><form id="rtConfig"><label>Часовой пояс <input id="rtZone" required placeholder="Europe/Moscow"></label><label><input id="rtAuto" type="checkbox"> Автоматические платные отчёты DeepSeek (до одного на дату)</label><p>Отправляется числовая сводка. Ключ и модель берутся из настроек Оракула. Отчёт доступен после завершённых суток, сна и последующей синхронизации.</p><button>Сохранить настройки</button></form><h3>Подключения источников</h3><p>Существующие ключи JSON-приёма можно отозвать. Ключ вставляется в Гекату → Асклепий → Настройки подключения. Создание ключа само по себе не запускает передачу.</p><button id="rtAdd">Создать ключ Гекаты</button><p id="rtToken" role="status"></p><div id="rtDevices"></div><h3>Источники измерений</h3><p>Меньшее число — выше приоритет при пересечениях. Сохранённая история остаётся доступна.</p><div id="rtSources"></div></section>`
};
export function createModule(directory, options = {}) {
  const store = new Rhythm(directory),
    reports = new Reports(store, options);
  let timer,
    busy = false;
  const counts = new Map();
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await reports.tick();
    } catch {
    } finally {
      busy = false;
    }
  };
  return {
    store,
    reports,
    start() {
      reports.recover();
      timer = setInterval(run, 60000);
      timer.unref();
    },
    close() {
      clearInterval(timer);
    },
    async summary() {
      const day = store.daily(dayName(Date.now(), store.config().zone));
      return {
        state: 'ok',
        items: [
          {label: 'Шаги', value: day.steps ?? 'Нет данных'},
          {label: 'Сон, мин', value: day.sleepMinutes ?? 'Нет данных'}
        ]
      };
    },
    async publicHandle({request}) {
      try {
        if (request.method !== 'POST' || request.headers.origin)
          throw fail('Метод недоступен', 405);
        const device = store.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
        const now = Date.now();
        for (const [id, v] of counts) if (now - v.start > 60000) counts.delete(id);
        const counter = counts.get(device.id) ?? {start: now, n: 0};
        if (++counter.n > 120) throw fail('Слишком много пакетов', 429);
        counts.set(device.id, counter);
        const data = await readJSON(request, 2 * 1024 * 1024);
        store.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
        if (data.type === 'hello')
          return Response.json({
            state: 'ready',
            companion: companion(),
            name: device.name,
            format: 'json',
            maxRecords: 500,
            bandSnapshot: true,
            bandExtended: true,
            bandMetrics: true
          });
        return Response.json(store.ingest(device, data));
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Ошибка приёма измерений'},
          {status: e.status ?? 500}
        );
      }
    },
    async handle({
      request,
      path: route,
      user,
      authorized = () => true,
      signal,
      searchParams = new URLSearchParams()
    }) {
      try {
        if (!authorized()) throw fail('Нужен вход', 401);
        if (request.method === 'GET') {
          if (route === '/')
            return new Response(
              modulePage({username: user.username, title: 'Асклепий', content: html}),
              {headers: {'Content-Type': 'text/html; charset=utf-8'}}
            );
          if (['/rhythm.js', '/rhythm.css'].includes(route))
            return new Response(fs.readFileSync(new URL('.' + route, import.meta.url)), {
              headers: {'Content-Type': route.endsWith('.js') ? 'text/javascript' : 'text/css'}
            });
          if (route === '/api/export' && request.method === 'GET') {
            const day = searchParams.get('day') || dayName(Date.now(), store.config().zone);
            return new Response(JSON.stringify(store.exportDay(day), null, 2), {
              headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': 'attachment; filename="asclepius-' + day + '.json"',
                'Cache-Control': 'private, no-store'
              }
            });
          }
          if (route === '/api')
            return Response.json({
              config: store.config(),
              devices: store.devices(),
              sources: store.sources(),
              day: store.daily(searchParams.get('day') || dayName(Date.now(), store.config().zone))
            });
        }
        if (request.method === 'POST') {
          const v = await readJSON(request, 2 * 1024 * 1024);
          if (!authorized()) throw fail('Сессия завершена', 401);
          if (route === '/api/config') return Response.json(store.configure(v));
          if (route === '/api/device') return Response.json(store.addDevice(v.name));
          if (route === '/api/revoke') {
            store.revoke(v.id);
            return Response.json({ok: true});
          }
          if (route === '/api/source') {
            store.priority(v.id, v.priority);
            return Response.json({ok: true});
          }
          if (route === '/api/sleep/confirm') return Response.json(store.confirmSleep(v.day));
          if (route === '/api/report') {
            const report = await reports.generate(v.day, v.retry === true);
            return Response.json(report);
          }
          if (route === '/api/import') {
            const device = store.devices().find((d) => d.id === v.device && !d.revoked);
            if (!device) throw fail('Выбери действующий источник');
            return Response.json(store.ingest(device, v));
          }
        }
        throw fail('Не найдено', 404);
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Ошибка «Асклепия»'},
          {status: e.status ?? 500}
        );
      }
    }
  };
}
const instance = createModule(path.join(process.env.DATA_DIR ?? '/app/data', 'rhythm'));
export const {handle, summary, start, close, publicHandle} = instance;
