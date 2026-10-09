const nexusNotices = (() => {
  const legacy = 'nexus-pending-notices-v1', prefix = 'nexus-notice-v2:';
  let memory = new Map(), busy = false, timer, failures = 0;
  const valid = v => v && /^[a-z][a-z0-9-]{0,31}$/.test(v.source) && /^(summary|home|request|task|history|connection)$/.test(v.code) && (v.active === undefined || typeof v.active === 'boolean');
  const owner = () => { try { return parent !== window && parent.Nexus?.notice; } catch { return null; } };
  const entries = () => {
    const found = new Map(memory);
    try { for (let i=0;i<localStorage.length;i++) { const key=localStorage.key(i); if(!key?.startsWith(prefix))continue; try {const v=JSON.parse(localStorage.getItem(key));if(valid(v) && Number.isFinite(v.at))found.set(key,v);}catch{} } } catch {}
    return [...found].sort((a,b)=>a[1].at-b[1].at || a[0].localeCompare(b[0]));
  };
  const remove = key => { memory.delete(key);try {localStorage.removeItem(key);} catch {} };
  const enqueue = (source,code,active) => {
    const items=entries(),previous=items.filter(([,v])=>v.source===source&&v.code===code).at(-1);
    if(previous && previous[1].active===active)return;
    const at=Math.max(Date.now(),(items.at(-1)?.[1].at||0)+1),id=prefix+at.toString(36)+'-'+Math.random().toString(36).slice(2),value={source,code,active,at};
    try {localStorage.setItem(id,JSON.stringify(value));} catch {memory.set(id,value);}
    for(const [key] of items.slice(0,Math.max(0,items.length-63)))remove(key);
  };
  async function flush() {
    if(owner() || busy || globalThis.navigator?.onLine===false || !entries().length)return;
    busy=true;clearTimeout(timer);
    try {
      const drain=async()=>{for(let item; (item=entries()[0]);) {
        const [key,{source,code,active}]=item;
        const response=await fetch('/api/notices',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({source,code,active}),signal:AbortSignal.timeout(8000)});
        if(response.status===401 || response.status===403)return;
        if(response.status===400){remove(key);continue;}
        if(!response.ok || (await response.json()).ok!==true)throw Error('Notice pending');
        remove(key);failures=0;
      }};
      if(globalThis.navigator?.locks?.request)await navigator.locks.request('nexus-notices',drain);else await drain();
    } catch {timer=setTimeout(flush,Math.min(300000,5000*2**Math.min(failures++,6)));}
    finally {busy=false;}
  }
  if(!owner())try {
    const saved=JSON.parse(localStorage.getItem(legacy)||'[]');
    if(Array.isArray(saved))for(const v of saved.slice(-64))if(valid(v))enqueue(v.source,v.code,v.active!==false);
    localStorage.removeItem(legacy);
  } catch {}
  if(typeof addEventListener==='function') {addEventListener('online',flush);addEventListener('pageshow',flush);addEventListener('storage',e=>{if(e.key?.startsWith(prefix))void flush();});}
  return (source,code='request',active=true) => {
    const delegate=owner();if(delegate)return delegate(source,code,active);
    if(!valid({source,code,active}))return;
    enqueue(source,code,active);void flush();
  };
})();
// A new module always starts at its beginning; reading progress is owned by the reader.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
addEventListener('pageshow', () => { if (!location.hash) scrollTo(0, 0); });
const nexusViews = new Map(), nexusLeaveGuards = new Set();
let nexusQuestionOpen = false;
window.Nexus = Object.freeze({
  notice: nexusNotices,
  viewSnapshot(key, value) {
    try { if (parent !== window && parent.Nexus) return parent.Nexus.viewSnapshot(key, value); } catch {}
    if (value !== undefined) {
      nexusViews.delete(key);
      nexusViews.set(key, value);
      if (nexusViews.size > 40) nexusViews.delete(nexusViews.keys().next().value);
    }
    return nexusViews.get(key);
  },
  rememberView(fields = [], capture = () => ({})) {
    const key = () => { const u = new URL(location.href); for (const name of ['_view','new','book','file','image','anime','game','card','project','track']) u.searchParams.delete(name); return u.pathname + u.search; };
    const saved = Nexus.viewSnapshot(key()), touched = new Set();
    const applyFields = () => {
      if (!saved) return;
        for (const id of fields) {
          const el = document.getElementById(id), value = saved.values[id];
          if (!el || value === undefined || touched.has(id)) continue;
          if (el.type === 'checkbox') el.checked = value;
          else if (el.tagName !== 'SELECT' || [...el.options].some(o => o.value === value)) el.value = value;
        }
    };
    applyFields();
    for (const id of fields) for (const type of ['input','change']) document.getElementById(id)?.addEventListener(type, () => touched.add(id));
    let restored = false;
    const save = () => {
      if (!restored && !touched.size) return;
      const values = {};
      for (const id of fields) {
        const el = document.getElementById(id);
        if (el && el.type !== 'password' && el.type !== 'file') values[id] = el.type === 'checkbox' ? el.checked : el.value;
      }
      const scroll = [...document.querySelectorAll('[id]')].filter(el => el.scrollTop || el.scrollLeft).map(el => [el.id, el.scrollLeft, el.scrollTop]);
      Nexus.viewSnapshot(key(), {values, extra:capture(), scroll, x:scrollX, y:scrollY});
    };
    addEventListener('pagehide', save);
    addEventListener('nexus:leave', save);
    return {
      value: saved?.extra || {},
      restore(render) {
        if (restored) return false;
        restored = true;
        if (!saved) return false;
        applyFields();
        Promise.resolve(render?.(saved.extra)).then(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!location.hash) window.scrollTo(0, 0);
        }))).catch(() => nexusNotices('hub','request'));
        return true;
      }
    };
  },
  beforeLeave(guard) { nexusLeaveGuards.add(guard); return () => nexusLeaveGuards.delete(guard); },
  async prepareLeave() {
    for (const guard of nexusLeaveGuards) if (await guard() === false) return false;
    if (await (window.NexusUI || parent.NexusUI)?.prepareLeave?.() === false) return false;
    dispatchEvent(new Event('nexus:leave'));
    return true;
  },
  empty(title, description, label, action) {
    const box = Nexus.node('div', undefined, 'ui-empty');
    box.append(Nexus.node('h3', title));
    if (description) box.append(Nexus.node('p', description));
    if (label && action) {
      const control = Nexus.node(typeof action === 'string' ? 'a' : 'button', label);
      if (typeof action === 'string') control.href = action;
      else { control.type = 'button'; control.onclick = action; }
      box.append(control);
    }
    return box;
  },
  problem(target, source, error) {
    if (!target) return;
    // Validation and conflicts must remain actionable beside the user's input.
    if ([400, 409, 422].includes(error?.status)) {
      target.textContent = error.message;
      return;
    }
    nexusNotices(source, 'request');
    target.replaceChildren(document.createTextNode(
      error?.status === 401 ? 'Войди в хаб заново. ' : 'Действие не завершено. '
    ));
    const link = Nexus.node('a', error?.status === 401 ? 'Войти' : 'Открыть Гермес');
    link.href = error?.status === 401 ? '/login' : '/modules/signal/';
    target.append(link);
  },
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
      signal: AbortSignal.timeout(45000),
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
  const controller = {requestClose, changed(dialog) {
    const before = watched.get(dialog);
    return before != null && before !== fields(dialog);
  }};
  function watchDialogs() {
    const dialogs = [...document.querySelectorAll('dialog[open]')].filter((d) =>
      d.matches(':modal')
    );
    for (const d of watched.keys())
      if (!dialogs.includes(d)) {
        d.classList.remove('nexus-dialog-covered');
        watched.delete(d);
        owner.unregister(d);
      }
    for (const d of dialogs)
      if (!watched.has(d)) {
        if (d.querySelector('form') && !d.classList.contains('ui-discard') &&
            !d.querySelector('.dialog-close,[data-close],[data-chat-close],[aria-label^="Закрыть"]')) {
          const close = document.createElement('button');
          close.type = 'button';
          close.className = 'dialog-close nexus-screen-close';
          close.setAttribute('aria-label', 'Закрыть окно');
          close.textContent = '×';
          d.prepend(close);
        }
        watched.set(d, editable(d) ? fields(d) : null);
        owner.register(d, controller);
      }
    // Only the top window reveals the shared background; lower windows keep their fields.
    const top = [...watched.keys()].at(-1);
    for (const d of watched.keys()) d.classList.toggle('nexus-dialog-covered', d !== top);
  }
  if (own) {
    window.NexusUI = {
      register,
      unregister,
      async prepareLeave() {
        const dialogs = live();
        if (dialogs.some(({dialog}) => dialog.querySelector('button[type=submit]:disabled'))) return false;
        if (dialogs.some(({dialog,controller}) => controller.changed(dialog)) &&
            !await Nexus.confirm('В открытом окне есть несохранённые изменения. Перейти и закрыть его?', {accept:'Перейти'})) return false;
        for (const {dialog} of dialogs) dialog.close();
        syncDialogs();
        await new Promise(resolve => { deferredNavigation = resolve; flushNavigation(); });
        return true;
      },
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
  let locked, dialogFocusState,
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
    if (parent !== window && dialogFocusState !== open) {
      dialogFocusState = open;
      parent.postMessage({type:'nexus:dialog-focus', active:open}, location.origin);
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

  // The document remains a valid observer target during rapid iframe replacements.
  new MutationObserver(syncDialogs).observe(document, {
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
