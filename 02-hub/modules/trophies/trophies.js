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
      cache: 'no-store'
    });
    if (r.status === 401) {
      location.href = '/login';
      throw Error('Войди в хаб');
    }
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'Не удалось выполнить запрос');
    return d;
  }
  let snapshot,
    current,
    index = 0,
    loading = false,
    disconnect,
    activitySequence = 0;
  const mode = () => $('trophyMode')?.value ?? 'soft';
  const selected = () => $('trophyProvider')?.value ?? '';
  function accountText(name, a) {
    return `${name}: ${a.connected ? a.name + (a.mode === 'qr' ? ' · QR-сессия' : '') : 'не подключён'}${a.connected ? ' · обновлено: ' + date(a.lastSync) : ''}${a.syncing ? ' · загрузка ' + (a.progress ? `${a.progress.done}/${a.progress.total}` : 'списка') : ''}${a.error ? ' · ' + a.error : ''}`;
  }
  function refreshButton() {
    if (!page || !snapshot) return;
    const accounts = Object.entries(snapshot.config)
        .filter(([k, a]) => a.connected && (!selected() || selected() === k))
        .map(([, a]) => a),
      button = $('trophySync');
    const available = accounts.some((a) => !a.syncing && Date.now() >= a.nextAttempt);
    button.disabled = !available;
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
    $('trophyAccounts').replaceChildren(
      ...Object.entries(snapshot.config).map(([k, a]) =>
        el('div', accountText(k === 'steam' ? 'Steam' : 'RetroAchievements', a))
      )
    );
    const search = $('trophySearch').value.toLocaleLowerCase(),
      filter = $('trophyFilter').value;
    const games = snapshot.games
      .filter((g) => {
        const n = g.provider === 'ra' && mode() === 'hard' ? g.hard : g.soft;
        return (
          (!selected() || g.provider === selected()) &&
          g.title.toLocaleLowerCase().includes(search) &&
          (!filter ||
            (filter === 'started' && n > 0 && n < g.total) ||
            (filter === 'beaten' &&
              (g.provider === 'ra' && mode() === 'hard' ? g.beatenHard : g.beaten)) ||
            (filter === 'complete' && g.total > 0 && n === g.total))
        );
      })
      .sort((a, b) => a.title.localeCompare(b.title));
    const pages = Math.max(1, Math.ceil(games.length / 24));
    index = Math.min(index, pages - 1);
    $('trophyGames').replaceChildren(
      ...games.slice(index * 24, index * 24 + 24).map((g) => {
        const b = el('button', undefined, 'trophy-card');
        b.type = 'button';
        if (g.cover) {
          const image = el('img');
          image.src = g.cover;
          image.alt = '';
          image.loading = 'lazy';
          image.addEventListener('error', () => image.remove());
          b.append(image);
        }
        b.append(el('strong', g.title), el('small', g.console));
        for (const [label, n] of g.provider === 'ra'
          ? [
              ['SC', g.soft],
              ['HC', g.hard]
            ]
          : [['', g.soft]]) {
          b.append(
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
            b.append(bar);
          }
        }
        if (g.error) b.append(el('small', 'Не обновлено'));
        b.addEventListener('click', () => openGame(g));
        return b;
      })
    );
    if (!games.length)
      $('trophyGames').append(el('p', 'Нет игр по выбранным условиям.', 'trophy-muted'));
    $('trophyCount').textContent = `${games.length} игр · ${index + 1}/${pages}`;
    $('trophyPrev').disabled = index === 0;
    $('trophyNext').disabled = index + 1 === pages;
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
    if (!page) return;
    const seq = ++activitySequence;
    try {
      const data = await api(`/activity?mode=${mode()}&provider=${selected()}`);
      if (seq !== activitySequence) return;
      const cells = [],
        now = new Date();
      now.setUTCHours(0, 0, 0, 0);
      for (let n = 83; n >= 0; n--) {
        const day = new Date(now.getTime() - n * 86400000).toISOString().slice(0, 10),
          count = data.days[day] || 0,
          cell = el('span', count || '', 'trophy-day');
        cell.dataset.active = String(count > 0);
        cell.title = `${day}: ${count}`;
        cell.setAttribute('aria-label', cell.title);
        cells.push(cell);
      }
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
      status(e.message);
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
      if (page) await activity();
    } catch (e) {
      status(e.message);
    } finally {
      loading = false;
    }
  }
  if (page) {
    for (const id of ['trophySearch', 'trophyFilter', 'trophyProvider', 'trophyMode'])
      $(id).addEventListener(id === 'trophySearch' ? 'input' : 'change', () => {
        index = 0;
        render();
        if (id === 'trophyProvider' || id === 'trophyMode') void activity();
      });
    $('trophyPrev').onclick = () => {
      index--;
      render();
    };
    $('trophyNext').onclick = () => {
      index++;
      render();
    };
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
    $('trophySync').onclick = async () => {
      $('trophySync').disabled = true;
      status();
      for (const [k, a] of Object.entries(snapshot.config))
        if (
          (!selected() || selected() === k) &&
          a.connected &&
          !a.syncing &&
          Date.now() >= a.nextAttempt
        )
          try {
            await api('/sync', {provider: k});
          } catch (e) {
            status(e.message);
          }
      await load();
    };
    setInterval(refreshButton, 1000);
  }
  if (settings) {
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
