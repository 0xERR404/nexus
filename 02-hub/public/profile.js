(() => {
  const trigger=document.getElementById('profileOpen'),dialog=document.getElementById('profileDialog');
  if(!trigger||!dialog)return;
  const key='nexus-profile-avatar-v1',input=document.getElementById('profileImage'),status=document.getElementById('profileStatus'),remove=document.getElementById('profileRemove');
  let profile={revision:0,avatar:null},busy=false,reading=null;
  const legacy=()=>{try{const value=localStorage.getItem(key);return typeof value==='string'&&value.length<300000&&/^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value)?value:null;}catch{return null;}};
  const forgetLegacy=()=>{try{localStorage.removeItem(key);}catch{}};
  function paint(){for(const img of document.querySelectorAll('[data-profile-image]')){img.hidden=!profile.avatar;if(profile.avatar)img.src=profile.avatar;else img.removeAttribute('src');}trigger.querySelector('span').hidden=!!profile.avatar;}
  function lock(value){busy=value;input.disabled=remove.disabled=value;}
  async function load(){
    if(reading)return reading;
    reading=(async()=>{const response=await fetch('/api/profile',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(10000)});
      if(!response.ok||response.redirected)throw Error('Не удалось загрузить профиль. Проверь соединение.');
      profile=await response.json();paint();return profile;
    })().finally(()=>reading=null);return reading;
  }
  async function save(avatar){
    const response=await fetch('/api/profile',{method:'POST',credentials:'same-origin',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:profile.revision,avatar}),signal:AbortSignal.timeout(10000)});
    if(response.redirected)throw Error('Войди в хаб заново.');
    if(response.status===409){profile=await response.json();paint();throw Error('Фотография изменена на другом устройстве. Повтори действие.');}
    if(!response.ok)throw Error('Не удалось сохранить фотографию на сервере. Попробуй ещё раз.');
    profile=await response.json();forgetLegacy();paint();
  }
  async function prepare(source){
    const img=new Image();img.src=source;try{await img.decode();}catch{throw Error('Не удалось прочитать изображение. Выбери другой файл.');}
    if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>32000000)throw Error('Слишком большое изображение.');
    const canvas=document.createElement('canvas');canvas.width=canvas.height=160;const size=Math.min(img.naturalWidth,img.naturalHeight);
    canvas.getContext('2d').drawImage(img,(img.naturalWidth-size)/2,(img.naturalHeight-size)/2,size,size,0,0,160,160);
    const value=canvas.toDataURL('image/png');if(value.length>200000)throw Error('Не удалось подготовить изображение.');return value;
  }
  lock(true);
  const ready=(async()=>{
    await load();const old=legacy();
    if(profile.revision===0&&old)await save(await prepare(old));
    else if(profile.revision>0)forgetLegacy();
  })().catch(error=>{status.textContent=error.message;}).finally(()=>lock(false));
  trigger.onclick=()=>{dialog.showModal();};
  document.getElementById('profileClose').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>trigger.focus());
  remove.onclick=async()=>{
    if(busy)return;lock(true);
    try{await ready;await load();await save(null);status.textContent='Фотография удалена из профиля.';}
    catch(error){status.textContent=error.message;}finally{lock(false);}
  };
  input.onchange=async()=>{
    const file=input.files[0];if(!file||busy)return;lock(true);
    try{
      await ready;
      if(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>2*1024*1024)throw Error('Выбери JPEG, PNG или WebP до 2 МБ.');
      const source=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(Error('Не удалось прочитать файл.'));reader.readAsDataURL(file);});
      const value=await prepare(source);await load();await save(value);status.textContent='Фотография сохранена и доступна на всех устройствах.';
    }catch(error){status.textContent=error.message||'Не удалось сохранить фотографию.';}finally{input.value='';lock(false);}
  };
  const refresh=()=>{if(!document.hidden&&!busy)void load().catch(()=>{});};
  addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
  setInterval(refresh,60000);paint();
})();
