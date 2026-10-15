(() => {
  const frame=document.getElementById('hubFrame');if(!frame)return;
  const links=[...document.querySelectorAll('[data-workspace-group]')];
  const groups=Object.fromEntries(links.map(a=>[a.dataset.workspaceGroup,(a.dataset.workspaceModules||'').split(',')]));
  let current;
  const nav=url=>window.NexusWave?.navigate(url);
  document.querySelector('.workspace-search')?.addEventListener('submit',e=>{e.preventDefault();const q=new FormData(e.currentTarget).get('q');nav('/search'+(q?'?q='+encodeURIComponent(q):''));});
  document.addEventListener('click',e=>{const a=e.target.closest('a[data-workspace-link]');if(!a||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();nav(a.href);});
  function selected(){
    try{current=new URL(frame.contentWindow.location.href);}catch{return;}
    const id=current.pathname==='/'?'home':current.pathname.startsWith('/modules/')?current.pathname.split('/')[2]:current.pathname.split('/')[1];
    document.body.classList.toggle('workspace-home',id==='home');
    const group=id==='home'?current.searchParams.get('group')||'overview':Object.keys(groups).find(g=>groups[g].includes(id));
    document.querySelectorAll('[data-workspace-category]').forEach(a=>{if(id==='home'&&a.dataset.workspaceCategory===group)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    links.forEach(a=>{if(a.dataset.workspaceGroup===group)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    document.querySelectorAll('[data-workspace-module]').forEach(a=>{const active=a.dataset.workspaceModule===id&&(id!=='home'||group==='overview');if(active)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const section=document.getElementById('workspaceSection');if(section){const selectedLink=links.find(a=>a.dataset.workspaceGroup===group);const title=document.createElement('span');title.textContent=selectedLink?.textContent.trim()||({'settings':'Настройки','status':'Состояние','search':'Поиск'}[id]??'Модуль');section.replaceChildren();const glyph=selectedLink?.querySelector('svg')?.cloneNode(true);if(glyph)section.append(glyph);section.append(title);section.href='/?group='+(group||'overview');}
  }
  frame.addEventListener('load',selected);
  addEventListener('message',e=>{if(e.origin===location.origin&&e.source===frame.contentWindow&&['nexus:ready','nexus:location'].includes(e.data?.type))selected();});
  document.querySelectorAll('form[action="/api/auth/logout"]').forEach(f=>f.addEventListener('submit',()=>window.NexusWave?.close()));
  selected();
})();
