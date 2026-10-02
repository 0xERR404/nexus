(() => {
  for (const root of document.querySelectorAll('[data-legacy-clients]')) {
    const route = root.dataset.legacyClients;
    const status = root.querySelector('[role="status"]');
    const list = root.querySelector('[data-clients-list]');
    async function load() {
      const result = await Nexus.request(route);
      const items = Array.isArray(result) ? result : result.items;
      list.replaceChildren();
      root.hidden = items.length === 0;
      for (const item of items) {
        const row = Nexus.node('p');
        row.append(Nexus.node('span', item.name + (item.enabled === false ? ' · отключено' : ' ')));
        if (item.enabled !== false) {
          const revoke = Nexus.node('button', 'Отозвать');
          revoke.type = 'button';
          revoke.onclick = async () => {
            if (
              !(await Nexus.confirm('Отозвать ключ «' + item.name + '»? Данные хаба сохранятся.'))
            )
              return;
            revoke.disabled = true;
            try {
              await Nexus.request(route + '/revoke', {id: item.id});
              await load();
            } catch (error) {
              status.textContent = error.message;
              revoke.disabled = false;
            }
          };
          row.append(revoke);
        }
        list.append(row);
      }
    }
    load().catch((error) => {
      root.hidden = false;
      status.textContent = error.message;
    });
  }
})();
