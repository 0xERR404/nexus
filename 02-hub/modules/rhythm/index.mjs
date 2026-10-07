import {companion} from '../../src/companion.mjs';
import {readJSON} from '../../src/input.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {Rhythm, fail} from './store.mjs';
import {Refresh} from './refresh.mjs';
import {Reports} from './reports.mjs';
import {WakeReports} from './wake.mjs';
import {dayName} from './summary.mjs';
const assetsHTML = `<link rel="stylesheet" href="/modules/rhythm/rhythm.css"><script src="/modules/rhythm/rhythm.js" defer></script>`;
const html = `${assetsHTML}<section id="rhythm">
<div class="rt-toolbar"><input type="date" id="rtDate" aria-label="Дата"><button id="rtRefresh">Обновить</button><a id="rtExport" download>Скачать измерения</a></div>
<p id="rtStatus" role="status"></p><p id="rtSyncState" role="status"></p>
<section class="rt-panel rt-summary"><div class="rt-section-head"><h2>Сводка за день</h2><span id="rtZoneLabel" class="rt-meta"></span></div><div id="rtCards"></div><details class="rt-coverage"><summary>Полнота данных</summary><p id="rtCoverage"></p></details></section>
<section class="rt-panel rt-ai"><div class="rt-section-head"><h2>Отчёт после пробуждения</h2><span id="rtWakeBadge" class="rt-badge">Автоматически</span></div><p id="rtWakePeriod" class="rt-meta"></p><p id="rtWakeState" role="status"></p><div id="rtWakeText"></div><div class="rt-toolbar"><button id="rtWakeGenerate">Сформировать отчёт</button><button id="rtWakeRedo" hidden>Пересоздать отчёт</button></div><p id="rtWakeAuto" class="rt-meta"></p><details id="rtWakeVersions" hidden><summary>Предыдущие версии</summary><div id="rtWakeArchive"></div></details></section>
<section class="rt-panel rt-ai"><details><summary>Предварительный разбор по календарной дате</summary><div class="rt-section-head"><h2>Разбор ИИ</h2><span class="rt-badge">Предварительная</span></div><p class="rt-meta">Что означают показатели, на что обратить внимание и что можно сделать. По доступным данным за выбранную дату, с учётом пропусков.</p><p id="rtReportState" role="status"></p><div id="rtReportText"></div><div class="rt-toolbar"><button id="rtReport">Отправить в ИИ</button><button id="rtRetry" hidden>Повторить запрос ИИ</button><a id="rtAiSetup" href="/settings/?module=chat" hidden>Настроить Сократ</a></div><p class="rt-meta">В DeepSeek передаётся числовая сводка. Запрос оплачивается по тарифу провайдера.</p>
<details id="rtDailyReport"><summary>Прежние итоги по календарным суткам</summary><p id="rtDailyState"></p><div id="rtDailyText"></div><div class="rt-toolbar"><button id="rtDailyGenerate">Сформировать суточный итог</button><button id="rtDailyRetry" hidden>Повторить платный запрос</button><button id="rtConfirmSleep" hidden>Подтвердить завершение сна</button></div><p id="rtAutoState" class="rt-meta"></p><a href="/settings/?module=rhythm">Настройки отчётов</a></details></details></section>
<section class="rt-panel"><details><summary>Все полученные записи</summary><p class="rt-meta">Принятые хабом записи за выбранную дату. Отсутствие записей не означает нулевое значение.</p><button id="rtShowData">Показать записи</button><div id="rtData"></div></details></section></section>`;
export const settings = {
  title: 'Асклепий',
  content: `${assetsHTML}<section id="rhythmSettings"><p id="rtStatus" role="status"></p><div class="settings-rhythm-grid"><section class="settings-group"><h2>Отчёты</h2><form id="rtConfig"><label>Часовой пояс<input id="rtZone" required placeholder="Europe/Moscow"></label><label><input id="rtAuto" type="checkbox">Отчёт DeepSeek после пробуждения</label><p>Числовая сводка отправляется в DeepSeek. Запрос платный; ключ и модель — из настроек Сократа.</p><details><summary>Как формируется отчёт</summary><p>Один отчёт на дату пробуждения, за период от предыдущего пробуждения до текущего. Отправка начинается после получения границ сна от браслета. При нескольких периодах выбирается самый длинный доступный, с приоритетом подробного сна. Новые данные не меняют готовый отчёт. Повтор — вручную с вводом ПЕРЕСОЗДАТЬ, прежняя версия сохраняется. После включения автоматически обрабатываются только будущие пробуждения; прошлые даты доступны вручную.</p></details><button type="submit">Сохранить</button></form></section><section class="settings-group"><h2>Талос</h2><p>Создай ключ и сохрани его вместе с адресом хаба в Талосе: Асклепий → Настройки. Затем подтверди сопряжение на телефоне и браслете.</p><button id="rtAdd" type="button">Создать ключ</button><p id="rtToken" role="status"></p><div id="rtDevices"></div></section><section class="settings-group settings-wide"><h2>Источники измерений</h2><p>Меньшее число — выше приоритет при пересечениях. Сохранённая история остаётся доступна.</p><div id="rtSources"></div></section><details class="settings-group settings-wide"><summary>Передача данных</summary><p>Создание ключа само по себе не запускает передачу. Существующие ключи JSON-приёма можно отозвать.</p><p>Экономия в Талосе: снимок каждые 15 минут, история — 30 минут, подробные файлы — 2 часа. Обычный режим — снимок: 5 минут · история: 15 минут · файлы: час, при поддержке формата. Открытие Асклепия запрашивает свежий обмен, если Талос на связи. Отправка автоматическая; Android может задерживать работу. Полный экспорт всех данных не поддерживается.</p><p>Счётчик шагов не прибавляется к истории. Неизвестные стадии сна не угадываются. Перед включением автоматических отчётов проверь реальный сон. Huawei-аккаунт и Health Connect не нужны.</p></details></div></section>`
};

