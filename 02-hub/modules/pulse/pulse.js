(() => {
  const $ = (id) => document.getElementById(id);
  const number = (value) => Number.isFinite(value);
  const percent = (value) =>
    number(value) ? value.toLocaleString('ru-RU', {maximumFractionDigits: 1}) + ' %' : '—';
  const bytes = (value) => {
    if (!number(value)) return '—';
    const units = ['Б', 'КиБ', 'МиБ', 'ГиБ', 'ТиБ'];
    const index = value > 0 ? Math.min(4, Math.floor(Math.log(value) / Math.log(1024))) : 0;
    return (
      (value / 1024 ** Math.max(0, index)).toLocaleString('ru-RU', {
        maximumFractionDigits: index > 0 ? 1 : 0
      }) +
      ' ' +
      units[Math.max(0, index)]
    );
  };
  const text = (id, value) => {
    $(id).textContent = value;
  };
  const element = (tag, content, className) => {
    const el = document.createElement(tag);
    if (content !== undefined) el.textContent = content;
    if (className) el.className = className;
    return el;
  };
  const history = [];
  let last = null,
    timer,
    busy = false;
  function graph(id, key, now) {
    let d = '',
      previous = null;
    for (const entry of history) {
      if (!number(entry[key])) {
        previous = null;
        continue;
      }
      const x = Math.max(0, Math.min(600, 600 - ((now - entry.time) / 300000) * 600));
      const y = 109 - (Math.max(0, Math.min(100, entry[key])) / 100) * 108;
      d += `${previous !== null && entry.time - previous <= 12000 ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `;
      previous = entry.time;
    }
    $(id).setAttribute('d', d);
  }
  function render(data) {
    text('pulseCpu', percent(data.cpu?.percent));
    text('pulseCpuNote', `${data.server.cores ?? '—'} логических CPU`);
    text('pulseMemory', percent(data.memory?.percent));
    text(
      'pulseMemoryNote',
      data.memory ? `${bytes(data.memory.used)} / ${bytes(data.memory.total)}` : 'нет данных'
    );
    text('pulseSwap', data.swap?.total === 0 ? 'выкл.' : percent(data.swap?.percent));
    text(
      'pulseSwapNote',
      data.swap
        ? data.swap.total
          ? `${bytes(data.swap.used)} / ${bytes(data.swap.total)}`
          : 'swap не подключён'
        : 'нет данных'
    );
    const uptime = data.uptime_seconds;
    text(
      'pulseUptime',
      number(uptime)
        ? uptime >= 86400
          ? `${Math.floor(uptime / 86400)} д ${Math.floor((uptime % 86400) / 3600)} ч`
          : `${Math.floor(uptime / 3600)} ч ${Math.floor((uptime % 3600) / 60)} м`
        : '—'
    );
    if (last && number(uptime) && uptime < last.uptime_seconds) history.length = 0;
    if (!data.stale && (!last || last.generated_at !== data.generated_at))
      history.push({time: data.generated_at, cpu: data.cpu?.percent, memory: data.memory?.percent});
    while (history.length && (data.generated_at - history[0].time > 300000 || history.length > 61))
      history.shift();
    graph('pulseCpuChart', 'cpu', data.generated_at);
    graph('pulseMemoryChart', 'memory', data.generated_at);
    const disks = data.disks.map((disk) => {
      const row = element('div', undefined, 'pulse-disk'),
        head = element('div', undefined, 'pulse-disk-head');
      head.append(element('strong', disk.mount), element('span', percent(disk.percent)));
      const meter = element('meter', undefined, 'pulse-meter');
      meter.min = 0;
      meter.max = 100;
      meter.value = disk.percent ?? 0;
      meter.setAttribute('aria-label', `Диск ${disk.mount}: занято ${percent(disk.percent)}`);
      row.append(
        head,
        meter,
        element(
          'p',
          `${bytes(disk.used)} из ${bytes(disk.total)} · доступно ${bytes(disk.available)}${disk.reserved > 0 ? ' · резерв ' + bytes(disk.reserved) : ''}`,
          'pulse-disk-note'
        )
      );
      return row;
    });
    $('pulseDisks').replaceChildren(
      ...(disks.length
        ? disks
        : [element('p', 'Нет доступных показателей дисков.', 'pulse-placeholder')])
    );
    const links = data.network.map((link) => {
      const row = element('div', undefined, 'pulse-network');
      row.append(element('strong', link.name));
      for (const [arrow, rate, total] of [
        ['↓', link.rx_per_second, link.rx_bytes],
        ['↑', link.tx_per_second, link.tx_bytes]
      ]) {
        const column = element('div');
        column.append(
          element('p', `${arrow} ${bytes(rate)}/с`),
          element('small', 'всего ' + bytes(total))
        );
        row.append(column);
      }
      return row;
    });
    $('pulseNetwork').replaceChildren(
      ...(links.length
        ? links
        : [element('p', 'Нет доступных сетевых интерфейсов.', 'pulse-placeholder')])
    );
    text('pulseHost', data.server.hostname || '—');
    text('pulseOs', data.server.os || '—');
    text('pulseKernel', data.server.kernel || '—');
    text('pulseModel', data.server.cpu_model || '—');
    text(
      'pulseLoad',
      data.cpu?.load
        ?.map((n) => n.toLocaleString('ru-RU', {minimumFractionDigits: 2}))
        .join(' / ') || '—'
    );
    text('pulseWait', `${percent(data.cpu?.iowait_percent)} / ${percent(data.cpu?.steal_percent)}`);
    last = data;
  }
  function state(message, error = false) {
    text('pulseStatus', message);
    $('pulseStatus').dataset.state = error ? 'error' : 'live';
    $('pulseData').classList.toggle('pulse-stale', error);
    $('pulseData').setAttribute('aria-busy', 'false');
  }
  async function update() {
    clearTimeout(timer);
    if (document.hidden || busy) return;
    busy = true;
    $('pulseRefresh').disabled = true;
    try {
      const response = await fetch('/modules/pulse/api', {
        cache: 'no-store',
        signal: AbortSignal.timeout(8000)
      });
      if (response.status === 401 || response.redirected) {
        location.replace('/login');
        return;
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Показатели недоступны.');
      render(data);
      const time = new Date(data.generated_at).toLocaleTimeString('ru-RU');
      state(
        data.stale
          ? `Данные устарели · последний замер ${time}`
          : data.warnings?.length
            ? `Часть показателей недоступна · ${time}`
            : `Обновлено ${time}`,
        data.stale || data.warnings?.length > 0
      );
    } catch (error) {
      state(
        (navigator.onLine
          ? error instanceof TypeError || error.name === 'TimeoutError'
            ? 'Нет ответа от сервера.'
            : error.message
          : 'Нет соединения.') + (last ? ' Показан последний замер.' : ''),
        true
      );
      if (!last) {
        text('pulseCpuNote', 'нет данных');
        text('pulseDisks', 'Показатели пока недоступны.');
        text('pulseNetwork', 'Показатели пока недоступны.');
      }
    } finally {
      busy = false;
      $('pulseRefresh').disabled = false;
      if (!document.hidden) timer = setTimeout(update, 5000);
    }
  }
  $('pulseRefresh').addEventListener('click', update);
  document.addEventListener('visibilitychange', () => {
    clearTimeout(timer);
    if (!document.hidden) update();
  });
  window.addEventListener('online', update);
  window.addEventListener('offline', () => state('Нет соединения. Показан последний замер.', true));
  update();
})();
