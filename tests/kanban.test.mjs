import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {Kanban} from '../02-hub/modules/kanban/store.mjs';
import {Storage} from '../02-hub/modules/storage/store.mjs';
import {Projects} from '../02-hub/modules/projects/store.mjs';
import {handle} from '../02-hub/modules/kanban/index.mjs';
import {kanbanEvents} from '../host/module-events.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'kanban-'));const store=new Kanban(path.join(root,'kanban'));t.after(()=>{store.db?.close();fs.rmSync(root,{recursive:true,force:true});});const board=store.createBoard('Работа');return {root,store,board};}
function input(board){return {board:board.board.id,column:board.columns[0].id,title:'Задача',description:'Описание',checklist:[{text:'Первый шаг',done:false}],tags:['важно'],attachments:[],priority:2,due:2000,remind:1000,project:null,done:false,archived:false};}
function edit(card,extra={}){return {...card,column:card.column_id,...extra};}
test('kanban creates and orders columns, rejecting stale board changes',t=>{const {store,board}=fixture(t);const cols=[...board.columns].reverse();cols[0]={...cols[0],name:'Завершено'};const saved=store.columns(board.board.id,1,[...cols,{name:'Потом'}]);assert.equal(saved.columns[0].name,'Завершено');assert.equal(saved.columns.length,4);assert.throws(()=>store.columns(board.board.id,1,cols),{status:409});assert.equal(store.snapshot(board.board.id).columns.length,4);});
test('kanban prevents lost task edits across database connections and validates board moves',t=>{const {store,board}=fixture(t);const c=store.save(input(board)).cards[0];const second=new Kanban(store.directory);t.after(()=>second.db?.close());const latest=second.save(edit(c,{title:'Новый текст'})).cards[0];assert.throws(()=>store.save(edit(c,{title:'Устаревший текст'})),{status:409});assert.throws(()=>store.move(c.id,board.columns[1].id,c.version),{status:409});const moved=store.move(c.id,board.columns[1].id,latest.version).cards[0];assert.equal(moved.title,'Новый текст');assert.equal(moved.column_id,board.columns[1].id);assert.deepEqual(moved.checklist,c.checklist);const other=store.createBoard('Другая');assert.throws(()=>store.move(c.id,other.columns[0].id,moved.version));assert.throws(()=>store.save(edit(moved,{archived:true})));const archived=store.save(edit(moved,{done:true,archived:true})).cards[0];assert.equal(archived.archived,1);});
test('kanban reuses storage files, validates projects and rolls back invalid edits',async t=>{const {root,store,board}=fixture(t);const storage=new Storage(path.join(root,'storage')),projects=new Projects(path.join(root,'projects'));t.after(()=>{storage.db?.close();projects.db?.close();});const req=Readable.from([Buffer.from('hello')]);req.headers={'content-length':'5'};const file=await storage.upload(req,'note.txt',null);const project=projects.create('Проект','Описание');const a=store.save({...input(board),attachments:[file.id],project:project.id}).cards[0];store.save({...input(board),title:'Вторая',attachments:[file.id]});assert.equal(storage.references(file.id).length,2);assert.throws(()=>store.save(edit(a,{attachments:[randomUUID()],title:'Потерянное'})));assert.equal(store.card(a.id).title,'Задача');assert.equal(storage.references(file.id).length,2);store.save(edit(a,{attachments:[]}));assert.equal(storage.references(file.id).length,1);});
test('kanban reminders survive reload without duplicates and suppress completed tasks',t=>{const {store,board}=fixture(t);const c=store.save(input(board)).cards[0];const file=path.join(store.directory,'kanban.sqlite');const state={};assert.equal(kanbanEvents(file,state,999).length,0);assert.equal(kanbanEvents(file,state,1000).length,1);assert.equal(kanbanEvents(file,JSON.parse(JSON.stringify(state)),2000).length,0);let latest=store.save(edit(c,{done:true,remind:2000})).cards[0];assert.equal(kanbanEvents(file,state,3000).length,0);latest=store.save(edit(latest,{done:false})).cards[0];assert.equal(kanbanEvents(file,state,3000).length,1);store.save(edit(latest,{title:'Переименовано'}));assert.equal(kanbanEvents(file,state,4000).length,0);});
test('kanban refuses unauthenticated pages and API mutations',async()=>{for(const route of ['/','/api','/api/card','/kanban.js']){const r=await handle({request:{method:route==='/api/card'?'POST':'GET'},path:route,authorized:()=>false});assert.equal(r.status,401);}});

test('signal tick publishes module reminders once using the active settings', async (t) => {
  const {Signal} = await import('../host/signal.mjs');
  const {DatabaseSync} = await import('node:sqlite');
  const {root, store, board} = fixture(t);
  store.save(input(board));
  fs.mkdirSync(path.join(root, 'rhythm'));
  const db = new DatabaseSync(path.join(root, 'rhythm/rhythm.sqlite'));
  db.exec("CREATE TABLE reports(day TEXT,status TEXT); INSERT INTO reports VALUES('2026-09-28','done')");
  t.after(() => db.close());
  const signal = new Signal({directory: root + '/signal', dataDirectory: root, now: () => 10000,
    settings: () => ({devices: [], categories: {maintenance: true}})});
  signal.collector = {sample: () => ({disks: []})};
  signal.rules.metrics = () => {};
  signal.rules.daily = () => {};
  signal.save = () => {};
  await signal.tick(); await signal.tick();
  assert.equal(signal.state.events.filter(e => e.key.startsWith('kanban.')).length, 1);
  assert.equal(signal.state.events.filter(e => e.key.startsWith('rhythm.')).length, 1);
});
