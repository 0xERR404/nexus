(() => {
  const $ = (id) => document.getElementById(id),
    node = Nexus.node;
  const time = (n) => (n >= 3600 ? (n / 3600).toFixed(1) + ' ч' : Math.round(n / 60) + ' мин');
  const labels = {wave: 'Аполлон · музыка', cinema: 'Гипнос · видео', reader: 'Клио · чтение'};
  function link(item) {
    if (item.source === 'cinema') {
      const [id, file] = item.item.split(':');
      return '/modules/cinema/?' + new URLSearchParams({id, file});
    }
    if (item.source === 'reader') return '/modules/reader/?book=' + encodeURIComponent(item.item);
    return '/modules/wave/';
  }
  function row(item) {
    const r = node('article', undefined, 'activity-row'),
      a = node('a', item.title);
    a.href = link(item);
    r.append(
      a,
      node(
        'span',
        `${labels[item.source]} · ${time(item.seconds)}${item.completed ? ' · Завершено' : ''}`
      ),
      node('small', new Date(item.updated).toLocaleString('ru-RU'))
    );
    return r;
  }
  if ($('statisticsPage')) {
    let generation = 0,
      data = {items: [], sources: []},
      selected = 'anime';
    const categories = [
      ['anime', 'Аниме'],
      ['cinema', 'Кино'],
      ['wave', 'Музыка'],
      ['reader', 'Книги'],
      ['trophies', 'Игры']
    ];
    const belongs = (item) =>
      selected === 'anime'
        ? item.source === 'cinema' && item.kind === 'anime'
        : selected === 'cinema'
          ? item.source === 'cinema' && item.kind === 'cinema'
          : item.source === selected;
    function draw() {
      $('statisticsSources').replaceChildren(
        ...categories.map(([id, title]) => {
          const source = data.sources.find((s) => s.id === id),
            card = node('section', undefined, 'activity-card'),
            a = node('a', title);
          a.href = '/modules/' + id + '/';
          card.append(a);
          if (!source || source.state === 'missing') card.append(node('p', 'Модуль не установлен'));
          else if (!source.items?.length) card.append(node('p', 'Статистика пока недоступна'));
          else
            for (const item of source.items) {
              const metric = node('div', undefined, 'statistics-metric');
              metric.append(node('span', item.label), node('strong', item.value));
              card.append(metric);
            }
          return card;
        })
      );
      $('statisticsTabs').replaceChildren(
        ...categories.map(([id, title]) => {
          const button = node('button', title);
          button.type = 'button';
          button.setAttribute('aria-pressed', String(selected === id));
          button.onclick = () => {
            selected = id;
            draw();
          };
          return button;
        })
      );
      const title = categories.find(([id]) => id === selected)[1];
      $('statisticsRecentTitle').textContent = title + ' · недавнее';
      const local = data.items.filter((i) => i.seconds > 0 && belongs(i)).slice(0, 20);
      const box = $('statisticsRecent');
      box.replaceChildren();
      function events(title, items) {
        if (title) box.append(node('h3', title));
        if (!items?.length) {
          box.append(node('p', 'Пока нет сохранённых событий с датой.'));
          return;
        }
        for (const item of items) {
          const line = node('article', undefined, 'activity-row'),
            a = node('a', item.title);
          a.href = item.href;
          line.append(
            a,
            node('span', item.detail),
            node('small', new Date(item.date).toLocaleString('ru-RU'))
          );
          box.append(line);
        }
      }
      const external = data.recent?.[selected];
      if (selected === 'anime') {
        events('История Shikimori', external?.items);
        if (external?.error) box.append(node('p', external.error));
        if (local.length) {
          box.append(node('h3', 'Просмотры в Гипносе'));
          box.append(...local.map(row));
        }
      } else if (selected === 'trophies') {
        const timeline = [...(external?.played ?? []), ...(external?.achievements ?? [])].sort(
          (a, b) => b.date - a.date
        );
        events(null, timeline);
        if (external?.error) box.append(node('p', external.error));
      } else {
        box.append(...local.map(row));
        if (!local.length) box.append(node('p', 'Пока нет записанной активности в хабе.'));
      }
    }
    async function load() {
      const current = ++generation;
      $('statisticsRefresh').disabled = true;
      try {
        const result = await Nexus.request('/modules/statistics/api');
        if (current !== generation) return;
        data = result;
        draw();
        $('statisticsStatus').textContent = '';
      } catch (e) {
        if (current === generation) $('statisticsStatus').textContent = e.message;
      } finally {
        if (current === generation) $('statisticsRefresh').disabled = false;
      }
    }
    $('statisticsRefresh').onclick = () => void load();
    void load();
  }
  if ($('watchHistory')) {
    let items = [];
    const selected = () => {
      const value = new URLSearchParams(location.search).get('kind');
      return ['anime', 'cinema', 'all'].includes(value) ? value : 'anime';
    };
    function draw() {
      const kind = selected(),
        list = items.filter((i) => i.seconds > 0 && (kind === 'all' || i.kind === kind));
      $('watchHistory').hidden = kind === 'anime';
      $('watchHistory').replaceChildren(
        ...list.map((item) => {
          const card = node('a', undefined, 'watch-card');
          card.href = link(item);
          card.title = item.title;
          const title = item.title.split(' · ')[0];
          card.append(
            node('span', title.trim().slice(0, 1).toLocaleUpperCase(), 'watch-cover'),
            node('strong', title),
            node('small', `${time(item.seconds)}${item.completed ? ' · Завершено' : ''}`),
            node('small', new Date(item.updated).toLocaleDateString('ru-RU'))
          );
          return card;
        })
      );
      if (!list.length) $('watchHistory').append(node('p', 'Просмотров пока нет.'));
      $('animeCollection').hidden = kind === 'cinema';
      for (const tab of document.querySelectorAll('[data-watch-kind]')) {
        if (tab.dataset.watchKind === kind) tab.setAttribute('aria-current', 'page');
        else tab.removeAttribute('aria-current');
      }
    }
    for (const tab of document.querySelectorAll('[data-watch-kind]'))
      tab.onclick = (e) => {
        if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        history.pushState(null, '', tab.href);
        draw();
      };
    addEventListener('popstate', draw);
    draw();
    void Nexus.request('/api/activity?source=cinema')
      .then((data) => {
        items = data.items;
        draw();
      })
      .catch((e) => ($('watchHistory').textContent = e.message));
  }
})();
