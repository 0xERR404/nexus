const $ = (id) => document.getElementById('rt' + id),
  node = Nexus.node;
let state;
const settings = Boolean(document.getElementById('rhythmSettings'));
const api = (route, body) => Nexus.request('/modules/rhythm' + route, body);
const action = (fn) => async () => {
  try {
    $('Status').textContent = 'Обработка…';
    await fn();
    $('Status').textContent = '';
  } catch (e) {
    $('Status').textContent = e.message;
  }
};
function button(text, fn) {
  const b = node('button', text);
  b.type = 'button';
  b.onclick = action(fn);
  return b;
}
const stamp = (n) => (n ? new Date(n).toLocaleString() : 'Ещё не было');
async function load() {
  state = await api('/api' + ($('Date')?.value ? '?day=' + $('Date').value : ''));
  const d = state.day;
  if (settings) {
    $('Zone').value = state.config.zone;
    $('Auto').checked = !!state.config.auto;
  } else {
    const extra = [],
      sleepExtras = [];
    for (const [key, label, unit] of [
      ['calories', 'Расход энергии', 'ккал'],
      ['distance', 'Расстояние', 'м']
    ])
      if (d.movement?.[key] !== null && d.movement?.[key] !== undefined)
        extra.push([label, `${d.movement[key]} ${unit}`]);
    const sm = d.sleepMetrics;
    if (sm)
      for (const [key, label, unit] of [
        ['score', 'Оценка сна', '/100'],
        ['efficiency', 'Эффективность сна', '%'],
        ['hrvAverage', 'HRV во сне', 'мс'],
        ['breathAverage', 'Дыхание во сне', '/мин'],
        ['heartAverage', 'Пульс во сне', 'уд/мин'],
        ['oxygenAverage', 'SpO₂ во сне', '%'],
        ['wakeCount', 'Пробуждения', ''],
        ['turnOverCount', 'Повороты во сне', '']
      ])
        if (sm[key] !== undefined) sleepExtras.push([label, `${sm[key]} ${unit}`]);
    if (d.sport)
      extra.push([
        'Отсчёты тренировок',
        `${d.sport.samples}${d.sport.heartMin !== null ? ' · пульс ' + d.sport.heartMin + '–' + d.sport.heartMax : ''}`
      ]);
    $('Date').value = d.day;
    const exportLink = $('Export');
    exportLink.href = '/modules/rhythm/api/export?day=' + encodeURIComponent(d.day);
    exportLink.setAttribute('download', 'asclepius-' + d.day + '.json');
    $('Cards').replaceChildren();
    for (const [label, value] of [
      ...extra,
      ['Шаги', d.steps === null ? 'Нет данных' : (d.stepsEstimated ? '≈ ' : '') + d.steps],
      [
        'Пульс',
        d.heart ? `${d.heart.average} уд/мин · ${d.heart.min}–${d.heart.max}` : 'Нет данных'
      ],
      [
        'Сон',
        d.sleepMinutes === null
          ? 'Нет данных'
          : `${d.sleepEstimated ? '≈ ' : ''}${Math.floor(d.sleepMinutes / 60)} ч ${d.sleepMinutes % 60} мин`
      ],
      ['Тренировки', d.activityMinutes === null ? 'Нет данных' : d.activityMinutes + ' мин'],
      ...(d.spo2 ? [['SpO₂', `${d.spo2.average}% · ${d.spo2.min}–${d.spo2.max}%`]] : []),
      ...(d.stress ? [['Стресс', `${d.stress.average}/100 · ${d.stress.samples} измерений`]] : []),
      ...(d.band ? [['На браслете', `${d.band.steps} шагов · заряд ${d.band.battery}%`]] : [])
    ]) {
      const card = node('section');
      card.className = 'rt-panel';
      card.append(node('small', label), node('h2', value));
      if (label === 'Сон' && sleepExtras.length) {
        const details = node('details');
        details.append(node('summary', 'Показатели сна'));
        for (const [name, value] of sleepExtras) details.append(node('p', name + ': ' + value));
        card.append(details);
      }
      if (label === 'Сон' && Object.values(d.sleepStages ?? {}).some(Boolean))
        card.append(
          node(
            'small',
            `Лёгкий ${d.sleepStages.light} · глубокий ${d.sleepStages.deep} · REM ${d.sleepStages.rem} · бодрствование ${d.sleepStages.awake} мин`
          )
        );
      if (label === 'Тренировки' && d.workouts?.length)
        for (const w of d.workouts) {
          const line = node(
            'small',
            `${new Date(w.start).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})} · ${Math.round((w.end - w.start) / 60000)} мин${w.distance !== undefined ? ' · ' + (w.distance / 1000).toFixed(2) + ' км' : ''}${w.calories !== undefined ? ' · ' + w.calories + ' ккал' : ''}`
          );
          card.append(line);
        }
      $('Cards').append(card);
    }
    $('Coverage').textContent =
      `${d.zone} · интервалы шагов: ${d.stepCoverageMinutes} мин · отсчёты пульса: ${d.heart?.minutes ?? 0} мин. Покрытие не подтверждает непрерывное ношение часов.${d.band ? ` Счётчик браслета на ${stamp(d.band.time)} показан отдельно и не прибавляется к истории.` : ''}`;
    const report = d.report;
    $('ReportText').textContent = report?.text ?? '';
    $('ReportState').textContent = report
      ? `${{done: 'Готов', running: 'Формируется', uncertain: 'Результат запроса неизвестен'}[report.status]}${report.stale ? ' · измерения изменились после подготовки сводки' : ''}. ${report.error}`
      : d.ready
        ? 'Данные готовы к формированию отчёта.'
        : 'Ожидаем закрытые сутки, завершённый сон и последующую синхронизацию.';
    $('ConfirmSleep').hidden = d.sleepMinutes === null || d.sleepComplete;
    $('Report').disabled = !d.ready || !!report;
    $('Retry').hidden = report?.status !== 'uncertain' || report.attempts >= 3;
  }
  if (settings) {
    $('Devices').replaceChildren();
    for (const dev of state.devices) {
      const line = node('div');
      line.className = 'rt-toolbar';
      line.append(
        node(
          'span',
          `${dev.name} · ${dev.revoked ? 'отозван' : 'последняя синхронизация: ' + stamp(dev.last_sync)}`
        )
      );
      if (!dev.revoked) {
        line.append(
          button('Отозвать', async () => {
            if (await Nexus.confirm('Отозвать доступ этого источника?')) {
              await api('/api/revoke', {id: dev.id});
              await load();
            }
          })
        );
      }
      $('Devices').append(line);
    }
    $('Sources').replaceChildren();
    for (const src of state.sources) {
      const line = node('div');
      line.className = 'rt-toolbar';
      const input = node('input');
      input.type = 'number';
      input.min = 0;
      input.max = 1000;
      input.value = src.priority;
      input.setAttribute('aria-label', 'Приоритет ' + src.name);
      line.append(
        node('span', src.name),
        input,
        button('Сохранить', async () => {
          await api('/api/source', {id: src.id, priority: Number(input.value)});
          await load();
        })
      );
      $('Sources').append(line);
    }
  }
}
if (settings) {
  $('Add').onclick = action(async () => {
    const name = await Nexus.prompt('Название источника измерений');
    if (!name) return;
    const v = await api('/api/device', {name});
    $('Token').textContent =
      `Адрес хаба: ${location.origin}\nКлюч: ${v.token}\nПоказывается только сейчас. Вставь адрес и ключ в Гекату → Асклепий → Настройки подключения. Выбери прямое подключение Band 11 по Bluetooth; Health Sync для него не нужен.`;
    await load();
  });
  $('Config').onsubmit = (e) => {
    e.preventDefault();
    action(async () => {
      await api('/api/config', {zone: $('Zone').value, auto: $('Auto').checked});
      await load();
    })();
  };
} else {
  $('Refresh').onclick = action(load);
  $('Date').onchange = action(load);
  async function generate(retry) {
    if (
      !(await Nexus.confirm(
        retry
          ? 'Повтор может привести к ещё одному списанию DeepSeek. Продолжить?'
          : 'Отправить числовую сводку DeepSeek и оплатить запрос по тарифу провайдера?'
      ))
    )
      return;
    $('Report').disabled = true;
    $('Retry').disabled = true;
    try {
      await api('/api/report', {day: $('Date').value, retry});
      await load();
    } finally {
      $('Retry').disabled = false;
    }
  }
  $('Report').onclick = action(() => generate(false));
  $('Retry').onclick = action(() => generate(true));
  $('ConfirmSleep').onclick = action(async () => {
    if (
      await Nexus.confirm(
        'Сон за выбранную дату действительно завершён, а часы уже синхронизированы? Новые изменения сна отменят подтверждение.'
      )
    ) {
      await api('/api/sleep/confirm', {day: $('Date').value});
      await load();
    }
  });
}
action(load)();
