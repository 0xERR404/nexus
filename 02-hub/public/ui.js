let nexusQuestionOpen = false;
window.Nexus = Object.freeze({
  question(message, value, options = {}) {
    const isPrompt = value !== undefined;
    if (nexusQuestionOpen) return Promise.resolve(isPrompt ? null : false);
    nexusQuestionOpen = true;
    return new Promise((resolve, reject) => {
      const dialog = document.createElement('dialog');
      dialog.className = 'nexus-question';
      dialog.dataset.uiPersistent = 'true';
      const heading = Nexus.node(
        'h2',
        options.title || (isPrompt ? 'Ввод данных' : 'Подтверждение')
      );
      heading.id = 'nexusQuestionTitle';
      dialog.setAttribute('aria-labelledby', heading.id);
      const label = Nexus.node('label', message);
      const form = document.createElement('form');
      form.method = 'dialog';
      let input,
        answer = isPrompt ? null : false;
      if (isPrompt) {
        input = document.createElement(options.multiline ? 'textarea' : 'input');
        input.value = String(value);
        if (!options.multiline) input.type = 'text';
        input.maxLength = options.maxLength || 10000;
        label.append(input);
      }
      const buttons = Nexus.node('div', undefined, 'nexus-question-actions');
      const cancel = Nexus.node('button', 'Отмена');
      cancel.type = 'button';
      const accept = Nexus.node(
        'button',
        options.accept || (isPrompt ? 'Сохранить' : 'Подтвердить')
      );
      accept.type = 'submit';
      cancel.onclick = () => dialog.close();
      form.onsubmit = (event) => {
        event.preventDefault();
        answer = isPrompt ? input.value : true;
        dialog.close();
      };
      buttons.append(cancel, accept);
      form.append(label, buttons);
      dialog.append(heading, form);
      const previousFocus = document.activeElement;
      dialog.addEventListener(
        'close',
        () => {
          dialog.remove();
          nexusQuestionOpen = false;
          if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
          resolve(answer);
        },
        {once: true}
      );
      try {
        document.body.append(dialog);
        dialog.showModal();
        (input || cancel).focus();
        input?.select();
      } catch (error) {
        dialog.remove();
        nexusQuestionOpen = false;
        reject(error);
      }
    });
  },
  prompt(message, value = '', options) {
    return Nexus.question(message, String(value ?? ''), options);
  },
  confirm(message, options) {
    return Nexus.question(message, undefined, options);
  },
  async request(url, data, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(data === undefined
        ? {}
        : {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(data)
          }),
      ...options
    });
    const error = (message, status = response.status) => Object.assign(Error(message), {status});
    if (response.redirected || response.status === 401) throw error('Войди в хаб заново', 401);
    let result;
    try {
      result = await response.json();
    } catch {
      throw error('Не удалось прочитать ответ сервера');
    }
    if (!response.ok)
      throw error(typeof result?.error === 'string' ? result.error : 'Ошибка запроса');
    return result;
  },
  node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }
});

