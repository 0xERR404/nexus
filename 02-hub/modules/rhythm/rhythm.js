const $ = (id) => document.getElementById('rt' + id),
  node = Nexus.node;
let state, reportBusy = false, loadSequence = 0;
const settings = Boolean(document.getElementById('rhythmSettings'));
const api = (route, body) => Nexus.request('/modules/rhythm' + route, body);
const action = (fn) => async () => {
  try {
    $('Status').textContent = 'Обработка…';
    await fn();
    $('Status').textContent = '';
  } catch (e) {
    Nexus.problem($('Status'), 'rhythm', e);
  }
};
function button(text, fn) {
  const b = node('button', text);
  b.type = 'button';
  b.onclick = action(fn);
  return b;
}
const stamp = (n) => (n ? new Date(n).toLocaleString('ru-RU', {timeZone: state?.day?.zone ?? 'Europe/Moscow'}) : 'Ещё не было');
const view = !settings && Nexus.rememberView?.(['rtDate']);
async function load() {
  const sequence = ++loadSequence;
  const next = await api('/api' + ($('Date')?.value ? '?day=' + $('Date').value : ''));
  if (sequence !== loadSequence) return;
  state = next;
  if (view) view.restore();
  const d = state.day;
  if (settings) {
    $('Zone').value = state.config.zone;
    $('Auto').checked = !!state.config.auto;
  } else {
    $('Date').value = d.day;
    $('ZoneLabel').textContent = d.zone;
    const exportLink = $('Export');
    exportLink.href = '/modules/rhythm/api/export?day=' + encodeURIComponent(d.day);
    exportLink.setAttribute('download', 'asclepius-' + d.day + '.json');
    renderSummary(d);
    $('Coverage').textContent =
      `${d.zone} · интервалы шагов: ${d.stepCoverageMinutes} мин · отсчёты пульса: ${d.heart?.minutes ?? 0} мин. Покрытие не подтверждает непрерывное ношение часов.${d.band ? ` Счётчик браслета на ${stamp(d.band.time)} показан отдельно и не прибавляется к истории.` : ''}`;
    if (d.unknownSleepMinutes) $('Coverage').textContent += ` Неизвестные стадии сна: ${d.unknownSleepMinutes} мин; в длительность сна не включены.`;
    $('Data').replaceChildren();
    renderReports(d);
    renderWake();

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
      `Адрес хаба: ${location.origin}\nКлюч: ${v.token}\nПоказывается только сейчас. Вставь адрес и ключ в Талос → Асклепий → Настройки подключения. Выбери прямое подключение Band 11 по Bluetooth; Health Sync для него не нужен.`;
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
  $('Refresh').onclick = action(async()=>{await load();await requestRefresh();});
  $('Date').onchange = action(load);
  async function generate(retry, preview = true) {
    if (reportBusy) return;
    const day = $('Date').value;
    if (!(await Nexus.confirm(retry
      ? 'Отправить сводку в DeepSeek ещё раз? Это новый платный запрос; предыдущая попытка могла быть оплачена.'
      : 'Отправить числовую сводку за ' + day + ' в DeepSeek? Запрос оплачивается по тарифу провайдера. Пропуски данных будут отмечены.'))) return;
    if (reportBusy || $('Date').value !== day) return;
    reportBusy = true;
    renderReports(state.day); renderWake();
    try {
      await api('/api/report', {day, retry, preview});
    } finally {
      reportBusy = false;
      await load();
    }
  }
  async function generateWake() {
    if (reportBusy) return;
    const day = $('Date').value, expected = state.wake?.attempt?.id ?? null;
    let confirmation = '';
    if (expected) {
      confirmation = await Nexus.prompt('Это новый платный запрос DeepSeek. Готовый отчёт останется в истории версий. Для подтверждения введи ПЕРЕСОЗДАТЬ', '', {title: 'Пересоздание отчёта', accept: 'Пересоздать', maxLength: 32});
      if (confirmation !== 'ПЕРЕСОЗДАТЬ') return;
    } else if (!(await Nexus.confirm('Сформировать отчёт после пробуждения за ' + day + '? Запрос DeepSeek платный.'))) return;
    if (reportBusy || $('Date').value !== day || (state.wake?.attempt?.id ?? null) !== expected) return;
    reportBusy = true; renderWake(); renderReports(state.day);
    try { await api('/api/wake-report', {day, expected, confirmation}); }
    finally { reportBusy = false; await load(); }
  }
  $('WakeGenerate').onclick = action(generateWake);
  $('WakeRedo').onclick = action(generateWake);
  $('Report').onclick = action(() => generate(!!state.day.previewReport));
  $('Retry').onclick = action(() => generate(true));
  $('DailyGenerate').onclick = action(() => generate(false, false));
  $('DailyRetry').onclick = action(() => generate(true, false));
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
let syncTimer, syncStarted=0, syncBusy=false, pageClosed=false;
function renderSync(rows) {
  if(!$('SyncState') || !Array.isArray(rows))return false;
  const labels={requested:'запрос отправлен',reading:'телефон запрашивает браслет',queued:'прочитанное сохранено на телефоне, ожидается доставка',delivered:'доступные данные доставлены; полнота зависит от протокола браслета',failed:'телефон не завершил чтение',timeout:'нет подтверждения за 3 минуты',idle:'ожидание'};
  $('SyncState').textContent=rows.length?rows.map(r=>r.name+': '+(r.state==='requested' && !r.online?'ожидание Талоса · служба должна работать':r.online || r.at?labels[r.state]:'Талос не на связи · проверь службу и интернет')+(r.lastSync?' · приём '+stamp(r.lastSync):'')).join(' · '):'Нет подключённых источников';
  return rows.some(r=>['requested','reading','queued'].includes(r.state));
}
function visible() {return !pageClosed && document.visibilityState!=='hidden';}
async function requestRefresh() {
  if(settings || !visible() || syncBusy)return;
  syncBusy=true;clearTimeout(syncTimer);
  try {
    const rows=await api('/api/refresh',{});syncStarted=Date.now();
    if(renderSync(rows))syncTimer=setTimeout(pollRefresh,3000);
  } catch(e) {if($('SyncState'))$('SyncState').textContent='Не удалось запросить телефон: '+e.message;}
  finally {syncBusy=false;}
}
async function pollRefresh() {
  if(!visible() || Date.now()-syncStarted>185000)return;
  try {
    const pending=renderSync(await api('/api/refresh'));
    await load();
    if(pending && visible())syncTimer=setTimeout(pollRefresh,3000);
  } catch(e) {if($('SyncState'))$('SyncState').textContent='Проверка обновления прервана: '+e.message;}
}
if(!settings) {
  addEventListener('visibilitychange',()=>{if(visible())requestRefresh();else clearTimeout(syncTimer);});
  addEventListener('pagehide',()=>{pageClosed=true;clearTimeout(syncTimer);});
  addEventListener('pageshow',()=>{if(pageClosed){pageClosed=false;requestRefresh();}});
}
action(async()=>{await load();if(!settings)await requestRefresh();})();

const fieldNames = {
  id: 'ID записи', source: 'Источник', type: 'Тип', start: 'Начало', end: 'Конец',
  modified: 'Изменено', time: 'Время', value: 'Значение', battery: 'Заряд, %', steps: 'Шаги',
  calories: 'Энергия (исходное значение)', distance: 'Расстояние, м', metrics: 'Показатели',
  emotion: 'Эмоциональные показатели', status: 'Код состояния', originStatus: 'Исходный код', valence: 'Эмоциональный тон', arousal: 'Уровень активации', window: 'Границы сна от браслета', samples: 'Измерения', stages: 'Стадии сна', stage: 'Стадия', complete: 'Завершено',
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
  heart: 'Пульс', spo2: 'SpO₂', sleep: 'Сон', stress: 'Стресс', emotion: 'Эмоции'};
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
  const records = (await api('/api/export?day=' + encodeURIComponent(day)))
    .filter(row => row.type !== 'activity' && row.type !== 'sport');
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

function renderReports(d) {
  const preview = d.previewReport, report = d.report;
  const configured = !!state.ai?.configured;
  const hasData = d.steps != null || d.band || d.heart || d.spo2 || d.stress || Object.values(d.movement ?? {}).some(Number.isFinite) || d.sleepReceived;
  const status = r => ({done: 'Готово', running: 'Формируется…', uncertain: 'Ответ не получен'})[r.status] ?? r.status;
  $('ReportText').textContent = preview?.text ?? '';
  $('ReportState').textContent = preview
    ? `${status(preview)} · ${stamp(preview.created)}${preview.analysisOutdated ? ' · доступен новый формат разбора' : preview.stale ? ' · появились новые данные' : ''}${preview.error ? '. ' + preview.error : ''}`
    : !configured ? 'Для отправки укажи ключ и модель DeepSeek в настройках Сократа.'
      : !hasData ? 'За эту дату пока нет измерений для анализа.'
        : 'Можно отправить сейчас. Завершение суток и полное чтение сна не требуются.';
  $('AiSetup').hidden = configured;
  $('Report').textContent = reportBusy ? 'Формируется…' : preview?.status === 'done'
    ? (preview.stale ? 'Обновить разбор ИИ' : 'Разбор актуален') : 'Отправить в ИИ';
  $('Report').disabled = reportBusy || !configured || !hasData || !!(preview && (preview.status !== 'done' || !preview.stale));
  $('Retry').hidden = preview?.status !== 'uncertain' || preview.attempts >= 3;
  $('Retry').disabled = reportBusy || !configured;
  $('DailyText').textContent = report?.text ?? '';
  $('DailyState').textContent = report
    ? `${status(report)} · ${stamp(report.created)}${report.stale ? ' · измерения изменились после подготовки итога' : ''}${report.error ? '. ' + report.error : ''}`
    : d.ready ? 'Данные готовы для суточного итога.'
      : 'Прежний календарный итог доступен вручную после завершённых суток, подтверждённого сна и синхронизации.';
  $('DailyGenerate').disabled = reportBusy || !configured || !d.ready || !!report;
  $('DailyRetry').hidden = report?.status !== 'uncertain' || report.attempts >= 3;
  $('DailyRetry').disabled = reportBusy || !configured;
  $('ConfirmSleep').hidden = d.sleepMinutes === null || d.sleepComplete;
  $('AutoState').textContent = state.config.auto ? 'Автоматически формируется отчёт после пробуждения выше. Календарный итог — только вручную.' : 'Автоматические отчёты выключены.';
}
function renderSummary(d) {
  const table = node('table'); table.className = 'rt-table';
  const caption = node('caption', 'Измерения за ' + d.day); caption.className = 'sr-only';
  const head = node('thead'), headings = node('tr'), body = node('tbody');
  for (const label of ['Показатель', 'Значение', 'Подробности']) {
    const th = node('th', label); th.setAttribute('scope', 'col'); headings.append(th);
  }
  head.append(headings); table.append(caption, head, body);
  const group = label => {
    const tr = node('tr'), th = node('th', label); tr.className = 'rt-group';
    th.setAttribute('colspan', '3'); th.setAttribute('scope', 'rowgroup'); tr.append(th); body.append(tr);
  };
  const row = (label, value, detail = '', missing = false) => {
    const tr = node('tr'), th = node('th', label), main = node('td'), note = node('td');
    th.setAttribute('scope', 'row');
    main.append(node('strong', value)); main.className = 'rt-value' + (missing ? ' rt-missing' : '');
    note.className = 'rt-note'; note.append(typeof detail === 'string' ? node('span', detail) : detail);
    tr.append(th, main, note); body.append(tr);
  };
  const number = n => Number(n).toLocaleString('ru-RU', {maximumFractionDigits: 2});
  const duration = n => `${Math.floor(n / 60)} ч ${n % 60} мин`;
  group('Активность');
  row('Шаги · история', d.steps == null ? 'Нет данных' : (d.stepsEstimated ? '≈ ' : '') + number(d.steps),
    `Покрытие интервалами: ${d.stepCoverageMinutes} мин`, d.steps == null);
  if (d.band) row('Шаги · браслет', number(d.band.steps), 'Снимок: ' + stamp(d.band.time) + '. Не прибавляется к истории.');
  row('Расстояние', d.movement?.distance == null ? 'Нет данных' : number(d.movement.distance) + ' м', 'По полученным записям', d.movement?.distance == null);
  row('Расход энергии', d.movement?.calories == null ? 'Нет данных' : number(d.movement.calories) + ' ккал', 'По полученным записям', d.movement?.calories == null);
  group('Измерения');
  row('Пульс', d.heart ? `${d.heart.average} уд/мин` : 'Нет данных', d.heart ? `Средний · диапазон ${d.heart.min}–${d.heart.max} · ${d.heart.minutes} мин с отсчётами` : 'Измерения не поступили', !d.heart);
  row('SpO₂', d.spo2 ? `${d.spo2.average}%` : 'Нет данных', d.spo2 ? `Среднее · диапазон ${d.spo2.min}–${d.spo2.max}%` : 'Измерения не поступили', !d.spo2);
  row('Стресс', d.stress ? `${d.stress.average}/100` : 'Не получен', d.stress ? `${d.stress.samples} измерений` : 'Записей нет. Это не нулевой уровень стресса.', !d.stress);
  if (d.emotion) {
    const e = d.emotion.latest;
    row('Эмоции', `${d.emotion.samples} записей`, [['status','Код состояния'],['originStatus','Исходный код'],['valence','Тон'],['arousal','Активация']].filter(([key])=>e[key]!==undefined).map(([key,title])=>`${title}: ${e[key]}`).join(' · ') + '. Отдельно от стресса.');
  }
  group('Сон');
  const detail = node('div');
  detail.append(node('span', d.sleepComplete ? 'Завершение подтверждено' : 'Данные неполные · итог может измениться'));
  const durations = [['light','Лёгкий'],['deep','Глубокий'],['rem','REM'],['awake','Бодрствование']]
    .filter(([key])=>d.sleepStages?.[key] > 0).map(([key,label])=>[label, `${d.sleepStages[key]} мин`]);
  if (d.unknownSleepMinutes) durations.push(['Неизвестные стадии', `${d.unknownSleepMinutes} мин · не включены в сон`]);
  const metricNames = [['score','Оценка сна','/100'],['efficiency','Эффективность','%'],['hrvAverage','HRV','мс'],['breathAverage','Дыхание','/мин'],['heartAverage','Средний пульс','уд/мин'],['oxygenAverage','Средняя SpO₂','%'],['wakeCount','Пробуждения',''],['turnOverCount','Повороты',''],['latency','Засыпание (значение устройства)',''],['heartMin','Минимальный пульс','уд/мин'],['heartMax','Максимальный пульс','уд/мин'],['oxygenMin','Минимальная SpO₂','%'],['oxygenMax','Максимальная SpO₂','%'],['breathMin','Минимальное дыхание','/мин'],['breathMax','Максимальное дыхание','/мин'],['hrvBaselineMin','Нижняя граница HRV','мс'],['hrvBaselineMax','Верхняя граница HRV','мс'],['rdi','Индекс дыхательных нарушений',''],['quality','Качество (значение устройства)',''],['snoreFrequency','Храп (значение устройства)','']];
  for (const [key,label,unit] of metricNames) if (d.sleepMetrics?.[key] != null) durations.push([label, `${d.sleepMetrics[key]} ${unit}`]);
  if (durations.length) {
    const fold = node('details'); fold.className = 'rt-sleep-details';
    fold.append(node('summary', 'Стадии и показатели сна'));
    const dl = node('dl');
    for (const [label,value] of durations) dl.append(node('dt',label), node('dd',value));
    fold.append(dl); detail.append(fold);
  }
  row('Длительность сна', d.sleepMinutes == null ? 'Не определена' : (d.sleepEstimated ? '≈ ' : '') + duration(d.sleepMinutes), detail, d.sleepMinutes == null);
  if (d.sleepWindowMinutes != null) {
    const windows = (d.sleepWindows ?? []).map(w=>`${stamp(w.start)} — ${stamp(w.end)}`).join('; ');
    row('Период сна', duration(d.sleepWindowMinutes), windows + '. Включает возможное бодрствование.');
  }
  if (d.band) { group('Устройство'); row('Заряд браслета', d.band.battery == null ? 'Нет данных' : `${d.band.battery}%`, stamp(d.band.time), d.band.battery == null); }
  $('Cards').replaceChildren(table);
}


function renderWake() {
  const w = state.wake ?? {}, report = w.report, attempt = w.attempt;
  const configured = !!state.ai?.configured, busy = reportBusy || attempt?.status === 'running';
  const period = w.period;
  $('WakePeriod').textContent = period
    ? `${stamp(period.start)} — ${stamp(period.end)}${period.previousWakeKnown ? ' · от пробуждения до пробуждения' : ' · первые 24 часа: предыдущее пробуждение неизвестно'}`
    : 'Период закроется, когда браслет передаст границы завершившегося сна.';
  $('WakeBadge').textContent = report ? 'Сохранён' : busy ? 'Формируется' : 'После сна';
  $('WakeText').textContent = report?.text ?? '';
  $('WakeState').textContent = attempt?.status === 'running'
    ? 'DeepSeek формирует отчёт…' + (report ? ' Прежняя версия сохранена ниже.' : '')
    : attempt?.status === 'uncertain' ? attempt.error
      : report ? `Сохранён ${stamp(report.created)}. Новые измерения его не изменяют.`
        : !configured ? 'Нужны ключ и модель DeepSeek в настройках Сократа.'
          : w.automatic?.state==='waiting_read' ? 'Сон получен. Автоматический отчёт ждёт финальную квитанцию чтения · устройств: '+w.automatic.pendingDevices+'.'
            : w.automatic?.state==='before_enabled' ? 'Период завершился до включения автоматических отчётов. Доступно ручное формирование.'
              : w.ready ? 'Границы сна получены. Отчёт можно сформировать.' : 'Ожидание данных о пробуждении.';
  $('WakeGenerate').hidden = !!attempt;
  $('WakeGenerate').disabled = busy || !configured || !w.ready;
  $('WakeRedo').hidden = !attempt;
  $('WakeRedo').textContent = report ? 'Пересоздать отчёт' : 'Повторить с подтверждением';
  $('WakeRedo').disabled = busy || !configured || !w.ready || (attempt?.status === 'uncertain' && attempt.attempts >= 3);
  $('WakeAuto').textContent = state.config.auto
    ? 'Автоматически после новых пробуждений и финальной квитанции чтения Талоса 0.1.61+. Завершённый проход не означает полноту измерений. Готовый отчёт закреплён; пересоздание требует ввода ПЕРЕСОЗДАТЬ.'
    : 'Автоматические отчёты выключены в настройках Асклепия.';
  $('WakeArchive').replaceChildren();
  $('WakeVersions').hidden = !w.versions?.length;
  for (const version of w.versions ?? []) {
    const item = node('details');
    item.append(node('summary', stamp(version.created)), node('p', version.text));
    $('WakeArchive').append(item);
  }
}
