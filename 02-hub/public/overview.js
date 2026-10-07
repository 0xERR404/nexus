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
            el('small', {projects: 'Дедал', kanban: 'Афина', articles: 'Клио'}[r.kind]),
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
                .map((e) => ({projects: 'Дедал', kanban: 'Афина', articles: 'Клио'})[e.id])
                .join(', ')
            : '');
      } catch (e) {
        if (n === generation) $('hubSearchStatus').textContent = e.message;
      }
    };
    const initialQuery = new URLSearchParams(location.search).get('q');
    if(initialQuery?.trim().length>=2){$('hubQuery').value=initialQuery.slice(0,100);void search();}
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
