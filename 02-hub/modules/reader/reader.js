(() => {
  const $ = (id) => document.getElementById(id),
    base = '/modules/reader';
  if (!$('readerPage') && !$('readerSettings')) return;
  const node = Nexus.node;
  const status = (text) => {
    $('readerStatus').textContent = text;
    if ($('readerReadStatus')) $('readerReadStatus').textContent = text;
  };
  const api = (route, data, extra = {}) =>
    Nexus.request(base + route, data, {
      signal: AbortSignal.timeout(60000),
      ...extra
    });
  const act = async (fn) => {
    document.querySelectorAll('.reader-error').forEach((n) => n.remove());
    try {
      await fn();
    } catch (e) {
      Nexus.problem($('readerStatus'), 'reader', e);
      Nexus.problem($('readerReadStatus'), 'reader', e);
      const opened = [...document.querySelectorAll('.reader-dialog[open]')];
      if (opened.length) {
        const n = node('p', e.message, 'reader-error');
        n.setAttribute('role', 'alert');
        opened.at(-1).prepend(n);
      }
    }
  };
  const settingsFields = {
    size: 'readerSize',
    line: 'readerLine',
    font: 'readerFont',
    theme: 'readerTheme',
    width: 'readerWidth'
  };
  if ($('readerSettings')) {
    void act(async () => {
      const value = await api('/settings');
      for (const [key, id] of Object.entries(settingsFields)) $(id).value = String(value[key]);
    });
    $('readerSettingsForm').onsubmit = (e) => {
      e.preventDefault();
      void act(async () => {
        const value = Object.fromEntries(
          Object.entries(settingsFields).map(([key, id]) => [
            key,
            ['size', 'line'].includes(key) ? Number($(id).value) : $(id).value
          ])
        );
        await api('/settings', value);
        status('Сохранено.');
      });
    };
    return;
  }
  document
    .querySelectorAll('[data-reader-close]')
    .forEach((b) => (b.onclick = () => b.closest('dialog').close()));
  let books = [],
    limit = 60,
    book = null,
    editingBook = null,
    chapter = 0,
    loading = false,
    dirty = false,
    conflict = false,
    saving = null,
    timer,
    changed = 0,
    loadGeneration = 0,
    engine = null,
    operation = null,
    lastPosition = null;
  window.NexusActivity?.reading(() =>
    book && $('readerReading').open ? {item: book.id, title: book.title,
      pageKey: mode === 'pages' && engine?.page ? JSON.stringify([engine.page.start, engine.page.end]) : null} : null
  );
  let acting = false,
    closing = false;
  const bookAction = (fn) => {
    if (acting || closing) return Promise.resolve();
    operation = act(async () => {
      if (acting) return;
      acting = true;
      try {
        await fn();
      } finally {
        acting = false;
        if (book) $('readerChapter').value = String(chapter);
      }
    });
    return operation;
  };
  const viewport = $('readerViewport');
  const reading = $('readerReading');
  let mode = 'scroll';
  try {
    mode = localStorage.getItem('nexus404-reader-mode') === 'pages' ? 'pages' : 'scroll';
  } catch {}
  $('readerMode').value = mode;
  function render(reset = true) {
    if (reset !== false) limit = 60;
    const q = $('readerSearch').value.toLocaleLowerCase(),
      filtered = books.filter((b) => (b.title + ' ' + b.author).toLocaleLowerCase().includes(q));
    $('readerBooks').replaceChildren(
      ...filtered.slice(0, limit).map((b) => {
        const card = node('article', undefined, 'reader-book');
        const button = node('button', undefined, 'reader-book-open');
        button.type = 'button';
        button.setAttribute('aria-label', 'Читать «' + b.title + '» · ' + (b.author || 'Автор не указан') + ' · ' + b.progress + '%');
        button.title = b.title + (b.author ? ' — ' + b.author : '');
        const fallback = node('div', b.title.slice(0, 1) || 'К', 'reader-cover');
        fallback.setAttribute('aria-hidden', 'true');
        button.append(fallback);
        if (b.cover) {
          const img = node('img');
          img.src = base + '/cover/' + b.id + '?v=' + encodeURIComponent(b.coverVersion||'original');
          img.alt = '';
          img.loading = 'lazy';
          img.decoding = 'async';
          img.addEventListener('error', () => img.remove(), {once:true});
          button.append(img);
        }
        const info = node('div', undefined, 'reader-card-info');
        info.append(node('strong', b.title), node('span', b.author || 'Автор не указан', 'reader-author'));
        const meta = node('div', undefined, 'reader-card-meta');
        meta.append(node('small', b.format.toUpperCase()), node('small', b.progress + '%'));
        const progress = node('progress');
        progress.max = 100;
        progress.value = b.progress;
        progress.setAttribute('aria-label', 'Прочитано');
        info.append(meta, progress);
        button.append(info);
        button.onclick = () => void bookAction(() => openBook(b.id));
        const edit = node('button', '✎', 'reader-card-edit');
        edit.type = 'button';
        edit.setAttribute('aria-label', 'Редактировать книгу «' + b.title + '»');
        edit.title = 'Редактировать книгу';
        edit.onclick = () => {
          if (!acting) editMetadata(b);
        };
        card.append(button, edit);
        return card;
      })
    );
    if (!filtered.length)
      $('readerBooks').append(
        Nexus.empty(books.length ? 'Ничего не найдено' : 'Библиотека пуста', books.length ? 'Попробуй другое название или автора.' : 'Добавь книгу в EPUB или TXT.', books.length ? 'Сбросить поиск' : 'Добавить книгу', () => { if(books.length) { $('readerSearch').value=''; render(); } else $('readerUpload').click(); })
      );
    $('readerMore').hidden = filtered.length <= limit;
  }
  const view = Nexus.rememberView?.(['readerSearch'], () => ({limit}));
  async function library() {
    books = await api('/library');
    if (view?.restore()) { limit = view.value.limit || 60; render(false); }
    else render();
  }
  $('readerSearch').oninput = render;
  $('readerMore').onclick = () => {
    limit += 60;
    render(false);
  };
  let uploading = false;
  $('readerUpload').onchange = () =>
    void act(async () => {
      if (uploading) return;
      uploading = true;
      $('readerUpload').disabled = true;
      let done = 0;
      const failed = [],
        files = [...$('readerUpload').files];
      try {
        for (const file of files) {
          status(`Импорт ${done + failed.length + 1} / ${files.length} · ${file.name}`);
          try {
            if (file.size > 64 * 1024 * 1024) throw Error('Файл больше 64 МБ');
            await api('/upload', undefined, {
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
        await library();
        status(
          `Добавлено: ${done} / ${files.length}` + (failed.length ? '\n' + failed.join('\n') : '')
        );
      } finally {
        uploading = false;
        $('readerUpload').disabled = false;
        $('readerUpload').value = '';
      }
    });
  let readingSettings;
  function applySettings(s) {
    readingSettings = {...s};
    $('readerLiveSize').value = String(s.size);
    for (const key of Object.keys(settingsFields)) viewport.dataset[key] = String(s[key]);
  }
  function position() {
    if (!reading.open) return lastPosition || book.position;
    lastPosition = engine ? engine.position() : book.position;
    return lastPosition;
  }
  function queueSave() {
    if (!book || loading || conflict) return;
    dirty = true;
    changed++;
    $('readerSaved').textContent = 'Сохраняем позицию…';
    clearTimeout(timer);
    timer = setTimeout(() => void act(savePosition), 1000);
  }
  async function savePosition() {
    clearTimeout(timer);
    if (saving) {
      await saving;
      if (dirty && !conflict) return savePosition();
      return;
    }
    if (!book || !dirty || loading) return;
    if (conflict) throw Error('Выбери, какую позицию продолжить.');
    saving = (async () => {
      while (dirty && !loading) {
        const generation = changed,
          p = position();
        try {
          const value = await api(
            '/position',
            {id: book.id, position: p, version: book.positionVersion},
            {keepalive: true}
          );
          book = {
            ...book,
            position: value.position,
            positionVersion: value.positionVersion,
            progress: value.progress,
            readAt: value.readAt
          };
          dirty = generation !== changed;
          $('readerProgress').textContent = book.progress + '%';
          $('readerSaved').textContent = dirty ? 'Сохраняем позицию…' : 'Позиция сохранена';
        } catch (e) {
          if (e.status === 409) {
            conflict = true;
            $('readerConflict').hidden = false;
            reading.classList.remove('reader-clean');
          }
          $('readerSaved').textContent = 'Позиция не сохранена';
          throw e;
        }
      }
    })();
    try {
      await saving;
    } finally {
      saving = null;
    }
  }
  async function showChapter(p) {
    const generation = ++loadGeneration;
    loading = true;
    try {
      await document.fonts?.ready;
      await engine.open(p, mode);
      if (reading.open) lastPosition = engine.position();
      if (generation !== loadGeneration) return;
      chapter = engine.position().chapter;
      $('readerChapter').value = String(chapter);
    } catch (error) {
      $('readerChapter').value = String(chapter);
      throw error;
    } finally {
      if (generation === loadGeneration) loading = false;
    }
  }
  function updatePosition() {
    if (!book || !engine || loading || !reading.open) return;
    chapter = position().chapter;
    $('readerChapter').value = String(chapter);
    queueSave();
  }
  async function openBook(id) {
    await savePosition();
    const [value, prefs] = await Promise.all([api('/book/' + id), api('/settings')]);
    book = value;
    lastPosition = value.position;
    dirty = false;
    conflict = false;
    applySettings(prefs);
    $('readerConflict').hidden = true;
    $('readerLibrary').hidden = true;
    engine?.close();
    engine = new window.NexusReaderEngine({
      viewport,
      text: $('readerText'),
      book,
      fetchChapter: (i) => api('/book/' + id + '/chapter/' + i),
      onChange: updatePosition,
      onError: (e) => Nexus.problem($('readerStatus'), 'reader', e)
    });
    $('readerText').replaceChildren();
    status('Загрузка книги…');
    reading.showModal();
    reading.classList.add('reader-clean');
    focusReading(true);
    viewport.focus({preventScroll: true});
    $('readerBookTitle').textContent = book.title;
    $('readerChapter').replaceChildren(
      ...book.chapters.map((c, i) => new Option(c.title, String(i)))
    );
    $('readerProgress').textContent = book.progress + '%';
    $('readerSaved').textContent = book.readAt ? 'Продолжаем с сохранённого места' : '';
    try {
      await showChapter(book.position);
    } catch (error) {
      book = null;
      reading.close();
      $('readerLibrary').hidden = false;
      throw error;
    }
    queueSave();
    status('');
  }

  const go = (p) =>
    bookAction(async () => {
      await savePosition();
      await showChapter(p);
      queueSave();
    });
  $('readerChapter').onchange = () => {
    const next = Number($('readerChapter').value);
    void go({chapter: next, block: 0, offset: 0});
  };
  const turn = (direction) =>
    bookAction(async () => {
      if (!engine) return;
      if (await engine.step(direction)) {
        updatePosition();
        status('');
      }
    });
  $('readerPrev').onclick = () => void turn(-1);
  $('readerNext').onclick = () => void turn(1);
  $('readerBack').onclick = () => reading.close();
  reading.addEventListener('close', () => {
    closing = true;
    $('readerLibrary').hidden = false;
    focusReading(false);
    void act(async () => {
      try {
        await operation;
        try {
          await savePosition();
        } catch (error) {
          $('readerLibrary').hidden = true;
          reading.showModal();
          focusReading(true);
          reading.classList.remove('reader-clean');
          throw error;
        }
        loadGeneration++;
        engine?.close();
        engine = null;
        book = null;
        $('readerLibrary').hidden = false;
        await library();
      } finally {
        closing = false;
      }
    });
  });
  $('readerLiveSize').onchange = () =>
    void bookAction(async () => {
      const control = $('readerLiveSize'),
        size = Number(control.value),
        p = position();
      control.disabled = true;
      try {
        await savePosition();
        const saved = await api('/settings', {...readingSettings, size});
        applySettings(saved);
        await showChapter(p);
        queueSave();
      } finally {
        control.value = String(readingSettings.size);
        control.disabled = false;
      }
    });
  $('readerMode').onchange = () =>
    void bookAction(async () => {
      const selected = $('readerMode').value,
        previous = mode,
        p = position();
      await savePosition();
      mode = selected;
      try {
        await showChapter(p);
      } catch (error) {
        mode = previous;
        $('readerMode').value = mode;
        await showChapter(p);
        throw error;
      }
      try {
        localStorage.setItem('nexus404-reader-mode', mode);
      } catch {}
      queueSave();
    });
  function focusReading(active) {
    document.documentElement.classList.toggle('reader-focused', active);
    if (window.parent !== window)
      window.parent.postMessage({type: 'nexus:reader-focus', active}, location.origin);
  }
  let touch,
    suppressClick = false;
  viewport.addEventListener(
    'touchstart',
    (e) => {
      touch =
        e.touches.length === 1
          ? {x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now()}
          : null;
    },
    {passive: true}
  );
  viewport.addEventListener(
    'touchend',
    (e) => {
      if (!touch || e.touches.length) {
        touch = null;
        return;
      }
      const t = e.changedTouches[0],
        dx = t.clientX - touch.x,
        dy = t.clientY - touch.y,
        elapsed = Date.now() - touch.time;
      touch = null;
      if (
        mode === 'pages' &&
        Math.abs(dx) > 45 &&
        Math.abs(dx) > Math.abs(dy) * 1.5 &&
        elapsed < 900 &&
        !window.getSelection()?.toString()
      ) {
        suppressClick = true;
        void turn(dx < 0 ? 1 : -1);
        setTimeout(() => {
          suppressClick = false;
        }, 400);
      }
    },
    {passive: true}
  );
  viewport.addEventListener(
    'touchcancel',
    () => {
      touch = null;
    },
    {passive: true}
  );
  viewport.addEventListener('click', () => {
    if (!suppressClick && !window.getSelection()?.toString())
      reading.classList.toggle('reader-clean');
  });
  reading.addEventListener('keydown', (e) => {
    if (
      e.target.closest('input,textarea,select') ||
      e.altKey ||
      e.ctrlKey ||
      e.metaKey ||
      e.defaultPrevented
    )
      return;
    if (['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'].includes(e.key)) {
      e.preventDefault();
      void turn(['ArrowLeft', 'PageUp'].includes(e.key) ? -1 : 1);
    }
    if (e.key === 'Tab') reading.classList.remove('reader-clean');
  });
  let resizeTimer;
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!book || !engine || !reading.open || mode !== 'pages' || acting || loading) return;
      const p = position();
      void bookAction(async () => {
        await savePosition();
        await showChapter(p);
      });
    }, 150);
  }).observe(viewport);
  async function applyRemote(value) {
    const previous = book;
    book = value;
    try {
      await showChapter(value.position);
    } catch (error) {
      book = previous;
      throw error;
    }
    dirty = false;
    conflict = false;
    $('readerConflict').hidden = true;
    $('readerProgress').textContent = book.progress + '%';
  }
  $('readerRemote').onclick = () =>
    void bookAction(async () => {
      const value = await api('/book/' + book.id);
      await applyRemote(value);
      $('readerSaved').textContent = 'Позиция с другого устройства';
    });
  $('readerLocal').onclick = () =>
    void bookAction(async () => {
      const latest = await api('/book/' + book.id);
      book.positionVersion = latest.positionVersion;
      conflict = false;
      $('readerConflict').hidden = true;
      dirty = true;
      await savePosition();
    });
  $('readerAddMark').onclick = () =>
    void bookAction(async () => {
      await savePosition();
      const p = position(),
        value = await api('/bookmark', {
          id: book.id,
          position: p,
          label: book.chapters[chapter].title.slice(0, 120)
        });
      book.bookmarks = value.bookmarks;
      status('Закладка добавлена.');
    });
  function renderMarks() {
    $('readerMarksList').replaceChildren(
      ...book.bookmarks.map((mark) => {
        const row = node('div', undefined, 'reader-mark'),
          open = node('button', mark.label),
          remove = node('button', '×');
        open.type = remove.type = 'button';
        remove.setAttribute('aria-label', 'Удалить закладку');
        open.onclick = () =>
          void bookAction(async () => {
            await savePosition();
            $('readerMarksDialog').close();
            await showChapter(mark.position);
            queueSave();
          });
        remove.onclick = () =>
          void bookAction(async () => {
            const value = await api('/bookmark/remove', {id: book.id, mark: mark.id});
            book.bookmarks = value.bookmarks;
            renderMarks();
          });
        row.append(open, remove);
        return row;
      })
    );
    if (!book.bookmarks.length) $('readerMarksList').append(node('p', 'Закладок пока нет.'));
  }
  $('readerMarks').onclick = () =>
    void bookAction(async () => {
      const value = await api('/book/' + book.id);
      book.bookmarks = value.bookmarks;
      renderMarks();
      $('readerMarksDialog').showModal();
    });
  let coverPreviewURL='';
  function clearCoverPreview(){if(coverPreviewURL)URL.revokeObjectURL(coverPreviewURL);coverPreviewURL='';}
  $('readerCoverInput').onchange=()=>{clearCoverPreview();const file=$('readerCoverInput').files[0],preview=$('readerCoverPreview');
    if(file&&file.size>8*1024*1024){$('readerCoverInput').value='';status('Обложка — до 8 МБ.');preview.hidden=true;return;}
    preview.hidden=!file&&!editingBook?.cover;
    if(file){coverPreviewURL=URL.createObjectURL(file);preview.src=coverPreviewURL;}
    else if(editingBook?.cover)preview.src=base+'/cover/'+editingBook.id+'?v='+encodeURIComponent(editingBook.coverVersion||'original');
  };
  $('readerEditDialog').addEventListener('close',clearCoverPreview);
  function editMetadata(target) {
    editingBook = target;
    document.querySelectorAll('.reader-error').forEach((n) => n.remove());
    $('readerTitleInput').value = target.title;
    $('readerAuthorInput').value = target.author;
    clearCoverPreview();$('readerCoverInput').value='';$('readerCoverPreview').hidden=!target.cover;if(target.cover)$('readerCoverPreview').src=base+'/cover/'+target.id+'?v='+encodeURIComponent(target.coverVersion||'original');
    $('readerEditDialog').showModal();
  }
  $('readerEdit').onclick = () => {
    if (book && !acting) editMetadata(book);
  };
  $('readerMetaForm').onsubmit = (e) => {
    e.preventDefault();
    const target = editingBook;
    if (!target) return;
    void bookAction(async () => {
      let value = await api('/metadata', {
        id: target.id,
        title: $('readerTitleInput').value,
        author: $('readerAuthorInput').value
      });
      const coverFile=$('readerCoverInput').files[0];if(coverFile)value=await api('/cover',undefined,{method:'POST',body:coverFile,headers:{'Content-Type':coverFile.type,'X-Book-Id':target.id}});
      if (book?.id === target.id) {
        book.cover=value.cover;book.coverVersion=value.coverVersion;
        book.title = value.title;
        book.author = value.author;
        $('readerBookTitle').textContent = value.title;
      }
      books = books.map((b) =>
        b.id === target.id ? {...b, title: value.title, author: value.author,cover:value.cover,coverVersion:value.coverVersion} : b
      );
      render(false);
      $('readerEditDialog').close();
    });
  };
  $('readerDelete').onclick = () => $('readerDeleteDialog').showModal();
  $('readerDeleteConfirm').onclick = () => {
    const target = editingBook;
    if (!target) return;
    void bookAction(async () => {
      if (book?.id === target.id) {
        clearTimeout(timer);
        if (saving) await saving;
      }
      await api('/delete', {id: target.id});
      if (book?.id === target.id) {
        book = null;
        dirty = false;
        reading.close();
        $('readerLibrary').hidden = false;
      }
      editingBook = null;
      $('readerDeleteDialog').close();
      $('readerEditDialog').close();
      await library();
    });
  };
  document.addEventListener('visibilitychange', () => {
    if (!book || !reading.open) return;
    if (document.hidden) {
      if (dirty && !conflict) void act(savePosition);
    } else if (!acting && !dirty && !saving && !loading)
      void bookAction(async () => {
        const id = book.id;
        const value = await api('/book/' + id);
        if (!book || book.id !== id || dirty || saving || loading) return;
        if (value.positionVersion !== book.positionVersion) {
          await applyRemote(value);
          $('readerSaved').textContent = 'Позиция обновлена';
        }
      });
  });
  window.addEventListener('pagehide', () => {
    clearTimeout(timer);
    if (book && dirty && !saving && !conflict && !loading)
      void fetch(base + '/position', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({id: book.id, position: position(), version: book.positionVersion}),
        keepalive: true
      }).catch(() => {});
  });
  window.addEventListener('beforeunload', (e) => {
    if (dirty || saving || conflict) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
  Nexus.beforeLeave?.(async () => {
    if (uploading || acting || loading) return false;
    if (conflict) { Nexus.problem($('readerReadStatus'), 'reader', {status:409,message:'Сначала выбери, какую позицию чтения сохранить.'}); return false; }
    try { await savePosition(); return !dirty; }
    catch (error) { Nexus.problem($('readerReadStatus'), 'reader', error); return false; }
  });
  void act(async () => {
    await library();
    const id = new URLSearchParams(location.search).get('book');
    if (id && books.some(item => item.id === id)) await openBook(id);
  });
})();
