(() => {
  const $ = (id) => document.getElementById(id),
    root = $('chatPage') ?? $('chatSettings');
  if (!root) return;
  const isSettings = Boolean($('chatSettings'));
  const make = (tag, text, cls) => {
    const n = document.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  };
  const label = (model) =>
    ({'deepseek-v4-pro': 'Pro', 'deepseek-flash': 'Flash', 'producer:standard': 'FlowMusic'})[
      model
    ] ?? model;
  let provider =
    new URLSearchParams(location.search).get('provider') === 'flowmusic' ? 'flowmusic' : 'deepseek';
  const flow = () => provider === 'flowmusic';
  const providerStatus = () =>
    flow()
      ? config.flowmusic.needsLogin
        ? 'FlowMusic: нужна новая сессия в настройках.'
        : config.flowmusic.configured
          ? ''
          : 'Сессия FlowMusic не задана.'
      : config.configured
        ? ''
        : 'API-ключ DeepSeek не задан.';
  function modelOptions(id, selected) {
    const list = config.models ?? ['deepseek-flash', 'deepseek-v4-pro'];
    $(id).replaceChildren(...list.map((m) => new Option(label(m), m)));
    $(id).value = list.includes(selected) ? selected : config.model;
    if (id === 'chatModel') $(id).hidden = flow();
  }
  function providerUI() {
    $('chatProvider').value = provider;
    $('chatModel').hidden = flow();
    $('chatInput').placeholder = flow() ? 'Опиши музыку, настроение и вокал…' : 'Напиши сообщение…';
    $('chatInput').maxLength = flow() ? 8000 : 32000;
    $('chatStop').textContent = flow() ? 'Прервать ожидание' : 'Стоп';
    root.querySelector('.chat-file').hidden = flow();
  }
  const status = (text, error = false) => {
    $('chatStatus').textContent = text;
    $('chatStatus').classList.toggle('error', error);
  };
  let config,
    current = null,
    topicId = new URLSearchParams(location.search).get('topic'),
    busy = false,
    dialogBusy = false,
    dialogAction = '',
    pendingId = null,
    loadTurn = 0,
    pendingSend = null,
    streamStarted = false,
    draftTopicId = null;
  async function api(route, data) {
    const response = await fetch('/modules/chat' + route, {
      method: data ? 'POST' : 'GET',
      cache: 'no-store',
      headers: data ? {'Content-Type': 'application/json'} : {},
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(20000)
    });
    if (response.status === 401 || response.redirected) {
      location.replace('/login');
      throw new Error('Требуется вход.');
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Запрос не выполнен.');
    return result;
  }
  const action = (text, fn, cls) => {
    const b = make('button', text, cls);
    b.type = 'button';
    b.addEventListener('click', () =>
      Promise.resolve()
        .then(fn)
        .catch((e) => status(e.message, true))
    );
    return b;
  };
  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const old = button.textContent;
      button.textContent = 'Скопировано';
      setTimeout(() => {
        button.textContent = old;
      }, 1200);
    } catch {
      status('Не удалось скопировать. Выдели текст вручную.', true);
    }
  }
  function inline(parent, text) {
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let last = 0;
    for (const m of text.matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(last, m.index)));
      const token = m[0];
      if (token[0] === '`') parent.append(make('code', token.slice(1, -1)));
      else if (token.startsWith('**')) parent.append(make('strong', token.slice(2, -2)));
      else {
        const parts = /^\[([^\]]+)\]\((.+)\)$/.exec(token);
        let url;
        try {
          url = new URL(parts[2]);
        } catch {}
        if (url && ['https:', 'http:'].includes(url.protocol)) {
          const a = make('a', parts[1]);
          a.href = url.href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          parent.append(a);
        } else parent.append(document.createTextNode(token));
      }
      last = m.index + token.length;
    }
    parent.append(document.createTextNode(text.slice(last)));
  }
  function codeBlock(source, language) {
    const block = make('div', undefined, 'chat-code'),
      head = make('div', undefined, 'chat-code-head'),
      pre = make('pre'),
      code = make('code');
    const lang = language.replace(/[^a-z0-9+#.-]/gi, '').slice(0, 20) || 'text';
    head.append(make('span', lang));
    const copyButton = action('Копировать', () => copy(source, copyButton));
    head.append(
      copyButton,
      action('Скачать', () => {
        const extensions = {
          javascript: 'js',
          js: 'js',
          typescript: 'ts',
          ts: 'ts',
          python: 'py',
          py: 'py',
          bash: 'sh',
          sh: 'sh',
          json: 'json',
          html: 'html',
          css: 'css',
          sql: 'sql',
          yaml: 'yml',
          markdown: 'md',
          md: 'md'
        };
        const url = URL.createObjectURL(new Blob([source], {type: 'text/plain;charset=utf-8'})),
          a = make('a');
        a.href = url;
        a.download = 'code.' + (extensions[lang] ?? 'txt');
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })
    );
    const tokens =
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b(?:const|let|var|function|return|if|else|for|while|class|import|from|async|await|def|True|False|None|true|false|null)\b)/g;
    let last = 0;
    for (const m of source.matchAll(tokens)) {
      code.append(
        document.createTextNode(source.slice(last, m.index)),
        make('span', m[0], /^['"]/.test(m[0]) ? 'chat-string' : 'chat-token')
      );
      last = m.index + m[0].length;
    }
    code.append(document.createTextNode(source.slice(last)));
    pre.append(code);
    block.append(head, pre);
    return block;
  }
  function markdown(node, text) {
    const lines = text.split('\n');
    node.replaceChildren();
    for (let i = 0; i < lines.length; i++) {
      const fence = /^\s*```([^`]*)$/.exec(lines[i]);
      if (fence) {
        const code = [];
        while (++i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i]);
        node.append(codeBlock(code.join('\n'), fence[1].trim()));
        continue;
      }
      if (
        i + 1 < lines.length &&
        lines[i].includes('|') &&
        /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])
      ) {
        const wrapper = make('div', undefined, 'chat-table'),
          table = make('table');
        const add = (line, tag) => {
          const tr = make('tr');
          for (const cell of line.replace(/^\s*\||\|\s*$/g, '').split('|')) {
            const td = make(tag);
            inline(td, cell.trim());
            tr.append(td);
          }
          table.append(tr);
        };
        add(lines[i], 'th');
        i += 2;
        while (i < lines.length && lines[i].includes('|')) {
          add(lines[i], 'td');
          i++;
        }
        i--;
        wrapper.append(table);
        node.append(wrapper);
        continue;
      }
      if (!lines[i].trim()) continue;
      const heading = /^#{1,6}\s+(.+)$/.exec(lines[i]),
        list = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(lines[i]);
      if (list) {
        const ordered = /^\s*\d/.test(lines[i]),
          ul = make(ordered ? 'ol' : 'ul');
        do {
          const li = make('li');
          inline(li, /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(lines[i])[1]);
          ul.append(li);
          i++;
        } while (i < lines.length && /^\s*(?:[-*]|\d+\.)\s+(.+)$/.test(lines[i]));
        i--;
        node.append(ul);
        continue;
      }
      const p = make(heading ? 'h3' : 'p');
      inline(p, heading ? heading[1] : lines[i]);
      node.append(p);
    }
  }
  function message(m) {
    const row = make('article', undefined, 'chat-message');
    row.dataset.role = m.role;
    row.dataset.id = m.id;
    const head = make('div', undefined, 'chat-message-head'),
      content = make('div', undefined, 'chat-text');
    head.append(
      make(
        'strong',
        m.role === 'user'
          ? 'Ты'
          : m.model === 'producer:standard'
            ? 'FlowMusic'
            : 'DeepSeek · ' + label(m.model)
      ),
      make(
        'span',
        new Date(m.created).toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit'})
      )
    );
    if (m.content) {
      const b = action('Копировать', () => copy(m.content, b), 'chat-copy');
      head.append(b);
    }
    if (m.role === 'user') content.textContent = m.content;
    else markdown(content, m.content);
    row.append(head, content);
    for (const track of m.audio ?? []) {
      const card = make('div', undefined, 'chat-audio'),
        player = make('audio'),
        download = make('a', 'Скачать');
      player.controls = true;
      player.preload = 'none';
      player.src = track.src;
      player.setAttribute('aria-label', track.title || 'Трек');
      download.href = track.src + '?download=1';
      download.download = 'flowmusic.' + track.extension;
      card.append(make('span', track.title || 'Трек'), player, download);
      row.append(card);
    }
    if (m.status === 'running') row.append(make('p', 'Отвечает…', 'chat-notice'));
    if (m.notice) row.append(make('p', m.notice, 'chat-notice'));
    if (m.usage)
      row.append(make('p', m.usage.total_tokens.toLocaleString('ru-RU') + ' токенов', 'chat-hint'));
    if (m.status === 'error' && m.id === current?.messages.at(-1)?.id) {
      const request = current.requests.find((r) => r.assistant === m.id);
      if (request) row.append(action('Повторить', () => send(request.id)));
    }
    return row;
  }
  function controls() {
    const running = current?.messages.some((m) => m.status === 'running');
    for (const id of [
      'chatProvider',
      'chatTopics',
      'chatNew',
      'chatRename',
      'chatDelete',
      'chatModel',
      'chatInput',
      'chatSend',
      'chatFile'
    ])
      $(id).disabled =
        busy ||
        Boolean(running) ||
        (!current && !['chatProvider', 'chatTopics', 'chatNew', 'chatModel'].includes(id));
    $('chatStop').hidden = !busy && !running;
    $('chatStop').disabled = busy && !streamStarted;
    if (!busy && running) pendingId = current.requests.find((r) => r.status === 'running')?.id;
    $('chatOlder').hidden = !current?.more;
    $('chatOlder').disabled = busy || Boolean(running);
    root.querySelectorAll('.chat-message button').forEach((b) => {
      if (b.textContent === 'Повторить') b.disabled = busy || Boolean(running);
    });
  }
  function render() {
    $('chatMessages').replaceChildren(
      ...(current
        ? current.messages.map(message)
        : [make('p', 'Создай тему, чтобы начать разговор.', 'chat-help')])
    );
    const usage =
      current?.messages.filter((m) => m.usage).reduce((sum, m) => sum + m.usage.total_tokens, 0) ??
      0;
    $('chatUsage').textContent = usage
      ? usage.toLocaleString('ru-RU') + ' токенов в показанных ответах'
      : '';
    controls();
  }
  async function load(select = topicId) {
    const turn = ++loadTurn;
    const data = await api('/topics');
    if (turn !== loadTurn) return;
    if (select) provider = data.topics.find((t) => t.id === select)?.provider ?? provider;
    data.topics = data.topics.filter((t) => t.provider === provider);
    providerUI();
    const id = data.topics.some((t) => t.id === select) ? select : (data.topics[0]?.id ?? null);
    const history = id ? await api('/history?topic=' + id) : null;
    if (turn !== loadTurn) return;
    $('chatTopics').replaceChildren(...data.topics.map((t) => new Option(t.title, t.id)));
    topicId = id;
    current = history;
    if (id) $('chatTopics').value = id;
    historyURL();
    render();
    status(providerStatus());
  }
  function historyURL() {
    const url = new URL(location.href);
    url.searchParams.set('provider', provider);
    if (topicId) url.searchParams.set('topic', topicId);
    else url.searchParams.delete('topic');
    history.replaceState(null, '', url);
  }
  function openDialog(kind) {
    if (busy) return;
    dialogAction = kind;
    draftTopicId = kind === 'create' ? crypto.randomUUID() : null;
    $('chatDialogError').textContent = '';
    $('chatTitleLabel').hidden = kind === 'delete';
    $('chatTitle').required = kind !== 'delete';
    $('chatTitle').value = kind === 'rename' ? current.topic.title : '';
    $('chatDialogTitle').textContent = {
      create: 'Новая тема',
      rename: 'Название темы',
      delete: 'Удалить тему?'
    }[kind];
    $('chatDialogText').textContent =
      kind === 'delete' ? 'Вся переписка этой темы будет удалена.' : '';
    $('chatConfirm').textContent = kind === 'delete' ? 'Удалить' : 'Сохранить';
    $('chatConfirm').classList.toggle('chat-danger', kind === 'delete');
    $('chatDialog').showModal();
    $(kind === 'delete' ? 'chatCancel' : 'chatTitle').focus();
  }
  root.querySelectorAll('[data-chat-close]').forEach((b) =>
    b.addEventListener('click', () => {
      if (!dialogBusy) b.closest('dialog').close();
    })
  );
  root.querySelectorAll('dialog').forEach((d) =>
    d.addEventListener('cancel', (e) => {
      if (dialogBusy) e.preventDefault();
    })
  );
  async function send(retryId) {
    if (busy || !current) return;
    const text = $('chatInput').value.trim();
    if (!retryId && !text) return;
    const topic = topicId,
      model = flow() ? 'producer:standard' : $('chatModel').value,
      signature = JSON.stringify([topic, text, model]);
    if (!retryId && pendingSend?.signature !== signature)
      pendingSend = {signature, id: crypto.randomUUID()};
    const id = retryId ?? pendingSend.id;
    busy = true;
    streamStarted = false;
    pendingId = id;
    controls();
    status(flow() ? 'FlowMusic запускает генерацию…' : 'DeepSeek отвечает…');
    let ended = false,
      buffer = '',
      live = null,
      reply = '';
    const onEvent = (event) => {
      if (event.type === 'start') {
        streamStarted = true;
        controls();
        if (!retryId) {
          $('chatInput').value = '';
          $('chatMessages').append(
            message({id: 'new-user', role: 'user', content: text, created: Date.now()})
          );
        }
        const row = make('article', undefined, 'chat-message');
        row.dataset.role = 'assistant';
        row.append(
          make('div', flow() ? 'FlowMusic' : 'DeepSeek · ' + label(model), 'chat-message-head')
        );
        live = make('div', '…', 'chat-text');
        row.append(live);
        $('chatMessages').append(row);
        if (event.limited) status('В контексте — последние сообщения темы.');
      }
      if (event.type === 'progress') status(event.text);
      if (event.type === 'replace') {
        reply = event.text;
        if (live) live.textContent = reply;
      }
      if (event.type === 'delta') {
        const follow = innerHeight + scrollY >= document.documentElement.scrollHeight - 180;
        reply += event.text;
        if (live) live.textContent = reply;
        if (follow) scrollTo({top: document.documentElement.scrollHeight});
      }
      if (event.type === 'done' || event.type === 'error') {
        ended = true;
        if (event.topic) current = event;
        render();
        status(event.error ?? '', event.type === 'error');
      }
    };
    try {
      const response = await fetch('/modules/chat/' + (retryId ? 'retry' : 'send'), {
        method: 'POST',
        cache: 'no-store',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(
          retryId
            ? {requestId: id, version: current.topic.version}
            : {requestId: id, topic, version: current.topic.version, text, model}
        )
      });
      if (response.status === 401 || response.redirected) {
        location.replace('/login');
        return;
      }
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? 'Не удалось отправить сообщение.');
      }
      if (response.headers.get('content-type')?.includes('application/json')) {
        const data = await response.json();
        current = data;
        $('chatInput').value = '';
        render();
        ended = true;
      } else {
        const reader = response.body.getReader(),
          decoder = new TextDecoder();
        try {
          while (true) {
            const {value, done} = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, {stream: true});
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, i);
              buffer = buffer.slice(i + 1);
              if (line) onEvent(JSON.parse(line));
            }
          }
        } finally {
          reader.releaseLock();
        }
        if (!ended) throw new Error('Соединение прервано. Проверяем сохранённую историю.');
      }
    } catch (error) {
      try {
        await load(topic);
        if (current?.requests.some((r) => r.id === id)) $('chatInput').value = '';
      } catch {}
      status(error.message, true);
    } finally {
      if (ended) pendingSend = null;
      busy = false;
      pendingId = null;
      controls();
    }
  }
  async function settingsLoad() {
    config = await api('/config');
    $('chatKeyState').textContent = config.configured ? 'ключ сохранён' : 'ключ не задан';
    modelOptions('chatDefaultModel', config.model);
    $('flowState').textContent = config.flowmusic.needsLogin
      ? 'нужна новая сессия'
      : config.flowmusic.configured
        ? 'сессия сохранена'
        : 'не подключён';
    $('flowCheck').disabled = $('flowRemove').disabled = !config.flowmusic.configured;
    $('chatMaxTokens').value = String(config.maxTokens);
    $('chatThinking').checked = config.thinking;
    $('chatCheckKey').disabled = $('chatRemoveKey').disabled = !config.configured;
    status('');
  }
  async function saveSettings(remove = false) {
    if (dialogBusy) return;
    dialogBusy = true;
    root.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      await api('/config', {
        key: $('chatKey').value.trim(),
        removeKey: remove,
        model: $('chatDefaultModel').value,
        maxTokens: Number($('chatMaxTokens').value),
        thinking: $('chatThinking').checked
      });
      $('chatKey').value = '';
      $('chatKeyDialog').close();
      await settingsLoad();
      status(remove ? 'Ключ удалён.' : 'Сохранено.');
    } catch (error) {
      if (remove) $('chatKeyError').textContent = error.message;
      else status(error.message, true);
    } finally {
      dialogBusy = false;
      root.querySelectorAll('button').forEach((b) => (b.disabled = false));
      $('chatCheckKey').disabled = $('chatRemoveKey').disabled = !config?.configured;
      $('flowCheck').disabled = $('flowRemove').disabled = !config?.flowmusic.configured;
    }
  }
  if (isSettings) {
    async function flowAction(kind) {
      if (dialogBusy) return;
      dialogBusy = true;
      root.querySelectorAll('button').forEach((b) => (b.disabled = true));
      status(kind === 'check' ? 'Проверяем сессию…' : 'Сохраняем…');
      try {
        await api(
          kind === 'check' ? '/flow/check' : '/flow/config',
          kind === 'save'
            ? {refreshToken: $('flowRefresh').value.trim(), anonKey: $('flowAnon').value.trim()}
            : kind === 'remove'
              ? {remove: true}
              : {}
        );
        $('flowRefresh').value = '';
        $('flowAnon').value = '';
        $('flowDialog').close();
        await settingsLoad();
        status(
          kind === 'check'
            ? 'Сессия FlowMusic обновлена.'
            : kind === 'remove'
              ? 'Сессия удалена.'
              : 'Сохранено. Сессия обновляется на сервере.'
        );
      } catch (e) {
        if (kind === 'remove') $('flowError').textContent = e.message;
        else status(e.message, true);
      } finally {
        $('flowRefresh').value = '';
        $('flowAnon').value = '';
        dialogBusy = false;
        root.querySelectorAll('button').forEach((b) => (b.disabled = false));
        $('flowCheck').disabled = $('flowRemove').disabled = !config?.flowmusic.configured;
        $('chatCheckKey').disabled = $('chatRemoveKey').disabled = !config?.configured;
      }
    }
    $('flowForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void flowAction('save');
    });
    $('flowCheck').addEventListener('click', () => void flowAction('check'));
    $('flowRemove').addEventListener('click', () => {
      $('flowError').textContent = '';
      $('flowDialog').showModal();
    });
    $('flowDeleteConfirm').addEventListener('click', () => void flowAction('remove'));
    $('chatKeyForm').addEventListener('submit', (e) => {
      e.preventDefault();
      void saveSettings();
    });
    $('chatCheckKey').addEventListener('click', async () => {
      const b = $('chatCheckKey');
      b.disabled = true;
      status('Проверяем ключ…');
      try {
        const checked = await api('/check', {});
        await settingsLoad();
        status('DeepSeek подключён. Модели: ' + checked.models.map(label).join(', ') + '.');
      } catch (e) {
        status(e.message, true);
      } finally {
        b.disabled = false;
      }
    });
    $('chatRemoveKey').addEventListener('click', () => {
      $('chatKeyError').textContent = '';
      $('chatKeyDialog').showModal();
    });
    $('chatKeyDeleteConfirm').addEventListener('click', () => void saveSettings(true));
    void settingsLoad().catch((e) => status(e.message, true));
    return;
  }
  $('chatProvider').addEventListener('change', () => {
    provider = $('chatProvider').value;
    $('chatInput').value = '';
    pendingSend = null;
    void load(null).catch((e) => status(e.message, true));
  });
  $('chatNew').addEventListener('click', () => openDialog('create'));
  $('chatRename').addEventListener('click', () => openDialog('rename'));
  $('chatDelete').addEventListener('click', () => openDialog('delete'));
  $('chatTopics').addEventListener(
    'change',
    () => void load($('chatTopics').value).catch((e) => status(e.message, true))
  );
  $('chatComposer').addEventListener('submit', (e) => {
    e.preventDefault();
    void send();
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (
      e.key === 'Enter' &&
      !e.shiftKey &&
      !e.isComposing &&
      !e.repeat &&
      !matchMedia('(pointer:coarse)').matches
    ) {
      e.preventDefault();
      void send();
    }
  });
  $('chatStop').addEventListener('click', async () => {
    $('chatStop').disabled = true;
    try {
      await api('/stop', {requestId: pendingId});
    } catch (e) {
      status(e.message, true);
      $('chatStop').disabled = busy && !streamStarted;
    }
  });
  $('chatDialogForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (dialogBusy) return;
    dialogBusy = true;
    const id = dialogAction === 'create' ? draftTopicId : topicId;
    $('chatDialog')
      .querySelectorAll('button,input')
      .forEach((n) => (n.disabled = true));
    try {
      await api('/topic', {
        action: dialogAction,
        provider,
        id,
        title: $('chatTitle').value.trim(),
        version: current?.topic.version
      });
      $('chatDialog').close();
      await load(dialogAction === 'delete' ? null : id);
    } catch (error) {
      $('chatDialogError').textContent = error.message;
    } finally {
      dialogBusy = false;
      $('chatDialog')
        .querySelectorAll('button,input')
        .forEach((n) => (n.disabled = false));
    }
  });
  $('chatOlder').addEventListener('click', async () => {
    if (!current || busy) return;
    const id = topicId;
    $('chatOlder').disabled = true;
    try {
      const older = await api('/history?topic=' + id + '&before=' + current.messages[0].id);
      if (id !== topicId) return;
      current = {...current, messages: [...older.messages, ...current.messages], more: older.more};
      const height = document.documentElement.scrollHeight;
      render();
      scrollBy(0, document.documentElement.scrollHeight - height);
    } catch (e) {
      status(e.message, true);
    } finally {
      controls();
    }
  });
  $('chatFile').addEventListener('change', async () => {
    const file = $('chatFile').files[0];
    $('chatFile').value = '';
    if (!file) return;
    if (
      file.size > 65536 ||
      !/\.(txt|md|js|mjs|json|csv|log|sh|html|css|yaml|yml|ts|py)$/i.test(file.name)
    ) {
      status('Можно добавить текстовый файл до 64 КБ.', true);
      return;
    }
    try {
      const text = await file.text();
      if (text.includes('\0')) throw new Error('Нужен текстовый файл.');
      const addition = '\n\nФайл: ' + file.name + '\n```\n' + text + '\n```';
      if ($('chatInput').value.length + addition.length > 32000)
        throw new Error('Сообщение с файлом длиннее 32 000 символов.');
      $('chatInput').value += addition;
      $('chatInput').focus();
      status('Текст файла добавлен к сообщению.');
    } catch (e) {
      status(e.message, true);
    }
  });
  async function refresh() {
    if (busy || document.hidden || root.querySelector('dialog[open]')) return;
    try {
      config = await api('/config');
      modelOptions('chatModel', $('chatModel').value);
      if (current?.messages.some((m) => m.status === 'running')) {
        current = await api('/history?topic=' + topicId);
        render();
      }
      status(providerStatus());
    } catch (e) {
      status(e.message, true);
    }
  }
  addEventListener('online', refresh);
  addEventListener('offline', () =>
    status('Нет соединения. Переписка доступна после подключения.', true)
  );
  setInterval(refresh, 5000);
  void (async () => {
    config = await api('/config');
    modelOptions('chatModel', config.model);
    await load();
  })().catch((e) => status(e.message, true));
})();
