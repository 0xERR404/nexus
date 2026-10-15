(() => {
  const key='nexus-orbit-appearance-v2', previousKey='nexus-orbit-appearance-v1', root=document.documentElement;
  const defaults={accent:'jade',ambient:true,reduceMotion:false};
  const colors={jade:'197,237,169',blue:'154,194,224',violet:'192,174,226',amber:'222,193,139'};
  const clean=v=>({accent:Object.hasOwn(colors,v?.accent)?v.accent:'jade',ambient:v?.ambient!==false,reduceMotion:v?.reduceMotion===true});
  const read=()=>{try{return clean(JSON.parse(localStorage.getItem(key)));}catch{return {...defaults};}};
  // Apply the forest palette once; preserve ambient and accessibility preferences. Subsequent color choices remain local.
  try {if(!localStorage.getItem(key)){let previous;try{previous=JSON.parse(localStorage.getItem(previousKey));}catch{}localStorage.setItem(key,JSON.stringify({...clean(previous),accent:defaults.accent}));}for(const old of ['nexus-carbon-appearance-v1','nexus-intro-enabled','nexus-intro-sound'])localStorage.removeItem(old);sessionStorage.removeItem('nexus-intro-pending');}catch{}
  let prefs=read();const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  function apply(value){prefs=clean(value);const rgb=colors[prefs.accent];root.dataset.orbitAccent=prefs.accent;root.dataset.orbitAmbient=String(prefs.ambient);root.dataset.orbitReduced=String(prefs.reduceMotion||reduced.matches);for(const [k,v]of Object.entries({'--accent':`rgb(${rgb})`,'--accent-rgb':rgb,'--accent-soft':`rgba(${rgb},.09)`,'--button-active':`rgba(${rgb},.14)`}))root.style.setProperty(k,v);}
  function sync(){const f=document.getElementById('appearanceForm');if(f){f.elements.accent.value=prefs.accent;f.elements.ambient.checked=prefs.ambient;f.elements.reduceMotion.checked=prefs.reduceMotion;}}
  function notify(){if(parent!==window)parent.postMessage({type:'nexus:appearance'},location.origin);for(const f of document.querySelectorAll('iframe'))f.contentWindow?.postMessage({type:'nexus:appearance'},location.origin);}
  apply(prefs);
  addEventListener('storage',e=>{if(e.key===key||e.key===null){apply(read());sync();}});
  addEventListener('message',e=>{if(e.origin!==location.origin||e.data?.type!=='nexus:appearance')return;if(e.source!==parent&&![...document.querySelectorAll('iframe')].some(f=>f.contentWindow===e.source))return;apply(read());sync();for(const f of document.querySelectorAll('iframe'))if(f.contentWindow!==e.source)f.contentWindow?.postMessage({type:'nexus:appearance'},location.origin);});
  reduced.addEventListener('change',()=>apply(prefs));addEventListener('pageshow',()=>{apply(read());sync();});
  function init(){sync();const f=document.getElementById('appearanceForm');if(!f)return;const status=document.getElementById('appearanceStatus');f.addEventListener('submit',e=>{e.preventDefault();const v=clean({accent:f.elements.accent.value,ambient:f.elements.ambient.checked,reduceMotion:f.elements.reduceMotion.checked});try{localStorage.setItem(key,JSON.stringify(v));apply(v);notify();status.textContent='Сохранено на этом устройстве.';}catch{status.textContent='Браузер не разрешил сохранить оформление.';}});document.getElementById('appearanceReset').addEventListener('click',()=>{f.elements.accent.value=defaults.accent;f.elements.ambient.checked=true;f.elements.reduceMotion.checked=false;status.textContent='Выбраны исходные настройки. Нажми «Сохранить».';});}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
