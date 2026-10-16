import fs from 'node:fs';
import path from 'node:path';
import {HUB,STATE,atomic,json,query} from './common.mjs';
export const moduleIDs=['pulse','signal','chat','balance','anime','trophies','wave','gallery','articles','reader','storage','projects','kanban','rhythm','cinema','statistics','vpn'];
export const UPDATE_CONTROL='/var/lib/nexus404-updates';
export function inside(root,name){
  const base=path.resolve(root),target=path.resolve(root,name);
  if(target===base||!target.startsWith(base+path.sep))throw Error('Путь вне каталога установки');
  return target;
}
export function regularTree(root){
  const stat=fs.lstatSync(root);
  if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('Ссылки и специальные файлы не поддерживаются: '+root);
  if(stat.isFile())return stat.size;
  return fs.readdirSync(root).reduce((size,name)=>size+regularTree(inside(root,name)),0);
}
export function savedModules(hub=HUB){
  const saved=json(path.join(hub,'config/preserved-modules.json'),{}),result={...saved};
  const directory=path.join(hub,'modules');
  if(fs.existsSync(directory))for(const name of fs.readdirSync(directory)){
    if(!moduleIDs.includes(name))throw Error('Неизвестный каталог в modules: '+name+'. Перенеси его вручную перед удалением');
    result[name]=json(path.join(directory,name,'manifest.json'));
  }
  for(const [id,manifest]of Object.entries(result))if(!moduleIDs.includes(id)||!manifest||typeof manifest.enabled!=='boolean')throw Error('Некорректные сохранённые настройки модулей');
  return result;
}
export async function removeHub(ui,{hub=HUB,state=STATE,control=UPDATE_CONTROL,inspect=query}={}){
  if(!fs.existsSync(path.join(hub,'config/auth.json')))throw Error('Хаб не установлен');
  const {composeArgs}=await import('./platform.mjs');
  regularTree(hub);
  const manifests=savedModules(hub);
  ui.line('Будут остановлены и удалены контейнер хаба и код всех установленных модулей.');
  ui.line('Сохраняются: '+path.join(hub,'data')+' — все файлы, базы, прогресс; '+path.join(hub,'config')+' — вход и настройки.');
  ui.line('Docker, Caddy и удалённые VPN-ноды останутся. Перед переносом на другой сервер скопируй data и config.');
  if((await ui.prompt('Для удаления введи NEXUS404; Enter — отмена')).trim()!=='NEXUS404'){ui.line('Удаление отменено');return false;}
  atomic(path.join(hub,'config/preserved-modules.json'),JSON.stringify(manifests));
  const version=json(path.join(hub,'data/hub-runtime.json'))?.version;
  if(version)atomic(path.join(hub,'config/preserved-installation.json'),JSON.stringify({version,removed:Date.now()}));
  // Persist intent before stopping anything; the timer cannot apply an old request after removal.
  atomic(path.join(state,'hub-removed'),new Date().toISOString());
  fs.rmSync(path.join(control,'requests/request.json'),{force:true});
  for(const unit of ['nexus404-hub-update.timer','nexus404-pulse.service','nexus404-signal.service']){
    if(inspect('systemctl',['cat',unit]).ok)await ui.run('Остановка '+unit,'systemctl',['disable','--now',unit]);
  }
  await ui.run('Удаление контейнера хаба','docker',composeArgs('nexus404-shell',hub,['down','--timeout','30']));
  const modules=inside(hub,'modules');
  if(fs.existsSync(modules)){regularTree(modules);fs.rmSync(modules,{recursive:true});}
  // Only remove this application's image tag. No volume deletion or Docker-wide pruning.
  if(inspect('docker',['image','inspect','nexus404-shell:local']).ok){
    try{await ui.run('Удаление образа хаба','docker',['image','rm','nexus404-shell:local']);}
    catch{ui.line('Образ используется другим контейнером и оставлен на диске');}
  }
  if(fs.existsSync(control))atomic(path.join(control,'status/status.json'),JSON.stringify({phase:'removed',heartbeat:Date.now()}),0o644);
  ui.line('[✓] Хаб удалён. Данные и настройки сохранены. Для восстановления: Хаб и модули → Восстановить из сохранённых данных.');
  return true;
}
export async function restoreHub(ui,{hub=HUB,state=STATE,control=UPDATE_CONTROL,installHub,installModule}={}){
  if(!fs.existsSync(path.join(hub,'config/auth.json')))throw Error('Нет сохранённого входа. Сначала верни каталог config');
  const journalFile=path.join(control,'private/state.json'),journal=json(journalFile);
  if(journal?.phase==='recovery-required'&&journal.backupReady)throw Error('Сначала выбери «Обновления → Вернуть хаб из резервной копии обновления»');
  const manifests=savedModules(hub);
  if(!installHub||!installModule){const platform=await import('./platform.mjs');installHub??=platform.installHub;installModule??=platform.installModule;}
  await installHub(ui,true,false);
  for(const id of Object.keys(manifests))await installModule(ui,id,false);
  fs.rmSync(path.join(state,'hub-removed'),{force:true});
  if(journal?.phase==='recovery-required')atomic(journalFile,JSON.stringify({...journal,phase:'idle',error:null}));
  ui.line('[✓] Хаб и ранее установленные модули восстановлены с сохранёнными данными');
}
