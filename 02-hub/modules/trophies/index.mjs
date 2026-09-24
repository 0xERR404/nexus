import fs from 'node:fs';
import path from 'node:path';
import {modulePage} from '../../src/views.mjs';
import {body} from '../../src/server.mjs';
import {TrophiesStore} from './store.mjs';
const head =
  '<link rel="stylesheet" href="/modules/trophies/trophies.css"><script src="/modules/trophies/trophies.js" defer></script>';
const status = '<p id="trophyStatus" role="status" aria-live="polite"></p>';
const content = `${head}<section id="trophiesPage"><div class="trophy-top"><nav class="trophy-tabs" aria-label="Библиотека игр"><a href="/modules/trophies/?provider=steam" data-trophy-provider="steam">Steam</a><a href="/modules/trophies/?provider=ra" data-trophy-provider="ra">RA</a><a href="/modules/trophies/" data-trophy-provider="">Общее</a></nav><div class="trophy-sync-actions"><button id="trophySync">Обновить</button><button id="trophyFullSync">Обновить всё</button></div></div><div class="trophy-statistics"><div id="trophyOverview" class="trophy-overview"></div>${status}<div id="trophyAccounts" class="trophy-meta"></div></div><div class="trophy-search-row"><input id="trophySearch" type="search" placeholder="Найти игру" aria-label="Найти игру" maxlength="200"><select id="trophySort" aria-label="Сортировка"><option value="name">По названию</option><option value="time">По времени игры</option><option value="progress">По % достижений</option></select><select id="trophyCompletion" aria-label="Прохождение"><option value="all">Все игры</option><option value="beaten">Пройдено</option><option value="unbeaten">Не пройдено</option></select></div><p id="trophyCount" class="sr-only"></p><div id="trophyGames" class="trophy-grid"></div><section id="trophyYear" class="trophy-year"><div class="trophy-meta"><h2>Активность за год</h2><span id="trophyYearRange"></span></div><div class="trophy-calendar-scroll"><div id="trophyCalendar" class="trophy-calendar" aria-label="Календарь достижений"></div></div><p id="trophyDayInfo" class="trophy-muted">Выбери день</p><p class="trophy-muted">По датам открытия достижений · UTC</p></section><details><summary>Редкие достижения · до 5%</summary><div id="trophyRare"></div></details><details id="trophyAwardsSection"><summary>Награды RetroAchievements</summary><div id="trophyAwards"></div></details><dialog id="trophyDialog" aria-labelledby="trophyDialogTitle"><div class="trophy-meta"><h2 id="trophyDialogTitle"></h2><button id="trophyClose" class="dialog-close" aria-label="Закрыть">×</button></div><p id="trophyDetailStatus"></p><div class="trophy-toolbar"><select id="trophyUnlockFilter" aria-label="Достижения"><option value="all">Все</option><option value="unlocked">Открытые</option><option value="locked">Оставшиеся</option></select><button id="trophyBeaten" hidden>Отметить прохождение</button></div><div id="trophyAchievements"></div></dialog></section>`;
export const settings = {
  title: 'Трофеи',
  content: `${head}<section id="trophiesSettings">${status}<div class="trophy-grid">${[
    [
      'steam',
      'Steam',
      'SteamID64 или ссылка на профиль',
      'https://steamcommunity.com/dev/apikey',
      'Web API key. В Steam открой профиль и сведения об играх.'
    ],
    [
      'ra',
      'RetroAchievements',
      'Имя пользователя',
      'https://retroachievements.org/controlpanel.php',
      'Web API key из Control Panel → Keys, не Connect Key.'
    ]
  ]
    .map(
      ([id, title, placeholder, url, help]) =>
        `<section class="trophy-panel"><h2>${title}</h2><p id="${id}Account"></p>${id === 'steam' ? '<button id="steamQRStart" type="button">Войти через QR</button><p class="trophy-muted">Подтверди вход в Steam Guard. Сессия сохраняется на этом VPS.</p><form id="steamStatsKey"><label>Web API key для достижений<input name="key" type="password" required maxlength="256" autocomplete="new-password"></label><button type="submit">Сохранить ключ</button></form><p class="trophy-muted" id="steamKeyState"></p><details><summary>Подключение через API — запасной способ</summary>' : ''}<form data-trophy-connect="${id}"><label>${placeholder}<input name="account" required maxlength="200" autocomplete="off"></label><label>Ключ API<input name="key" required type="password" maxlength="256" autocomplete="new-password"></label><button type="submit">Подключить</button></form><p class="trophy-muted">${help} <a href="${url}" target="_blank" rel="noopener noreferrer">Получить ключ ↗</a></p>${id === 'steam' ? '</details>' : ''}<button data-trophy-disconnect="${id}" type="button" hidden>Отключить</button></section>`
    )
    .join(
      ''
    )}</div><dialog id="steamQRDialog" aria-labelledby="steamQRTitle"><div class="trophy-meta"><h2 id="steamQRTitle">Вход в Steam</h2><button id="steamQRClose" class="dialog-close" aria-label="Закрыть">×</button></div><p id="steamQRStatus" role="status">Создание QR…</p><img id="steamQRImage" alt="QR для входа через Steam Guard" width="246" height="246" hidden><p class="trophy-muted">Steam → Steam Guard → сканировать QR. В подтверждении проверь устройство NEXUS404 и адрес своего VPS. Не подтверждай чужой вход.</p><button id="steamQRRetry" type="button" hidden>Новый QR</button></dialog><dialog id="trophyDisconnectDialog"><div class="trophy-meta"><h2>Отключить аккаунт?</h2><button id="trophyDisconnectClose" class="dialog-close" aria-label="Закрыть">×</button></div><p>Список этого сервиса будет удалён из хаба. Сам аккаунт останется.</p><div class="trophy-toolbar"><button id="trophyConfirmDisconnect">Отключить</button><button id="trophyCancelDisconnect">Отмена</button></div></dialog></section>`
};
const assets = new Map(
  ['trophies.css', 'trophies.js'].map((x) => [
    '/' + x,
    fs.readFileSync(new URL(x, import.meta.url))
  ])
);
export function createModule(
  directory = path.join(process.env.DATA_DIR ?? '/app/data', 'trophies'),
  options = {}
) {
  const store = new TrophiesStore(directory, options);
  return {
    store,
    start: () => store.start(),
    close: () => store.close(),
    async summary() {
      const s = store.snapshot();
      return {
        state:
          Object.values(s.config).some((a) => a.error || (a.connected && !a.lastSync)) ||
          !s.games.length
            ? s.games.length
              ? 'warning'
              : 'stale'
            : 'ok',
        items: [
          {label: 'Игр', value: s.games.length},
          {label: '100%', value: s.games.filter((g) => g.total > 0 && g.soft === g.total).length},
          {label: 'Открыто', value: s.games.reduce((n, g) => n + (g.soft ?? 0), 0)}
        ]
      };
    },
    async handle({request, path: route, user, searchParams}) {
      try {
        if (['GET', 'HEAD'].includes(request.method)) {
          if (route === '/')
            return new Response(modulePage({username: user.username, title: 'Трофеи', content}), {
              headers: {'Content-Type': 'text/html; charset=utf-8'}
            });
          if (assets.has(route))
            return new Response(assets.get(route), {
              headers: {
                'Content-Type': route.endsWith('.css')
                  ? 'text/css; charset=utf-8'
                  : 'text/javascript; charset=utf-8'
              }
            });
          if (route === '/api') return Response.json(store.snapshot());
          if (route === '/config') return Response.json(store.config());
          if (route === '/steam-qr')
            return new Response(store.qrImage(searchParams?.get('attempt')), {
              headers: {'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store'}
            });
          if (route === '/activity')
            return Response.json(
              store.activity(searchParams?.get('mode'), searchParams?.get('provider'))
            );
          const game = /^\/game\/(steam|ra)\/(\d{1,12})$/.exec(route);
          if (game) return Response.json(store.detail(game[1], game[2]));
          const cover = /^\/cover\/(steam|ra)\/(\d{1,12})$/.exec(route);
          if (cover) {
            const r = await store.cover(cover[1], cover[2]);
            return r
              ? new Response(r.data, {headers: {'Content-Type': r.type}})
              : new Response(null, {status: 404});
          }
        }
        if (
          request.method === 'POST' &&
          [
            '/connect',
            '/disconnect',
            '/sync',
            '/beaten',
            '/steam/begin',
            '/steam/poll',
            '/steam/cancel',
            '/steam/key'
          ].includes(route)
        ) {
          if (!request.headers['content-type']?.startsWith('application/json'))
            return Response.json({error: 'Ожидается JSON'}, {status: 415});
          let d;
          try {
            d = JSON.parse(await body(request, 4096));
          } catch {
            return Response.json({error: 'Некорректный JSON'}, {status: 400});
          }
          if (!d || typeof d !== 'object' || Array.isArray(d))
            return Response.json({error: 'Некорректный запрос'}, {status: 400});
          if (route === '/steam/key') return Response.json(await store.steamKey(d.key));
          if (route === '/steam/begin') return Response.json(await store.qrBegin());
          if (route === '/steam/poll') return Response.json(await store.qrPoll(d.attempt));
          if (route === '/steam/cancel') {
            store.steamAuth.cancel(d.attempt);
            return Response.json({ok: true});
          }
          if (route === '/connect')
            return Response.json(await store.connect(d.provider, d.account, d.key));
          if (route === '/disconnect') return Response.json(store.disconnect(d.provider));
          if (route === '/beaten') return Response.json(store.mark(d.id, d.beaten));
          const c = store.config()[d.provider];
          if (!c?.connected)
            return Response.json({error: 'Подключи аккаунт в настройках'}, {status: 400});
          if (!c.syncing && Date.now() < c.nextAttempt)
            return Response.json(
              {error: 'Дождись окончания паузы между обновлениями'},
              {status: 429}
            );
          void store.sync(d.provider, d.mode === 'full' ? 'full' : 'quick').catch(() => {});
          return Response.json({syncing: true}, {status: 202});
        }
        return Response.json({error: 'Маршрут не найден'}, {status: 404});
      } catch (e) {
        return Response.json(
          {error: e.status ? e.message : 'Не удалось обработать данные «Трофеев»'},
          {status: e.status ?? 503}
        );
      }
    }
  };
}
const module = createModule();
export const {handle, summary, start, close} = module;
