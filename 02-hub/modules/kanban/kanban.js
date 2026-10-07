const $ = (id) => document.getElementById('kb' + id);
let columnEditing = null, mutating = false, nativeDrag = null, refreshSequence = 0;
let snapshot = null,
  editing = null,
  files = [],
  projects = [];
const node = Nexus.node;
const view = Nexus.rememberView?.(['kbSearch','kbTag','kbPriority','kbArchive'], () => ({board:$('Board').value}));
const api = (route, body) => Nexus.request('/modules/kanban' + route, body);
function action(fn) {
  return async () => {
    try {
      await fn();
      $('Status').textContent = '';
    } catch (e) {
      Nexus.problem($('Status'), 'kanban', e);
    }
  };
}
function button(label, fn) {
  const b = node('button', label);
  b.type = 'button';
  b.onclick = action(fn);
  return b;
}
function iconButton(kind, label, fn) {
  const b = button('', fn); b.className = 'kb-icon'; b.title = label; b.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(svg.namespaceURI, 'path');
  p.setAttribute('d', {plus:'M12 5v14M5 12h14', trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', edit:'m15 4 5 5M4 20l5-1L20 8a3 3 0 0 0-4-4L5 15Z', left:'m14 5-7 7 7 7M7 12h14', right:'m10 5 7 7-7 7M3 12h14'}[kind]);
  svg.append(p); b.append(svg); if (kind === 'trash') b.classList.add('kb-trash'); return b;
}
async function metadata() {
  const values = await Promise.all([
    apiMetadata('/modules/storage/api', null), apiMetadata('/modules/projects/api', [])
  ]);
  files = values[0]?.files ?? []; projects = Array.isArray(values[1]) ? values[1] : [];
}
async function apiMetadata(url, fallback) { try { return await Nexus.request(url); } catch { return fallback; } }
async function boards(id) {
  const rows = await api('/api');
  $('Board').replaceChildren(...rows.map((b) => new Option(b.name, b.id)));
  if (rows.some(b => b.id === id)) $('Board').value = id;
  await metadata();
  if ($('Board').value) await refresh();
  else { snapshot = null; $('Status').textContent = 'Создай первую доску'; $('Columns').replaceChildren(); }
}
async function refresh() {
  const id = $('Board').value, sequence = ++refreshSequence;
  const next = await api('/api/board/' + id);
  if (sequence !== refreshSequence || $('Board').value !== id) return;
  snapshot = next; render();
}
async function mutate(route, body) {
  if (mutating) throw Error('Дождись сохранения текущего изменения');
  mutating = true; $('Board').disabled = true;
  try {
    const next = await api(route, body);
    if ($('Board').value === next.board.id) { ++refreshSequence; snapshot = next; render(); }
  } finally { mutating = false; $('Board').disabled = false; }
}
async function columns(rows) {
  return mutate('/api/columns', {board: snapshot.board.id, version: snapshot.board.version, columns: rows});
}
async function move(card, column) {
  if (column === card.column_id) return;
  return mutate('/api/move', {id: card.id, column, version: card.version});
}
function columnAt(x, y) {
  const board = $('Columns'), rect = board.getBoundingClientRect();
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return null;
  const columns = [...board.querySelectorAll('.kb-column')];
  return columns.find(section => { const r = section.getBoundingClientRect(); return x >= r.left - 5 && x <= r.right + 5; }) ?? null;
}
function clearDrop() { $('Columns').querySelectorAll('.kb-drop-target').forEach(el => el.classList.remove('kb-drop-target')); }
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
      target = columnAt(x, y);
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
  cancelDrag?.(); nativeDrag = null;
  $('Columns').replaceChildren();
  const query = $('Search').value.toLocaleLowerCase(), tag = $('Tag').value.toLocaleLowerCase();
  const visible = snapshot.cards.filter(c => !!c.archived === $('Archive').checked &&
    (!query || [c.title, c.description, ...c.tags, ...c.checklist.map(item => item.text)].join(' ').toLocaleLowerCase().includes(query)) &&
    (!tag || c.tags.some(t => t.toLocaleLowerCase().includes(tag))) &&
    (!$('Priority').value || String(c.priority) === $('Priority').value));
  for (const [i, col] of snapshot.columns.entries()) {
    const section = node('section', undefined, 'kb-column'); section.dataset.column = col.id;
    const heading = node('div', undefined, 'kb-column-head');
    const title = node('h3', col.name), count = node('span', String(visible.filter(c => c.column_id === col.id).length), 'kb-count');
    heading.append(title, count);
    const tools = node('div', undefined, 'kb-column-actions');
    if (i === 0) {
      const add = iconButton('plus', 'Добавить задачу', async () => { $('Archive').checked = false; render(); await edit(null); });
      add.id = 'kbNewCard'; tools.append(add);
    }
    tools.append(iconButton('edit', 'Редактировать колонку «' + col.name + '»', () => editColumn(col)));
    for (const [kind, offset, label] of [['left', -1, 'Колонку влево'], ['right', 1, 'Колонку вправо']]) {
      const b = iconButton(kind, label, () => { const rows = [...snapshot.columns]; [rows[i], rows[i + offset]] = [rows[i + offset], rows[i]]; return columns(rows); });
      b.disabled = i + offset < 0 || i + offset >= snapshot.columns.length; tools.append(b);
    }
    heading.append(tools); section.append(heading);
    const cards = visible.filter(c => c.column_id === col.id);
    for (const c of cards) {
      const card = node('article', undefined, 'kb-card'); card.dataset.card = c.id; card.draggable = true;
      card.ondragstart = e => {
        if (e.target.closest('input, textarea, select, a')) {e.preventDefault(); return;}
        nativeDrag = c.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', c.id); card.classList.add('kb-dragging');
      };
      card.ondragend = () => {nativeDrag = null; clearDrop(); card.classList.remove('kb-dragging');};
      const head = node('div', undefined, 'kb-card-head'), grip = node('span', '⠿', 'kb-grip');
      grip.title = 'Перетащи задачу в любое место колонки'; grip.setAttribute('aria-label', 'Перетащить задачу'); touchDrag(grip, card, c);
      const open = button(c.title, () => edit(c)); open.className = 'kb-card-title'; head.append(open, grip); card.append(head);
      const state = node('div', undefined, 'kb-card-state');
      state.append(node('span', c.done ? 'Завершено' : 'Открыта', c.done ? 'kb-done' : ''));
      state.append(node('span', ['Обычный', 'Низкий', 'Высокий', 'Срочный'][c.priority], 'kb-priority kb-priority-' + c.priority)); card.append(state);
      if (c.description) {
        const description = node('p', c.description, 'kb-description'); card.append(description);
        if (c.description.length > 240) {
          description.classList.add('kb-truncated');
          const more = button('Описание целиком', () => {const short = description.classList.toggle('kb-truncated'); more.textContent = short ? 'Описание целиком' : 'Свернуть описание';});
          more.className = 'kb-text-button'; card.append(more);
        }
      }
      const dates = node('div', undefined, 'kb-dates');
      if (c.due) dates.append(node('span', 'Срок · ' + new Date(c.due).toLocaleString('ru-RU', {dateStyle:'short', timeStyle:'short'}), !c.done && c.due < Date.now() ? 'kb-overdue' : ''));
      if (c.remind) dates.append(node('span', 'Напомнить · ' + new Date(c.remind).toLocaleString('ru-RU', {dateStyle:'short', timeStyle:'short'})));
      if (dates.childNodes.length) card.append(dates);
      if (c.tags.length) {const tags = node('div', undefined, 'kb-tags'); c.tags.forEach(tag => tags.append(node('span', tag))); card.append(tags);}
      if (c.project) {const link = node('a', 'Проект · ' + (projects.find(p => p.id === c.project)?.name ?? 'Открыть в Дедале'), 'kb-project'); link.href = '/modules/projects/?project=' + encodeURIComponent(c.project); card.append(link);}
      if (c.checklist.length) {
        const list = node('div', undefined, 'kb-checklist');
        list.append(node('div', `Чек-лист · ${c.checklist.filter(item => item.done).length} из ${c.checklist.length}`, 'kb-check-heading'));
        let extra;
        c.checklist.forEach((item, index) => {
          const label = node('label', undefined, 'kb-check-item'), check = node('input'); check.type = 'checkbox'; check.checked = item.done;
          check.setAttribute('aria-label', item.text); check.dataset.index = index;
          check.onchange = action(async () => {
            const done = check.checked; card.querySelectorAll('.kb-checklist input').forEach(el => el.disabled = true);
            try { await mutate('/api/check', {id:c.id, version:c.version, index, done});
              $('Columns').querySelector(`[data-card="${c.id}"] [data-index="${index}"]`)?.focus({preventScroll:true});
            } catch (error) {check.checked = item.done; throw error;}
            finally {card.querySelectorAll('.kb-checklist input').forEach(el => el.disabled = false);}
          });
          label.append(check, node('span', item.text));
          if (index < 6) list.append(label);
          else {if (!extra) {extra = node('details'); extra.append(node('summary', 'Ещё ' + (c.checklist.length - 6) + ' пунктов')); list.append(extra);} extra.append(label);}
        }); card.append(list);
      }
      if (c.attachments.length) {
        const group = node('details', undefined, 'kb-attachments'); group.append(node('summary', 'Файлы · ' + c.attachments.length));
        c.attachments.forEach((id,index) => {const link = node('a', files.find(f => f.id === id)?.name ?? 'Файл ' + (index + 1)); link.href = '/modules/storage/file/' + encodeURIComponent(id); link.target = '_blank'; link.rel = 'noopener'; group.append(link);}); card.append(group);
      }
      section.append(card);
    }
    const hint = node('p', cards.length ? 'Перетащи задачу сюда' : 'Нет задач · можно перенести сюда', 'kb-drop-hint'); section.append(hint);
    $('Columns').append(section);
  }
}
$('Columns').ondragover = e => {
  if (!nativeDrag) return;
  const target = columnAt(e.clientX, e.clientY); clearDrop();
  if (target) {e.preventDefault(); e.dataTransfer.dropEffect = 'move'; target.classList.add('kb-drop-target');}
};
$('Columns').ondragleave = e => {if (!$('Columns').contains(e.relatedTarget)) clearDrop();};
$('Columns').ondrop = e => {
  if (!nativeDrag) return;
  e.preventDefault(); const target = columnAt(e.clientX, e.clientY), card = snapshot.cards.find(c => c.id === nativeDrag);
  nativeDrag = null; clearDrop();
  if (target && card) void action(() => move(card, target.dataset.column))();
};
function editColumn(col) {
  columnEditing = {...col, version: snapshot.board.version, board: snapshot.board.id};
  $('ColumnName').value = col.name;
  const count = snapshot.cards.filter(c => c.column_id === col.id).length;
  $('ColumnCount').textContent = count ? `${count} задач, включая архивные. При удалении колонки они будут перенесены.` : 'В колонке нет задач.';
  $('MoveTo').replaceChildren(...snapshot.columns.filter(c => c.id !== col.id).map(c => new Option(c.name, c.id)));
  $('MoveLabel').hidden = !count || snapshot.columns.length === 1;
  const remove = iconButton('trash', 'Удалить колонку', async () => {
    if (snapshot.board.id !== columnEditing.board) throw Error('Доска изменилась');
    const destination = $('MoveTo').value || null;
    const name = snapshot.columns.find(c => c.id === destination)?.name;
    if (!(await Nexus.confirm('Удалить колонку «' + col.name + '»?' + (count ? ' Все её задачи будут перенесены в «' + name + '».' : '')))) return;
    remove.disabled = true;
    try {await mutate('/api/column/remove', {board:columnEditing.board, version:columnEditing.version, id:col.id, destination}); $('ColumnEditor').close();}
    catch (error) {$('ColumnStatus').textContent = error.message;}
    finally {remove.disabled = snapshot.columns.length === 1;}
  });
  remove.disabled = snapshot.columns.length === 1; $('ColumnRemove').replaceChildren(remove);
  $('ColumnStatus').textContent = snapshot.columns.length === 1 ? 'Последнюю колонку удалить нельзя.' : '';
  $('ColumnEditor').showModal();
}
$('ColumnForm').onsubmit = async e => {
  e.preventDefault(); const submit = e.submitter; submit.disabled = true;
  try {
    if (snapshot.board.id !== columnEditing.board) throw Error('Доска изменилась');
    await mutate('/api/columns', {board:columnEditing.board, version:columnEditing.version,
      columns:snapshot.columns.map(c => c.id === columnEditing.id ? {...c, name:$('ColumnName').value} : c)});
    $('ColumnEditor').close();
  } catch (error) {$('ColumnStatus').textContent = error.message;}
  finally {submit.disabled = false;}
};
$('ColumnCancel').onclick = () => $('ColumnEditor').close();
function checklistRow(item = {text:'', done:false}) {
  const row = node('div', undefined, 'kb-check-edit-row'), check = node('input'), input = node('input');
  check.type = 'checkbox'; check.checked = item.done; check.setAttribute('aria-label', 'Пункт выполнен');
  input.type = 'text'; input.maxLength = 300; input.value = item.text; input.placeholder = 'Что нужно сделать'; input.setAttribute('aria-label', 'Текст пункта');
  row.append(check, input, iconButton('trash', 'Удалить пункт чек-листа', () => row.remove())); $('Checklist').append(row); return input;
}
$('AddCheck').onclick = () => {if ($('Checklist').children.length >= 100) {$('EditorStatus').textContent = 'Не более 100 пунктов'; return;} checklistRow().focus();};
const localDate = (n) =>
  n === null
    ? ''
    : new Date(n - new Date(n).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
async function edit(c) {
  await metadata();
  editing = c;
  $('Title').value = c?.title ?? '';
  $('Description').value = c?.description ?? '';
  $('Column').replaceChildren(...snapshot.columns.map((x) => new Option(x.name, x.id)));
  $('Column').value = c?.column_id ?? snapshot.columns[0].id;
  $('EditPriority').value = c?.priority ?? 0;
  $('Due').value = localDate(c?.due ?? null);
  $('Remind').value = localDate(c?.remind ?? null);
  $('Tags').value = c?.tags.join(', ') ?? '';
  $('Checklist').replaceChildren();
  (c?.checklist ?? []).forEach(checklistRow);
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
      checklist: [...$('Checklist').children].map(row => ({text:row.querySelector('input[type=text]').value.trim(), done:row.querySelector('input[type=checkbox]').checked})).filter(item => item.text),
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
Nexus.beforeLeave?.(() => !mutating);
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
for (const key of ['Search', 'Tag', 'Priority', 'Archive'])
  $(key).oninput = () => snapshot && render();
action(async () => {
  const query = new URLSearchParams(location.search);
  await boards(query.get('board') || view?.value.board);
  view?.restore(() => { if(snapshot) render(); });
  const card = snapshot?.cards.find((c) => c.id === query.get('card'));
  if (card) {
    $('Archive').checked = !!card.archived;
    render();
    await edit(card);
  } else if(query.get('new')==='1' && snapshot) await edit();
})();
