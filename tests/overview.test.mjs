import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Overview} from '../02-hub/src/overview.mjs';
import {currentManifest,loadModules} from '../02-hub/src/modules.mjs';
import {Projects} from '../02-hub/modules/projects/store.mjs';
import {Kanban} from '../02-hub/modules/kanban/store.mjs';
import {ContentStore} from '../02-hub/src/content-store.mjs';
import {createApp} from '../02-hub/src/server.mjs';
import {passwordHash} from '../02-hub/src/auth.mjs';
const modules=()=>new Map(['projects','kanban','articles','rhythm'].map(id=>[id,{id,title:id,version:'0.34.2'}]));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'overview-')),mods=modules(),overview=new Overview(root,mods);t.after(()=>{overview.close();fs.rmSync(root,{recursive:true,force:true});});return {root,mods,overview};}
test('home preferences persist, retain hidden module access, and reject a stale second tab',t=>{const {root,mods,overview}=fixture(t);const old=overview.config();overview.save({...old,order:['kanban','projects'],hidden:['projects']});const second=new Overview(root,mods);t.after(()=>second.close());assert.deepEqual(second.config().order,['kanban','projects']);assert.equal(second.ordered()[0].id,'kanban');assert.ok(!second.ordered().some(m=>m.id==='projects'));assert.ok(mods.has('projects'));assert.ok(second.ordered(true).some(m=>m.id==='projects'));assert.throws(()=>second.save({...old,order:[]}),{status:409});assert.throws(()=>second.save({...second.config(),hidden:['unknown']}),{status:400});});
test('global search handles Cyrillic, returns deep links and excludes install secrets and disabled modules',t=>{const {root,mods,overview}=fixture(t);const projects=new Projects(path.join(root,'projects')),kanban=new Kanban(path.join(root,'kanban')),content=new ContentStore(path.join(root,'content'));t.after(()=>{projects.db?.close();kanban.db?.close();});const p=projects.create('ПРОВЕРКА','Описание');const secret='secret-install-token';projects.db.prepare('UPDATE projects SET token=? WHERE id=?').run(secret,p.id);const b=kanban.createBoard('Доска');const task=kanban.save({board:b.board.id,column:b.columns[0].id,title:'ПРОВЕРКА задачи',description:'Текст',checklist:[],tags:[],attachments:[],priority:0,due:Date.now(),remind:null,project:null}).cards[0];const a=content.saveArticle({title:'Статья',body:'ПРОВЕРКА текста',tags:[],status:'draft'});const result=overview.search('проверка');assert.equal(result.results.length,3);assert.ok(result.results.some(r=>r.url.includes('card='+task.id)));assert.ok(result.results.some(r=>r.url.includes('article='+a.id)));assert.equal(overview.search(secret).results.length,0);assert.doesNotMatch(JSON.stringify(result),/secret-install-token/);mods.delete('projects');assert.equal(overview.search('проверка').results.length,2);});
test('upgrade removes obsolete dashboard settings and preserves order, visibility and conflict protection',t=>{const {overview}=fixture(t);overview.load();overview.db.prepare('UPDATE preferences SET version=7,data=? WHERE id=1').run(JSON.stringify({order:['kanban'],hidden:['projects'],today:['tasks'],zone:'UTC'}));overview.close();overview.db=null;assert.deepEqual(overview.config(),{version:8,order:['kanban'],hidden:['projects']});assert.deepEqual(JSON.parse(overview.db.prepare('SELECT data FROM preferences').get().data),{order:['kanban'],hidden:['projects']});assert.throws(()=>overview.save({version:7,order:[],hidden:[]}),{status:409});overview.close();overview.db=null;assert.equal(overview.config().version,8);});
test('module names migrate defaults but preserve custom names; broken and disabled modules appear in diagnostics',async t=>{const {root}=fixture(t);for(const [id,title]of [['storage','Хранилище'],['projects','Проекты'],['kanban','Канбан'],['rhythm','Ритм']]){const result=currentManifest(id,{title});assert.notEqual(result.title,title);assert.equal(currentManifest(id,{title:'Моё имя'}).title,'Моё имя');}for(const id of ['broken','disabled']){fs.mkdirSync(path.join(root,id));fs.writeFileSync(path.join(root,id,'manifest.json'),JSON.stringify({apiVersion:1,title:id,description:'',enabled:id!=='disabled',version:'0.1.0'}));}const loaded=await loadModules(root);assert.equal(loaded.size,0);assert.ok(loaded.diagnostics.some(x=>x.state==='error'));assert.ok(loaded.diagnostics.some(x=>x.state==='disabled'));assert.doesNotMatch(JSON.stringify(loaded.diagnostics),/ENOENT|file:\/\/|workspace/);});
test('overview APIs enforce login and origin, settings survive restart, and hidden cards are absent from HTML',async t=>{const {root,mods}=fixture(t);const config={username:'admin',origin:'https://hub.example.com',...await passwordHash('overview-password-123')};let app=createApp({config,modules:mods,dataDirectory:root});await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));});const base='http://127.0.0.1:'+app.address().port;for(const route of ['/api/home','/api/status','/api/search?q=test'])assert.equal((await fetch(base+route,{redirect:'manual'})).status,401);const login=await fetch(base+'/api/auth/login',{method:'POST',redirect:'manual',headers:{Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=admin&password=overview-password-123'});const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,'Content-Type':'application/json'},data=await(await fetch(base+'/api/home',{headers})).json();assert.equal('today' in data,false);const body=JSON.stringify({...data.config,hidden:['projects'],order:['kanban']});assert.equal((await fetch(base+'/api/home',{method:'POST',headers,body})).status,403);assert.equal((await fetch(base+'/api/home',{method:'POST',headers:{...headers,Origin:config.origin},body})).status,200);const html=await(await fetch(base+'/',{headers})).text();assert.doesNotMatch(html,/data-module="projects"|hubToday|hub-header-nav|href="\/search\/"|href="\/status\/"/);assert.match(html,/data-module="kanban"/);assert.equal((await fetch(base+'/status/',{headers})).status,200);assert.equal((await fetch(base+'/search/',{headers})).status,200);});

test('new core refuses to import an installed legacy Steam QR module during upgrade', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-nika-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  fs.mkdirSync(path.join(directory, 'trophies'));
  fs.writeFileSync(path.join(directory, 'trophies/manifest.json'), JSON.stringify({apiVersion: 1, enabled: true, title: 'Ника', description: '', version: '0.27.0'}));
  fs.writeFileSync(path.join(directory, 'trophies/steam-auth.mjs'), '');
  fs.writeFileSync(path.join(directory, 'trophies/index.mjs'), `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(path.join(directory, "executed"))}, "executed"); export function handle() {}\n`);
  const modules = await loadModules(directory, {start: true});
  assert.equal(modules.has('trophies'), false);
  assert.equal(fs.existsSync(path.join(directory, 'executed')), false);
  assert.equal(modules.diagnostics[0].state, 'error');
});

test('performance diagnostics allocate no observers or timers unless explicitly started', async () => {
 const {runInNewContext}=await import('node:vm');
 const source=fs.readFileSync(new URL('../02-hub/public/performance.js',import.meta.url),'utf8');
 let resources=0;
 runInNewContext(source,{sessionStorage:{getItem:()=>null},document:{getElementById:()=>null},setInterval:()=>resources++,requestAnimationFrame:()=>resources++,MutationObserver:class{constructor(){resources++;}}});
 assert.equal(resources,0);
});
test('performance diagnostics exclude hidden time and release observers on navigation', async () => {
 const {runInNewContext}=await import('node:vm');
 const source=fs.readFileSync(new URL('../02-hub/public/performance.js',import.meta.url),'utf8');
 const stored=new Map([['nexus-performance',JSON.stringify({started:1,until:Date.now()+120000,effect:'normal',pages:[]})]]);
 const listeners={},frames=new Map();let next=0,disconnected=0,cleared=0;
 const document={hidden:false,documentElement:{dataset:{}},body:{classList:{contains:()=>false}},getElementById:()=>null,addEventListener:(event,fn)=>listeners[event]=fn};
 runInNewContext(source,{sessionStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)},document,window:{},crypto:{randomUUID:()=> 'test'},location:{pathname:'/modules/wave/'},performance:{},MutationObserver:class{observe(){}disconnect(){disconnected++;}},requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),setInterval:()=>1,clearInterval:()=>cleared++,addEventListener:(event,fn)=>listeners[event]=fn});
 const tick=time=>{const [id,fn]=frames.entries().next().value;frames.delete(id);fn(time);};
 tick(100);tick(116);tick(166);
 document.hidden=true;listeners.visibilitychange();
 document.hidden=false;listeners.visibilitychange();tick(10000);tick(10016);
 listeners.pagehide();
 const sample=JSON.parse(stored.get('nexus-performance')).pages[0];
 assert.equal(sample.visibleMs,82);assert.equal(sample.frameGapsOver34ms,1);assert.equal(sample.frames,3);
 assert.equal(frames.size,0);assert.equal(disconnected,1);assert.equal(cleared,1);
});
