(() => {
  const frame=document.getElementById('hubFrame');if(!frame)return;
  const links=[...document.querySelectorAll('[data-workspace-group]')],positions=new Map();
  const groups=Object.fromEntries(links.map(a=>[a.dataset.workspaceGroup,(a.dataset.workspaceModules||'').split(',')]));
  let current;
  const nav=url=>{if(current?.pathname==='/')try{positions.set(current.searchParams.get('group')||'overview',frame.contentWindow.scrollY);}catch{}window.NexusWave?.navigate(url);};
  document.addEventListener('click',e=>{const a=e.target.closest('a[data-workspace-link]');if(!a||e.button||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;e.preventDefault();nav(a.href);});
  document.querySelector('.workspace-search')?.addEventListener('submit',e=>{e.preventDefault();nav('/search/?q='+encodeURIComponent(document.getElementById('workspaceQuery').value.trim()));});
  function shortcut(e){if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();const q=document.getElementById('workspaceQuery');if(q?.getClientRects().length)q.focus();else nav('/search/');}}
  document.addEventListener('keydown',shortcut);
  function selected(){
    try{current=new URL(frame.contentWindow.location.href);}catch{return;}
    const id=current.pathname==='/'?'home':current.pathname.startsWith('/modules/')?current.pathname.split('/')[2]:current.pathname.split('/')[1];
    const group=id==='home'?current.searchParams.get('group')||'overview':Object.keys(groups).find(g=>groups[g].includes(id));
    links.forEach(a=>{if(a.dataset.workspaceGroup===group)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
    const section=document.getElementById('workspaceSection');if(section){const selectedLink=links.find(a=>a.dataset.workspaceGroup===group);const title=document.createElement('span');title.textContent=selectedLink?.textContent.trim()||({'settings':'Настройки','status':'Состояние','search':'Поиск'}[id]??'Модуль');section.replaceChildren();const glyph=selectedLink?.querySelector('svg')?.cloneNode(true);if(glyph)section.append(glyph);section.append(title);section.href='/?group='+(group||'overview');}
    try{frame.contentDocument.addEventListener('keydown',shortcut);}catch{}
  }
  frame.addEventListener('load',()=>{selected();if(current?.pathname==='/')frame.contentWindow.scrollTo(0,positions.get(current.searchParams.get('group')||'overview')||0);});
  addEventListener('message',e=>{if(e.origin===location.origin&&e.source===frame.contentWindow&&['nexus:ready','nexus:location'].includes(e.data?.type))selected();});
  document.querySelectorAll('form[action="/api/auth/logout"]').forEach(f=>f.addEventListener('submit',()=>window.NexusWave?.close()));
  selected();
})();
