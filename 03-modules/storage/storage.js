(() => {
  const $ = (id) => document.getElementById(id),
    base = '/modules/storage',
    settings = $('storageSettingsUsage');
  if (!settings && !$('storageStatus')) return;
  const request = (route, data) => Nexus.request(base + route, data);
  const node = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const size = (n) =>
    n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' ГиБ' : n < 1048576 ? Math.ceil(n / 1024) + ' КБ' : (n / 1048576).toFixed(1) + ' МБ';
  const fileType = (item) => {
    const extension = /\.([a-z0-9]{1,8})$/i.exec(item.name || '');
    return node('span', extension ? extension[1].toUpperCase() : 'ФАЙЛ', 'storage-file-type');
  };
  const count = (n) =>
    new Intl.NumberFormat('ru-RU').format(n) +
    ' ' +
    (n % 10 === 1 && n % 100 !== 11
      ? 'файл'
      : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)
        ? 'файла'
        : 'файлов');
  const say = (text) => {
    if ($('storageStatus')) $('storageStatus').textContent = text;
  };
  let state = {files: [], folders: []},
    hub = [],
    place = [],
    limit = 60,
    busy = false,
    sequence = 0,
    backup = {phase:'loading'}, systemBackups = {items:[],loading:true}, backupTimer, backupClosed = false, backupSequence = 0;
  const view = !settings && Nexus.rememberView?.(['storageSearch'], () => ({place,limit}));
  let initialFileOpened = false;
  const button = (text, fn, cls) => {
    const n = node('button', text, cls);
    n.type = 'button';
    n.onclick = async () => {
      if (busy || n.disabled) return;
      n.disabled = true;
      try { await fn(); }
      catch (e) { Nexus.problem($('storageStatus'), 'storage', e); }
      finally { n.disabled = false; }
    };
    return n;
  };
  const pathOf = (f) => [f.source, ...(f.folders || [])];
  const inside = (f, path) => path.every((part, i) => pathOf(f)[i] === part);
  const own = () => place[0] === 'own';
  const inBackups = () => place[0] === 'backups';
  const backupTitles = {settings:'Настройки и записи',media:'Медиа и проекты',all:'Все данные'};
  const backupReady = () => backup.phase === 'ready' && backup.expires > Date.now() && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(backup.snapshotId);
  const backupName = () => 'nexus404-' + backup.mode + '-' + new Date(backup.created).toISOString().slice(0,10) + '.tar.gz';
  const currentFolder = () => (own() && place.length > 1 ? place.at(-1) : null);
  const ownPath = (id) => {
    const ids = [],
      seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const f = state.folders.find((item) => item.id === id);
      if (!f) break;
      ids.unshift(id);
      id = f.parent;
    }
    return ids;
  };
  const navigate = (path) => {
    place = path[0] === 'own' && path.length > 1 ? ['own', ...ownPath(path.at(-1))] : path;
    limit = 60;
    $('storageSearch').value = '';
    draw();
    if(inBackups())void refreshBackups();else clearTimeout(backupTimer);
  };
  const folderCard = (title, detail, open, actions = []) => {
    const card = node('article', undefined, 'storage-folder-card'),
      link = button('', open, 'storage-folder-open');
    link.append(
      node('span', '▱', 'storage-folder-icon'),
      node('strong', title),
      node('small', detail)
    );
    card.append(link);
    if (actions.length) {
      const menu = node('details', undefined, 'storage-menu'),
        summary = node('summary', '⋯');
      summary.setAttribute('aria-label', 'Действия с папкой ' + title);
      menu.append(summary, ...actions);
      card.append(menu);
    }
    return card;
  };
  async function removeModuleFiles(files, title) {
    if (!files.length) return;
    const names =
      files
        .slice(0, 8)
        .map((f) => f.name)
        .join('\n') + (files.length > 8 ? '\n… и ещё ' + (files.length - 8) : '');
    if (
      !(await Nexus.confirm(
        'Удалить «' +
          title +
          '» и ' +
          count(files.length) +
          ' без восстановления?\n' +
          names +
          '\nУдаление затронет библиотеку модуля, связанные плейлисты, закладки или установочные ссылки.'
      ))
    )
      return;
    busy = true;
    let failures = 0,
      removed = 0;
    try {
      for (let i = 0; i < files.length; i += 200) {
        say('Удаление: ' + removed + ' из ' + files.length);
        const result = await request('/api/modules/delete-many', {
          source: files[0].source,
          ids: files.slice(i, i + 200).map((f) => f.id)
        });
        removed += result.removed.length;
        failures += result.errors.length;
      }
      await refresh();
      say(
        'Удалено: ' +
          removed +
          (failures
            ? ' · Не удалось удалить: ' +
              failures +
              '. Связанные файлы могут использоваться в статьях.'
            : '')
      );
    } finally {
      busy = false;
    }
  }
  const ownFolderActions = (item) => [
    button('Переименовать', async () => {
      const name = await Nexus.prompt('Название папки', item.name);
      if (name) {
        await request('/api/folder/rename', {id: item.id, name});
        await refresh();
      }
    }),
    button(
      'Удалить',
      async () => {
        if (
          !(await Nexus.confirm(
            'Удалить папку «' +
              item.name +
              '» со всеми вложенными папками? Файлы попадут в корзину; восстановить их можно будет в корень загрузок.'
          ))
        )
          return;
        await request('/api/folder/delete', {id: item.id});
        await refresh();
        await trash();
      },
      'storage-danger'
    )
  ];
  function preview(item) {
    const dialog = node('dialog', undefined, 'storage-preview');
    const heading = node('h2', item.name);
    const close = button('×', () => dialog.close(), 'dialog-close nexus-screen-close');
    close.setAttribute('aria-label', 'Закрыть');
    dialog.append(close, heading);
    dialog.setAttribute('aria-label', item.name);
    if (/^(image\/|application\/pdf$|text\/plain$)/.test(item.type)) {
      const frame = node('iframe'); frame.title = item.name;
      frame.src = base + '/file/' + encodeURIComponent(item.id) + '?preview=1';
      dialog.append(frame);
    } else {
      const download = node('a', 'Скачать файл');
      download.href = base + '/file/' + encodeURIComponent(item.id);
      dialog.append(node('p', 'Этот формат можно открыть после скачивания.'), download);
    }
    document.body.append(dialog);
    dialog.addEventListener('close', () => dialog.remove(), {once:true});
    dialog.showModal();
  }
  function ownRow(item) {
    const r = node('article', undefined, 'storage-row'),
      info = node('div', undefined, 'storage-file-info');
    info.append(node('strong', item.name), node('small', size(item.size)));
    const actions = node('div', undefined, 'storage-actions'),
      download = node('a', 'Скачать');
    download.href = base + '/file/' + item.id;
    actions.append(download);
    const menu = node('details', undefined, 'storage-menu'),
      summary = node('summary', '⋯');
    summary.setAttribute('aria-label', 'Действия с файлом ' + item.name);
    menu.append(summary);
    if (/^(image\/|application\/pdf$|text\/plain$)/.test(item.type))
      actions.append(
        button('Просмотр', () => preview(item))
      );
    menu.append(
      button('Ссылка для статьи', async () => {
        await navigator.clipboard.writeText(
          `[${item.name.replace(/[\[\]\r\n]/g, '')}](file:${item.id})`
        );
        say('Ссылка скопирована');
      })
    );
    menu.append(
      button('Переименовать', async () => {
        const name = await Nexus.prompt('Название файла', item.name);
        if (name) {
          await request('/api/rename', {id: item.id, name, version: item.version});
          await refresh();
        }
      })
    );
    menu.append(
      button('Переместить', async () => {
        const dialog = node('dialog'),
          form = node('form'),
          select = node('select');
        form.method = 'dialog';
        select.append(new Option('Загрузки', ''));
        for (const f of state.folders)
          select.append(
            new Option(
              ownPath(f.id)
                .map((id) => state.folders.find((item) => item.id === id).name)
                .join(' / '),
              f.id
            )
          );
        select.value = item.folder || '';
        select.setAttribute('aria-label', 'Папка назначения');
        form.append(node('h3', 'Переместить файл'), select);
        const submit = node('button', 'Переместить');
        submit.type = 'submit';
        form.append(
          submit,
          button('Отмена', () => dialog.close())
        );
        dialog.append(form);
        document.body.append(dialog);
        form.onsubmit = async (e) => {
          e.preventDefault();
          submit.disabled = true;
          try {
            await request('/api/move', {
              id: item.id,
              folder: select.value || null,
              version: item.version
            });
            dialog.close();
            await refresh();
          } catch (error) {
            say(error.message);
          } finally {
            submit.disabled = false;
          }
        };
        dialog.addEventListener('close', () => dialog.remove(), {once: true});
        dialog.showModal();
      })
    );
    menu.append(
      button(
        'В корзину',
        async () => {
          await request('/api/trash', {id: item.id});
          await refresh();
          await trash();
        },
        'storage-danger'
      )
    );
    r.append(fileType(item), info, actions, menu);
    return r;
  }
  function moduleRow(item) {
    const r = node('article', undefined, 'storage-row'),
      info = node('div', undefined, 'storage-file-info');
    info.append(
      node('strong', item.name),
      node(
        'small',
        item.sourceTitle +
          ' · ' +
          item.kind +
          (Number.isFinite(item.size) ? ' · ' + size(item.size) : '')
      )
    );
    const actions = node('div', undefined, 'storage-actions'),
      link = node('a', 'Открыть');
    link.href = item.href;
    actions.append(
      link,
      button('Удалить', () => removeModuleFiles([item], item.name), 'storage-danger')
    );
    r.append(fileType(item), info, actions);
    return r;
  }
  const backupLink = () => {
    const link=node('a','Подготовить новую копию');link.href='/settings/?module=backups';return link;
  };
  function drawUserBackup(files,query) {
    const intro=node('div',undefined,'storage-backup-intro');
    intro.append(node('h3','Пользовательские данные'),node('p','Без кода хаба и модулей. После скачивания снимок удаляется; без скачивания хранится час.'),backupLink());files.append(intro);
    if(!backupReady()) {
      const messages={loading:'Проверка резервных копий…',preparing:'Готовится копия. Хаб скоро снова будет доступен.',failed:backup.error||'Не удалось подготовить копию. Открой настройки резервного копирования.',deleted:'Копия удалена с сервера.',expired:'Срок хранения копии истёк.',idle:'Готовых копий пока нет.','recovery-required':'Нужна проверка службы на сервере.'};
      files.append(node('p',backup.fetchError||(!backup.available&&backup.phase!=='loading'?'Служба копирования недоступна. Проверь её в настройках.':backup.pending?'Запрос принят, ожидается сервер':messages[backup.phase]||'Готовых копий пока нет.'),'storage-empty'));return;
    }
    const title=backupTitles[backup.mode]||'Пользовательские данные',name=backupName();
    if(query&&!(name+' '+title).toLocaleLowerCase('ru-RU').includes(query)){files.append(node('p','Копия с таким названием не найдена.','storage-empty'));return;}
    const row=node('article',undefined,'storage-row storage-backup-row'),info=node('div',undefined,'storage-file-info');
    info.append(node('strong',title),node('small',name),node('small',new Date(backup.created).toLocaleString('ru-RU')+' · '+size(backup.bytes)+' до сжатия · '+count(backup.files)),node('small','Доступно до '+new Date(backup.expires).toLocaleTimeString('ru-RU')));
    const actions=node('div',undefined,'storage-actions'),form=node('form'),input=node('input'),download=node('button','Скачать');
    form.method='post';form.action='/api/data-backup/download';input.type='hidden';input.name='id';input.value=backup.snapshotId;download.type='submit';download.disabled=!backup.available||!!backup.pending||!!backup.fetchError;
    form.append(input,download);form.onsubmit=()=>say('Скачивание началось. Проверь загрузки браузера; при обрыве копию можно скачать повторно.');
    const snapshotId=backup.snapshotId;
    const remove=button('Удалить',async()=>{
      if(!await Nexus.confirm('Удалить резервную копию «'+title+'» с сервера? Текущие файлы и настройки хаба сохранятся.'))return;
      await Nexus.request('/api/data-backup',{action:'delete',snapshotId});await refreshBackups();
    },'storage-danger');remove.disabled=download.disabled;
    actions.append(form,remove);row.append(node('span','TAR.GZ','storage-file-type'),info,actions);files.append(row);
    if(backup.pending||backup.fetchError||!backup.available)files.append(node('p',backup.fetchError||(backup.pending?'Запрос принят, ожидается сервер':'Служба временно недоступна'),'storage-empty'));
  }
  function drawBackups(files,query){
    drawUserBackup(files,query);
    const intro=node('div',undefined,'storage-backup-intro');intro.append(node('h3','Системные копии и старые обновления'),node('p','Здесь могут быть код и данные старой установки. Скачивание не удаляет эти копии. Ненужные копии можно удалить отдельно; последняя копия для восстановления защищена.'));files.append(intro);
    const items=systemBackups.items.filter(item=>!query||(item.title+' '+(item.version||'')+' '+item.id).toLocaleLowerCase('ru-RU').includes(query));
    for(const item of items){
      const row=node('article',undefined,'storage-row storage-backup-row'),info=node('div',undefined,'storage-file-info'),actions=node('div',undefined,'storage-actions');
      info.append(node('strong',item.title+(item.version?' · '+item.version:'')),node('small','Копия '+item.id.slice(-8)));
      if(Number.isFinite(item.created)&&Number.isFinite(item.bytes))info.append(node('small',new Date(item.created).toLocaleString('ru-RU')+' · '+size(item.bytes)+' до сжатия · '+count(item.files)));
      if(item.hasData)info.append(node('small','Содержит данные старой установки'));
      if(item.reason)info.append(node('small',item.reason));
      const form=node('form'),input=node('input'),download=node('button','Скачать');form.method='post';form.action='/api/backup-browser/download';input.type='hidden';input.name='id';input.value=item.id;download.type='submit';download.disabled=!!item.unavailable||!systemBackups.available;form.append(input,download);form.onsubmit=()=>say('Скачивание системной копии началось. Копия останется на сервере до отдельного удаления.');
      const remove=button('Удалить',async()=>{
        const warning=item.hasData?' В ней есть старые данные, которые могут отличаться от текущих.':'';
        if(!await Nexus.confirm('Удалить «'+item.title+'» ('+item.id+') окончательно?'+warning+' Текущая установка не затрагивается. Сначала сохрани копию на своём устройстве, если она нужна.'))return;
        await Nexus.request('/api/backup-browser',{action:'delete',id:item.id});await refreshBackups();
      },'storage-danger');remove.disabled=!!item.protected||!systemBackups.available;
      actions.append(form,remove);row.append(node('span','TAR.GZ','storage-file-type'),info,actions);files.append(row);
    }
    if(systemBackups.error)files.append(node('p',systemBackups.error,'storage-empty'));
    else if(!items.length)files.append(node('p',systemBackups.loading?'Проверка системных копий…':query?'Системные копии с таким названием не найдены.':'Системных копий на сервере пока нет.','storage-empty'));
  }
  async function refreshBackups() {
    clearTimeout(backupTimer);if(backupClosed||settings)return;
    const revision=++backupSequence;
    try {
      const results=await Promise.allSettled([Nexus.request('/api/data-backup'),Nexus.request('/api/backup-browser')]);
      if(revision!==backupSequence||backupClosed)return;
      const [user,system]=results, next=user.status==='fulfilled'?user.value:{...backup,available:false,fetchError:'Не удалось обновить пользовательские копии. Проверка повторится автоматически.'};
      const nextSystem=system.status==='fulfilled'?system.value:{...systemBackups,available:false,error:system.reason.message||'Служба системных копий недоступна'};
      const changed=['phase','pending','available','snapshotId','mode','created','expires','files','bytes','error','fetchError'].some(k=>next[k]!==backup[k])||JSON.stringify(nextSystem)!==JSON.stringify(systemBackups);
      backup=next;systemBackups=nextSystem;if(changed&&inBackups())draw();
    }finally{if(revision===backupSequence&&!backupClosed&&inBackups())backupTimer=setTimeout(refreshBackups,15000);}
  }
  function draw() {
    const query = $('storageSearch').value.trim().toLocaleLowerCase('ru-RU'),
      folders = $('storageFolders'),
      files = $('storageFiles'),
      crumbs = $('storageBreadcrumb');
    $('storageFolder').closest('.storage-app').classList.toggle('storage-backup-view',inBackups());
    $('storageFolder').hidden=inBackups();
    $('storageInput').closest('label').hidden=inBackups();
    $('storageTrash').parentElement.hidden=inBackups();
    files.classList.toggle('storage-backups',inBackups());
    folders.replaceChildren();
    files.replaceChildren();
    crumbs.replaceChildren(button('Хранилище', () => navigate([])));
    for (let i = 0; i < place.length; i++) {
      const title =
        place[0] === 'own'
          ? i === 0
            ? 'Загрузки'
            : state.folders.find((f) => f.id === place[i])?.name || 'Папка'
          : i === 0
            ? inBackups() ? 'Резервные копии' : hub.find((f) => f.source === place[0])?.sourceTitle || place[i]
            : place[i];
      crumbs.append(
        node('span', '/'),
        button(title, () => navigate(place.slice(0, i + 1)))
      );
    }
    if(inBackups()){drawBackups(files,query);$('storageMore').hidden=true;return;}
    if(!place.length&&(!query||'резервные копии бекапы бэкапы backups'.includes(query)))folders.append(folderCard('Резервные копии',backupReady()?'Есть готовая копия':'Данные и системные копии',()=>navigate(['backups'])));
    let visibleOwn = [],
      visibleHub = [];
    if (query) {
      visibleOwn = state.files.filter((f) => f.name.toLocaleLowerCase('ru-RU').includes(query));
      visibleHub = hub.filter((f) =>
        (f.name + ' ' + f.sourceTitle + ' ' + (f.folders || []).join(' '))
          .toLocaleLowerCase('ru-RU')
          .includes(query)
      );
      for (const f of state.folders.filter((f) =>
        f.name.toLocaleLowerCase('ru-RU').includes(query)
      ))
        folders.append(
          folderCard(f.name, 'Загрузки', () => navigate(['own', f.id]), ownFolderActions(f))
        );
    } else if (!place.length) {
      folders.append(folderCard('Загрузки', count(state.files.length), () => navigate(['own'])));
      const groups = new Map();
      for (const f of hub) {
        if (!groups.has(f.source)) groups.set(f.source, {title: f.sourceTitle, files: []});
        groups.get(f.source).files.push(f);
      }
      for (const [source, group] of [...groups].sort((a, b) =>
        a[1].title.localeCompare(b[1].title, 'ru')
      ))
        folders.append(
          folderCard(group.title, count(group.files.length), () => navigate([source]), [
            button(
              'Удалить файлы',
              () => removeModuleFiles(group.files, group.title),
              'storage-danger'
            )
          ])
        );
    } else if (own()) {
      for (const f of state.folders.filter((f) => f.parent === currentFolder()))
        folders.append(
          folderCard(f.name, 'Папка', () => navigate([...place, f.id]), ownFolderActions(f))
        );
      visibleOwn = state.files.filter((f) => f.folder === currentFolder());
    } else {
      const matches = hub.filter((f) => inside(f, place)),
        groups = new Map();
      for (const f of matches) {
        const name = pathOf(f)[place.length];
        if (name !== undefined) {
          if (!groups.has(name)) groups.set(name, []);
          groups.get(name).push(f);
        }
      }
      for (const [name, children] of [...groups].sort((a, b) => a[0].localeCompare(b[0], 'ru')))
        folders.append(
          folderCard(name, count(children.length), () => navigate([...place, name]), [
            button('Удалить папку', () => removeModuleFiles(children, name), 'storage-danger')
          ])
        );
      visibleHub = matches.filter((f) => pathOf(f).length === place.length);
    }
    const rows = [
      ...visibleOwn.map((f) => ({f, own: true})),
      ...visibleHub.map((f) => ({f, own: false}))
    ];
    for (const {f, own: isOwn} of rows.slice(0, limit))
      files.append(isOwn ? ownRow(f) : moduleRow(f));
    if (!folders.children.length && !rows.length)
      files.append(Nexus.empty(query ? 'Ничего не найдено' : 'Папка пуста', query ? 'Попробуй другое имя файла.' : own() ? 'Загрузи файлы в эту папку.' : 'Здесь появятся файлы выбранного раздела.', query ? 'Сбросить поиск' : own() ? 'Загрузить файлы' : '', () => { if(query) { $('storageSearch').value=''; draw(); } else $('storageInput').click(); }));
    $('storageMore').hidden = rows.length <= limit;
  }
  async function refresh() {
    const current = ++sequence;
    const values = await Promise.all([
      request('/api'),
      settings ? Promise.resolve(null) : request('/api/modules'),
      settings ? Promise.resolve(null) : Nexus.request('/api/data-backup').catch(()=>({available:false,phase:'unavailable'}))
    ]);
    if (current !== sequence) return;
    state = values[0];
    if (settings) {
      settings.textContent = `Загрузки: ${size(state.stats.used)} из ${size(state.stats.limit)} · ${count(state.stats.files)}. Объём включает корзину.`;
      return;
    }
    hub = values[1].files;backup=values[2];
    if(view?.restore()) { place = view.value.place || []; limit = view.value.limit || 60; }
    if (own()) {
      while (place.length > 1 && !state.folders.some((f) => f.id === place.at(-1))) place.pop();
    } else if(!inBackups()) while (place.length && !hub.some((f) => inside(f, place))) place.pop();
    draw();
    if(inBackups())void refreshBackups();
    if (values[1].errors.length) Nexus.problem($('storageStatus'),'storage'); else say('');
    if (!initialFileOpened) {
      initialFileOpened = true;
      const id = new URLSearchParams(location.search).get('file'), item = state.files.find(f => f.id === id);
      if (item) { navigate(['own', ...ownPath(item.folder)]); preview(item); }
    }
  }
  async function trash() {
    const items = await request('/api/trash'),
      box = $('storageTrash');
    box.replaceChildren();
    for (const item of items) {
      const r = node('article', undefined, 'storage-row'),
        actions = node('div', undefined, 'storage-actions');
      r.append(fileType(item), node('strong', item.name));
      actions.append(
        button('Восстановить', async () => {
          await request('/api/restore', {id: item.id});
          await refresh();
          await trash();
        }),
        button(
          'Удалить',
          async () => {
            if (await Nexus.confirm('Удалить «' + item.name + '» окончательно?')) {
              await request('/api/purge', {id: item.id});
              await refresh();
              await trash();
            }
          },
          'storage-danger'
        )
      );
      r.append(actions);
      box.append(r);
    }
    if (!items.length) box.append(node('p', 'Корзина пуста', 'storage-empty'));
  }
  if (!settings) {
    $('storageSearch').oninput = () => {
      limit = 60;
      draw();
    };
    $('storageRefresh').onclick = () => refresh().catch((e) => Nexus.problem($('storageStatus'), 'storage', e));
    $('storageMore').onclick = () => {
      limit += 60;
      draw();
    };
    $('storageFolder').onclick = async () => {
      if (busy) return;
      busy = true;
      const name = await Nexus.prompt('Название папки');
      if (!name) { busy = false; return; }
      try {
        const parent = currentFolder();
        await request('/api/folder', {name, parent});
        if (!own()) place = ['own'];
        await refresh();
      } catch (e) {
        Nexus.problem($('storageStatus'), 'storage', e);
      } finally { busy = false; }
    };
    $('storageInput').onchange = async (event) => {
      const selected = [...event.target.files],
        destination = currentFolder();
      event.target.value = '';
      if (!selected.length) return;
      busy = true;
      $('storageInput').disabled = true;
      try {
        for (const file of selected) {
          const line = node('div', undefined, 'storage-progress'),
            progress = node('progress');
          progress.max = 100;
          progress.value = 0;
          line.append(node('span', file.name), progress);
          $('storageProgress').append(line);
          try {
            await new Promise((resolve, reject) => {
              const xhr = new XMLHttpRequest();
              xhr.open(
                'POST',
                base +
                  '/api/upload' +
                  (destination ? '?folder=' + encodeURIComponent(destination) : '')
              );
              xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
              xhr.upload.onprogress = (e) => {
                if (e.lengthComputable) progress.value = Math.round((e.loaded / e.total) * 100);
              };
              xhr.onerror = () => reject(Error('Соединение прервано'));
              xhr.onload = () => {
                let data = {};
                try {
                  data = JSON.parse(xhr.responseText);
                } catch {}
                xhr.status === 201
                  ? resolve()
                  : reject(Error(data.error || 'Загрузка не завершена'));
              };
              xhr.send(file);
            });
            line.remove();
          } catch (e) {
            line.append(node('small', e.message));
          }
        }
        if (!own()) place = ['own'];
        await refresh();
      } catch (e) {
        Nexus.problem($('storageStatus'), 'storage', e);
      } finally {
        busy = false;
        $('storageInput').disabled = false;
      }
    };
    $('storageTrash').parentElement.addEventListener('toggle', () => {
      if ($('storageTrash').parentElement.open) trash().catch((e) => Nexus.problem($('storageStatus'), 'storage', e));
    });
  }
  addEventListener('pagehide',()=>{backupClosed=true;backupSequence++;clearTimeout(backupTimer);});
  addEventListener('pageshow',()=>{backupClosed=false;if(inBackups())void refreshBackups();});
  Nexus.beforeLeave?.(() => !busy);
  refresh().catch((e) => Nexus.problem($('storageStatus'), 'storage', e));
})();
