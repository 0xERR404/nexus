export const groups = [
  {id:'overview',title:'Обзор',icon:'home',modules:[]},
  {id:'media',title:'Медиа',icon:'navMedia',modules:['wave','anime','cinema','trophies','reader','gallery']},
  {id:'work',title:'Работа',icon:'navWork',modules:['kanban','articles','storage','chat']},
  {id:'personal',title:'Личное',icon:'navPersonal',modules:['rhythm','balance','statistics']},
  {id:'system',title:'Система',icon:'pulse',modules:['pulse','signal','projects','vpn']}
];
export const groupFor = id => groups.find(g=>g.modules.includes(id))?.id ?? 'system';
export const selectedGroup = id => groups.find(g=>g.id===id) ?? groups[0];
