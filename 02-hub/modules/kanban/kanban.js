const $ = (id) => document.getElementById('kb' + id);
let snapshot = null,
  editing = null,
  files = [],
  projects = [];
const node = Nexus.node;
const api = (route, body) => Nexus.request('/modules/kanban' + route, body);
function action(fn) {
  return async () => {
    try {
      await fn();
      $('Status').textContent = '';
    } catch (e) {
      $('Status').textContent = e.message;
    }
  };
}
function button(label, fn) {
  const b = node('button', label);
  b.type = 'button';
  b.onclick = action(fn);
  return b;
}
async function boards(id) {
  const rows = await api('/api');
  $('Board').replaceChildren(...rows.map((b) => new Option(b.name, b.id)));
  if (id) $('Board').value = id;
  if ($('Board').value) await refresh();
  else {
    $('Status').textContent = 'Создай первую доску';
    $('Columns').replaceChildren();
  }
}
async function refresh() {
  snapshot = await api('/api/board/' + $('Board').value);
  render();
}
async function columns(rows) {
  snapshot = await api('/api/columns', {
    board: snapshot.board.id,
    version: snapshot.board.version,
    columns: rows
  });
  render();
}
async function move(card, column) {
  snapshot = await api('/api/move', {id: card.id, column, version: card.version});
  render();
}
let cancelDrag = null;
function touchDrag(grip, element, card) {
  grip.onpointerdown = (e) => {
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    e.preventDefault();
    cancelDrag?.();
    const board = $('Columns'),
      startX = e.clientX,
      startY = e.clientY;
    let x = startX,
      y = startY,
      moving = false,
      target = null,
      frame = 0,
      last = 0;
    grip.setPointerCapture(e.pointerId);
    function locate() {
      target?.classList.remove('kb-drop-target');
      target = document.elementFromPoint(x, y)?.closest('.kb-column');
      if (target && !board.contains(target)) target = null;
      target?.classList.add('kb-drop-target');
    }
    function scroll(time) {
      const elapsed = Math.min(32, time - last || 16);
      last = time;
      if (moving) {
        const rect = board.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const edge = 40,
            shift = x < rect.left + edge ? -1 : x > rect.right - edge ? 1 : 0;
          board.scrollLeft += shift * elapsed * 0.45;
        }
        locate();
      }
      frame = requestAnimationFrame(scroll);
    }
    const cleanup = () => {
      cancelAnimationFrame(frame);
      target?.classList.remove('kb-drop-target');
      element.classList.remove('kb-dragging');
      grip.onpointermove =
        grip.onpointerup =
        grip.onpointercancel =
        grip.onlostpointercapture =
          null;
      if (grip.hasPointerCapture(e.pointerId)) grip.releasePointerCapture(e.pointerId);
      cancelDrag = null;
    };
    cancelDrag = cleanup;
    grip.onpointermove = (event) => {
      x = event.clientX;
      y = event.clientY;
      if (Math.hypot(x - startX, y - startY) > 6) {
        moving = true;
        element.classList.add('kb-dragging');
        locate();
      }
    };
    grip.onpointerup = (event) => {
      x = event.clientX;
      y = event.clientY;
      locate();
      const column = moving ? target?.dataset.column : null;
      cleanup();
      if (column && column !== card.column_id) void action(() => move(card, column))();
    };
    grip.onpointercancel = grip.onlostpointercapture = cleanup;
    frame = requestAnimationFrame(scroll);
  };
}
addEventListener('pagehide', () => cancelDrag?.());
function render() {
  cancelDrag?.();
  $('Columns').replaceChildren();
  for (const [i, col] of snapshot.columns.entries()) {
    const section = node('section');
    section.className = 'kb-column';
    section.dataset.column = col.id;
    const heading = node('div');
    heading.className = 'kb-tools';
    heading.append(node('h3', col.name));
    heading.append(
      button('✎', async () => {
        const name = await Nexus.prompt('Название колонки', col.name);
        if (name) await columns(snapshot.columns.map((c) => (c.id === col.id ? {...c, name} : c)));
      })
    );
    for (const [label, offset] of [
      ['←', -1],
      ['→', 1]
    ]) {
      const b = button(label, () => {
        const rows = [...snapshot.columns];
        [rows[i], rows[i + offset]] = [rows[i + offset], rows[i]];
        return columns(rows);
      });
      b.disabled = i + offset < 0 || i + offset >= snapshot.columns.length;
      heading.append(b);
    }
    section.append(heading);
    section.ondragover = (e) => e.preventDefault();
    section.ondrop = (e) => {
      e.preventDefault();
      const c = snapshot.cards.find((c) => c.id === e.dataTransfer.getData('text/plain'));
      if (c) action(() => move(c, col.id))();
    };
    const query = $('Search').value.toLocaleLowerCase(),
      tag = $('Tag').value.toLocaleLowerCase();
    for (const c of snapshot.cards.filter(
      (c) =>
        c.column_id === col.id &&
        !!c.archived === $('Archive').checked &&
        (!query ||
          [c.title, c.description, ...c.tags].join(' ').toLocaleLowerCase().includes(query)) &&
        (!tag || c.tags.some((t) => t.toLocaleLowerCase().includes(tag))) &&
        (!$('Priority').value || String(c.priority) === $('Priority').value)
    )) {
      const card = node('article');
      card.className = 'kb-card';
      card.draggable = true;
      card.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.id);
      const grip = node('span', '⠿', 'kb-grip');
      grip.title = 'Перетащи задачу';
      grip.setAttribute('aria-label', 'Перетащить задачу');
      card.append(grip);
      touchDrag(grip, card, c);
      card.append(
        button((c.done ? '✓ ' : '') + c.title, () => edit(c)),
        node('p', c.description.slice(0, 180))
      );
      card.append(
        node(
          'small',
          [
            ['Обычный', 'Низкий', 'Высокий', 'Срочный'][c.priority],
            c.due ? 'Срок: ' + new Date(c.due).toLocaleString() : '',
            c.tags.join(', '),
            c.checklist.length
              ? `${c.checklist.filter((x) => x.done).length}/${c.checklist.length}`
              : ''
          ]
            .filter(Boolean)
            .join(' · ')
        )
      );
      if (c.project) {
        const link = node('a', 'Открыть проект в Гефесте');
        link.href = '/modules/projects/?project=' + encodeURIComponent(c.project);
        card.append(link);
      }
      section.append(card);
    }
    $('Columns').append(section);
  }
}
const localDate = (n) =>
  n === null
    ? ''
    : new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
