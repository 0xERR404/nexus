(() => {
  const $ = (id) => document.getElementById(id),
    settings = Boolean($('bankSettings'));
  if (!settings && !$('bankInbox')) return;
  let offset = 0,
    busy = false,
    ledger,
    reviewing,
    editingRule,
    deletingRule,
    sequence = 0;
  const status = (message) => {
    $('bankStatus').textContent = message;
  };
  const node = (tag, text, cls) => {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (cls) item.className = cls;
    return item;
  };
  const button = (text, fn) => {
    const item = node('button', text);
    item.type = 'button';
    item.onclick = () => {
      if (!busy) fn();
    };
    return item;
  };
  async function api(route, data) {
    const response = await fetch('/modules/balance' + route, {
      method: data ? 'POST' : 'GET',
      cache: 'no-store',
      headers: data ? {'Content-Type': 'application/json'} : {},
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(15000)
    });
    if (response.status === 401 || response.redirected) throw Error('Требуется вход в хаб');
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Не удалось выполнить запрос');
    return result;
  }
  const stamp = (time) => new Date(time).toLocaleString('ru-RU');
  const select = (id, items, value) => {
    $(id).replaceChildren(
      ...items.map((a) => new Option(a.name + (a.currency ? ' · ' + a.currency : ''), a.id))
    );
    if (items.some((a) => a.id === value)) $(id).value = value;
  };
  async function load() {
    if (document.hidden || busy || $('bankReview')?.open || $('bankRuleDelete')?.open) return;
    const run = ++sequence;
    try {
      const [data, snapshot] = await Promise.all([
        api(settings ? '/bank/sources' : '/bank/inbox?offset=' + offset),
        api('/api')
      ]);
      if (run !== sequence || busy || $('bankReview')?.open || $('bankRuleDelete')?.open) return;
      ledger = snapshot;
      if (settings) {
        select(
          'bankRuleCategory',
          ledger.categories.filter((c) => c.kind === 'expense' && !c.archived),
          $('bankRuleCategory').value
        );
        $('bankRules').replaceChildren(
          ...data.rules.map((rule) => {
            const row = node('div', undefined, 'balance-row'),
              description = node('div'),
              actions = node('div', undefined, 'balance-actions');
            description.append(
              node('strong', rule.merchant),
              node(
                'p',
                rule.category_name + (rule.archived ? ' · архивная, используется «Другое»' : '')
              )
            );
            actions.append(
              button('Изменить', () => {
                editingRule = rule;
                $('bankRuleMerchant').value = rule.merchant;
                $('bankRuleCategory').value = rule.category;
                $('bankRuleSave').textContent = 'Сохранить';
                $('bankRuleCancel').hidden = false;
                $('bankRuleMerchant').focus();
              }),
              button('Удалить', () => {
                deletingRule = rule;
                $('bankRuleDeleteName').textContent = rule.merchant;
                $('bankRuleDelete').showModal();
              })
            );
            row.append(description, actions);
            return row;
          })
        );
        select(
          'bankSourceAccount',
          ledger.accounts.filter((a) => !a.archived),
          $('bankSourceAccount').value
        );
        $('bankSources').replaceChildren(
          ...data.items.map((source) => {
            const row = node('div', undefined, 'balance-row'),
              description = node('div'),
              actions = node('div', undefined, 'balance-actions');
            description.append(
              node('strong', source.name),
              node('p', source.package),
              node(
                'p',
                source.enabled
                  ? source.last_seen
                    ? 'Последний приём: ' + stamp(source.last_seen)
                    : 'Ожидает уведомления'
                  : 'Ключ отозван'
              )
            );
            if (source.enabled)
              actions.append(
                button(
                  'Поступления и возвраты: ' +
                    (source.auto_credits ? 'автоматически' : 'с проверкой'),
                  () => mutate('/bank/auto-credits', {id: source.id, enabled: !source.auto_credits})
                ),
                button('Отозвать', () => mutate('/bank/revoke', {id: source.id}))
              );
            row.append(description, actions);
            return row;
          })
        );
        status(data.items.length ? '' : 'Источники ещё не подключены.');
      } else {
        if (offset && !data.items.length) {
          offset = Math.max(0, offset - 30);
          return load();
        }
        $('bankCount').textContent = data.total ? '· ' + data.total : '';
        $('bankEvents').replaceChildren(
          ...data.items.map((event) => {
            const row = node('div', undefined, 'balance-row'),
              description = node('div');
            const amount =
              event.amount == null
                ? 'Нужна проверка суммы'
                : new Intl.NumberFormat('ru-RU', {
                    style: 'currency',
                    currency: event.currency
                  }).format(event.amount / 100);
            description.append(
              node(
                'strong',
                ({expense: 'Расход', income: 'Поступление', refund: 'Возврат'}[event.kind] ||
                  'Расход') +
                  ' · ' +
                  amount
              ),
              node('p', event.source_name + ' · ' + stamp(event.occurred)),
              node('p', event.text.slice(0, 180))
            );
            row.append(
              description,
              button('Проверить', () => review(event))
            );
            return row;
          })
        );
        $('bankPrev').disabled = offset === 0;
        $('bankNext').disabled = offset + 30 >= data.total;
        status(
          data.total
            ? 'Ожидают проверки. Остатки пока не изменены.'
            : 'Нет уведомлений для проверки. Покупки из Гекаты записываются в историю автоматически.'
        );
      }
    } catch (error) {
      if (run === sequence) status(error.message);
    }
  }
  async function mutate(route, data) {
    if (busy) return;
    busy = true;
    sequence++;
    const root = settings ? $('bankSettings') : $('bankInbox');
    const controls = [
      ...root.querySelectorAll('button,input,select'),
      ...($('bankReview')?.querySelectorAll('button,input,select') ?? [])
    ].map((el) => [el, el.disabled]);
    controls.forEach(([el]) => (el.disabled = true));
    try {
      const result = await api(route, data);
      if (route === '/bank/source') {
        $('bankEndpoint').value = location.origin;
        $('bankAuthorization').value = result.token;
        $('bankConnection').hidden = false;
      }
      if (route === '/bank/rule') resetRule();
      if (route === '/bank/rule-delete') {
        $('bankRuleDelete').close();
        deletingRule = null;
      }
      if (route === '/bank/revoke') hideKey();
      if (route === '/bank/resolve') {
        $('bankReview').close();
        reviewing = null;
        dispatchEvent(new Event('balance:changed'));
      }
      status('Сохранено');
    } catch (error) {
      if ($('bankRuleDelete')?.open) $('bankRuleDeleteName').textContent = error.message;
      else if ($('bankReview')?.open) $('bankReviewError').textContent = error.message;
      else status(error.message);
      return;
    } finally {
      busy = false;
      controls.forEach(([el, disabled]) => (el.disabled = disabled));
    }
    await load();
  }
  function hideKey() {
    if (!settings) return;
    $('bankAuthorization').value = '';
    $('bankEndpoint').value = '';
    $('bankConnection').hidden = true;
  }
  function review(event) {
    if (!ledger) return;
    reviewing = event;
    $('bankReviewForm').reset();
    $('bankReviewText').textContent = event.text;
    $('bankReviewError').textContent =
      event.amount == null
        ? 'Сумма не распознана. Проверь, что это расход, и введи её вручную.'
        : event.kind === 'refund'
          ? 'Возврат будет отдельным доходом; исходная покупка останется без изменений.'
          : 'Проверь сумму, дату и счёт перед сохранением.';
    select(
      'bankAccount',
      ledger.accounts.filter(
        (a) => !a.archived && (!event.currency || a.currency === event.currency)
      ),
      event.account
    );
    select(
      'bankCategory',
      ledger.categories.filter(
        (c) =>
          !c.archived && c.kind === (event.kind && event.kind !== 'expense' ? 'income' : 'expense')
      )
    );
    $('bankDate').value = event.date;
    $('bankAmount').value = event.amount == null ? '' : (event.amount / 100).toFixed(2);
    $('bankNote').value = event.text.slice(0, 280);
    $('bankReview').showModal();
  }
  function resetRule() {
    editingRule = null;
    $('bankRuleForm').reset();
    $('bankRuleSave').textContent = 'Добавить правило';
    $('bankRuleCancel').hidden = true;
  }
  if (settings) {
    $('bankRuleForm').onsubmit = (event) => {
      event.preventDefault();
      mutate('/bank/rule', {
        id: editingRule?.id,
        version: editingRule?.version,
        merchant: $('bankRuleMerchant').value,
        category: $('bankRuleCategory').value
      });
    };
    $('bankRuleCancel').onclick = resetRule;
    $('bankRuleDeleteCancel').onclick = () => {
      if (!busy) $('bankRuleDelete').close();
    };
    $('bankRuleDeleteConfirm').onclick = () => {
      if (!busy && deletingRule)
        mutate('/bank/rule-delete', {id: deletingRule.id, version: deletingRule.version});
    };
    $('bankRuleDelete').addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    });
    $('bankZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Moscow';
    $('bankSourceForm').onsubmit = (event) => {
      event.preventDefault();
      if (location.protocol !== 'https:')
        return status('Для подключения телефона нужен HTTPS-адрес хаба.');
      mutate('/bank/source', {
        name: $('bankSourceName').value,
        package: $('bankPackage').value,
        account: $('bankSourceAccount').value,
        zone: $('bankZone').value
      });
    };
    $('bankHideConnection').onclick = hideKey;
    $('bankCopyConnection').onclick = async () => {
      try {
        await navigator.clipboard.writeText($('bankAuthorization').value);
        status('Ключ скопирован. Вставь его в Гекату и после подключения очисти буфер обмена.');
      } catch {
        status('Не удалось скопировать. Адрес и ключ можно выделить вручную.');
      }
    };
    addEventListener('pagehide', hideKey);
  } else {
    $('bankRefresh').onclick = load;
    $('bankPrev').onclick = () => {
      offset = Math.max(0, offset - 30);
      load();
    };
    $('bankNext').onclick = () => {
      offset += 30;
      load();
    };
    $('bankReviewClose').onclick = () => {
      if (!busy) $('bankReview').close();
    };
    $('bankReview').addEventListener('cancel', (event) => {
      if (busy) event.preventDefault();
    });
    $('bankDismiss').onclick = () => {
      if (reviewing) mutate('/bank/resolve', {id: reviewing.id, action: 'dismiss'});
    };
    $('bankReviewForm').onsubmit = (event) => {
      event.preventDefault();
      if (!reviewing) return;
      mutate('/bank/resolve', {
        id: reviewing.id,
        action: 'accept',
        transaction: {
          kind: reviewing.kind && reviewing.kind !== 'expense' ? 'income' : 'expense',
          account: $('bankAccount').value,
          category: $('bankCategory').value,
          date: $('bankDate').value,
          amount: $('bankAmount').value,
          note: $('bankNote').value
        }
      });
    };
  }
  addEventListener('focus', load);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
  load();
})();
