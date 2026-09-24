import {readFile, stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {modulePage} from '../../src/views.mjs';
const assets = new Map(
  ['pulse.css', 'pulse.js'].map((name) => [
    '/' + name,
    readFileSync(new URL(name, import.meta.url))
  ])
);
const card = (name, id, note) =>
  `<section class="pulse-stat"><h2>${name}</h2><strong id="${id}">—</strong><p id="${id}Note">${note}</p></section>`;
const chart = (title, id, color) =>
  `<section class="pulse-panel"><div class="pulse-panel-title"><h2>${title}</h2><span>0–100 %</span></div><svg class="pulse-chart ${color}" viewBox="0 0 600 110" preserveAspectRatio="none" role="img" aria-label="${title}: история последних пяти минут"><path class="pulse-grid" d="M0 1H600 M0 55H600 M0 109H600"/><path id="${id}" class="pulse-curve" d=""/></svg><div class="pulse-axis"><span>5 мин назад</span><span>сейчас</span></div></section>`;
const content = `<link rel="stylesheet" href="/modules/pulse/pulse.css"><script src="/modules/pulse/pulse.js" defer></script>
<div class="pulse-toolbar"><p id="pulseStatus" role="status" aria-live="polite">Подключение к сборщику…</p><button type="button" id="pulseRefresh">Обновить</button></div>
<div id="pulseData" aria-busy="true"><div class="pulse-stats">${card('CPU', 'pulseCpu', 'первый замер…')}${card('ПАМЯТЬ', 'pulseMemory', 'занято / всего')}${card('SWAP', 'pulseSwap', 'занято / всего')}${card('UPTIME', 'pulseUptime', 'с последней загрузки')}</div>
<div class="pulse-charts">${chart('Загрузка CPU', 'pulseCpuChart', '')}${chart('Использование RAM', 'pulseMemoryChart', 'pulse-chart-memory')}</div>
<p class="pulse-history-note">История накапливается, пока открыта страница.</p>
<div class="pulse-resources"><section class="pulse-panel"><div class="pulse-panel-title"><h2>Диски</h2><span>локальные файловые системы</span></div><div id="pulseDisks"><p class="pulse-placeholder">Ожидаем показатели…</p></div></section>
<section class="pulse-panel"><div class="pulse-panel-title"><h2>Сеть</h2><span>скорость / с</span></div><div id="pulseNetwork"><p class="pulse-placeholder">Ожидаем показатели…</p></div><p class="pulse-small">↓ приём · ↑ отправка. Счётчики — с запуска интерфейса.</p></section>
</div><section class="pulse-panel"><div class="pulse-panel-title"><h2>О сервере</h2><span id="pulseHost">—</span></div><dl class="pulse-details"><div><dt>Система</dt><dd id="pulseOs">—</dd></div><div><dt>Ядро</dt><dd id="pulseKernel">—</dd></div><div><dt>Процессор</dt><dd id="pulseModel">—</dd></div><div><dt>Load · 1 / 5 / 15 мин</dt><dd id="pulseLoad">—</dd></div><div><dt>Ожидание I/O / steal</dt><dd id="pulseWait">—</dd></div></dl></section></div>
<footer class="page-foot"><span>ПУЛЬС · NEXUS404</span><span>обновление каждые 5 с</span></footer><noscript><p>Для обновления показателей включи JavaScript.</p></noscript>`;

export function createHandler(
  file = process.env.PULSE_FILE ?? '/app/metrics/pulse.json',
  now = Date.now
) {
  return async ({request, path, user}) => {
    if (!['GET', 'HEAD'].includes(request.method))
      return new Response('Метод не поддерживается', {status: 405, headers: {Allow: 'GET, HEAD'}});
    if (path === '/')
      return new Response(modulePage({username: user.username, title: 'Пульс', content}), {
        headers: {'Content-Type': 'text/html; charset=utf-8'}
      });
    if (assets.has(path))
      return new Response(assets.get(path), {
        headers: {
          'Content-Type': path.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : 'text/javascript; charset=utf-8'
        }
      });
    if (path !== '/api') return new Response('Не найдено', {status: 404});
    try {
      if ((await stat(file)).size > 524288) throw new Error('Oversized snapshot');
      const data = JSON.parse(await readFile(file, 'utf8'));
      if (
        data.schema !== 1 ||
        !Number.isFinite(data.generated_at) ||
        !data.server ||
        !Array.isArray(data.disks) ||
        !Array.isArray(data.network)
      )
        throw new Error('Invalid snapshot');
      const age = now() - data.generated_at;
      return Response.json({...data, stale: age > 20000 || age < -10000});
    } catch {
      return Response.json(
        {error: 'Сборщик пока не передал данные. Проверь службу «Пульс» на сервере.'},
        {status: 503}
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
    const percent = (value) => (Number.isFinite(value) ? Math.round(value) + '%' : '—');
    const disk = data.disks.find((d) => d.mount === '/') ?? data.disks[0];
    return {
      state: data.stale ? 'stale' : data.warnings?.length ? 'warning' : 'ok',
      items: [
        {label: 'CPU', value: percent(data.cpu?.percent)},
        {label: 'RAM', value: percent(data.memory?.percent)},
        {label: 'Диск', value: percent(disk?.percent)}
      ]
    };
  };
}
export const summary = createSummary(handle);