export function createModule(directory, options = {}) {
  const store = new Rhythm(directory),
    reports = new Reports(store, options);
  const refresh = new Refresh(store);
  let timer,
    busy = false;
  const counts = new Map();
  const clock = options.now ?? Date.now;
  const wake = new WakeReports(store, reports, clock);
  let pending;
  const run = async () => {
    if (busy || pending) return;
    busy = true;
    try {
      await wake.tick();
    } catch {
    } finally {
      busy = false;
    }
  };
  return {
    store,
    reports,
    wake,
    start() {
      reports.recover();
      wake.recover();
      void run();
      timer = setInterval(run, 60000);
      timer.unref();
    },
    close() {
      clearInterval(timer);
      clearTimeout(pending);
      refresh.close();
    },
    home() {
      const day=store.daily(dayName(Date.now(),store.config().zone));
      const value=(v,unit='')=>Number.isFinite(v)?v.toLocaleString('ru-RU')+unit:'Нет данных';
      return {note:'Сохранённые измерения за '+day.day+'. Наличие записей не подтверждает полноту чтения браслета.',items:[
        {title:'Шаги · история',detail:value(day.steps),href:'/modules/rhythm/'},
        {title:'Шаги · снимок браслета',detail:value(day.band?.steps),href:'/modules/rhythm/'},
        {title:'Сон',detail:value(day.sleepMinutes,' мин')+(day.sleepMinutes!==null?(day.sleepComplete?' · полнота отмечена источником':' · неполные данные'):''),href:'/modules/rhythm/'},
        {title:'Пульс · средний',detail:value(day.heart?.average,' уд/мин'),href:'/modules/rhythm/'},
        {title:'SpO₂ · среднее',detail:value(day.spo2?.average,'%'),href:'/modules/rhythm/'},
        {title:'Стресс · средний',detail:value(day.stress?.average),href:'/modules/rhythm/'}
      ]};
    },
    async summary() {
      const day = store.daily(dayName(Date.now(), store.config().zone));
      return {
        state: 'ok',
        items: [
          {label: 'Шаги · история', value: day.steps ?? 'Нет данных'},
          ...(day.band ? [{label: 'На браслете', value: day.band.steps}] : []),
          {label: 'Сон, мин', value: day.sleepMinutes ?? 'Нет данных'}
        ]
      };
    },
    async publicHandle({request}) {
      try {
        if (request.method !== 'POST' || request.headers.origin)
          throw fail('Метод недоступен', 405);
        const device = store.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
        const now = clock();
        for (const [id, v] of counts) if (now - v.start >= 60000) counts.delete(id);
        const counter = counts.get(device.id) ?? {start: now, n: 0};
        if (counter.n >= 120)
          return Response.json({error: 'Слишком много пакетов'}, {
            status: 429,
            headers: {'Retry-After': String(Math.max(1, Math.ceil((counter.start + 60000 - now) / 1000)))}
          });
        counter.n++;
        counts.set(device.id, counter);
        const data = await readJSON(request, 2 * 1024 * 1024);
        store.authenticate(request.headers.authorization?.replace(/^Bearer /, ''));
        if (data.type === 'watch') return refresh.watch(device,()=>store.authenticate(request.headers.authorization?.replace(/^Bearer /, '')));
        if (data.type === 'refreshAck') return Response.json(refresh.acknowledge(device,data));
        if (data.type === 'hello')
          return Response.json({
            state: 'ready',
            companion: companion(),
            name: device.name,
            format: 'json',
            maxRecords: 500,
            bandRefresh: true,
            bandSnapshot: true,
            bandExtended: true,
            bandMetrics: true,
            bandEmotion: true
          });
        const result = store.ingest(device, data);
        clearTimeout(pending);
        pending = setTimeout(() => {pending = null; void run();}, 1500);
        pending.unref();
        return Response.json(result);
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
              modulePage({embedded: user.embedded, username: user.username, title: 'Асклепий', content: html}),
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
          if (route === '/api/refresh') return Response.json(refresh.status());
          if (route === '/api')
            return Response.json({
              config: store.config(),
              devices: store.devices(),
              sources: store.sources(),
              ai: reports.availability(),
              day: store.daily(searchParams.get('day') || dayName(clock(), store.config().zone), clock()),
              wake: wake.state(searchParams.get('day') || dayName(clock(), store.config().zone))
            });
        }
        if (request.method === 'POST') {
          const v = await readJSON(request, 2 * 1024 * 1024);
          if (!authorized()) throw fail('Сессия завершена', 401);
          if (route === '/api/refresh') return Response.json(refresh.request());
          if (route === '/api/config') return Response.json(store.configure(v));
          if (route === '/api/device') return Response.json(store.addDevice(v.name));
          if (route === '/api/revoke') {
            store.revoke(v.id);
            refresh.revoke(v.id);
            return Response.json({ok: true});
          }
          if (route === '/api/source') {
            store.priority(v.id, v.priority);
            return Response.json({ok: true});
          }
          if (route === '/api/sleep/confirm') return Response.json(store.confirmSleep(v.day));
          if (route === '/api/wake-report')
            return Response.json(await wake.generate(v.day, {manual: true, expected: v.expected ?? null, confirmation: v.confirmation}));
          if (route === '/api/report') {
            const report = await reports.generate(v.day, v.retry === true, v.preview === true);
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
export const {handle, summary, start, close, publicHandle, home} = instance;
