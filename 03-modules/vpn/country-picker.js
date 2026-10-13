(() => {
  const english=new Intl.DisplayNames(['en'],{type:'region'});
  const normalize=value=>String(value??'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replaceAll('ё','е').trim();
  function matching(countries,query){
    const words=normalize(query).split(/\s+/).filter(Boolean);
    return countries.filter(c=>{const text=normalize([c.code,c.name,english.of(c.code)].join(' '));return words.every(word=>text.includes(word));});
  }
  function bind(container,countries){
    for(const picker of container.querySelectorAll('[data-country-picker]')){
      const search=picker.querySelector('[name=countrySearch]'),select=picker.querySelector('[name=country]'),status=picker.querySelector('[data-country-results]'),preview=picker.querySelector('[data-country-preview]');
      const render=()=>{
        const selected=select.value,rows=matching(countries,search.value),current=countries.find(c=>c.code===selected);
        const options=[new Option('Не указана','',false,!selected)];
        // Filtering must never silently clear the saved selection.
        if(current&&!rows.some(c=>c.code===selected))options.push(new Option(current.name+' · выбрана',selected,false,true));
        for(const c of rows)options.push(new Option(c.name+' · '+c.code,c.code,false,c.code===selected));
        select.replaceChildren(...options);select.value=selected;
        preview.replaceChildren();
        if(current){const img=document.createElement('img');img.className='vpn-flag';img.src='/modules/vpn/flags/'+current.code.toLowerCase()+'.svg';img.alt='';const text=document.createElement('span');text.textContent=current.name;preview.append(img,text);}
        status.textContent=search.value.trim()?(rows.length?'Найдено: '+rows.length:'Совпадений нет. Текущий выбор сохранён.'):'Поиск по названию страны или коду';
      };
      search.addEventListener('input',render);select.addEventListener('change',render);render();
    }
  }
  const accounting=node=>node.stale?'Нет свежих данных':node.status?.running?'Обновляется':'Приостановлен';
  globalThis.NexusVPNCountryPicker=Object.freeze({matching,bind,accounting});
})();
