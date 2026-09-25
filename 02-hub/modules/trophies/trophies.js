(() => {
  const $ = (id) => document.getElementById(id),
    page = $('trophiesPage'),
    settings = $('trophiesSettings');
  if (!page && !settings) return;
  const status = (text = '') => {
    $('trophyStatus').textContent = text;
  };
  const el = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const date = (n) => (n ? new Date(n).toLocaleString('ru-RU') : 'ещё не было');
  async function api(route, data) {
    const r = await fetch('/modules/trophies' + route, {
      method: data ? 'POST' : 'GET',
      headers: data ? {'Content-Type': 'application/json'} : {},
      body: data ? JSON.stringify(data) : undefined,
      cache: 'no-store',
      keepalive: route === '/sync'
    });
    if (r.status === 401) {
      location.href = '/login';
      throw Error('Войди в хаб');
    }
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'Не удалось выполнить запрос');
    return d;
  }
  const gameNodes = new Map();
  let renderedList,
    snapshot,
    current,
    loading = false,
    disconnect,
    activitySequence = 0,
    activityKey = '';
  const mode = () => $('trophyMode')?.value ?? 'soft';
  const selected = () => {
    const value = new URLSearchParams(location.search).get('provider');
    return ['steam', 'ra'].includes(value) ? value : '';
  };
  function renderTabs() {
    for (const a of document.querySelectorAll('[data-trophy-provider]')) {
      if (a.dataset.trophyProvider === selected()) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }

    const overview = !selected();
    for (const node of page.querySelectorAll(
      '.trophy-search-row, #trophyCount, #trophyGames, #trophyAccounts, #trophyStatus, .trophy-sync-actions, #trophiesPage > details'
    ))
      node.hidden = overview;
    $('trophyAwardsSection').hidden = selected() !== 'ra';
    $('trophyYear').hidden = !overview;
  }
  function accountText(name, a) {
    if (!a.connected) return settings ? name + ': не подключён' : name + ' · не подключён';
    if (a.syncing)
      return `${name} · достижения ${a.progress ? `${a.progress.done}/${a.progress.total}` : '…'}${a.progress?.metadataTotal ? ` · магазин ${a.progress.metadata}/${a.progress.metadataTotal}` : ''}`;
    return `${name} · ${a.error || 'обновлено ' + date(a.lastSync)}`;
  }
  function refreshButton() {
    if (!page || !snapshot) return;
    const accounts = Object.entries(snapshot.config)
        .filter(([k, a]) => a.connected && (!selected() || selected() === k))
        .map(([, a]) => a),
      button = $('trophySync');
    const available = accounts.some((a) => !a.syncing && Date.now() >= a.nextAttempt);
    button.disabled = !available;
    $('trophyFullSync').disabled = !available;
    const wait = accounts.length
      ? Math.max(
          0,
          Math.ceil((Math.min(...accounts.map((a) => a.nextAttempt || 0)) - Date.now()) / 1000)
        )
      : 0;
    button.textContent = available
      ? 'Обновить'
      : accounts.some((a) => a.syncing)
        ? 'Загрузка…'
        : wait
          ? `Обновить · ${Math.floor(wait / 60)}:${String(wait % 60).padStart(2, '0')}`
          : 'Обновить';
  }
  function render() {
    if (!snapshot) return;
    if (settings) {
      $('steamKeyState').textContent = snapshot.config.steam.hasKey
        ? 'Ключ достижений сохранён'
        : 'Для достижений нужен Web API key, QR-сессии недостаточно.';
      $('steamStatsKey').hidden = !snapshot.config.steam.connected;
      for (const k of ['steam', 'ra']) {
        const a = snapshot.config[k];
        $(k + 'Account').textContent = accountText(
          k === 'steam' ? 'Steam' : 'RetroAchievements',
          a
        );
        const button = document.querySelector(`[data-trophy-disconnect="${k}"]`);
        button.hidden = !a.connected;
        button.disabled = a.syncing;
      }
      return;
    }
    renderTabs();
    $('trophyAccounts').replaceChildren(
      ...Object.entries(snapshot.config)
        .filter(([k, a]) => (selected() ? k === selected() : a.connected))
        .map(([k, a]) => el('div', accountText(k === 'steam' ? 'Steam' : 'RetroAchievements', a)))
    );
    const search = $('trophySearch').value.toLocaleLowerCase(),
      sort = $('trophySort').value,
      completion = $('trophyCompletion').value;
    const games = selected()
      ? snapshot.games
          .filter(
            (g) =>
              g.provider === selected() &&
              g.title.toLocaleLowerCase().includes(search) &&
              (completion === 'all' || (completion === 'beaten' ? !!g.beaten : !g.beaten))
          )
          .sort((a, b) => {
            const value = (g) =>
              sort === 'time'
                ? (g.minutes ?? -1)
                : g.total > 0 && g.soft != null
                  ? g.soft / g.total
                  : -1;
            return (
              (sort === 'name' ? 0 : value(b) - value(a)) || a.title.localeCompare(b.title, 'ru')
            );
          })
      : [];
    const signature = JSON.stringify(games);
    if (signature !== renderedList) {
      renderedList = signature;
      const cards = games.map((g) => {
        const key = g.provider + ':' + g.id,
          signature = JSON.stringify(g),
          cached = gameNodes.get(key);
        if (cached?.signature === signature) return cached.node;
        const b = el('button', undefined, 'trophy-card');
        b.type = 'button';
        b.dataset.provider = g.provider;
        if (g.cover) {
          const image = el('img');
          image.src = g.cover;
          image.alt = '';
          image.loading = 'lazy';
          image.decoding = 'async';
          let retries = 0;
          image.addEventListener('error', () => {
            if (!retries++)
              setTimeout(() => {
                image.src = g.cover + '?retry=1';
              }, 1500);
            else {
              image.hidden = true;
              b.classList.add('cover-missing');
            }
          });
          b.append(image);
        }
        const title = el('strong', g.title);
        title.title = g.title;
        b.append(title);
        const stats = el('div', undefined, 'trophy-card-stats');
        if (g.error) stats.append(el('small', 'Не обновлено'));
        if (g.metadataError) stats.append(el('small', 'Отзывы / цена не обновлены'));
        if (g.provider === 'steam') {
          const review = el('small', undefined, 'trophy-review');
          if (g.reviewPercent != null) {
            review.append(
              el('span', g.reviewPercent + '%'),
              el(
                'span',
                ' положительных · ' + g.reviewCount.toLocaleString('ru-RU'),
                'trophy-review-extra'
              )
            );
            review.setAttribute('aria-label', g.reviewPercent + '% положительных отзывов');
          } else review.textContent = g.reviewCount === 0 ? 'Нет отзывов' : 'Отзывы —';
          const facts = el('div', undefined, 'trophy-card-facts');
          facts.append(review);
          if (g.minutes != null)
            facts.append(el('small', `${Math.round(g.minutes / 6) / 10} ч`, 'trophy-hours'));
          stats.append(facts);
        }
        for (const [label, n] of g.provider === 'ra'
          ? [
              ['SC', g.soft],
              ['HC', g.hard]
            ]
          : [['', g.soft]]) {
          stats.append(
            el(
              'small',
              n === null
                ? 'Прогресс недоступен'
                : `${label} ${n}/${g.total} · ${g.total ? Math.round((n / g.total) * 100) : 0}%`
            )
          );
          if (g.total > 0 && n !== null) {
            const bar = el('progress');
            bar.max = g.total;
            bar.value = n;
            bar.setAttribute('aria-label', label || 'Прогресс');
            stats.append(bar);
          }
        }
        b.append(stats);
        b.addEventListener('click', () => openGame(g));
        gameNodes.set(key, {signature, node: b});
        return b;
      });
      const fragment = document.createDocumentFragment();
      for (const [title, match] of [
        ['С достижениями', (g) => g.total > 0],
        ['Без достижений', (g) => g.available && g.total === 0],
        ['Данные ещё не получены', (g) => !(g.total > 0) && !(g.available && g.total === 0)]
      ]) {
        const rows = games.map((g, i) => (match(g) ? cards[i] : null)).filter(Boolean);
        if (!rows.length) continue;
        fragment.append(el('h2', title + ' · ' + rows.length, 'trophy-group-title'), ...rows);
      }
      $('trophyGames').replaceChildren(fragment);
      const ids = new Set(snapshot.games.map((g) => g.provider + ':' + g.id));
      for (const key of gameNodes.keys()) if (!ids.has(key)) gameNodes.delete(key);

      if (!games.length)
        $('trophyGames').append(el('p', 'Нет игр по выбранным условиям.', 'trophy-muted'));
    }
    const library = snapshot.games.filter((g) => !selected() || g.provider === selected()),
      known = library.filter((g) => g.available),
      unlocked = (g) => (g.provider === 'ra' && mode() === 'hard' ? g.hard || 0 : g.soft || 0),
      prices = library.filter((g) => g.provider === 'steam' && g.priceUsd != null);
    const summary = [
      ['Игр', library.length],
      ['Открыто', known.reduce((n, g) => n + unlocked(g), 0)],
      ['100%', known.filter((g) => g.total > 0 && unlocked(g) === g.total).length],
      ['Часов Steam', Math.round(library.reduce((n, g) => n + (g.minutes || 0), 0) / 6) / 10]
    ];
    const steamCount = library.filter((g) => g.provider === 'steam').length;
    if (steamCount)
      summary.push([
        'Стоимость · USD',
        prices.length ? '$' + prices.reduce((n, g) => n + g.priceUsd, 0).toFixed(2) : '—'
      ]);
    $('trophyOverview').replaceChildren(
      ...summary.map(([label, value]) => {
        const cell = el('div');
        cell.append(el('small', label), el('strong', String(value)));
        return cell;
      })
    );
    $('trophyCount').textContent = `${games.length} игр`;
    refreshButton();
    const names = {
      'Game Beaten': 'Пройдена',
      'Mastery/Completion': 'Все достижения',
      'Achievement Unlocks Yield': 'Достижения',
      'Achievement Points Yield': 'Очки'
    };
    $('trophyAwards').replaceChildren(
      ...snapshot.awards.map((a) =>
        el(
          'p',
          `${a.title || a.game} · ${names[a.type] || a.type} · ${a.hard ? 'Hardcore' : 'Softcore'} · ${date(a.time)}`,
          'trophy-muted'
        )
      )
    );
    if (!snapshot.awards.length)
      $('trophyAwards').append(el('p', 'Наград пока нет.', 'trophy-muted'));
    if (snapshot.hiddenAwards)
      $('trophyAwards').append(el('p', `Скрытых наград: ${snapshot.hiddenAwards}`, 'trophy-muted'));
  }
  async function activity() {
    if (!page || !snapshot) return;
    const key = JSON.stringify([
      selected(),
      mode(),
      Math.floor(Date.now() / 86400000),
      snapshot.games.map((g) => [g.provider, g.id, g.detailAt, g.soft, g.hard])
    ]);
    if (key === activityKey) return;
    activityKey = key;
    const seq = ++activitySequence;
    try {
      const data = await api(`/activity?mode=${mode()}&provider=${selected()}`);
      if (seq !== activitySequence) return;
      const cells = [],
        today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const start = new Date(today);
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      start.setUTCDate(start.getUTCDate() + 1);
      const pad = (start.getUTCDay() + 6) % 7;
      for (let n = 0; n < pad; n++) {
        const blank = el('span');
        blank.setAttribute('aria-hidden', 'true');
        cells.push(blank);
      }
      const max = Math.max(1, ...Object.values(data.days));
      for (let time = start.getTime(); time <= today.getTime(); time += 86400000) {
        const day = new Date(time).toISOString().slice(0, 10),
          count = data.days[day] || 0;
        const cell = el('button', undefined, 'trophy-day');
        cell.type = 'button';
        cell.dataset.level = String(count ? Math.min(4, Math.ceil((count / max) * 4)) : 0);
        cell.title = day + ': ' + count + ' достижений';
        cell.setAttribute('aria-label', cell.title);
        cell.onclick = () => {
          $('trophyDayInfo').textContent = cell.title;
        };
        cells.push(cell);
      }
      $('trophyYearRange').textContent =
        start.toLocaleDateString('ru-RU', {timeZone: 'UTC'}) +
        ' — ' +
        today.toLocaleDateString('ru-RU', {timeZone: 'UTC'});
      $('trophyCalendar').replaceChildren(...cells);
      $('trophyRare').replaceChildren(
        ...data.rare.map((a) =>
          el('p', `${a.rarity}% · ${a.title} · ${a.gameTitle}`, 'trophy-muted')
        )
      );
      if (!data.rare.length)
        $('trophyRare').append(
          el(
            'p',
            'Открытых редких достижений пока нет или сервис не сообщил редкость.',
            'trophy-muted'
          )
        );
    } catch (e) {
      if (seq !== activitySequence) return;
      activityKey = '';
      if (!selected()) $('trophyDayInfo').textContent = e.message;
      else status(e.message);
    }
  }
  function renderDetail() {
    if (!current) return;
    $('trophyDialogTitle').textContent = current.title;
    $('trophyDetailStatus').textContent =
      current.error ||
      (current.available ? 'Обновлено: ' + date(current.detailAt) : 'Достижения пока недоступны');
    const hard = current.provider === 'ra' && mode() === 'hard',
      filter = $('trophyUnlockFilter').value;
    const list = current.achievements.filter(
      (a) => filter === 'all' || (filter === 'unlocked') === (hard ? a.hard : a.soft)
    );
    $('trophyAchievements').replaceChildren(
      ...list.map((a) => {
        const unlocked = hard ? a.hard : a.soft,
          when = hard ? a.hardDate : a.date,
          rarity = hard ? a.hardRarity : a.rarity,
          row = el('div', undefined, 'trophy-achievement');
        row.append(
          el('strong', `${unlocked ? '✓' : '○'} ${a.title}`),
          el('p', a.description),
          el(
            'p',
            `${unlocked ? (when ? date(when) : 'Открыто · дата неизвестна') : 'Не открыто'}${rarity !== null ? ' · ' + rarity + '%' : ''}${a.points ? ' · ' + a.points + ' очков' : ''}`
          )
        );
        return row;
      })
    );
    if (!list.length)
      $('trophyAchievements').append(
        el(
          'p',
          current.available
            ? 'Достижений по этому фильтру нет.'
            : 'Дождись успешной загрузки игры.',
          'trophy-muted'
        )
      );
    $('trophyBeaten').hidden = current.provider !== 'steam';
    $('trophyBeaten').textContent = current.beaten ? 'Сюжет пройден ✓' : 'Отметить: сюжет пройден';
  }
  async function openGame(g) {
    try {
      current = await api(`/game/${g.provider}/${g.id}`);
      $('trophyUnlockFilter').value = 'all';
      renderDetail();
      $('trophyDialog').showModal();
    } catch (e) {
      status(e.message);
    }
  }
  async function load() {
    if (loading || document.hidden) return;
    loading = true;
    try {
      snapshot = settings ? {config: await api('/config')} : await api('/api');
      render();
      if (page) {
        if (current && $('trophyDialog').open) {
          current = await api(`/game/${current.provider}/${current.id}`);
          renderDetail();
        }
        await activity();
      }
    } catch (e) {
      status(e.message);
    } finally {
      loading = false;
    }
  }
  if (page) {
    for (const id of ['trophySearch', 'trophySort', 'trophyCompletion'])
      $(id).addEventListener(id === 'trophySearch' ? 'input' : 'change', () => {
        render();
        if (id === 'trophyMode') void activity();
      });
    for (const tab of document.querySelectorAll('[data-trophy-provider]'))
      tab.addEventListener('click', (event) => {
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
          return;
        event.preventDefault();
        if (tab.dataset.trophyProvider !== selected()) history.pushState(null, '', tab.href);
        render();
        void activity();
      });
    window.addEventListener('popstate', () => {
      render();
      void activity();
    });
    $('trophyClose').onclick = () => $('trophyDialog').close();
    $('trophyUnlockFilter').onchange = renderDetail;
    $('trophyBeaten').onclick = async () => {
      const b = $('trophyBeaten');
      b.disabled = true;
      try {
        current = await api('/beaten', {id: current.id, beaten: !current.beaten});
        renderDetail();
        await load();
      } catch (e) {
        $('trophyDetailStatus').textContent = e.message;
      } finally {
        b.disabled = false;
      }
    };
    const synchronize = async (mode) => {
      $('trophySync').disabled = true;
      status();
      $('trophyFullSync').disabled = true;
      const targets = Object.entries(snapshot.config).filter(
        ([k, a]) =>
          (!selected() || selected() === k) &&
          a.connected &&
          !a.syncing &&
          Date.now() >= a.nextAttempt
      );
      await Promise.all(
        targets.map(async ([provider]) => {
          try {
            await api('/sync', {provider, mode});
          } catch (e) {
            status(e.message);
          }
        })
      );
      await load();
    };
    $('trophySync').onclick = () => synchronize('quick');
    $('trophyFullSync').onclick = () => synchronize('full');
    setInterval(refreshButton, 1000);
  }
  if (settings) {
    $('steamStatsKey').onsubmit = async (event) => {
      event.preventDefault();
      const form = event.currentTarget,
        button = form.querySelector('button');
      button.disabled = true;
      try {
        await api('/steam/key', {key: form.elements.key.value.trim()});
        form.reset();
        await load();
        status('Ключ сохранён. Достижения обновляются.');
      } catch (e) {
        status(e.message);
      } finally {
        button.disabled = false;
      }
    };
    let qrAttempt,
      qrTimer,
      qrBusy = false,
      qrGeneration = 0;
    const cancelQR = async () => {
      qrGeneration++;
      clearTimeout(qrTimer);
      const attempt = qrAttempt;
      qrAttempt = null;
      $('steamQRImage').hidden = true;
      $('steamQRImage').removeAttribute('src');
      if (attempt)
        try {
          await api('/steam/cancel', {attempt});
        } catch {}
    };
    async function beginQR() {
      if (qrBusy) return;
      await cancelQR();
      const generation = qrGeneration;
      qrBusy = true;
      $('steamQRStart').disabled = true;
      $('steamQRRetry').hidden = true;
      $('steamQRStatus').textContent = 'Создаю QR…';
      if (!$('steamQRDialog').open) $('steamQRDialog').showModal();
      try {
        const result = await api('/steam/begin', {});
        if (generation !== qrGeneration) {
          await api('/steam/cancel', {attempt: result.attempt});
          return;
        }
        qrAttempt = result.attempt;
        showQR(result);
        qrTimer = setTimeout(pollQR, result.interval);
      } catch (e) {
        if (generation === qrGeneration) {
          $('steamQRStatus').textContent = e.message;
          $('steamQRRetry').hidden = false;
        }
      } finally {
        qrBusy = false;
        $('steamQRStart').disabled = false;
      }
    }
    function showQR(result) {
      $('steamQRImage').src =
        `/modules/trophies/steam-qr?attempt=${encodeURIComponent(qrAttempt)}&v=${result.revision}`;
      $('steamQRImage').hidden = false;
      $('steamQRStatus').textContent = result.scanned
        ? 'Подтверди вход в Steam Guard.'
        : 'Отсканируй код в приложении Steam. Действует до ' +
          new Date(result.expiresAt).toLocaleTimeString('ru-RU', {
            hour: '2-digit',
            minute: '2-digit'
          }) +
          '.';
    }
    async function pollQR() {
      if (!qrAttempt || !$('steamQRDialog').open) return;
      const attempt = qrAttempt;
      try {
        const result = await api('/steam/poll', {attempt});
        if (attempt !== qrAttempt) return;
        if (result.connected) {
          qrAttempt = null;
          $('steamQRDialog').close();
          status('Steam подключён. Загружаю библиотеку.');
          await load();
          return;
        }
        showQR(result);
        qrTimer = setTimeout(pollQR, result.interval ?? 5000);
      } catch (e) {
        if (attempt !== qrAttempt) return;
        $('steamQRStatus').textContent = e.message;
        $('steamQRImage').hidden = true;
        $('steamQRRetry').hidden = false;
      }
    }
    $('steamQRStart').onclick = beginQR;
    $('steamQRRetry').onclick = beginQR;
    $('steamQRClose').onclick = () => $('steamQRDialog').close();
    $('steamQRDialog').addEventListener('close', cancelQR);
    window.addEventListener('pagehide', () => {
      clearTimeout(qrTimer);
      if (qrAttempt)
        fetch('/modules/trophies/steam/cancel', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({attempt: qrAttempt}),
          keepalive: true
        }).catch(() => {});
    });
    for (const form of document.querySelectorAll('[data-trophy-connect]'))
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const buttons = [...form.querySelectorAll('button')];
        buttons.forEach((b) => (b.disabled = true));
        status('Проверяю аккаунт…');
        try {
          await api('/connect', {
            provider: form.dataset.trophyConnect,
            account: form.elements.account.value.trim(),
            key: form.elements.key.value.trim()
          });
          form.reset();
          status('Аккаунт подключён. Загрузка списка выполняется отдельно.');
          await load();
        } catch (e) {
          status(e.message);
        } finally {
          buttons.forEach((b) => (b.disabled = false));
        }
      });
    for (const b of document.querySelectorAll('[data-trophy-disconnect]'))
      b.onclick = () => {
        disconnect = b.dataset.trophyDisconnect;
        $('trophyDisconnectDialog').showModal();
      };
    $('trophyDisconnectClose').onclick = () => $('trophyDisconnectDialog').close();
    $('trophyCancelDisconnect').onclick = () => $('trophyDisconnectDialog').close();
    $('trophyConfirmDisconnect').onclick = async () => {
      try {
        await api('/disconnect', {provider: disconnect});
        $('trophyDisconnectDialog').close();
        await load();
      } catch (e) {
        $('trophyDisconnectDialog').close();
        status(e.message);
      }
    };
  }
  void load();
  setInterval(load, 10000);
  document.addEventListener('visibilitychange', load);
})();