(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const own = window.parent === window || !window.parent.NexusUI;
  const stack = [],
    watched = new Map(),
    cancelling = new WeakSet();
  const push = history.pushState.bind(history),
    replace = history.replaceState.bind(history);
  let marker = false,
    rewinding = false,
    promptFor,
    deferredNavigation;
  const flushNavigation = () => {
    if (!marker && !rewinding && !live().length && deferredNavigation) {
      const run = deferredNavigation;
      deferredNavigation = null;
      run();
    }
  };
  const fields = (d) =>
    JSON.stringify(
      [...d.querySelectorAll('input,textarea,select,[contenteditable=true]')].map((n) => [
        n.type,
        n.type === 'file'
          ? [...n.files].map((f) => [f.name, f.size, f.lastModified])
          : (n.value ?? n.textContent),
        n.checked
      ])
    );
  const editable = (d) =>
    !d.dataset?.uiPersistent &&
    d.querySelector(
      'form:not([method=dialog]),textarea,input:not([type=search]):not([type=range]),[contenteditable=true]'
    );
  const live = () => stack.filter((e) => e.dialog.isConnected && e.dialog.open);
  function mark() {
    if (!marker && !rewinding && live().length) {
      push({...history.state, nexusDialogs: true}, '', location.href);
      marker = true;
    }
  }
  function register(dialog, controller) {
    if (stack.some((e) => e.dialog === dialog)) return;
    stack.push({dialog, controller});
    mark();
  }
  function unregister(dialog, rewind = true) {
    const index = stack.findIndex((e) => e.dialog === dialog);
    if (index >= 0) stack.splice(index, 1);
    if (!live().length && marker) {
      marker = false;
      if (rewind) {
        rewinding = true;
        history.back();
      }
    }
    flushNavigation();
  }
  const owner = own ? {register, unregister} : window.parent.NexusUI;
  function requestClose(dialog, discard = false) {
    if (!dialog?.open) return true;
    if (dialog.querySelector('button[type=submit]:disabled')) return false;
    cancelling.add(dialog);
    const accepted = dialog.dispatchEvent(new Event('cancel', {cancelable: true}));
    cancelling.delete(dialog);
    if (!accepted) return false;
    const before = watched.get(dialog);
    if (!discard && before !== null && before !== undefined && before !== fields(dialog)) {
      if (promptFor?.open) return false;
      promptFor?.remove();
      const confirm = document.createElement('dialog');
      promptFor = confirm;
      confirm.className = 'ui-discard';
      confirm.setAttribute('aria-labelledby', 'uiDiscardTitle');
      confirm.innerHTML =
        '<h2 id="uiDiscardTitle">Закрыть без сохранения?</h2><p>Изменения в этом окне будут потеряны.</p><div class="ui-dialog-actions"><button type="button" data-keep>Остаться</button><button type="button" data-discard>Закрыть</button></div>';
      document.body.append(confirm);
      confirm.querySelector('[data-keep]').onclick = () => confirm.close();
      confirm.querySelector('[data-discard]').onclick = () => {
        confirm.close();
        requestClose(dialog, true);
      };
      confirm.addEventListener(
        'close',
        () => {
          if (promptFor === confirm) promptFor = null;
          confirm.remove();
        },
        {once: true}
      );
      confirm.showModal();
      return false;
    }
    dialog.close();
    syncDialogs();
    return true;
  }
  const controller = {requestClose};
  function watchDialogs() {
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter((d) =>
      d.matches(':modal')
    );
    for (const d of watched.keys())
      if (!dialogs.includes(d)) {
        watched.delete(d);
        owner.unregister(d);
      }
    for (const d of dialogs)
      if (!watched.has(d)) {
        watched.set(d, editable(d) ? fields(d) : null);
        owner.register(d, controller);
      }
  }
  if (own) {
    window.NexusUI = {
      register,
      unregister,
      afterDialogs(run) {
        deferredNavigation = run;
        flushNavigation();
      }
    };
    addEventListener(
      'popstate',
      (event) => {
        if (rewinding) {
          rewinding = false;
          event.stopImmediatePropagation();
          mark();
          flushNavigation();
          return;
        }
        if (marker) {
          event.stopImmediatePropagation();
          marker = false;
          const top = live().at(-1);
          if (top) top.controller.requestClose(top.dialog);
          mark();
          flushNavigation();
          return;
        }
        if (history.state?.nexusDialogs) {
          event.stopImmediatePropagation();
          const state = {...history.state};
          delete state.nexusDialogs;
          replace(state, '', location.href);
        }
      },
      true
    );
  }
  addEventListener(
    'keydown',
    (event) => {
      if (
        !['Escape', 'Backspace'].includes(event.key) ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey
      )
        return;
      if (
        event.key === 'Backspace' &&
        event.target.closest?.('input,textarea,select,[contenteditable]')
      )
        return;
      const top = own
        ? live().at(-1)
        : [...watched.keys()]
            .filter((d) => d.open)
            .map((dialog) => ({dialog, controller}))
            .at(-1);
      if (!top) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      top.controller.requestClose(top.dialog);
    },
    true
  );
  document.addEventListener(
    'cancel',
    (event) => {
      if (event.target.tagName !== 'DIALOG' || cancelling.has(event.target)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestClose(event.target);
    },
    true
  );
  let backdrop;
  const outside = (d, e) => {
    const r = d.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  document.addEventListener(
    'pointerdown',
    (event) => {
      backdrop =
        event.target.tagName === 'DIALOG' && outside(event.target, event) ? event.target : null;
    },
    true
  );
  document.addEventListener(
    'click',
    (event) => {
      const top = own ? live().at(-1) : null;
      if (top && top.dialog.ownerDocument !== document) {
        event.preventDefault();
        event.stopImmediatePropagation();
        top.controller.requestClose(top.dialog);
        return;
      }
      const d = event.target.closest?.('dialog');
      if (!d) return;
      if (backdrop === d && event.target === d && outside(d, event)) {
        backdrop = null;
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose(d);
        return;
      }
      backdrop = null;
      const b = event.target.closest('button');
      if (
        b &&
        !d.classList.contains('ui-discard') &&
        (b.matches('.dialog-close,[data-close],[data-chat-close],[aria-label^="Закрыть"]') ||
          /^(Отмена|Отменить|Закрыть)$/.test(b.textContent.trim()))
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        requestClose(d);
      }
    },
    true
  );
  let locked,
    suspended = false;
  function unlockScroll() {
    if (!locked) return;
    const saved = locked;
    locked = null;
    root.classList.remove('nexus-dialog-open');
    root.style.removeProperty('--nexus-dialog-x');
    root.style.removeProperty('--nexus-dialog-y');
    const behavior = root.style.getPropertyValue('scroll-behavior');
    const priority = root.style.getPropertyPriority('scroll-behavior');
    root.style.setProperty('scroll-behavior', 'auto', 'important');
    scrollTo(saved.x, saved.y);
    if (behavior) root.style.setProperty('scroll-behavior', behavior, priority);
    else root.style.removeProperty('scroll-behavior');
  }
  function syncDialogs() {
    if (suspended) return;
    const open = [...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal'));
    if (!open) unlockScroll();
    else if (!locked) {
      locked = {x: scrollX, y: scrollY};
      root.style.setProperty('--nexus-dialog-x', `-${locked.x}px`);
      root.style.setProperty('--nexus-dialog-y', `-${locked.y}px`);
      root.classList.add('nexus-dialog-open');
    }
    watchDialogs();
  }
  document.addEventListener('close', syncDialogs, true);
  document.addEventListener(
    'toggle',
    (event) => {
      if (event.target.tagName === 'DIALOG') syncDialogs();
    },
    true
  );
  addEventListener('pagehide', () => {
    suspended = true;
    unlockScroll();
    for (const d of watched.keys()) owner.unregister(d, false);
    watched.clear();
  });
  addEventListener('pageshow', () => {
    suspended = false;
    if (own && !marker && history.state?.nexusDialogs) {
      const state = {...history.state};
      delete state.nexusDialogs;
      replace(state, '', location.href);
    }
    syncDialogs();
  });

  new MutationObserver(syncDialogs).observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open']
  });
  syncDialogs();

  const tabs = '.trophy-tabs, .settings-tabs, #waveNav';
  const ignore =
    'input, textarea, select, button, audio, video, [contenteditable], dialog, .wave-player, #wavePlayer';
  let gesture,
    suppressClickUntil = 0,
    suppressClickTarget,
    animation;
  document.addEventListener(
    'touchstart',
    (event) => {
      gesture = null;
      suppressClickUntil = 0;
      if (event.touches.length !== 1 || locked || innerWidth > 1000) return;
      const target = event.target;
      if (target.closest(ignore) || !target.closest('main')) return;
      // Preserve native horizontal scrollers and the browser's edge gesture.
      for (let node = target; node && node !== document.body; node = node.parentElement) {
        if (
          node.scrollWidth > node.clientWidth + 2 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return;
      }
      const touch = event.touches[0];
      if (touch.clientX < 24 || touch.clientX > innerWidth - 24) return;
      const nav = document.querySelector(tabs);
      if (!nav) return;
      gesture = {x: touch.clientX, y: touch.clientY, time: performance.now(), nav, target};
    },
    {passive: true}
  );
  document.addEventListener(
    'touchmove',
    (event) => {
      if (!gesture) return;
      if (event.touches.length !== 1) {
        gesture = null;
        return;
      }
      const t = event.touches[0];
      const dx = Math.abs(t.clientX - gesture.x),
        dy = Math.abs(t.clientY - gesture.y);
      if (dy > 22) gesture = null;
      else if (dx > 12 && dx > dy * 2.5 && event.cancelable) event.preventDefault();
    },
    {passive: false}
  );
  document.addEventListener(
    'touchcancel',
    () => {
      gesture = null;
    },
    {passive: true}
  );
  document.addEventListener(
    'touchend',
    (event) => {
      const start = gesture;
      gesture = null;
      if (!start || locked || !event.changedTouches.length) return;
      const t = event.changedTouches[0],
        dx = t.clientX - start.x,
        dy = t.clientY - start.y;
      if (
        performance.now() - start.time > 900 ||
        Math.abs(dx) < 65 ||
        Math.abs(dx) < Math.abs(dy) * 2.5
      )
        return;
      const links = [...start.nav.querySelectorAll('a[href]')].filter(
        (a) => a.getClientRects().length
      );
      const index = links.findIndex((a) => a.getAttribute('aria-current') === 'page');
      const next = index < 0 ? null : links[index + (dx < 0 ? 1 : -1)];
      if (!next) return;
      suppressClickUntil = performance.now() + 500;
      suppressClickTarget = start.target;
      next.click();
    },
    {passive: true}
  );
  document.addEventListener(
    'click',
    (event) => {
      if (
        event.isTrusted &&
        performance.now() < suppressClickUntil &&
        suppressClickTarget?.contains(event.target)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true
  );
  document.addEventListener('click', (event) => {
    if (
      reduced.matches ||
      !event.target.closest('[data-trophy-provider], [data-wave-nav]') ||
      !event.defaultPrevented
    )
      return;
    const main = document.querySelector('main');
    animation?.cancel();
    animation = main?.animate([{opacity: 0.45}, {opacity: 1}], {duration: 220, easing: 'ease-out'});
  });
})();
