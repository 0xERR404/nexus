(() => {
  const trigger=document.getElementById('profileOpen'),dialog=document.getElementById('profileDialog');
  if(!trigger||!dialog)return;
  const key='nexus-profile-avatar-v1',input=document.getElementById('profileImage'),status=document.getElementById('profileStatus');
  const valid=v=>typeof v==='string'&&v.length<300000&&/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v);
  const read=()=>{try{const v=localStorage.getItem(key);return valid(v)?v:null;}catch{return null;}};
  function paint(){const value=read();for(const img of document.querySelectorAll('[data-profile-image]')){img.hidden=!value;if(value)img.src=value;else img.removeAttribute('src');}trigger.querySelector('span').hidden=!!value;}
  trigger.onclick=()=>{status.textContent='';dialog.showModal();};
  document.getElementById('profileClose').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>trigger.focus());
  document.getElementById('profileRemove').onclick=()=>{try{localStorage.removeItem(key);paint();status.textContent='Фотография удалена с этого устройства.';}catch{status.textContent='Не удалось изменить хранилище браузера.';}};
  input.onchange=async()=>{
    const file=input.files[0];if(!file)return;input.disabled=true;
    try{
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024)throw Error('Выбери JPEG, PNG или WebP до 2 МБ.');
      const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Не удалось прочитать файл.'));reader.readAsDataURL(file);});
      const img=new Image();img.src=source;try{await img.decode();}catch{throw Error('Не удалось прочитать изображение. Выбери другой файл.');}
      if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>32000000)throw Error('Слишком большое изображение.');
      const canvas=document.createElement('canvas');canvas.width=canvas.height=160;const size=Math.min(img.naturalWidth,img.naturalHeight);
      canvas.getContext('2d').drawImage(img,(img.naturalWidth-size)/2,(img.naturalHeight-size)/2,size,size,0,0,160,160);
      const value=canvas.toDataURL('image/webp',.85);if(!valid(value))throw Error('Не удалось подготовить изображение.');localStorage.setItem(key,value);paint();status.textContent='Фотография сохранена на этом устройстве.';
    }catch(e){status.textContent=e.message||'Не удалось сохранить фотографию.';}finally{input.value='';input.disabled=false;}
  };
  addEventListener('storage',e=>{if(e.key===key||e.key===null)paint();});paint();
})();
