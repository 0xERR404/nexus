(() => {
  const $ = (id) => document.getElementById(id),
    make = (tag, text, cls) => {
      const el = document.createElement(tag);
      if (text !== undefined) el.textContent = text;
      if (cls) el.className = cls;
      return el;
    };
  let data = {tracks: [], playlists: []},
    shown = [],
    confirm;
  const host = () => (window.parent !== window ? window.parent.NexusWave : window.NexusWave);
  const status = (text) => ($('waveStatus').textContent = text);
  async function api(route, payload) {
    const r = await fetch(
      '/modules/wave' + route,
      payload
        ? {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(payload)
          }
        : {}
    );
    if (r.redirected) throw Error('Войди в хаб заново.');
    const d = await r.json();
    if (!r.ok) throw Error(d.error || 'Не удалось выполнить запрос.');
    return d;
  }
  async function change(payload) {
    data = await api('/change', payload);
    render();
    await host()?.refresh();
  }
  function button(label, handler, text = label) {
    const b = make('button', text);
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = () =>
      Promise.resolve(handler()).catch((e) => {
        if ($('waveDialog').open) $('waveDialogError').textContent = e.message;
        else status(e.message);
      });
    return b;
  }
  function dialog(title, build, action, label = 'Сохранить') {
    $('waveDialogTitle').textContent = title;
    $('waveDialogBody').replaceChildren();
    $('waveDialogError').textContent = '';
    build($('waveDialogBody'));
    $('waveDialogSubmit').textContent = label;
    confirm = action;
    $('waveDialog').showModal();
  }
  $('waveDialogClose').onclick = () => $('waveDialog').close();
  $('waveDialogForm').onsubmit = async (e) => {
    e.preventDefault();
    $('waveDialogSubmit').disabled = true;
    try {
      await confirm();
      $('waveDialog').close();
    } catch (e) {
      $('waveDialogError').textContent = e.message;
    } finally {
      $('waveDialogSubmit').disabled = false;
    }
  };
  function render() {
    const selected = $('waveFilter').value;
    const options = [
      new Option('Все треки', 'all'),
      new Option('Избранное', 'favorite'),
      ...data.playlists.map((p) => new Option(p.name, p.id))
    ];
    $('waveFilter').replaceChildren(...options);
    $('waveFilter').value = options.some((o) => o.value === selected) ? selected : 'all';
    const playlist = data.playlists.find((p) => p.id === $('waveFilter').value),
      q = $('waveSearch').value.toLocaleLowerCase();
    shown = data.tracks.filter(
      (t) =>
        (!playlist || playlist.tracks.includes(t.id)) &&
        ($('waveFilter').value !== 'favorite' || t.favorite) &&
        [t.title, t.artist, t.album].join(' ').toLocaleLowerCase().includes(q)
    );
    if (playlist)
      shown.sort((a, b) => playlist.tracks.indexOf(a.id) - playlist.tracks.indexOf(b.id));
    else shown.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
    $('waveEditPlaylist').hidden = !playlist;
    $('waveCount').textContent = shown.length + ' треков';
    $('wavePlay').disabled = !shown.length;
    $('waveTracks').replaceChildren(
      ...shown.map((t) => {
        const row = make('article', undefined, 'wave-track'),
          cover = make('div', undefined, 'wave-cover');
        if (t.cover) {
          const img = make('img');
          img.src = '/modules/wave/cover/' + t.id;
          img.alt = '';
          img.loading = 'lazy';
          cover.append(img);
        } else cover.textContent = '♫';
        const info = button('Воспроизвести ' + t.title, () => play(t.id), '');
        info.className = 'wave-track-info';
        info.append(
          make('strong', t.title),
          make('span', [t.artist, t.album].filter(Boolean).join(' · '))
        );
        const length = make(
          'span',
          Math.floor(t.duration / 60) + ':' + String(Math.floor(t.duration % 60)).padStart(2, '0'),
          'wave-duration'
        );
        const favorite = button(
          t.favorite ? 'Убрать из избранного' : 'В избранное',
          () => change({action: 'favorite', id: t.id, favorite: !t.favorite}),
          t.favorite ? '♥' : '♡'
        );
        favorite.setAttribute('aria-pressed', String(t.favorite));
        const menu = button('Действия с треком', () => trackMenu(t), '⋯');
        row.append(cover, info, length, favorite, menu);
        return row;
      })
    );
    if (!shown.length)
      $('waveTracks').append(
        make(
          'p',
          data.tracks.length
            ? 'Треки не найдены.'
            : 'Загрузи музыку или сохрани трек из FlowMusic.',
          'wave-empty'
        )
      );
  }
  function play(id) {
    if (!host()) throw Error('Открой «Волну» через главную страницу хаба.');
    return host().playList(
      shown.map((t) => t.id),
      id
    );
  }
  function trackMenu(t) {
    dialog(
      t.title,
      (box) => {
        box.append(
          button('Добавить в очередь', async () => {
            await host()?.enqueue(t.id);
            $('waveDialog').close();
          })
        );
        const select = make('select');
        select.id = 'wavePlaylistTarget';
        select.setAttribute('aria-label', 'Плейлист');
        select.append(...data.playlists.map((p) => new Option(p.name, p.id)));
        box.append(select);
        box.append(
          button('Добавить в плейлист', async () => {
            if (!select.value) throw Error('Сначала создай плейлист.');
            await change({action: 'playlist.add', id: select.value, track: t.id});
            $('waveDialog').close();
          })
        );
        const current = data.playlists.find((p) => p.id === $('waveFilter').value);
        if (current)
          box.append(
            button('Убрать из плейлиста', async () => {
              await change({action: 'playlist.remove', id: current.id, track: t.id});
              $('waveDialog').close();
            })
          );
        const link = make('a', 'Скачать оригинал');
        link.href = '/modules/wave/original/' + t.id;
        link.download = '';
        box.append(link);
        const warning = make('p', 'Удаление уберёт трек из библиотеки и всех плейлистов.');
        box.append(warning);
      },
      () => change({action: 'delete', id: t.id}),
      'Удалить трек'
    );
  }
  $('waveCreate').onclick = () =>
    dialog(
      'Новый плейлист',
      (box) => {
        const input = make('input');
        input.id = 'wavePlaylistName';
        input.placeholder = 'Название';
        input.setAttribute('aria-label', 'Название плейлиста');
        input.maxLength = 80;
        input.required = true;
        box.append(input);
      },
      () => change({action: 'playlist.create', name: $('wavePlaylistName').value})
    );
  $('waveEditPlaylist').onclick = () => {
    const p = data.playlists.find((p) => p.id === $('waveFilter').value);
    dialog(
      'Плейлист',
      (box) => {
        const input = make('input');
        input.id = 'wavePlaylistName';
        input.value = p.name;
        input.maxLength = 80;
        input.required = true;
        input.setAttribute('aria-label', 'Название плейлиста');
        box.append(
          input,
          button('Удалить плейлист', () => {
            dialog(
              'Удалить плейлист?',
              (b) => b.append(make('p', 'Треки останутся в библиотеке.')),
              () => change({action: 'playlist.delete', id: p.id}),
              'Удалить'
            );
          })
        );
      },
      () => change({action: 'playlist.rename', id: p.id, name: $('wavePlaylistName').value})
    );
  };
  $('waveSearch').oninput = render;
  $('waveFilter').onchange = render;
  $('wavePlay').onclick = () => play(shown[0]?.id).catch((e) => status(e.message));
  $('waveUpload').onchange = async () => {
    const files = [...$('waveUpload').files];
    $('waveUpload').disabled = true;
    let added = 0,
      duplicates = 0,
      errors = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      status(`Загрузка ${i + 1}/${files.length} · ${file.name}`);
      try {
        if (file.size > 256 * 1024 * 1024) throw Error('Больше 256 МБ.');
        await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/modules/wave/upload?name=' + encodeURIComponent(file.name));
          xhr.timeout = 240000;
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable)
              status(
                `Загрузка ${i + 1}/${files.length} · ${Math.round((e.loaded / e.total) * 100)}%`
              );
          };
          xhr.upload.onload = () => status(`Чтение тегов и подготовка ${i + 1}/${files.length}…`);
          xhr.onload = () => {
            try {
              const d = JSON.parse(xhr.responseText);
              if (xhr.status !== 200) throw Error(d.error || 'Ошибка загрузки.');
              d.duplicate ? duplicates++ : added++;
              resolve();
            } catch (e) {
              reject(e);
            }
          };
          xhr.onerror = () => reject(Error('Нет соединения.'));
          xhr.ontimeout = () => reject(Error('Превышено время ожидания.'));
          xhr.send(file);
        });
      } catch (e) {
        errors.push(file.name + ': ' + e.message);
      }
    }
    $('waveUpload').disabled = false;
    $('waveUpload').value = '';
    await load();
    status(
      `Добавлено: ${added} · уже есть: ${duplicates}` +
        (errors.length ? ' · ' + errors.join('; ') : '')
    );
    await host()?.refresh();
  };
  async function load() {
    data = await api('/library');
    render();
  }
  load().catch((e) => status(e.message));
})();
