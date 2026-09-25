(() => {
  const root = document.documentElement;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  let locked;
  function syncDialogs() {
    const open = [...document.querySelectorAll('dialog[open]')].some((d) => d.matches(':modal'));
    if (open === Boolean(locked)) return;
    if (open) {
      const body = document.body;
      locked = {
        x: scrollX,
        y: scrollY,
        body: body.getAttribute('style'),
        root: root.getAttribute('style')
      };
      root.style.overflow = 'hidden';
      body.style.position = 'fixed';
      body.style.top = `-${locked.y}px`;
      body.style.left = `-${locked.x}px`;
      body.style.width = '100%';
      body.style.overflow = 'hidden';
    } else {
      const saved = locked;
      locked = null;
      for (const [node, style] of [
        [document.body, saved.body],
        [root, saved.root]
      ]) {
        if (style === null) node.removeAttribute('style');
        else node.setAttribute('style', style);
      }
      const behavior = root.style.scrollBehavior;
      root.style.scrollBehavior = 'auto';
      scrollTo(saved.x, saved.y);
      root.style.scrollBehavior = behavior;
    }
  }
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
