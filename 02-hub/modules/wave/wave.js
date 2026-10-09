import {catalog, nameKey, albumKey, trackYearOrder, artistCover} from './catalog.mjs';
const uploadPaths = new WeakMap();
export async function droppedFiles(dataTransfer, progress = () => {}) {
  const items = Array.from(dataTransfer.items || []).filter((item) => item.kind === 'file');
  const roots = items.map((item) => ({entry: item.webkitGetAsEntry?.(), file: item.getAsFile?.()}));
  const fallback = Array.from(dataTransfer.files || []);
  const files = [];
  let visited = 0;
  async function visit(entry, prefix = '', depth = 0) {
    if (++visited > 50000 || depth > 64)
      throw Error('Папка слишком большая или вложенная. Перенеси её частями.');
    const relative = prefix + entry.name;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      uploadPaths.set(file, relative);
      files.push(file);
      if (files.length > 10000) throw Error('За один раз можно добавить до 10 000 файлов.');
      progress(files.length);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await visit(child, relative + '/', depth + 1);
      }
    }
  }
  if (!roots.length) return fallback;
  for (const {entry, file} of roots) {
    if (entry) await visit(entry);
    else if (file) files.push(file);
  }
  return files;
}
if (typeof document !== 'undefined')
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
      submitDialog;
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
      library = undefined;
      data = await api('/change', payload);
      render();
      await host()?.refresh();
    }
    function button(label, handler, text = label) {
      const b = make('button', text);
      b.type = 'button';
      b.title = label;
      b.setAttribute('aria-label', label);
      b.onclick = async () => {
        try {
          await handler();
        } catch (e) {
          if ($('waveDialog').open) $('waveDialogError').textContent = e.message;
          else Nexus.problem($('waveStatus'), 'wave', e);
        }
      };
      return b;
    }
    function dialog(title, build, action, label = 'Сохранить') {
      $('waveDialogTitle').textContent = title;
      $('waveDialogBody').replaceChildren();
      $('waveDialogError').textContent = '';
      build($('waveDialogBody'));
      $('waveDialogSubmit').textContent = label;
      submitDialog = action;
      $('waveDialog').showModal();
    }
    $('waveDialogClose').onclick = () => $('waveDialog').close();
    $('waveDialogForm').onsubmit = async (e) => {
      e.preventDefault();
      $('waveDialogSubmit').disabled = true;
      try {
        await submitDialog();
        $('waveDialog').close();
      } catch (e) {
        $('waveDialogError').textContent = e.message;
      } finally {
        $('waveDialogSubmit').disabled = false;
      }
    };
    function artistArt(artist) {
      const box = make('div', undefined, 'wave-art artist'),
        cover = artistCover(artist, data.artistProfiles);
      if (cover) {
        const image = make('img');
        image.src = cover;
        image.alt = '';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.onerror = () => {
          image.remove();
          box.textContent = artist.name.slice(0, 2).toLocaleUpperCase('ru');
        };
        box.append(image);
      } else box.textContent = artist.name.slice(0, 2).toLocaleUpperCase('ru');
      return box;
    }
    function editArtist(artist) {
      const profile = (data.artistProfiles || []).find((p) => p.key === artist.key) || {};
      dialog(
        'Профиль артиста',
        (box) => {
          for (const [key, title, value] of [
            ['Name', 'Имя / название группы', artist.name],
            ['Bio', 'Об артисте', profile.bio || '']
          ]) {
            const label = make('label', title),
              field = make(key === 'Bio' ? 'textarea' : 'input');
            field.id = 'waveArtist' + key;
            field.value = value;
            field.maxLength = key === 'Bio' ? 1000 : 180;
            field.required = key === 'Name';
            label.append(field);
            box.append(label);
          }
          const image = make('img');
          image.className = 'wave-profile-preview';
          image.alt = 'Фото артиста';
          const cover = artistCover(artist, data.artistProfiles);
          image.hidden = !cover;
          if (cover) image.src = cover;
          const label = make('label', 'Фото · JPEG, PNG или WebP · до 8 МБ'),
            input = make('input');
          input.type = 'file';
          input.accept = '.jpg,.jpeg,.png,.webp';
          input.id = 'waveArtistPhoto';
          label.append(input);
          const note = make('p', 'Фото сохраняется после выбора файла.', 'wave-muted');
          note.setAttribute('role', 'status');
          input.onchange = async () => {
            const file = input.files[0];
            if (!file) return;
            input.disabled = $('waveDialogSubmit').disabled = true;
            note.textContent = 'Сохранение фото…';
            try {
              if (file.size > 8 * 1024 * 1024) throw Error('Фото — не больше 8 МБ.');
              const response = await fetch(
                '/modules/wave/artist-photo?key=' + encodeURIComponent(artist.key),
                {
                  method: 'POST',
                  headers: {'Content-Type': file.type || 'application/octet-stream'},
                  body: file
                }
              );
              if (response.redirected) throw Error('Войди в хаб заново.');
              const result = await response.json();
              if (!response.ok) throw Error(result.error || 'Не удалось загрузить фото.');
              data = result;
              library = undefined;
              render();
              image.src =
                '/modules/wave/artist-photo/' +
                data.artistProfiles.find((p) => p.key === artist.key).photo;
              image.hidden = false;
              note.textContent = 'Фото сохранено.';
            } catch (e) {
              note.textContent = e.message;
            } finally {
              input.disabled = $('waveDialogSubmit').disabled = false;
              input.value = '';
            }
          };
          const removeLabel = make('label', 'Убрать фото'),
            remove = make('input');
          remove.type = 'checkbox';
          remove.id = 'waveArtistRemovePhoto';
          removeLabel.prepend(remove);
          box.append(image, label, note, removeLabel);
        },
        async () => {
          const name = $('waveArtistName').value;
          await change({
            action: 'artist.save',
            key: artist.key,
            name,
            bio: $('waveArtistBio').value,
            removePhoto: $('waveArtistRemovePhoto').checked
          });
          go('artist', nameKey(name));
        }
      );
    }
    function editRelease(release) {
      dialog(
        'Данные релиза',
        (box) => {
          box.append(make('p', release.name));
          const label = make('label', 'Тип'),
            select = make('select');
          select.id = 'waveReleaseType';
          select.append(new Option('Альбом', 'album'), new Option('Сингл', 'single'));
          select.value = release.type;
          label.append(select);
          const yearLabel = make('label', 'Год релиза'),
            year = make('input');
          year.id = 'waveReleaseYear';
          year.type = 'number';
          year.min = '1000';
          year.max = '9999';
          year.step = '1';
          year.placeholder = 'Не указан';
          year.value = release.year || '';
          yearLabel.append(year);
          box.append(label, yearLabel);
        },
        () =>
          change({
            action: 'release.type',
            key: release.key,
            type: $('waveReleaseType').value,
            year: $('waveReleaseYear').value
          })
      );
    }
    let selecting = false;
    const selected = new Set();
    function selectionPaint() {
      const live = new Set(data.tracks.map((t) => t.id));
      for (const id of selected) if (!live.has(id)) selected.delete(id);
      $('waveSelection').hidden = !selecting;
      $('waveSelectedCount').textContent = 'Выбрано: ' + selected.size;
      $('waveDeleteSelected').disabled = !selected.size;
      $('waveSelectAll').checked = shown.length > 0 && shown.every((t) => selected.has(t.id));
      $('waveSelectAll').indeterminate =
        shown.some((t) => selected.has(t.id)) && !$('waveSelectAll').checked;
      $('waveSelect').textContent = selecting ? 'Завершить выбор' : 'Выбрать';
    }
    $('waveSelect').onclick = () => {
      selecting = !selecting;
      selected.clear();
      render();
    };
    $('waveCancelSelect').onclick = () => {
      selecting = false;
      selected.clear();
      render();
    };
    $('waveSelectAll').onchange = () => {
      for (const t of shown)
        $('waveSelectAll').checked ? selected.add(t.id) : selected.delete(t.id);
      render();
    };
    $('waveDeleteSelected').onclick = () => {
      const ids = [...selected];
      if (!ids.length) return;
      dialog(
        'Удалить выбранные треки?',
        (box) =>
          box.append(
            make('p', `${ids.length} треков будут удалены из библиотеки, плейлистов и с сервера.`)
          ),
        async () => {
          await change({action: 'delete.many', ids});
          selected.clear();
          selectionPaint();
        },
        'Удалить'
      );
    };
    let uploadFiles = [],
      scanningUploads = false;
    function uploadState() {
      const transfer = host()?.transfer?.();
      const running = Boolean(transfer?.running);
      if (transfer?.message) status(transfer.message);
      $('waveUploadMessage').textContent = transfer?.message || '';
      $('waveUploadStart').disabled = running || scanningUploads || !uploadFiles.length;
      $('waveUploadClear').disabled = running || scanningUploads || !uploadFiles.length;
      $('waveChooseFiles').disabled = running || scanningUploads;
      $('waveUploadStop').hidden = !running;
      const progress = $('waveUploadProgress');
      progress.hidden = !transfer?.total;
      progress.value = transfer?.total
        ? Math.min(
            100,
            (100 * (transfer.done + (running ? transfer.percent / 100 : 0))) / transfer.total
          )
        : 0;
    }
    function chooseUploads(files) {
      if (host()?.transfer?.().running) return;
      let skipped = 0;
      const keys = new Set(
        uploadFiles.map((f) =>
          JSON.stringify([uploadPaths.get(f) || f.name, f.size, f.lastModified])
        )
      );
      for (const file of files) {
        if (!/\.(mp3|m4a|aac|wav|flac|ogg|opus|webm)$/i.test(file.name)) {
          skipped++;
          continue;
        }
        const key = JSON.stringify([
          uploadPaths.get(file) || file.name,
          file.size,
          file.lastModified
        ]);
        if (!keys.has(key)) {
          keys.add(key);
          uploadFiles.push(file);
        }
      }
      $('waveUploadList').replaceChildren(
        ...uploadFiles.slice(0, 200).map((f) => make('li', uploadPaths.get(f) || f.name))
      );
      if (uploadFiles.length > 200)
        $('waveUploadList').append(make('li', `Ещё ${uploadFiles.length - 200} файлов`));
      $('waveUploadSummary').textContent =
        `Выбрано: ${uploadFiles.length} · ${(uploadFiles.reduce((n, f) => n + f.size, 0) / 1048576).toFixed(1)} МиБ` +
        (skipped ? ` · пропущено: ${skipped}` : '');
      uploadState();
    }
    async function startUpload() {
      if (scanningUploads || !uploadFiles.length || host()?.transfer?.().running) return;
      try {
        if (!host()?.upload) throw Error('Открой «Орфей» через главную страницу хаба.');
        const pending = host().upload(uploadFiles);
        uploadState();
        await pending;
        uploadFiles = uploadFiles.slice(host().transfer().done);
        chooseUploads([]);
        await load();
      } catch (e) {
        $('waveUploadMessage').textContent = e.message;
        Nexus.problem($('waveStatus'), 'wave', e);
      }
    }
    const views = [
      ['home', 'Для тебя'],
      ['artists', 'Артисты'],
      ['albums', 'Альбомы'],
      ['tracks', 'Треки'],
      ['favorite', 'Избранное'],
      ['playlists', 'Плейлисты']
    ];
    let playlistsOpen = false;
    let route,
      library,
      limit = 100;
    const clock = (n) =>
      Math.floor((n || 0) / 60) + ':' + String(Math.floor((n || 0) % 60)).padStart(2, '0');
    const duration = (tracks) => {
      const minutes = Math.round(tracks.reduce((sum, t) => sum + t.duration, 0) / 60);
      return minutes >= 60
        ? Math.floor(minutes / 60) + ' ч ' + (minutes % 60) + ' мин'
        : minutes + ' мин';
    };
    const currentPlaylist = () =>
      route.view === 'playlist' ? data.playlists.find((p) => p.id === route.id) : null;
    function readRoute() {
      const p = new URLSearchParams(location.search);
      route = {view: p.get('view') || 'home', id: p.get('id') || ''};
      const focused=data.tracks.find(t=>t.id===p.get('track'));if(focused){route.view='tracks';$('waveSearch').value=focused.title;}
      if (![...views.map((v) => v[0]), 'artist', 'album', 'playlist'].includes(route.view))
        route.view = 'home';
    }
    function url(view, id = '') {
      const u = new URL('/modules/wave/', location.origin);
      if (view !== 'home') u.searchParams.set('view', view);
      if (id) u.searchParams.set('id', id);
      return u;
    }
    function go(view, id = '') {
      history.pushState(null, '', url(view, id));
      readRoute();
      selecting = false;
      selected.clear();
      limit = 100;
      $('waveSearch').value = '';
      $('waveSort').value = 'default';
      if (view === 'playlist') playlistsOpen = true;
      render();
      scrollTo({top:0, left:0, behavior:'instant'});
    }
    function link(title, view, id = '', cls = '') {
      const a = make('a', title, cls);
      a.href = url(view, id).pathname + url(view, id).search;
      a.dataset.waveNav = '';
      a.onclick = (e) => {
        if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        go(view, id);
      };
      return a;
    }
    function artwork(tracks, kind = '') {
      const box = make('div', undefined, 'wave-art ' + kind),
        cover = tracks.find((t) => t.cover);
      if (cover) {
        const img = make('img');
        img.src = '/modules/wave/cover/' + cover.id;
        img.alt = '';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.onerror = () => {
          img.remove();
          box.textContent = '♫';
        };
        box.append(img);
      } else box.append(make('span', kind === 'artist' ? '◉' : '♫'));
      return box;
    }
    function groupCard(group, type) {
      const tracks = group.tracks
        .map((t) => (typeof t === 'string' ? data.tracks.find((x) => x.id === t) : t))
        .filter(Boolean);
      const card = link('', type, group.key || group.id, 'wave-card');
      card.append(
        type === 'artist' ? artistArt(group) : artwork(tracks),
        make('strong', group.name),
        make(
          'span',
          type === 'album'
            ? [group.year || 'Год не указан', group.artist].join(' · ')
            : tracks.length + ' треков'
        )
      );
      return card;
    }
    function section(title, groups, type, view, max = groups.length) {
      if (!groups.length) return;
      const section = make('section', undefined, 'wave-section'),
        heading = make('div', undefined, 'wave-section-head'),
        grid = make('div', undefined, 'wave-card-grid');
      if (!['artists', 'albums', 'playlists'].includes(route.view))
        heading.append(make('h3', title));
      if (view) heading.append(link('Все →', view));
      grid.append(...groups.slice(0, max).map((g) => groupCard(g, type)));
      section.append(heading, grid);
      $('waveBrowse').append(section);
    }
    function render() {
      library ??= catalog(data.tracks);
      const playlist = currentPlaylist(),
        artist = library.artists.find((a) => a.key === route.id),
        album = library.releases.find((a) => a.key === route.id);
      const q = $('waveSearch').value.trim().toLocaleLowerCase('ru');
      $('wavePage').dataset.view = route.view;
      $('wavePage').classList.toggle('wave-searching', !!q);
      const matches = (t) =>
        [t.title, t.artist, t.album].join(' ').toLocaleLowerCase('ru').includes(q);
      const groupMatches = (g) =>
        [g.name, g.artist].join(' ').toLocaleLowerCase('ru').includes(q) ||
        g.tracks.some((t) =>
          matches(typeof t === 'string' ? data.tracks.find((x) => x.id === t) || {} : t)
        );
      $('waveNav').replaceChildren(
        ...views.map(([value, title]) => {
          const a = link(title, value);
          if (route.view === value || route.view === value.slice(0, -1))
            a.setAttribute('aria-current', 'page');
          if (value !== 'playlists') return a;
          a.setAttribute('aria-expanded', String(playlistsOpen));
          a.setAttribute('aria-controls', 'wavePlaylists');
          a.onclick = (e) => {
            if (e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            playlistsOpen = !playlistsOpen;
            if (route.view !== 'playlists') go('playlists');
            else render();
          };
          const row = make('div', undefined, 'wave-playlist-heading');
          const add = button('Создать плейлист', createPlaylist, '+');
          add.id = 'waveCreate';
          row.append(a, add);
          return row;
        })
      );
      $('wavePlaylists').hidden = !playlistsOpen;
      $('wavePlaylists').replaceChildren(
        ...data.playlists.map((p) => {
          const a = link(p.name, 'playlist', p.id);
          if (playlist === p) a.setAttribute('aria-current', 'page');
          return a;
        })
      );
      if (!data.playlists.length)
        $('wavePlaylists').append(make('span', 'Пока пусто', 'wave-muted'));
      $('waveHero').replaceChildren();
      $('waveBrowse').replaceChildren();
      let tracks = data.tracks,
        title = views.find((v) => v[0] === route.view)?.[1] || '',
        subtitle = '',
        art = null;
      if (route.view === 'artist') {
        tracks = artist?.tracks || [];
        title = artist?.name || 'Артист не найден';
        subtitle = 'Артист';
        art = artistArt(artist || {key: route.id, name: '?'});
      }
      if (route.view === 'album') {
        tracks = album?.tracks || [];
        title = album?.name || 'Релиз не найден';
        subtitle = [
          album?.type === 'single' ? 'Сингл' : 'Альбом',
          album?.year || 'Год не указан',
          album?.artist
        ]
          .filter(Boolean)
          .join(' · ');
        art = artwork(tracks);
      }
      if (route.view === 'playlist') {
        tracks = (playlist?.tracks || [])
          .map((id) => data.tracks.find((t) => t.id === id))
          .filter(Boolean);
        title = playlist?.name || 'Плейлист не найден';
        subtitle = 'Плейлист';
        art = artwork(tracks);
      }
      if (route.view === 'favorite') {
        tracks = tracks.filter((t) => t.favorite);
        subtitle = 'Твоя коллекция';
      }
      if (route.view === 'home') {
        title = q ? 'Результаты поиска' : 'Твоя музыка';
        subtitle = q ? '' : 'Любимое всегда рядом';
      }
      if (route.view === 'favorite') art = make('div', '♥', 'wave-art wave-liked-art');
      const hero = make('div', undefined, 'wave-hero'),
        heading = make('div', undefined, 'wave-hero-text');
      if (art) hero.append(art);
      if (subtitle) heading.append(make('span', subtitle, 'wave-muted'));
      heading.append(make('h2', title));
      if (route.view === 'artist' && artist) {
        const profile = (data.artistProfiles || []).find((p) => p.key === artist.key);
        if (profile?.bio) heading.append(make('p', profile.bio, 'wave-artist-bio'));
        const actions = make('div', undefined, 'wave-hero-actions');
        actions.append(button('Редактировать профиль', () => editArtist(artist)));
        heading.append(actions);
      }
      $('waveEditRelease')?.remove();
      if (route.view === 'album' && album) {
        const edit = button('Изменить релиз', () => editRelease(album), '');
        edit.id = 'waveEditRelease';
        edit.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m16 3 5 5-12 12-6 1 1-6Z M13 6l5 5"/></svg>';
        $('waveUploadButton').after(edit);
      }
      hero.append(heading);
      $('waveHero').append(hero);
      shown = tracks.filter(matches);
      const sort = $('waveSort').value;
      $('waveSort').options[0].textContent = ['album', 'playlist'].includes(route.view)
        ? 'По порядку'
        : 'По году релиза';
      $('waveSort').querySelector('[value=year]').hidden = !['album', 'playlist'].includes(
        route.view
      );
      if (sort === 'year' || (sort === 'default' && !['album', 'playlist'].includes(route.view)))
        shown.sort(trackYearOrder);
      else if (sort === 'duration') shown.sort((a, b) => b.duration - a.duration);
      else if (sort === 'artist')
        shown.sort(
          (a, b) => a.artist.localeCompare(b.artist, 'ru') || a.title.localeCompare(b.title, 'ru')
        );
      else if (sort === 'name' || !['album', 'playlist'].includes(route.view))
        shown.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
      const home = route.view === 'home' && !q;
      const browsing = home || ['artists', 'albums', 'playlists'].includes(route.view);
      if (home && data.tracks.length) {
        const quick = make('div', undefined, 'wave-quick');
        const liked = link('', 'favorite', '', 'wave-quick-item');
        liked.append(make('span', '♥', 'wave-quick-art wave-liked-art'), make('strong', 'Избранное'));
        quick.append(liked);
        for (const album of library.releases.slice(0, 5)) {
          const item = link('', 'album', album.key, 'wave-quick-item');
          item.append(artwork(album.tracks), make('strong', album.name));
          quick.append(item);
        }
        $('waveBrowse').append(quick);
        section('Твои альбомы', library.releases, 'album', 'albums', 12);
        section('Твои артисты', library.artists, 'artist', 'artists', 12);
        section('Твои плейлисты', data.playlists, 'playlist', 'playlists', 8);
      }
      if (route.view === 'artists')
        section('Артисты', library.artists.filter(groupMatches), 'artist', null, limit);
      if (route.view === 'albums')
        section('Альбомы', library.albums.filter(groupMatches), 'album', null, limit);
      if (route.view === 'playlists')
        section('Плейлисты', data.playlists.filter(groupMatches), 'playlist', null, limit);
      if (route.view === 'artist' && artist)
        section(
          'Альбомы',
          library.albums.filter((a) => artist.albums.has(a.key) && groupMatches(a)),
          'album',
          null
        );
      if (route.view === 'artist' && artist)
        section(
          'Синглы',
          library.singles.filter((a) => artist.albums.has(a.key) && groupMatches(a)),
          'album',
          null
        );
      $('waveCount').textContent = shown.length + ' треков · ' + duration(shown);
      $('waveEditPlaylist').hidden = !playlist;
      $('wavePlay').disabled = $('waveMix').disabled = !shown.length;
      $('wavePlay').hidden = $('waveMix').hidden = browsing;
      $('waveSort').hidden = browsing;
      document.querySelector('.wave-secondary').hidden = home;
      const visible = browsing ? [] : shown.slice(0, limit);
      $('waveTracks').replaceChildren(...visible.map(trackRow));
      let count = shown.length;
      if (browsing && !home)
        count = (
          route.view === 'artists'
            ? library.artists
            : route.view === 'albums'
              ? library.albums
              : data.playlists
        ).filter(groupMatches).length;
      if (browsing && !home)
        $('waveCount').textContent =
          {artists: 'Артистов', albums: 'Альбомов', singles: 'Синглов', playlists: 'Плейлистов'}[
            route.view
          ] +
          ': ' +
          count;
      $('waveMore').hidden = home || count <= limit;
      if (!count)
        $('waveTracks').append(
          Nexus.empty(route.view === 'playlists' ? 'Пока нет плейлистов' : 'Здесь пока нет музыки', data.tracks.length ? 'Выбери другой раздел или добавь музыку.' : 'Загрузи аудиофайлы или сохрани трек из Сократа.', route.view === 'playlists' ? 'Создать плейлист' : 'Добавить музыку', () => route.view === 'playlists' ? createPlaylist() : $('waveUploadButton').click())
        );
      $('waveSelect').hidden = browsing || !shown.length;
      selectionPaint();
      paintPlaying();
    }
    function trackRow(t) {
      const row = make('article', undefined, 'wave-track');
      row.dataset.track = t.id;
      const start = button('Воспроизвести ' + t.title, () => play(t.id), '');
      start.className = 'wave-track-start';
      start.append(artwork([t]), make('span', '▶', 'wave-track-play'));
      const info = make('div', undefined, 'wave-track-info'),
        title = button('Воспроизвести ' + t.title, () => play(t.id), t.title),
        meta = make('div', undefined, 'wave-track-meta');
      title.className = 'wave-track-title';
      meta.append(link(t.artist, 'artist', nameKey(t.artist)));
      if (t.album)
        meta.append(make('span', '·'), link(t.album, 'album', albumKey(t), 'wave-album-link'));
      info.append(title, meta);
      const favorite = button(
        t.favorite ? 'Убрать из избранного' : 'В избранное',
        () => change({action: 'favorite', id: t.id, favorite: !t.favorite}),
        t.favorite ? '♥' : '♡'
      );
      favorite.className = 'wave-favorite';
      favorite.setAttribute('aria-pressed', String(t.favorite));
      const menu = button('Действия с треком', () => trackMenu(t), '⋯');
      menu.className = 'wave-track-menu';
      if (selecting) {
        const check = make('input');
        check.type = 'checkbox';
        check.checked = selected.has(t.id);
        check.setAttribute('aria-label', 'Выбрать ' + t.title);
        check.onchange = () => {
          check.checked ? selected.add(t.id) : selected.delete(t.id);
          selectionPaint();
        };
        row.append(check);
      }
      row.append(start, info, make('span', clock(t.duration), 'wave-duration'), favorite, menu);
      return row;
    }
    function paintPlaying() {
      const state = host()?.state?.();
      document.querySelectorAll('.wave-track').forEach((row) => {
        const current = row.dataset.track === state?.id;
        row.classList.toggle('is-current', current);
        row.querySelector('.wave-track-play').textContent = current && state.playing ? 'Ⅱ' : '▶';
        row
          .querySelector('.wave-track-start')
          .setAttribute('aria-label', current && state.playing ? 'Пауза' : 'Воспроизвести');
      });
    }
    function play(id, shuffle = false) {
      if (!host()) throw Error('Открой «Орфей» через главную страницу хаба.');
      if (!shuffle && host().state?.().id === id && host().state().playing) {
        host().pause();
        return;
      }
      return host().playList(
        shown.map((t) => t.id),
        id,
        {shuffle}
      );
    }
    function trackMenu(t) {
      dialog(
        t.title,
        (box) => {
          box.append(button('Изменить данные трека', () => editTrack(t)));
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
          const current = currentPlaylist();
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
    function editTrack(t) {
      dialog(
        'Данные трека',
        (box) => {
          for (const [key, title] of [
            ['title', 'Название'],
            ['artist', 'Артист'],
            ['album', 'Альбом'],
            ['albumArtist', 'Артист альбома'],
            ['trackNumber', 'Номер трека']
          ]) {
            const label = make('label', title),
              input = make('input');
            input.id = 'waveEdit-' + key;
            input.value = t[key] || '';
            input.maxLength = 180;
            input.required = key === 'title';
            if (key === 'trackNumber') {
              input.type = 'number';
              input.min = '0';
              input.max = '9999';
            }
            label.append(input);
            box.append(label);
          }
        },
        () =>
          change({
            action: 'track.edit',
            id: t.id,
            ...Object.fromEntries(
              ['title', 'artist', 'album', 'albumArtist', 'trackNumber'].map((key) => [
                key,
                $('waveEdit-' + key).value
              ])
            )
          })
      );
    }
    const createPlaylist = () =>
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
        async () => {
          const before = new Set(data.playlists.map((p) => p.id));
          await change({action: 'playlist.create', name: $('wavePlaylistName').value});
          const created = data.playlists.find((p) => !before.has(p.id));
          if (created) go('playlist', created.id);
        }
      );
    $('waveEditPlaylist').onclick = () => {
      const p = currentPlaylist();
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
                async () => {
                  await change({action: 'playlist.delete', id: p.id});
                  go('playlists');
                },
                'Удалить'
              );
            })
          );
        },
        () => change({action: 'playlist.rename', id: p.id, name: $('wavePlaylistName').value})
      );
    };
    let searchTimer;
    $('waveSearch').oninput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        limit = 100;
        render();
      }, 120);
    };
    $('waveSort').onchange = render;
    $('waveMore').onclick = () => {
      limit += 100;
      render();
    };
    $('waveUploadButton').onclick = () => {
      uploadState();
      $('waveUploadDialog').showModal();
    };
    $('waveUploadClose').onclick = () => $('waveUploadDialog').close();
    $('waveChooseFiles').onclick = () => $('waveUpload').click();
    $('waveUploadStart').onclick = startUpload;
    $('waveUploadClear').onclick = () => {
      uploadFiles = [];
      chooseUploads([]);
    };
    $('waveUploadStop').onclick = () => host()?.cancelUpload?.();
    const dropZone = $('waveDropZone');
    dropZone.ondragover = (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = scanningUploads || host()?.transfer?.().running ? 'none' : 'copy';
      dropZone.classList.add('dragging');
    };
    dropZone.ondragleave = () => dropZone.classList.remove('dragging');
    dropZone.ondrop = async (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragging');
      if (scanningUploads || host()?.transfer?.().running) return;
      scanningUploads = true;
      uploadState();
      $('waveUploadSummary').textContent = 'Читаю папку…';
      try {
        const files = await droppedFiles(e.dataTransfer, (count) => {
          $('waveUploadSummary').textContent = `Найдено файлов: ${count}…`;
        });
        chooseUploads(files);
        if (!files.length)
          $('waveUploadSummary').textContent =
            'В папке нет файлов. Можно выбрать треки кнопкой «Выбрать файлы».';
      } catch (error) {
        $('waveUploadSummary').textContent =
          error.message || 'Не удалось прочитать папку. Попробуй выбрать файлы.';
      } finally {
        scanningUploads = false;
        uploadState();
      }
    };
    for (const name of ['dragover', 'drop'])
      document.addEventListener(name, (e) => e.preventDefault());
    $('wavePlay').onclick = () =>
      Promise.resolve(play(shown[0]?.id)).catch((e) => Nexus.problem($('waveStatus'), 'wave', e));
    $('waveMix').onclick = () =>
      Promise.resolve(play(shown[Math.floor(Math.random() * shown.length)]?.id, true)).catch((e) =>
        Nexus.problem($('waveStatus'), 'wave', e)
      );
    addEventListener('popstate', () => {
      readRoute();
      selecting = false;
      selected.clear();
      render();
    });
    addEventListener('message', (e) => {
      if (
        e.origin === location.origin &&
        e.source === window.parent &&
        e.data?.type === 'nexus:wave-state'
      )
        paintPlaying();
      if (
        e.origin === location.origin &&
        e.source === window.parent &&
        e.data?.type === 'nexus:wave-upload'
      ) {
        uploadState();
        if (!host()?.transfer()?.running) load().catch((e) => Nexus.problem($('waveStatus'), 'wave', e));
      }
    });
    readRoute();
    $('waveUpload').onchange = () => {
      chooseUploads([...$('waveUpload').files]);
      $('waveUpload').value = '';
    };
    const view = Nexus.rememberView?.(['waveSearch','waveSort'], () => ({limit}));
    async function load() {
      data = await api('/library');
      readRoute();
      if (view?.restore()) limit = view.value.limit || 100;
      library = undefined;
      render();
      uploadState();
    }
    load().catch((e) => Nexus.problem($('waveStatus'), 'wave', e));
  })();