async function edit(c) {
  const data = await Promise.all([
    fetch('/modules/storage/api')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
    fetch('/modules/projects/api')
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => [])
  ]);
  files = data[0]?.files ?? [];
  projects = Array.isArray(data[1]) ? data[1] : [];
  editing = c;
  $('Title').value = c?.title ?? '';
  $('Description').value = c?.description ?? '';
  $('Column').replaceChildren(...snapshot.columns.map((x) => new Option(x.name, x.id)));
  $('Column').value = c?.column_id ?? snapshot.columns[0].id;
  $('EditPriority').value = c?.priority ?? 0;
  $('Due').value = localDate(c?.due ?? null);
  $('Remind').value = localDate(c?.remind ?? null);
  $('Tags').value = c?.tags.join(', ') ?? '';
  $('Checklist').value = c?.checklist.map((x) => (x.done ? '[x] ' : '') + x.text).join('\n') ?? '';
  $('Done').checked = !!c?.done;
  $('Archived').checked = !!c?.archived;
  if (c?.project && !projects.some((p) => p.id === c.project))
    projects.push({id: c.project, name: 'Связанный проект (недоступен)'});
  $('Project').replaceChildren(
    new Option('Без проекта', ''),
    ...projects.map((p) => new Option(p.name, p.id))
  );
  $('Project').value = c?.project ?? '';
  for (const id of c?.attachments ?? [])
    if (!files.some((f) => f.id === id)) files.push({id, name: 'Недоступный файл ' + id});
  $('Files').replaceChildren();
  for (const f of files) {
    const label = node('label'),
      check = node('input');
    check.type = 'checkbox';
    check.value = f.id;
    check.checked = c?.attachments.includes(f.id) ?? false;
    const link = node('a', f.name);
    link.href = '/modules/storage/file/' + f.id;
    link.target = '_blank';
    link.rel = 'noopener';
    label.append(check, link);
    $('Files').append(label);
  }
  if (!files.length) $('Files').textContent = 'Загрузи файлы в общее хранилище.';
  $('EditorStatus').textContent = '';
  $('Editor').showModal();
}
$('Form').onsubmit = async (e) => {
  e.preventDefault();
  const submit = e.submitter;
  submit.disabled = true;
  try {
    snapshot = await api('/api/card', {
      id: editing?.id,
      version: editing?.version,
      board: snapshot.board.id,
      column: $('Column').value,
      title: $('Title').value,
      description: $('Description').value,
      priority: Number($('EditPriority').value),
      due: $('Due').value ? new Date($('Due').value).getTime() : null,
      remind: $('Remind').value ? new Date($('Remind').value).getTime() : null,
      tags: $('Tags')
        .value.split(',')
        .map((t) => t.trim())
        .filter(Boolean),
      project: $('Project').value || null,
      checklist: $('Checklist')
        .value.split('\n')
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => ({done: /^\[x\]/i.test(t), text: t.replace(/^\[(x| )\]\s*/i, '')})),
      attachments: [...$('Files').querySelectorAll('input:checked')].map((i) => i.value),
      done: $('Done').checked,
      archived: $('Archived').checked
    });
    $('Editor').close();
    render();
  } catch (err) {
    $('EditorStatus').textContent = err.message;
  } finally {
    submit.disabled = false;
  }
};
$('Cancel').onclick = () => $('Editor').close();
$('Board').onchange = action(refresh);
$('Refresh').onclick = action(refresh);
$('NewBoard').onclick = action(async () => {
  const name = await Nexus.prompt('Название доски');
  if (name) {
    const s = await api('/api/board', {name});
    await boards(s.board.id);
  }
});
$('NewColumn').onclick = action(async () => {
  if (!snapshot) return;
  const name = await Nexus.prompt('Название колонки');
  if (name) await columns([...snapshot.columns, {name}]);
});
$('NewCard').onclick = action(() => snapshot && edit(null));
for (const key of ['Search', 'Tag', 'Priority', 'Archive'])
  $(key).oninput = () => snapshot && render();
action(async () => {
  const query = new URLSearchParams(location.search);
  await boards(query.get('board'));
  const card = snapshot?.cards.find((c) => c.id === query.get('card'));
  if (card) {
    $('Archive').checked = !!card.archived;
    render();
    await edit(card);
  }
})();
