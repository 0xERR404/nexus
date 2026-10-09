(() => {
  const $ = (id) => document.getElementById(id),
    page = $('contentPage');
  if (!page) return;
  const kind = page.dataset.kind,
    base = '/modules/' + kind;
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const status = (message) => {
    $('contentStatus').textContent = message;
  };
  const date = (time) => new Date(time).toLocaleString('ru-RU');
  const splitTags = (value) => [
    ...new Set(
      value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean)
    )
  ];
  const request = async (route, data, opts = {}) => {
    const r = await fetch(base + route, {
      credentials: 'same-origin',
      cache: 'no-store',
      signal: AbortSignal.timeout(45000),
      ...(data === undefined
        ? {}
        : {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
          }),
      ...opts
    });
    let value;
    try {
      value = await r.json();
    } catch {
      throw Error('Не удалось прочитать ответ сервера.');
    }
    if (!r.ok) throw Object.assign(Error(value.error || 'Не удалось выполнить действие.'), {status:r.status});
    return value;
  };
  let actionPending = false;
  async function action(fn) {
    if (actionPending) return;
    actionPending = true;
    document.querySelectorAll('.content-error').forEach((n) => n.remove());
    try {
      await fn();
    } catch (e) {
      Nexus.problem($('contentStatus'), kind, e);
      const opened = [...document.querySelectorAll('.content-dialog[open]')];
      if (opened.length) {
        const alert = node('p', undefined, 'content-error');
        Nexus.problem(alert, kind, e);
        alert.setAttribute('role', 'alert');
        opened.at(-1).prepend(alert);
      }
    } finally { actionPending = false; }
  }
  document
    .querySelectorAll('[data-close]')
    .forEach((b) => (b.onclick = () => b.closest('dialog').close()));
  let images = [],
    albums = [],
    list = [],
    currentImage,
    shown = [],
    imageLimit = 80;
  const view = Nexus.rememberView?.(kind === 'gallery' ? ['contentSearch','albumFilter','tagFilter'] : ['contentSearch','articleFilter','tagFilter'], () => ({limit:imageLimit}));
  const select = (el, values, empty) => {
    const chosen = el.value;
    el.replaceChildren(new Option(empty, ''), ...values.map((v) => new Option(v, v)));
    el.value = chosen;
  };
  const imageURL = (id, thumb = false) => base + (thumb ? '/thumb/' : '/file/') + id;
  function imageCard(item, click) {
    const b = node('button', undefined, 'gallery-card');
    b.type = 'button';
    const img = node('img');
    img.src = imageURL(item.id, true);
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.onerror = () => {
      img.classList.add('image-missing');
      img.alt = 'Миниатюра недоступна';
    };
    b.append(img, node('span', item.name));
    b.title = item.name;
    b.onclick = () => click(item);
    return b;
  }
  function renderImages(reset = true) {
    if (reset !== false) imageLimit = 80;
    const q = $('contentSearch').value.toLocaleLowerCase(),
      album = $('albumFilter').value,
      tag = $('tagFilter').value;
    shown = images.filter(
      (i) =>
        (!album || i.album === album) &&
        (!tag || i.tags.includes(tag)) &&
        [i.name, ...i.tags].join(' ').toLocaleLowerCase().includes(q)
    );
    const host = $('contentList');
    host.replaceChildren(...shown.slice(0, imageLimit).map((i) => imageCard(i, openImage)));
    $('galleryMore').hidden = shown.length <= imageLimit;
    if (!shown.length)
      host.append(
        Nexus.empty(images.length ? 'Ничего не найдено' : 'Галерея пуста', images.length ? 'Попробуй другой поиск или альбом.' : 'Добавь изображения и собери их в альбомы.', images.length ? 'Сбросить фильтры' : 'Добавить изображения', () => { if(images.length) { for(const id of ['contentSearch','albumFilter','tagFilter']) $(id).value=''; renderImages(); } else $('imageUpload').click(); })
      );
  }
  async function loadImages() {
    const data = await request('/images');
    images = data.images;
    albums = data.albums;
    if (kind === 'gallery') {
      select($('albumFilter'), albums, 'Все альбомы');
      select($('tagFilter'), [...new Set(images.flatMap((i) => i.tags))].sort(), 'Все теги');
      if (view?.restore()) { imageLimit = view.value.limit || 80; renderImages(false); }
      else renderImages();
    }
  }
  let zoom = 1,
    panX = 0,
    panY = 0;
  function transform() {
    $('imageFull').style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
    $('zoomReset').textContent = Math.round(zoom * 100) + '%';
  }
  function changeZoom(value) {
    zoom = Math.min(6, Math.max(1, value));
    if (zoom === 1) panX = panY = 0;
    transform();
  }
  function openImage(item) {
    currentImage = item;
    zoom = 1;
    panX = panY = 0;
    $('imageTitle').textContent = item.name;
    $('imageFull').src = imageURL(item.id);
    $('imageFull').alt = item.name;
    $('imageDownload').href = imageURL(item.id) + '?download=1';
    transform();
    if (!$('imageViewer').open) $('imageViewer').showModal();
  }
  if (kind === 'gallery') {
    $('galleryMore').onclick = () => {
      imageLimit += 80;
      renderImages(false);
    };
    $('contentSearch').oninput = renderImages;
    $('albumFilter').onchange = renderImages;
    $('tagFilter').onchange = renderImages;
    $('newAlbum').onclick = () => {
      $('albumName').value = '';
      $('albumEditor').showModal();
    };
    $('albumForm').onsubmit = (e) => {
      e.preventDefault();
      void action(async () => {
        await request('/album', {name: $('albumName').value});
        await loadImages();
        $('albumEditor').close();
      });
    };
    let uploading = false;
    $('imageUpload').onchange = () =>
      void action(async () => {
        if (uploading) return;
        const files = [...$('imageUpload').files];
        uploading = true;
        $('imageUpload').disabled = true;
        let done = 0,
          failed = [];
        try {
          for (const file of files) {
            status(`Загрузка ${done + failed.length + 1} / ${files.length} · ${file.name}`);
            try {
              if (file.size > 20 * 1024 * 1024) throw Error('Больше 20 МБ');
              await request('/upload', undefined, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/octet-stream',
                  'X-File-Name': encodeURIComponent(file.name)
                },
                body: file
              });
              done++;
            } catch (e) {
              failed.push(file.name + ': ' + e.message);
            }
          }
          await loadImages();
          status(
            `Загружено: ${done} / ${files.length}` + (failed.length ? '\n' + failed.join('\n') : '')
          );
        } finally {
          uploading = false;
          $('imageUpload').disabled = false;
          $('imageUpload').value = '';
        }
      });
    $('zoomIn').onclick = () => changeZoom(zoom * 1.3);
    $('zoomOut').onclick = () => changeZoom(zoom / 1.3);
    $('zoomReset').onclick = () => changeZoom(1);
    for (const [id, step] of [
      ['imagePrev', -1],
      ['imageNext', 1]
    ])
      $(id).onclick = () => {
        if (shown.length)
          openImage(
            shown[
              (shown.findIndex((i) => i.id === currentImage.id) + step + shown.length) %
                shown.length
            ]
          );
      };
    const stage = $('imageStage'),
      pointers = new Map();
    let gesture;
    const measure = () => {
      const p = [...pointers.values()];
      return p.length > 1
        ? {
            x: (p[0].x + p[1].x) / 2,
            y: (p[0].y + p[1].y) / 2,
            d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
          }
        : {...p[0], d: 0};
    };
    stage.onpointerdown = (e) => {
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
      gesture = measure();
    };
    stage.onpointermove = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
      const next = measure();
      if (gesture?.d && next.d) zoom = Math.min(6, Math.max(1, (zoom * next.d) / gesture.d));
      if (zoom > 1 && gesture) {
        panX += next.x - gesture.x;
        panY += next.y - gesture.y;
      } else panX = panY = 0;
      gesture = next;
      transform();
    };
    stage.onpointerup = stage.onpointercancel = (e) => {
      pointers.delete(e.pointerId);
      gesture = pointers.size ? measure() : null;
    };
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        changeZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      },
      {passive: false}
    );
    stage.ondblclick = () => changeZoom(zoom === 1 ? 2 : 1);
    $('imageViewer').addEventListener('close', () => {
      pointers.clear();
      gesture = null;
      $('imageFull').removeAttribute('src');
    });
    $('imageEdit').onclick = () => {
      $('imageName').value = currentImage.name;
      select($('imageAlbum'), albums, 'Без альбома');
      $('imageAlbum').value = currentImage.album;
      $('imageTags').value = currentImage.tags.join(', ');
      $('imageEditor').showModal();
    };
    $('imageMetaForm').onsubmit = (e) => {
      e.preventDefault();
      void action(async () => {
        const item = await request('/image/edit', {
          id: currentImage.id,
          name: $('imageName').value,
          album: $('imageAlbum').value,
          tags: splitTags($('imageTags').value)
        });
        await loadImages();
        $('imageEditor').close();
        openImage(item);
      });
    };
    $('imageDelete').onclick = () => $('deleteConfirm').showModal();
    $('confirmDelete').onclick = () =>
      void action(async () => {
        await request('/image/delete', {id: currentImage.id});
        for (const id of ['deleteConfirm', 'imageEditor', 'imageViewer']) $(id).close();
        await loadImages();
        status('Изображение удалено.');
      });
    Nexus.beforeLeave?.(() => !uploading && !actionPending);
    void action(async () => {
      await loadImages();
      const id = new URLSearchParams(location.search).get('image');
      const item = images.find(i => i.id === id);
      if (item) openImage(item);
    });
    return;
  }
  let article = null,
    dirty = false,
    timer,
    saving = null,
    editGeneration = 0,
    searchGeneration = 0;
  const editorFields = ['articleTitle', 'articleBody', 'articleTags', 'articleState'];
  const workspace = $('articleWorkspace'),
    editor = $('articleEditor'),
    editorHome = editor.parentNode;
  const readingWorkspace = document.createElement('dialog');
  readingWorkspace.id = 'articleReadingWorkspace';
  readingWorkspace.className = 'content-dialog';
  readingWorkspace.setAttribute('aria-label', 'Чтение статьи');
  const readingClose = node('button', '×', 'dialog-close');
  readingClose.type = 'button';
  readingClose.setAttribute('aria-label', 'Закрыть');
  readingClose.onclick = () => readingWorkspace.close();
  $('articleReading').querySelector('.content-heading').append(readingClose);
  readingWorkspace.append($('articleReading'));
  document.body.append(readingWorkspace);
  workspace.dataset.uiPersistent = 'true';
  function expandEditor() {
    if (workspace.open) return;
    $('articleWorkspaceBody').append(editor);
    workspace.showModal();
    $('articleExpand').hidden = true;
  }
  $('articleExpand').onclick = expandEditor;
  workspace.addEventListener('close', () => {
    editorHome.append(editor);
    editor.hidden = true;
    $('articleExpand').hidden = false;
  });

  let editingAction = false;
  const editorAction = (fn) =>
    action(async () => {
      if (editingAction) return;
      editingAction = true;
      for (const id of editorFields) $(id).disabled = true;
      try {
        await fn();
      } finally {
        editingAction = false;
        for (const id of editorFields) $(id).disabled = false;
      }
    });
  const payload = () => ({
    id: article.id,
    version: article.version,
    title: $('articleTitle').value,
    body: $('articleBody').value,
    tags: splitTags($('articleTags').value),
    status: $('articleState').value
  });
  function renderArticles() {
    const state = $('articleFilter').value,
      tag = $('tagFilter').value;
    const rows = list
      .filter((a) => (!state || a.status === state) && (!tag || a.tags.includes(tag)))
      .sort((a, b) => b.updated - a.updated);
    $('contentList').replaceChildren(
      ...rows.map((a) => {
        const b = node('button', undefined, 'article-card');
        b.type = 'button';
        b.classList.toggle('selected', a.id === article?.id);
        b.append(
          node('strong', a.title || 'Без названия'),
          node('small', a.status === 'draft' ? 'Черновик' : 'Готова')
        );
        b.onclick = () =>
          void editorAction(async () => {
            await flush();
            await setArticle(await request('/article/' + a.id));
          });
        return b;
      })
    );
    if (!rows.length) {
      const filtered = Boolean($('contentSearch').value || state || tag);
      $('contentList').append(Nexus.empty(filtered ? 'Ничего не найдено' : 'Пока нет статей', filtered ? 'Попробуй другой поиск или фильтр.' : 'Сохрани заметку, идею или большой текст.', filtered ? 'Сбросить фильтры' : 'Написать статью', () => { if(filtered) { for(const id of ['contentSearch','articleFilter','tagFilter']) $(id).value=''; void action(loadArticles); } else $('articleNew').click(); }));
    }
  }
  async function loadArticles() {
    const generation = ++searchGeneration;
    const result = await request('/articles?q=' + encodeURIComponent($('contentSearch').value));
    if (generation !== searchGeneration) return;
    list = result;
    select($('tagFilter'), [...new Set(list.flatMap((a) => a.tags))].sort(), 'Все теги');
    renderArticles();
  }
  async function setArticle(value) {
    article = value;
    dirty = false;
    clearTimeout(timer);
    for (const id of editorFields) $(id).disabled = false;
    $('articleEditor').hidden = false;
    $('articleTitle').value = value.title;
    $('articleBody').value = value.body;
    syncStyle();

    $('articleTags').value = value.tags.join(', ');
    $('articleState').value = value.status;
    $('articleSaveState').textContent = 'Сохранено · ' + date(value.updated);
    renderArticles();
    if (value.status === 'ready') await showReading();
    else showEditor();
  }
  function showEditor() {
    if (readingWorkspace.open) readingWorkspace.close();
    $('articleReading').hidden = true;
    $('articleEditor').hidden = false;
    expandEditor();
  }
  async function showReading() {
    if (workspace.open) workspace.close();
    $('articleEditor').hidden = true;
    $('articleReading').hidden = false;
    $('articleReadTitle').textContent = article.title || 'Без названия';
    $('articleReadBody').textContent = 'Загрузка…';
    if (!readingWorkspace.open) readingWorkspace.showModal();
    try {
      const result = await request('/preview', {body: article.body});
      $('articleReadBody').innerHTML = result.html;
    } catch (e) {
      $('articleReadBody').textContent =
        'Не удалось открыть текст. Можно перейти к редактированию.';
      throw e;
    }
  }
  $('articleEdit').onclick = () => {
    if (!editingAction) showEditor();
  };
  $('articleRead').onclick = () =>
    void editorAction(async () => {
      await flush();
      await showReading();
    });
  async function flush() {
    clearTimeout(timer);
    if (saving) {
      await saving;
      if (dirty) return flush();
      return;
    }
    if (!dirty || !article) return;
    saving = (async () => {
      while (dirty) {
        const generation = editGeneration,
          data = payload();
        $('articleSaveState').textContent = 'Сохранение…';
        try {
          const result = await request('/save', data);
          article = result;
          dirty = generation !== editGeneration;
          $('articleSaveState').textContent = dirty
            ? 'Есть изменения…'
            : 'Сохранено · ' + date(result.updated);
        } catch (e) {
          $('articleSaveState').textContent = 'Не сохранено: ' + e.message;
          throw e;
        }
      }
      await loadArticles();
    })();
    try {
      await saving;
    } finally {
      saving = null;
    }
  }
  for (const id of editorFields)
    $(id).addEventListener(id === 'articleState' ? 'change' : 'input', () => {
      dirty = true;
      editGeneration++;
      $('articleSaveState').textContent = 'Есть изменения…';
      clearTimeout(timer);
      timer = setTimeout(() => void action(flush), 1200);
    });
  $('articleSave').onclick = () =>
    void editorAction(async () => {
      await flush();
      if (article?.status === 'ready') await showReading();
    });
  $('articleImport').onchange = () =>
    void editorAction(async () => {
      const input = $('articleImport'),
        file = input.files[0];
      if (!file) return;
      try {
        if (!/\.(md|markdown)$/i.test(file.name) || file.size > 1024 * 1024)
          throw Error('Нужен UTF-8 файл .md до 1 МиБ');
        let body;
        try {
          body = new TextDecoder('utf-8', {fatal: true}).decode(await file.arrayBuffer());
        } catch {
          throw Error('Файл должен быть в кодировке UTF-8');
        }
        if (body.length > 262144 || body.includes('\0'))
          throw Error('Текст больше 262144 символов или содержит нулевой байт');
        await flush();
        const title = file.name.replace(/\.(md|markdown)$/i, '').slice(0, 160);
        await setArticle(await request('/save', {title, body, tags: [], status: 'draft'}));
        await loadArticles();
      } finally {
        input.value = '';
      }
    });
  $('articleExport').onclick = () =>
    void editorAction(async () => {
      await flush();
      const a = node('a');
      a.href = base + '/article/' + article.id + '/export';
      a.download = (article.title || 'Заметка') + '.md';
      document.body.append(a);
      a.click();
      a.remove();
    });

  $('articleNew').onclick = () =>
    void editorAction(async () => {
      await flush();
      await setArticle(await request('/save', {title: '', body: '', tags: [], status: 'draft'}));
      await loadArticles();
      $('articleTitle').focus();
    });
  $('contentSearch').oninput = () => {
    clearTimeout($('contentSearch')._timer);
    $('contentSearch')._timer = setTimeout(() => void action(loadArticles), 250);
  };
  $('articleFilter').onchange = renderArticles;
  $('tagFilter').onchange = renderArticles;
  function insert(value, wrap = false) {
    if (editingAction) return;
    const input = $('articleBody'),
      start = input.selectionStart,
      end = input.selectionEnd;
    input.setRangeText(
      wrap ? value + input.value.slice(start, end) + value : value,
      start,
      end,
      'end'
    );
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
  function format(command) {
    if (editingAction || $('articleBody').disabled) return;
    const input = $('articleBody');
    const edit = NexusMarkdownEdit(input.value, input.selectionStart, input.selectionEnd, command);
    if (input.value.length - (edit.to - edit.from) + edit.value.length > input.maxLength) {
      $('articleSaveState').textContent = 'Достигнут предел длины статьи.';
      return;
    }
    input.setRangeText(edit.value, edit.from, edit.to, 'preserve');
    input.focus({preventScroll:true});
    input.setSelectionRange(edit.start, edit.end);
    input.dispatchEvent(new Event('input', {bubbles:true}));
  }
  document.querySelectorAll('[data-md]').forEach(button => {
    button.onmousedown = event => event.preventDefault();
    button.onclick = () => format(button.dataset.md);
  });
  $('formatStyle').onchange = event => format(event.target.value);
  $('formatBlock').onchange = event => {const command = event.target.value; event.target.value = ''; if(command) format(command);};
  $('formatInsert').onchange = event => {
    const command = event.target.value; event.target.value = '';
    if (command === 'image') $('insertImage').click();
    else if (command === 'file') $('insertFile').click();
    else if (command) format(command);
  };
  $('articleMore').onchange = event => {
    const command = event.target.value; event.target.value = '';
    if (command === 'export') $('articleExport').click();
    if (command === 'history') $('articleHistory').click();
    if (command === 'help') $('markdownHelp').showModal();
  };
  const syncStyle = () => {
    const input = $('articleBody');
    const start = input.selectionStart === 0 ? 0 : input.value.lastIndexOf('\n', input.selectionStart - 1) + 1;
    const line = input.value.slice(start).split('\n')[0];
    const heading = /^(#{1,6})\s/.exec(line);
    $('formatStyle').value = heading ? 'h' + heading[1].length : 'paragraph';
  };
  for (const event of ['click','keyup','select','input']) $('articleBody').addEventListener(event, syncStyle);
  $('articleBody').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && ['b','i'].includes(event.key.toLowerCase())) {
      event.preventDefault(); format(event.key.toLowerCase() === 'b' ? 'bold' : 'italic');
    }
  });
  async function preview(body, title, target = 'articleRendered') {
    const result = await request('/preview', {body});
    $(target).innerHTML = result.html;
    if (target === 'articleRendered') {
      $('previewTitle').textContent = title || 'Без названия';
      $('articleViewer').showModal();
    }
  }
  $('articlePreview').onclick = () =>
    void editorAction(async () => {
      await flush();
      await preview(article.body, article.title);
    });
  let selection,
    pickerFiles = null;
  function renderPicker() {
    const q = $('pickerSearch').value.toLocaleLowerCase();
    if (pickerFiles) {
      $('pickerList').replaceChildren(
        ...pickerFiles
          .filter((f) => f.name.toLocaleLowerCase().includes(q))
          .map((f) => {
            const b = node('button', f.name, 'gallery-card');
            b.type = 'button';
            b.onclick = () => {
              $('articleBody').setSelectionRange(selection[0], selection[1]);
              insert('\n[' + f.name.replace(/[\[\]\\\r\n]/g, '') + '](file:' + f.id + ')\n');
              $('imagePicker').close();
            };
            return b;
          })
      );
      if (!$('pickerList').children.length)
        $('pickerList').append(node('p', 'Файлы не найдены. Загрузи их в Мнемосину.'));
      return;
    }
    $('pickerList').replaceChildren(
      ...images
        .filter((i) => [i.name, ...i.tags].join(' ').toLocaleLowerCase().includes(q))
        .map((i) =>
          imageCard(i, () => {
            const input = $('articleBody');
            input.setSelectionRange(selection[0], selection[1]);
            insert('\n![' + i.name.replace(/[\[\]\r\n]/g, '') + '](media:' + i.id + ')\n');
            $('imagePicker').close();
          })
        )
    );
    if (!images.length) $('pickerList').append(node('p', 'Сначала загрузи изображения в «Пинакотеку».'));
  }
  $('insertImage').onclick = () =>
    void editorAction(async () => {
      selection = [$('articleBody').selectionStart, $('articleBody').selectionEnd];
      pickerFiles = null;
      $('pickerTitle').textContent = 'Изображения Пинакотеки';
      await loadImages();
      $('pickerSearch').value = '';
      renderPicker();
      $('imagePicker').showModal();
    });
  $('insertFile').onclick = () =>
    void editorAction(async () => {
      selection = [$('articleBody').selectionStart, $('articleBody').selectionEnd];
      const data = await Nexus.request('/modules/storage/api');
      pickerFiles = data.files;
      $('pickerTitle').textContent = 'Файлы Мнемосины';
      $('pickerSearch').value = '';
      renderPicker();
      $('imagePicker').showModal();
    });
  $('pickerSearch').oninput = renderPicker;
  let revision;
  $('articleHistory').onclick = () =>
    void editorAction(async () => {
      await flush();
      const fresh = await request('/article/' + article.id);
      $('historyList').replaceChildren(
        ...fresh.history.map((r) => {
          const b = node(
            'button',
            'Редакция ' + r.version + ' · ' + date(r.updated),
            'revision-row'
          );
          b.type = 'button';
          b.onclick = () =>
            void editorAction(async () => {
              revision = r;
              $('revisionDate').textContent = (r.title || 'Без названия') + ' · ' + date(r.updated);
              await preview(r.body, r.title, 'revisionText');
              $('revisionViewer').showModal();
            });
          return b;
        })
      );
      if (!fresh.history.length)
        $('historyList').append(node('p', 'Предыдущих редакций пока нет.'));
      $('historyViewer').showModal();
    });
  $('revisionRestore').onclick = () =>
    void editorAction(async () => {
      await flush();
      const value = await request('/restore', {
        id: article.id,
        revision: revision.version,
        version: article.version
      });
      await setArticle(value);
      $('revisionViewer').close();
      $('historyViewer').close();
      await loadArticles();
    });
  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    if (dirty && !saving && article) {
      const data = JSON.stringify(payload());
      if (new TextEncoder().encode(data).length < 60000)
        void fetch(base + '/save', {
          method: 'POST',
          credentials: 'same-origin',
          headers: {'Content-Type': 'application/json'},
          body: data,
          keepalive: true
        }).catch(() => {});
    }
  });
  Nexus.beforeLeave?.(async () => {
    if (editingAction) return false;
    try { await flush(); return !dirty; }
    catch (error) { Nexus.problem($('articleSaveState'), 'articles', error); return false; }
  });
  void action(async () => {
    await loadArticles();
    if (view?.restore()) await loadArticles();
    const id = new URLSearchParams(location.search).get('article');
    if (id && /^[a-f0-9-]{36}$/.test(id)) await setArticle(await request('/article/' + id));
  });
})();
