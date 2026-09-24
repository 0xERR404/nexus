(() => {
  const $ = (id) => document.getElementById(id),
    root = $('balancePage') ?? $('balanceSettings');
  if (!root) return;
  const settings = Boolean($('balanceSettings'));
  const make = (tag, text, cls) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (cls) node.className = cls;
    return node;
  };
  const sameText = (a, b) =>
    a.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU') ===
    b.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
  const decimal = (value) => (value / 100).toFixed(2);
  const money = (value, currency) =>
    new Intl.NumberFormat('ru-RU', {style: 'currency', currency, maximumFractionDigits: 2}).format(
      value / 100
    );
  const today = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const names = {
    income: 'Доход',
    expense: 'Расход',
    transfer: 'Перевод',
    card: 'Карта',
    cash: 'Наличные',
    savings: 'Накопления'
  };
  let state,
    offset = 0,
    busy = false,
    sequence = 0,
    editing = null,
    editingAccount = null,
    editingCategory = null,
    deleting = null,
    pending = null;
  const status = (message, error = false) => {
    $('balanceStatus').textContent = message;
    $('balanceStatus').classList.toggle('error', error);
  };
  const account = (id) => state.accounts.find((a) => a.id === id);
  const category = (id) => state.categories.find((c) => c.id === id);
  const button = (label, handler, cls) => {
    const node = make('button', label, cls);
    node.type = 'button';
    node.addEventListener('click', () => {
      if (!busy) handler();
    });
    return node;
  };
  function options(node, items, value, empty) {
    node.replaceChildren(
      ...(empty ? [new Option(empty, '')] : []),
      ...items.map((item) => new Option(item.name, item.id))
    );
    if ([...node.options].some((o) => o.value === value)) node.value = value;
  }
  async function api(route, data) {
    const response = await fetch('/modules/balance' + route, {
      method: data ? 'POST' : 'GET',
      cache: 'no-store',
      headers: data ? {'Content-Type': 'application/json'} : {},
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(10000)
    });
    if (response.status === 401 || response.redirected) {
      location.replace('/login');
      throw new Error('Требуется вход');
    }
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(result.error ?? 'Запрос не выполнен'), {
        status: response.status
      });
    return result;
  }
  let insightBusy = false,
    ratesLoaded = false,
    aiState;
  const number = (v, digits = 2) =>
    new Intl.NumberFormat('ru-RU', {maximumFractionDigits: digits}).format(v);
  const stamp = (v) =>
    v
      ? new Date(v).toLocaleString('ru-RU', {
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        })
      : '';
  function quoteCard(id, data, codes, source) {
    const box = $(id);
    box.replaceChildren(
      ...codes.map((code) => {
        const row = make('div', undefined, 'balance-quote');
        row.append(
          make('span', code),
          make(
            'strong',
            data.prices?.[code] ? number(data.prices[code], code === 'KZT' ? 4 : 2) : '—'
          )
        );
        return row;
      })
    );
    $(id + 'Date').textContent =
      source +
      (data.date ? ' · ' + data.date : data.sourceAt ? ' · ' + stamp(data.sourceAt) : '') +
      (data.stale ? ' · нет свежих данных' : '');
  }
  function renderAI() {
    const box = $('balanceAI');
    box.replaceChildren();
    if (!aiState?.available) {
      box.append(make('p', 'Учёт появится после обновления и запуска чата.', 'balance-help'));
      return;
    }
    const period = aiState.periods.find((p) => p.id === $('balanceAIPeriod').value);
    for (const [provider, title] of [
      ['deepseek', 'DeepSeek'],
      ['flowmusic', 'FlowMusic']
    ]) {
      const row = period?.providers.find((p) => p.provider === provider);
      const line = make('div', undefined, 'balance-ai-line');
      const header = make('div', undefined, 'balance-quote');
      const cost = row?.priced ? '≈ $' + number(row.low, 6) + '–' + number(row.high, 6) : '—';
      header.append(make('span', title), make('strong', cost));
      line.append(header);
      const details = !row
        ? 'Нет обращений'
        : provider === 'flowmusic'
          ? number(row.requests) + ' обращ. · стоимость не передаётся'
          : number(row.tokens) +
            ' ток. · ' +
            number(row.requests) +
            ' обращ.' +
            (row.requests > row.priced ? ' · без оценки: ' + (row.requests - row.priced) : '');
      line.append(make('p', details, 'balance-source'));
      box.append(line);
    }
    $('balanceTariffDate').textContent =
      'Диапазон по тарифам ' +
      aiState.tariffDate +
      ': время запроса и кэш. Оценка сохраняется с запросом.';
  }
  async function loadInsights() {
    if (settings || insightBusy || document.hidden) return;
    insightBusy = true;
    await Promise.allSettled([
      api('/rates')
        .then((data) => {
          quoteCard('balanceFiat', data.fiat, ['USD', 'EUR', 'KZT', 'CNY'], 'ЦБ РФ');
          quoteCard('balanceCrypto', data.crypto, ['BTC', 'ETH', 'XMR', 'TON'], 'CoinGecko');
          ratesLoaded = true;
        })
        .catch(() => {
          if (!ratesLoaded) {
            quoteCard('balanceFiat', {}, ['USD', 'EUR', 'KZT', 'CNY'], 'ЦБ РФ');
            quoteCard('balanceCrypto', {}, ['BTC', 'ETH', 'XMR', 'TON'], 'CoinGecko');
          }
          for (const id of ['balanceFiatDate', 'balanceCryptoDate'])
            $(id).textContent = 'Нет соединения · данные не обновлены';
        }),
      api('/ai')
        .then((data) => {
          aiState = data;
          renderAI();
        })
        .catch(() => {
          $('balanceAI').replaceChildren(make('p', 'Учёт временно недоступен', 'balance-help'));
        }),
      api('/credit')
        .then((data) => {
          $('balanceCredit').textContent =
            data.state === 'unconfigured'
              ? 'DeepSeek: ключ не задан'
              : data.balances?.length
                ? 'Остаток API: ' +
                  data.balances
                    .map((b) => number(Number(b.amount), 4) + ' ' + b.currency)
                    .join(' · ') +
                  ' · ' +
                  stamp(data.updatedAt) +
                  (data.state === 'error' ? ' · не обновлён' : '')
                : 'Остаток API временно недоступен';
        })
        .catch(() => {
          $('balanceCredit').textContent = 'Остаток API не обновлён';
        })
    ]);
    insightBusy = false;
  }
  async function marketConfig(data) {
    const form = $('balanceMarketForm');
    if (!form || form.getAttribute('aria-busy') === 'true') return;
    form.setAttribute('aria-busy', 'true');
    form.querySelectorAll('button,input').forEach((node) => (node.disabled = true));
    try {
      const result = await api('/market-config', data);
      $('balanceMarketState').textContent = result.configured
        ? 'Ключ сохранён на сервере'
        : 'Публичный доступ без ключа';
      if (data) $('balanceMarketKey').value = '';
      $('balanceMarketError').textContent = '';
    } catch (error) {
      $('balanceMarketError').textContent = error.message;
    } finally {
      form.removeAttribute('aria-busy');
      form.querySelectorAll('button,input').forEach((node) => (node.disabled = false));
    }
  }
  async function load() {
    const turn = ++sequence;
    const query = new URLSearchParams({
      month: settings ? today().slice(0, 7) : $('balanceMonth').value,
      offset: String(offset)
    });
    if (!settings) {
      query.set('account', $('balanceFilterAccount').value);
      query.set('kind', $('balanceFilterKind').value);
    }
    try {
      const data = await api('/api?' + query);
      if (turn !== sequence) return;
      state = data;
      if (offset >= state.total && offset > 0) {
        offset = Math.max(0, Math.floor((state.total - 1) / state.limit) * state.limit);
        return load();
      }
      render();
      status('Обновлено · ' + new Date().toLocaleTimeString('ru-RU'));
    } catch (error) {
      if (turn === sequence)
        status(error.message + (state ? ' · последние данные за ' + state.month : ''), true);
    }
  }
  async function save(action, data, dialog, errorId) {
    if (busy) return;
    busy = true;
    const controls = [...root.querySelectorAll('button,input,select')].map((node) => [
      node,
      node.disabled
    ]);
    controls.forEach(([node]) => (node.disabled = true));
    root.setAttribute('aria-busy', 'true');
    if (errorId) $(errorId).textContent = '';
    const key = JSON.stringify({action, data});
    if (pending?.key !== key) pending = {key, requestId: crypto.randomUUID()};
    try {
      await api('/mutate', {requestId: pending.requestId, action, data});
      pending = null;
      if (dialog) $(dialog).close();
      await load();
    } catch (error) {
      if (error.status && error.status < 500) pending = null;
      const message = error.status
        ? error.message
        : 'Нет подтверждения сохранения. Повтори — операция не продублируется.';
      if (errorId) $(errorId).textContent = message;
      else status(message, true);
    } finally {
      controls.forEach(([node, disabled]) => (node.disabled = disabled));
      busy = false;
      root.removeAttribute('aria-busy');
      if (state && !settings) {
        $('balancePrev').disabled = state.offset === 0;
        $('balanceNext').disabled = state.offset + state.limit >= state.total;
      }
    }
  }
  function renderTotals() {
    $('balanceTotals').replaceChildren(
      ...state.totals.map((total) => {
        const card = make('article', undefined, 'balance-total');
        const grid = make('div', undefined, 'balance-total-grid');
        const metric = (label, value, cls) => {
          const cell = make('div');
          cell.append(make('h2', label), make('strong', money(value, total.currency), cls));
          grid.append(cell);
        };
        metric('Остаток', total.amount, 'balance-transfer');
        for (const kind of ['income', 'expense']) {
          const value =
            state.period.find((p) => p.currency === total.currency && p.kind === kind)?.amount ?? 0;
          metric(kind === 'income' ? 'Доходы' : 'Расходы', value, 'balance-' + kind);
        }
        card.append(grid);
        const history = state.history?.find((item) => item.currency === total.currency);
        const chart = window.nexusBalanceChart?.(history);
        if (chart) {
          const section = make('div', undefined, 'balance-history');
          section.append(chart, make('p', 'Остаток по дням · ' + state.month, 'spark-caption'));
          card.append(section);
        }
        return card;
      })
    );
    $('balanceAccounts').replaceChildren(
      ...state.accounts
        .filter((a) => !a.archived)
        .map((a) => {
          const card = make('article', undefined, 'balance-account');
          card.append(make('h3', a.name), make('strong', money(a.balance, a.currency)));
          return card;
        })
    );
    if (!state.accounts.some((a) => !a.archived))
      $('balanceAccounts').append(
        make('p', 'Добавь или восстанови счёт в настройках.', 'balance-help')
      );
  }
  function renderHistory() {
    $('balanceCount').textContent = String(state.total);
    const selected = $('balanceFilterAccount').value;
    options($('balanceFilterAccount'), state.accounts, selected, 'Все счета');
    $('balanceTransactions').replaceChildren(
      ...state.transactions.map((t) => {
        const source = account(t.account),
          target = account(t.target),
          row = make('article', undefined, 'balance-row');
        const description = make('div'),
          side = make('div', undefined, 'balance-row-side'),
          actions = make('div', undefined, 'balance-actions');
        const title =
          t.kind === 'transfer'
            ? `${source.name} → ${target.name}`
            : (category(t.category)?.name ?? names[t.kind]);
        description.append(
          make('strong', title),
          make(
            'p',
            `${t.date.split('-').reverse().join('.')}${t.kind === 'transfer' ? '' : ' · ' + source.name}`
          )
        );
        if (t.note && !sameText(t.note, title)) description.append(make('p', t.note));
        let amount =
          (t.kind === 'income' ? '+' : t.kind === 'expense' ? '−' : '') +
          money(t.amount, source.currency);
        if (target && target.currency !== source.currency)
          amount += ' → ' + money(t.received, target.currency);
        side.append(make('strong', amount, 'balance-' + t.kind));
        const edit = button('Изменить', () => openOperation(t)),
          remove = button('Удалить', () => openDelete(t), 'balance-danger');
        if (source.archived || target?.archived) {
          edit.disabled = true;
          remove.disabled = true;
          edit.title = remove.title = 'Сначала восстанови счёт в настройках';
        }
        actions.append(edit, remove);
        side.append(actions);
        row.append(description, side);
        return row;
      })
    );
    if (!state.transactions.length)
      $('balanceTransactions').append(
        make('p', 'За выбранный период операций нет.', 'balance-help')
      );
    $('balancePrev').disabled = state.offset === 0;
    $('balanceNext').disabled = state.offset + state.limit >= state.total;
    $('balancePageNumber').textContent =
      `${Math.floor(state.offset / state.limit) + 1} / ${Math.max(1, Math.ceil(state.total / state.limit))}`;
  }
  function renderSettings() {
    $('balanceManageAccounts').replaceChildren(
      ...state.accounts.map((a) => {
        const row = make('div', undefined, 'balance-row'),
          description = make('div'),
          actions = make('div', undefined, 'balance-actions');
        description.append(
          make('strong', a.name),
          make(
            'p',
            `${sameText(a.name, names[a.kind]) ? '' : names[a.kind] + ' · '}${money(a.balance, a.currency)}${a.archived ? ' · архив' : ''}`
          )
        );
        actions.append(
          button('Изменить', () => openAccount(a)),
          button(a.archived ? 'Вернуть' : 'В архив', () =>
            save('account.archive', {id: a.id, version: a.version, archived: !a.archived})
          )
        );
        row.append(description, actions);
        return row;
      })
    );
    $('balanceManageCategories').replaceChildren(
      ...['expense', 'income'].map((kind) => {
        const group = make('section', undefined, 'balance-category-group');
        group.append(make('h3', kind === 'expense' ? 'Расходы' : 'Доходы'));
        for (const c of state.categories.filter((c) => c.kind === kind)) {
          const row = make('div', undefined, 'balance-row'),
            description = make('div'),
            actions = make('div', undefined, 'balance-actions');
          description.append(make('strong', c.name));
          if (c.archived) description.append(make('p', 'Архив'));
          actions.append(
            button('Изменить', () => openCategory(c)),
            button(c.archived ? 'Вернуть' : 'В архив', () =>
              save('category.archive', {id: c.id, version: c.version, archived: !c.archived})
            )
          );
          row.append(description, actions);
          group.append(row);
        }
        return group;
      })
    );
  }

  function render() {
    if (settings) renderSettings();
    else {
      renderTotals();
      renderHistory();
    }
  }
  function operationFields() {
    const kind = $('balanceKind').value,
      isTransfer = kind === 'transfer';
    const selected = $('balanceCategory').value;
    options(
      $('balanceCategory'),
      state.categories.filter(
        (c) => c.kind === kind && (!c.archived || c.id === editing?.category)
      ),
      selected
    );
    $('balanceCategory').closest('label').hidden = isTransfer;
    $('balanceCategory').required = !isTransfer;
    $('balanceTarget').closest('label').hidden = !isTransfer;
    $('balanceTarget').required = isTransfer;
    const target = $('balanceTarget').value,
      source = account($('balanceAccount').value);
    options(
      $('balanceTarget'),
      state.accounts.filter((a) => !a.archived && a.id !== source?.id),
      target
    );
    const destination = account($('balanceTarget').value),
      foreign = isTransfer && source?.currency !== destination?.currency;
    $('balanceReceived').closest('label').hidden = !foreign;
    $('balanceReceived').required = foreign;
    $('balanceAmount').previousElementSibling.textContent =
      'Сумма' + (source ? ' · ' + source.currency : '');
    $('balanceReceived').previousElementSibling.textContent =
      'Получено' + (destination ? ' · ' + destination.currency : '');
  }
  function openOperation(transaction = null) {
    if (!state) return;
    editing = transaction;
    $('balanceOperationForm').reset();
    $('balanceOperationError').textContent = '';
    $('balanceOperationTitle').textContent = transaction ? 'Изменить операцию' : 'Новая операция';
    $('balanceKind').value = transaction?.kind ?? 'expense';
    $('balanceDate').value = transaction?.date ?? today();
    options(
      $('balanceAccount'),
      state.accounts.filter((a) => !a.archived),
      transaction?.account
    );
    options(
      $('balanceTarget'),
      state.accounts.filter((a) => !a.archived),
      transaction?.target
    );
    operationFields();
    if (transaction?.category) $('balanceCategory').value = transaction.category;
    $('balanceAmount').value = transaction ? decimal(transaction.amount) : '';
    $('balanceReceived').value = transaction?.received ? decimal(transaction.received) : '';
    $('balanceNote').value = transaction?.note ?? '';
    $('balanceOperation').showModal();
    $('balanceAmount').focus();
  }
  function openAccount(a = null) {
    if (!state) return;
    editingAccount = a;
    $('balanceAccountForm').reset();
    $('balanceAccountError').textContent = '';
    $('balanceAccountTitle').textContent = a ? 'Изменить счёт' : 'Новый счёт';
    $('balanceAccountName').value = a?.name ?? '';
    $('balanceAccountKind').value = a?.kind ?? 'card';
    $('balanceCurrency').value = a?.currency ?? 'RUB';
    $('balanceOpening').value = decimal(a?.opening ?? 0);
    $('balanceCurrency').disabled = Boolean(a?.used);
    $('balanceOpening').disabled = Boolean(a?.used);
    $('balanceOpeningHelp').textContent = a?.used
      ? 'Счёт с операциями: валюта и начальный остаток закреплены.'
      : 'Остаток до первой записанной операции.';
    $('balanceAccountDialog').showModal();
    $('balanceAccountName').focus();
  }
  function openDelete(transaction) {
    deleting = {id: transaction.id, version: transaction.version};
    $('balanceDeleteError').textContent = '';
    const source = account(transaction.account);
    $('balanceDeleteDetails').textContent =
      `${transaction.date.split('-').reverse().join('.')} · ${source.name} · ${money(transaction.amount, source.currency)}`;
    $('balanceDeleteDialog').showModal();
    $('balanceDeleteCancel').focus();
  }
  $('balanceDeleteForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    if (deleting) save('transaction.delete', deleting, 'balanceDeleteDialog', 'balanceDeleteError');
  });
  $('balanceDeleteDialog')?.addEventListener('close', () => {
    deleting = null;
  });
  function openCategory(c = null) {
    if (!state) return;
    editingCategory = c;
    $('balanceCategoryForm').reset();
    $('balanceCategoryError').textContent = '';
    $('balanceCategoryTitle').textContent = c ? 'Изменить категорию' : 'Новая категория';
    $('balanceCategoryName').value = c?.name ?? '';
    $('balanceCategoryKind').value = c?.kind ?? 'expense';
    $('balanceCategoryKind').disabled = Boolean(c);
    $('balanceCategoryDialog').showModal();
    $('balanceCategoryName').focus();
  }
  root.querySelectorAll('[data-close]').forEach((node) =>
    node.addEventListener('click', () => {
      if (!busy) $(node.dataset.close).close();
    })
  );
  root.querySelectorAll('dialog').forEach((node) =>
    node.addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    })
  );
  $('balanceNew')?.addEventListener('click', () => {
    if (!busy) openOperation();
  });
  $('balanceAddAccount')?.addEventListener('click', () => {
    if (!busy) openAccount();
  });
  $('balanceAddCategory')?.addEventListener('click', () => {
    if (!busy) openCategory();
  });
  for (const id of ['balanceKind', 'balanceAccount', 'balanceTarget'])
    $(id)?.addEventListener('change', operationFields);
  $('balanceOperationForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    save(
      'transaction.save',
      {
        ...(editing ? {id: editing.id, version: editing.version} : {}),
        kind: $('balanceKind').value,
        date: $('balanceDate').value,
        account: $('balanceAccount').value,
        target: $('balanceTarget').value,
        category: $('balanceCategory').value,
        amount: $('balanceAmount').value,
        received: $('balanceReceived').value,
        note: $('balanceNote').value
      },
      'balanceOperation',
      'balanceOperationError'
    );
  });
  $('balanceAccountForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    save(
      'account.save',
      {
        ...(editingAccount ? {id: editingAccount.id, version: editingAccount.version} : {}),
        name: $('balanceAccountName').value,
        kind: $('balanceAccountKind').value,
        currency: $('balanceCurrency').value,
        opening: $('balanceOpening').value
      },
      'balanceAccountDialog',
      'balanceAccountError'
    );
  });
  $('balanceCategoryForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    save(
      'category.save',
      {
        ...(editingCategory ? {id: editingCategory.id, version: editingCategory.version} : {}),
        name: $('balanceCategoryName').value,
        kind: $('balanceCategoryKind').value
      },
      'balanceCategoryDialog',
      'balanceCategoryError'
    );
  });
  if (!settings) {
    $('balanceMonth').value = today().slice(0, 7);
    for (const id of ['balanceMonth', 'balanceFilterAccount', 'balanceFilterKind'])
      $(id).addEventListener('change', () => {
        offset = 0;
        load();
      });
    $('balancePrev').addEventListener('click', () => {
      if (state && !busy) {
        offset = Math.max(0, offset - state.limit);
        load();
      }
    });
    $('balanceNext').addEventListener('click', () => {
      if (state && !busy) {
        offset += state.limit;
        load();
      }
    });
  }
  addEventListener('online', () => {
    if (!busy && !root.querySelector('dialog[open]')) load();
  });
  addEventListener('offline', () => status('Нет соединения · показаны последние данные', true));
  addEventListener('focus', () => {
    if (!busy && !root.querySelector('dialog[open]')) load();
  });
  if (settings) {
    marketConfig();
    $('balanceMarketForm').addEventListener('submit', (event) => {
      event.preventDefault();
      marketConfig({key: $('balanceMarketKey').value.trim()});
    });
    $('balanceMarketRemove').addEventListener('click', () =>
      marketConfig({key: '', removeKey: true})
    );
  } else {
    $('balanceAIPeriod').addEventListener('change', renderAI);
    loadInsights();
    setInterval(loadInsights, 60000);
    addEventListener('online', loadInsights);
    document.addEventListener('visibilitychange', loadInsights);
  }
  load();
})();
