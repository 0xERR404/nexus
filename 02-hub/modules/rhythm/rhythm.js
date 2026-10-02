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
        ['turnOverCount', 'Повороты во сне', ''],
        ['latency', 'Засыпание (значение устройства)', ''],
        ['heartMin', 'Минимальный пульс во сне', 'уд/мин'],
        ['heartMax', 'Максимальный пульс во сне', 'уд/мин'],
        ['oxygenMin', 'Минимальная SpO₂ во сне', '%'],
        ['oxygenMax', 'Максимальная SpO₂ во сне', '%'],
        ['breathMin', 'Минимальная частота дыхания', '/мин'],
        ['breathMax', 'Максимальная частота дыхания', '/мин'],
        ['hrvBaselineMin', 'Нижняя граница HRV', 'мс'],
        ['hrvBaselineMax', 'Верхняя граница HRV', 'мс'],
        ['rdi', 'Индекс дыхательных нарушений', ''],
        ['quality', 'Качество сна (значение устройства)', ''],
        ['snoreFrequency', 'Храп (значение устройства)', '']
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
      ['Шаги · история', d.steps === null ? 'Нет данных' : (d.stepsEstimated ? '≈ ' : '') + d.steps],
      [
        'Пульс',
        d.heart ? `${d.heart.average} уд/мин · ${d.heart.min}–${d.heart.max}` : 'Нет данных'
      ],
      [
        'Сон',
        d.sleepMinutes === null
          ? (d.sleepReceived ? 'Стадии не распознаны' : 'Нет данных')
          : `${d.sleepEstimated ? '≈ ' : ''}${Math.floor(d.sleepMinutes / 60)} ч ${d.sleepMinutes % 60} мин`
      ],
      ['Тренировки', d.activityMinutes === null ? 'Нет данных' : d.activityMinutes + ' мин'],
      ['SpO₂', d.spo2 ? `${d.spo2.average}% · ${d.spo2.min}–${d.spo2.max}%` : 'Нет записей'],
      ['Стресс', d.stress ? `${d.stress.average}/100 · ${d.stress.samples} измерений` : 'Нет записей'],
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
    if (d.unknownSleepMinutes) $('Coverage').textContent += ` Неизвестные стадии сна: ${d.unknownSleepMinutes} мин; в длительность сна не включены.`;
    $('Data').replaceChildren();
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
  $('ShowData').onclick = action(showData);
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

const fieldNames = {
  id: 'ID записи', source: 'Источник', type: 'Тип', start: 'Начало', end: 'Конец',
  modified: 'Изменено', time: 'Время', value: 'Значение', battery: 'Заряд, %', steps: 'Шаги',
  calories: 'Энергия (исходное значение)', distance: 'Расстояние, м', metrics: 'Показатели',
  samples: 'Измерения', stages: 'Стадии сна', stage: 'Стадия', complete: 'Завершено',
  detail: 'Формат сна', dictionary: 'Словарь устройства: нерасшифрованные поля',
  deviceFields: 'Исходные поля устройства, HEX', extensions: 'Расширения, HEX',
  extensionMask: 'Маска расширений', workout: 'Тренировка', kind: 'Код вида тренировки',
  duration: 'Длительность, с', bpm: 'Пульс, уд/мин', heart: 'Пульс, уд/мин',
  speed: 'Скорость (значение устройства)', cadence: 'Каденс', swolf: 'SWOLF',
  strokeRate: 'Частота гребков', frequency: 'Частота', power: 'Мощность', altitude: 'Высота',
  score: 'Оценка сна', efficiency: 'Эффективность, %', latency: 'Засыпание (значение устройства)',
  wakeCount: 'Пробуждения', turnOverCount: 'Повороты', heartMin: 'Минимальный пульс',
  heartMax: 'Максимальный пульс', heartAverage: 'Средний пульс', oxygenMin: 'Минимальная SpO₂',
  oxygenMax: 'Максимальная SpO₂', oxygenAverage: 'Средняя SpO₂', breathMin: 'Минимальное дыхание',
  breathMax: 'Максимальное дыхание', breathAverage: 'Среднее дыхание', hrvAverage: 'Средняя HRV',
  hrvBaselineMin: 'Нижняя граница HRV', hrvBaselineMax: 'Верхняя граница HRV',
  rdi: 'Индекс дыхательных нарушений', quality: 'Качество сна (значение устройства)',
  snoreFrequency: 'Храп (значение устройства)'
};
const typeNames = {band: 'Счётчик и заряд', steps: 'История шагов', movement: 'Энергия и расстояние',
  heart: 'Пульс', spo2: 'SpO₂', sleep: 'Сон', stress: 'Стресс', activity: 'Тренировки', sport: 'Отсчёты тренировок'};
function fields(value, key = '') {
  if (value !== null && typeof value === 'object') {
    const box = node('div');
    for (const [name, item] of Object.entries(value)) {
      if (item !== null && typeof item === 'object') {
        const detail = node('details');
        detail.append(node('summary', `${fieldNames[name] ?? (Array.isArray(value) ? Number(name) + 1 : name)}${Array.isArray(item) ? ' · ' + item.length : ''}`));
        let rendered = false;
        detail.ontoggle = () => {
          if (detail.open && !rendered) { rendered = true; detail.append(fields(item, name)); }
        };
        box.append(detail);
      } else box.append(node('p', `${fieldNames[name] ?? name}: ${display(item, name)}`));
    }
    return box;
  }
  return node('span', display(value, key));
}
function display(value, key) {
  if (value === null) return 'Нет данных';
  if (['start', 'end', 'time', 'modified'].includes(key))
    return new Date(value).toLocaleString('ru-RU', {timeZone: state.day.zone});
  if (key === 'stage') return ({0:'Неизвестно',1:'Бодрствование',2:'Сон без стадии',3:'Вне постели',4:'Лёгкий сон',5:'Глубокий сон',6:'REM',7:'Бодрствование в постели'})[value] ?? `Неизвестный код ${value}`;
  if (typeof value === 'boolean') return value ? 'Да' : 'Нет';
  return String(value);
}
async function showData() {
  const day = state.day.day;
  const records = await api('/api/export?day=' + encodeURIComponent(day));
  if (state.day.day !== day) return;
  const root = $('Data');
  root.replaceChildren(node('p', `${records.length} записей · ${state.day.zone}. Энергия в исходных минутных записях Huawei — калории; карточка показывает ккал. Неизвестным полям не приписывается смысл.`));
  for (const [type, title] of Object.entries(typeNames)) {
    const rows = records.filter(r => r.type === type);
    const group = node('details');
    group.append(node('summary', `${title} · ${rows.length ? rows.length + ' записей' : 'Нет записей'}`));
    const content = node('div');
    let offset = 0;
    const more = button('Показать ещё', async () => render());
    const render = () => {
      for (const row of rows.slice(offset, offset + 25)) {
        const item = node('details');
        item.append(node('summary', `${display(row.start, 'start')} — ${display(row.end, 'end')}`));
        let opened = false;
        item.ontoggle = () => {
          if (item.open && !opened) { opened = true; item.append(fields(row)); }
        };
        content.append(item);
      }
      offset += 25;
      more.hidden = offset >= rows.length;
    };
    let opened = false;
    group.ontoggle = () => { if (group.open && !opened) { opened = true; render(); } };
    group.append(content, more);
    more.hidden = true;
    root.append(group);
  }
}
