(() => {
  const $ = (id) => document.getElementById(id),
    node = Nexus.node;
  const time = (n) => (n >= 3600 ? (n / 3600).toFixed(1) + ' ч' : Math.round(n / 60) + ' мин');
  const labels = {wave: 'Орфей', cinema: 'Дионис', reader: 'Александрия'};
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
    const view = Nexus.rememberView?.(['statisticsDays'], () => ({selected}));
    selected = view?.value.selected || selected;
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
      if($('statisticsTotal')) $('statisticsTotal').textContent = 'В хабе за '+data.days+' дней: '+time((data.measured??[]).reduce((n,r)=>n+r.seconds,0));
      const chart=$('statisticsTimeline');
      if(chart) {
        const days=new Map();for(const r of data.timeline??[])days.set(r.day,(days.get(r.day)||0)+r.seconds);
        const max=Math.max(1,...days.values());chart.replaceChildren();
        for(const [day,seconds] of days){const row=node('div',undefined,'statistics-day'),bar=node('span',undefined,'statistics-bar');bar.style.width=(seconds/max*100)+'%';bar.setAttribute('aria-hidden','true');row.append(node('small',day.slice(5)),bar,node('small',time(seconds)));chart.append(row);}
      }
      $('statisticsSources').replaceChildren(
        ...categories.map(([id, title]) => {
          const card = node('section', undefined, 'activity-card'),
            a = node('a', title);
          a.href = '/modules/' + id + '/';
          card.append(a);
          const kind = {wave:'music',reader:'book',cinema:'cinema',anime:'anime'}[id];
          const measured = data.measured?.find(m => m.kind === kind);
          const metric = (label,value) => {const line=node('div',undefined,'statistics-metric');line.append(node('span',label),node('strong',value));card.append(line);};
          if (id === 'trophies') {
            metric('Steam · последние 14 дней', data.games ? time(data.games.minutes * 60) : 'Нет данных');
            metric('Запускалось игр',data.games?.games ?? '—');
            if(data.games)card.append(node('small','Снимок '+new Date(data.games.at).toLocaleString('ru-RU')));
          } else {
            metric('Время за '+data.days+' дней',measured ? time(measured.seconds) : 'Нет записей');
            metric({wave:'Прослушиваний ≥90%',cinema:'Просмотров ≥90%',anime:'Серий ≥90%',reader:'Книг открыто'}[id],measured ? (id==='reader'?measured.items:measured.completed) : '—');
            if(id==='reader')metric('Новых экранов прочитано',data.pages ?? '—');
            else metric('Разных материалов',measured?.items ?? '—');
          }
          if (id==='reader') card.append(node('small','Экран — страница текущей вёрстки, открытая не менее 5 секунд. При прокрутке учитывается время.'));
          if (id==='anime') card.append(node('small','Время и серии — просмотры в Дионисе; события Shikimori показаны ниже отдельно.'));
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
          box.append(node('h3', 'Просмотры в Дионисе'));
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
        const result = await Nexus.request('/modules/statistics/api?days='+($('statisticsDays')?.value||14));
        if (current !== generation) return;
        data = result;
        draw();
        view?.restore();
        $('statisticsStatus').textContent = '';
      } catch (e) {
        if (current === generation) Nexus.problem($('statisticsStatus'), 'statistics', e);
      } finally {
        if (current === generation) $('statisticsRefresh').disabled = false;
      }
    }
    $('statisticsRefresh').onclick = () => void load();
    if($('statisticsDays'))$('statisticsDays').onchange=()=>void load();
    function delivery() {
      const q=window.NexusActivity?.queueState?.();
      if (!q) return;
      $('statisticsDelivery').textContent=[q.error,q.pending ? 'Ожидают отправки: '+q.pending : '',q.rejected ? 'Отложено отдельно: '+q.rejected+'. '+q.reasons.join('; ')+'. Остальные события отправляются.' : ''].filter(Boolean).join(' · ');
      $('statisticsRejected').hidden=!q.rejected;
    }
    addEventListener('nexus:activity-status',delivery);
    $('statisticsRejected').onclick=()=>{
      const blob=new Blob([JSON.stringify(window.NexusActivity.rejectedEvents(),null,2)],{type:'application/json'});
      const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='nexus404-activity-rejected.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    delivery();
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
      .catch((e) => (Nexus.problem($('watchHistory'), 'anime', e)));
  }
})();
