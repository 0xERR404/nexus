(() => {
  const $ = (id) => document.getElementById(id),
    el = Nexus.node;
  const stamp = (t) => (t ? new Date(t).toLocaleString() : 'Нет данных');
  async function api(url, value) {
    try {
      return await Nexus.request(url, value);
    } catch (error) {
      if (error.status === 401) location.href = '/login';
      throw error;
    }
  }
  function link(title, url) {
    const a = el('a', title);
    a.href = url;
    return a;
  }
  const run = (status, fn) => async () => {
    try {
      status.textContent = 'Загрузка…';
      await fn();
      status.textContent = '';
    } catch (e) {
      status.textContent = e.message;
    }
  };
  if ($('hubHomeSettings')) {
    let config, modules;
    function draw() {
      const box = $('hubOrder');
      box.replaceChildren();
      for (const [i, id] of config.order.entries()) {
        const m = modules.find((m) => m.id === id);
        if (!m) continue;
        const row = el('div');
        row.className = 'hub-order-row';
        const label = el('label'),
          check = el('input');
        check.type = 'checkbox';
        check.checked = !config.hidden.includes(id);
        check.onchange = () => {
          config.hidden = config.hidden.filter((x) => x !== id);
          if (!check.checked) config.hidden.push(id);
        };
        label.append(check, document.createTextNode(m.title));
        row.append(label, link('Открыть', '/modules/' + id + '/'));
        for (const [title, offset] of [
          ['↑', -1],
          ['↓', 1]
        ]) {
          const b = el('button', title);
          b.type = 'button';
          b.disabled = i + offset < 0 || i + offset >= config.order.length;
          b.setAttribute('aria-label', m.title + (offset < 0 ? ' выше' : ' ниже'));
          b.onclick = () => {
            [config.order[i], config.order[i + offset]] = [
              config.order[i + offset],
              config.order[i]
            ];
            draw();
          };
          row.append(b);
        }
        box.append(row);
      }
    }
    run($('hubHomeStatus'), async () => {
      const data = await api('/api/home');
      config = data.config;
      modules = data.modules;
      config.order = [
        ...config.order.filter((id) => modules.some((m) => m.id === id)),
        ...modules.map((m) => m.id).filter((id) => !config.order.includes(id))
      ];
      config.hidden = config.hidden.filter((id) => modules.some((m) => m.id === id));
      draw();
    })();
    $('hubSaveHome').onclick = async () => {
      if (!config) return;
      $('hubSaveHome').disabled = true;
      try {
        config = await api('/api/home', config);
        $('hubHomeStatus').textContent = 'Сохранено. Главная обновится при открытии.';
      } catch (e) {
        $('hubHomeStatus').textContent = e.message;
      } finally {
        $('hubSaveHome').disabled = false;
      }
    };
  }
  if ($('hubSearch')) {
    let generation = 0;
    const search = async () => {
      const n = ++generation;
      $('hubSearchStatus').textContent = 'Поиск…';
      try {
        const data = await api('/api/search?q=' + encodeURIComponent($('hubQuery').value));
        if (n !== generation) return;
        $('hubSearchResults').replaceChildren();
        for (const r of data.results) {
          const item = el('article');
          item.className = 'hub-search-result';
          item.append(
            el('small', {projects: 'Гефест', kanban: 'Афина', articles: 'Каллиопа'}[r.kind]),
            link(r.title, r.url),
            el('p', r.snippet)
          );
          $('hubSearchResults').append(item);
        }
        $('hubSearchStatus').textContent =
          `Найдено: ${data.results.length}. До ${data.limitPerModule} результатов на модуль.` +
          (data.errors.length
            ? ' Некоторые источники недоступны: ' +
              data.errors
                .map((e) => ({projects: 'Гефест', kanban: 'Афина', articles: 'Каллиопа'})[e.id])
                .join(', ')
            : '');
      } catch (e) {
        if (n === generation) $('hubSearchStatus').textContent = e.message;
      }
    };
    $('hubSearchForm').onsubmit = (e) => {
      e.preventDefault();
      search();
    };
  }
  if ($('hubState')) {
    const refresh = run($('hubStateStatus'), async () => {
      const data = await api('/api/status');
      $('hubVersion').textContent =
        'NEXUS404 · ' + data.version + ' · проверено ' + stamp(data.checkedAt);
      $('hubModuleState').replaceChildren();
      for (const m of data.modules) {
        const row = el('tr');
        for (const text of [
          m.title,
          m.version ?? 'Не указана',
          {
            ok: 'Работает',
            warning: 'Внимание',
            loaded: 'Загружен',
            stale: 'Данные устарели',
            disabled: 'Выключен',
            error: 'Ошибка',
            unknown: 'Нет сведений'
          }[m.state] ?? m.state,
          stamp(m.checkedAt)
        ])
          row.append(el('td', text));
        if (m.error) row.children[2].append(el('p', m.error));
        $('hubModuleState').append(row);
      }
      $('hubSyncs').replaceChildren();
      for (const s of data.syncs)
        $('hubSyncs').append(
          el(
            'p',
            `${s.name} · ${stamp(s.time)} · ${{synced: 'синхронизировано', waiting: 'ожидание', revoked: 'ключ отозван', error: 'ошибка'}[s.state] ?? s.state}`
          )
        );
      if (!data.syncs.length)
        $('hubSyncs').textContent = 'Источники синхронизации пока не настроены.';
      $('hubStateNote').textContent = data.note;
    });
    $('hubRefreshState').onclick = refresh;
    refresh();
  }
})();
