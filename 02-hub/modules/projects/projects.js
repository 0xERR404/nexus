(() => {
  const base = '/modules/projects',
    $ = (id) => document.getElementById(id);
  if (!$('projectList')) return;
  let list = [],
    selected = null,
    detail = null,
    generation = 0;
  const say = (message) => {
    $('projectStatus').textContent = message;
  };
  const api = (route, value) => Nexus.request(base + route, value);
  const node = Nexus.node;
  const action = (label, fn) => {
    const button = node('button', label);
    button.type = 'button';
    button.onclick = () => Promise.resolve(fn()).catch((e) => say(e.message));
    return button;
  };
  function renderList() {
    const q = $('projectSearch').value.trim().toLocaleLowerCase(),
      box = $('projectList');
    const matches = list.filter((p) =>
      (p.name + ' ' + p.description).toLocaleLowerCase().includes(q)
    );
    box.replaceChildren();
    for (const item of matches) {
      const card = action('', () => open(item.id));
      card.className = 'project-card';
      card.setAttribute('aria-label', 'Открыть проект «' + item.name + '»');
      card.setAttribute('aria-pressed', String(item.id === selected));
      const description = node(
        'span',
        item.description || 'Описание пока не добавлено',
        'project-card-description'
      );
      description.title = item.description || '';
      card.append(node('strong', item.name), description);
      box.append(card);
    }
    if (!matches.length)
      box.append(node('p', q ? 'Проекты не найдены' : 'Добавь первый проект', 'projects-empty'));
  }
  async function load() {
    list = await api('/api');
    renderList();
    if (selected) await open(selected);
  }
  async function open(id) {
    selected = id;
    const current = ++generation;
    const result = await api('/api/' + id);
    if (current !== generation) return;
    detail = result;
    renderList();
    const {project, releases, deliveries} = detail;
    $('projectDetail').hidden = false;
    $('projectTitle').textContent = project.name;
    $('projectDescription').textContent = project.description;
    const selection = $('selectedRelease');
    selection.replaceChildren(node('option', 'Выбери версию'));
    selection.firstChild.value = '';
    for (const release of releases) {
      const option = node('option', release.version);
      option.value = release.id;
      selection.append(option);
    }
    selection.value = project.selected || '';
    $('installEnabled').checked = Boolean(project.enabled);
    const access = $('installAccess');
    access.hidden = !project.enabled || !project.token;
    const release = releases.find((r) => r.id === project.selected);
    if (!access.hidden && release) {
      const link = `${location.origin}/install/${project.token}/${release.entrypoint ? 'script' : 'archive'}`;
      $('installLink').value = link;
      $('installCommand').value = release.entrypoint
        ? `curl -fsSL '${link}' -o nexus404-install.sh && sudo sh ./nexus404-install.sh`
        : `curl -fsSL '${link}' -o release.zip && printf '%s  %s\\n' '${release.sha256}' release.zip | sha256sum -c -`;
      $('releaseHash').textContent = 'SHA-256 архива: ' + release.sha256;
    }
    const versions = $('releaseList');
    versions.replaceChildren();
    for (const r of releases) {
      const row = node('div', '', 'project-row');
      row.append(
        node('strong', r.version),
        node('span', `${r.size} байт · ${r.entries} файлов · ${r.notes || 'Без заметок'}`)
      );
      if (project.selected === r.id) row.append(node('span', 'Выдаётся по ссылке'));
      row.append(
        node('span', r.entrypoint ? `${r.runner} · ${r.entrypoint}` : 'Только скачивание')
      );
      let editor;
      row.append(
        action('Запуск', async () => {
          if (editor) {
            editor.remove();
            editor = null;
            return;
          }
          editor = node('div', '', 'project-launch');
          row.append(editor);
          const target = editor;
          const files = await api('/api/' + id + '/files/' + r.id);
          if (editor !== target || !row.isConnected) return;
          const select = node('select');
          select.setAttribute('aria-label', 'Стартовый файл');
          const empty = node('option', 'Без установщика — скачать ZIP');
          empty.value = '';
          select.append(empty);
          for (const file of files) {
            const option = node('option', file);
            option.value = file;
            select.append(option);
          }
          select.value = r.entrypoint || '';
          const runner = node('input');
          runner.value = r.runner || 'sh';
          runner.placeholder = 'Интерпретатор: sh, bash, node…';
          runner.setAttribute('aria-label', 'Интерпретатор');
          const save = action('Сохранить запуск', async () => {
            await api('/api/' + id + '/launch', {
              release: r.id,
              entrypoint: select.value,
              runner: runner.value.trim()
            });
            await open(id);
          });
          const fileLabel = node('label', 'Стартовый файл'),
            runnerLabel = node('label', 'Интерпретатор');
          fileLabel.append(select);
          runnerLabel.append(runner);
          editor.append(fileLabel, runnerLabel, save);
          runner.focus();
        })
      );
      row.append(
        action('Заметки', async () => {
          const notes = await Nexus.prompt('Изменения версии', r.notes, {multiline: true});
          if (notes === null) return;
          await api('/api/' + id + '/notes', {release: r.id, notes});
          await open(id);
        })
      );
      versions.append(row);
    }
    const journal = $('deliveryList');
    journal.replaceChildren();
    for (const d of deliveries)
      journal.append(
        node(
          'div',
          `${new Date(d.time).toLocaleString()} · ${d.release} · ${{streamed: 'Файл передан', aborted: 'Передача прервана', error: 'Ошибка передачи'}[d.result] || d.result}`,
          'project-row'
        )
      );
  }
  $('projectEdit').onclick = async () => {
    if (!detail) return;
    const project = detail.project;
    const name = await Nexus.prompt('Название проекта', project.name);
    if (name === null) return;
    const description = await Nexus.prompt('Короткое описание', project.description);
    if (description === null) return;
    try {
      await api('/api/' + project.id + '/edit', {name, description});
      await load();
      say('Проект сохранён');
    } catch (e) {
      say(e.message);
    }
  };
  $('projectDelete').onclick = async () => {
    if (!detail) return;
    const project = detail.project;
    if (
      !(await Nexus.confirm(
        'Удалить проект «' +
          project.name +
          '», все версии и журнал выдачи? Установочная ссылка перестанет работать. Восстановить удалённое нельзя.'
      ))
    )
      return;
    $('projectDelete').disabled = true;
    try {
      const result = await api('/api/' + project.id + '/delete', {});
      if (selected === project.id) {
        ++generation;
        selected = null;
        detail = null;
        $('projectDetail').hidden = true;
        $('installLink').value = '';
        $('installCommand').value = '';
      }
      await load();
      say(
        result.cleanupPending
          ? 'Проект удалён, ссылка отозвана. Очистка оставшихся архивов повторится при следующем запуске модуля.'
          : 'Проект удалён'
      );
    } catch (e) {
      say(e.message);
    } finally {
      $('projectDelete').disabled = false;
    }
  };
  $('projectSearch').oninput = renderList;
  $('projectNew').onclick = async () => {
    const name = await Nexus.prompt('Название проекта');
    if (!name) return;
    const description = await Nexus.prompt('Короткое описание', '', {multiline: true});
    if (description === null) return;
    try {
      const project = await api('/api', {name, description});
      selected = project.id;
      await load();
    } catch (e) {
      say(e.message);
    }
  };
  $('selectedRelease').onchange = async (event) => {
    if (!event.target.value || !selected) return;
    try {
      await api('/api/' + selected + '/select', {release: event.target.value});
      await open(selected);
    } catch (e) {
      say(e.message);
    }
  };
  $('installEnabled').onchange = async (event) => {
    const enabled = event.target.checked;
    try {
      await api('/api/' + selected + '/access', {enabled});
      await open(selected);
    } catch (e) {
      event.target.checked = !enabled;
      say(e.message);
    }
  };
  $('copyInstall').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('installCommand').value);
      say('Команда скопирована');
    } catch {
      say('Не удалось скопировать команду');
    }
  };
  $('releaseFile').onchange = async (event) => {
    const file = event.target.files[0],
      version = $('releaseVersion').value.trim(),
      notes = $('releaseNotes').value;
    event.target.value = '';
    if (!file || !selected) return;
    if (!version) return say('Укажи версию');
    const projectId = selected;
    const progress = $('releaseProgress');
    progress.textContent = 'Загрузка 0%';
    const xhr = new XMLHttpRequest();
    xhr.open('POST', base + '/api/' + projectId + '/upload');
    xhr.setRequestHeader('X-Release-Version', version);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable)
        progress.textContent =
          e.loaded === e.total
            ? 'Архив передан · проверяем файлы и контрольные суммы…'
            : 'Загрузка ' + Math.round((e.loaded / e.total) * 100) + '%';
    };
    xhr.onload = async () => {
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        result = {};
      }
      if (xhr.status !== 201) {
        progress.textContent = 'Архив не принят';
        return say(result.error || 'Версия не загружена');
      }
      try {
        if (notes) await api('/api/' + projectId + '/notes', {release: result.id, notes});
        progress.textContent =
          'Версия сохранена. При необходимости выбери стартовый файл кнопкой «Запуск».';
        if (selected === projectId) await open(projectId);
      } catch (e) {
        say(e.message);
      }
    };
    xhr.onerror = () => {
      progress.textContent = 'Загрузка прервана';
      say('Соединение прервано');
    };
    xhr.send(file);
  };
  load()
    .then(() => {
      const id = new URLSearchParams(location.search).get('project');
      if (id && list.some((p) => p.id === id)) return open(id);
    })
    .catch((e) => say(e.message));
})();
