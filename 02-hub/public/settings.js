(() => {
  const select=document.getElementById('settingsSection');
  select?.addEventListener('change',()=>{
    const link=[...document.querySelectorAll('.settings-nav a')].find(a=>new URL(a.href).searchParams.get('module')===select.value);
    link?.click();
  });
})();
