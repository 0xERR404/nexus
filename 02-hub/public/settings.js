(() => {
  const select=document.getElementById('settingsSection');
  select?.addEventListener('change',()=>{
    const link=[...document.querySelectorAll('.settings-nav a')].find(a=>new URL(a.href).searchParams.get('module')===select.value);
    link?.click();
  });
})();

(() => {
  const content = document.getElementById('settingsContent');
  if (!content) return;
  // Keep details nodes and toggle events for modules that load their data on open.
  // Their summaries are now headings, and settings cannot be collapsed.
  function revealSections() {
    for (const section of content.querySelectorAll('details')) {
      section.removeAttribute('name');
      if (!section.open) section.open = true;
      const heading = section.querySelector(':scope > summary');
      if (!heading) continue;
      heading.setAttribute('role', 'heading');
      heading.setAttribute('aria-level', '3');
      heading.setAttribute('tabindex', '-1');
    }
  }
  content.addEventListener('click', event => {
    const heading = event.target.closest('summary');
    if (heading?.parentElement?.tagName === 'DETAILS' && content.contains(heading) &&
        !event.target.closest('a,button,input,select,textarea')) event.preventDefault();
  });
  revealSections();
  new MutationObserver(revealSections).observe(content, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['open']
  });
})();
