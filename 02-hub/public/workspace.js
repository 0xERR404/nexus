(() => {
  const frame=document.getElementById('hubFrame');if(!frame)return;
  const links=[...document.querySelectorAll('[data-workspace-group]')];
  const groups=Object.fromEntries(links.map(a=>[a.dataset.workspaceGroup,(a.dataset.workspaceModules||'').split(',')]));
  let current;
  const nav=url=>window.NexusWave?.navigate(url);
  document.addEventListener('click',e=>{const a=e.target.closest('a[data-workspace-link]');if(!a||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();nav(a.href);});
  function selected(){
    try{current=new URL(frame.contentWindow.location.href);}catch{return;}
    const id=current.pathname==='/'?'home':current.pathname.startsWith('/modules/')?current.pathname.split('/')[2]:current.pathname.split('/')[1];
    const group=id==='home'?current.searchParams.get('group')||'overview':Object.keys(groups).find(g=>groups[g].includes(id));
    links.forEach(a=>{if(a.dataset.workspaceGroup===group)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const section=document.getElementById('workspaceSection');if(section){const selectedLink=links.find(a=>a.dataset.workspaceGroup===group);const title=document.createElement('span');title.textContent=selectedLink?.textContent.trim()||({'settings':'Настройки','status':'Состояние','search':'Поиск'}[id]??'Модуль');section.replaceChildren();const glyph=selectedLink?.querySelector('svg')?.cloneNode(true);if(glyph)section.append(glyph);section.append(title);section.href='/?group='+(group||'overview');}
  }
  frame.addEventListener('load',selected);
  addEventListener('message',e=>{if(e.origin===location.origin&&e.source===frame.contentWindow&&['nexus:ready','nexus:location'].includes(e.data?.type))selected();});
  document.querySelectorAll('form[action="/api/auth/logout"]').forEach(f=>f.addEventListener('submit',()=>window.NexusWave?.close()));
  selected();
})();
