(() => {
  const select=document.getElementById('settingsSection');
  select?.addEventListener('change',()=>{
    const link=[...document.querySelectorAll('.settings-nav a')].find(a=>new URL(a.href).searchParams.get('module')===select.value);
    link?.click();
  });
})();

document.querySelectorAll('#settingsContent :is(.settings-card,.security-panel,.chat-panel,.balance-panel,.signal-panel,.trophy-panel,.anime-panel,.maintenance-grid>section,.settings-group)').forEach(card=>{
 const paragraphs=[...card.children].filter(e=>e.tagName==='P'&&!e.id&&!e.hasAttribute('role')&&!e.querySelector('a,button,input')&&!/error|warning|status/.test(e.className)&&e.textContent.trim().length>45);
 if(!paragraphs.length)return;const help=document.createElement('details'),title=document.createElement('summary');help.className='settings-help';title.textContent='Справка';help.append(title,...paragraphs);card.append(help);
});
