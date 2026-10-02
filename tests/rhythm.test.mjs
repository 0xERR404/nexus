import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {Rhythm} from '../02-hub/modules/rhythm/store.mjs';
import {summarize,bounds} from '../02-hub/modules/rhythm/summary.mjs';
import {Reports} from '../02-hub/modules/rhythm/reports.mjs';
import {createModule} from '../02-hub/modules/rhythm/index.mjs';
import {combinedUsage} from '../02-hub/src/ai-usage.mjs';
import {rhythmEvents} from '../host/module-events.mjs';
const day='2026-01-10',base=Date.parse(day+'T00:00:00Z'),hour=3600000;
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'rhythm-')),store=new Rhythm(path.join(root,'rhythm'));store.configure({zone:'UTC',auto:false});const dev=store.addDevice('Телефон');t.after(()=>{store.db?.close();fs.rmSync(root,{recursive:true,force:true});});return {root,store,dev};}
const row=(id='a',extra={})=>({id,source:'Huawei / тестовые измерения',type:'steps',start:base+hour,end:base+2*hour,modified:base+3*hour,value:1000,...extra});
function request(value,token){const r=Readable.from([Buffer.from(JSON.stringify(value))]);r.method='POST';r.headers={'content-type':'application/json',authorization:'Bearer '+token};return r;}
function ready(store,dev){store.ingest(dev,{records:[row(),row('sleep',{type:'sleep',start:base-hour,end:base+7*hour,complete:true})],deleted:[],complete:true});fs.mkdirSync(path.join(store.directory,'../chat'));fs.writeFileSync(path.join(store.directory,'../chat/deepseek.json'),JSON.stringify({key:'test-only',model:'deepseek-flash'}));}
test('rhythm retries are idempotent, older corrections ignored, deletion is retained',t=>{const {store,dev}=fixture(t);const batch={records:[row()],deleted:[],complete:true};assert.equal(store.ingest(dev,batch).changed,1);assert.equal(store.ingest(dev,batch).changed,0);assert.equal(store.daily(day).steps,1000);store.ingest(dev,{records:[row('a',{value:1200,modified:base+4*hour})],deleted:[]});assert.equal(store.daily(day).steps,1200);store.ingest(dev,batch);assert.equal(store.daily(day).steps,1200);store.ingest(dev,{records:[],deleted:['a']});store.ingest(dev,batch);assert.equal(store.daily(day).steps,null);});
test('rhythm invalid batch is atomic, reset is scoped to one bridge, revoked credentials fail',t=>{const {store,dev}=fixture(t);store.ingest(dev,{records:[row()],deleted:[]});const other=store.addDevice('Второй');store.ingest(other,{records:[row('b')],deleted:[]});assert.throws(()=>store.ingest(dev,{records:[row('c'),row('d',{value:-1})],deleted:[]}));assert.equal(store.db.prepare('SELECT count(*) AS n FROM records').get().n,2);store.ingest(dev,{records:[],deleted:[],reset:true});assert.equal(store.db.prepare('SELECT count(*) AS n FROM records').get().n,1);store.revoke(dev.id);assert.throws(()=>store.authenticate(dev.token),{status:401});assert.throws(()=>store.ingest(dev,{records:[],deleted:[]}),{status:401});assert.equal(store.authenticate(other.token).id,other.id);});
test('rhythm overlapping sources are not summed and partial intervals are marked estimated',t=>{const {store,dev}=fixture(t);store.ingest(dev,{records:[row(),row('b',{source:'CMF',start:base+1.5*hour,end:base+2.5*hour,value:2000})],deleted:[]});const primary=store.sources().find(s=>s.name.includes('Huawei'));store.priority(primary.id,0);assert.equal(store.daily(day).steps,2000);assert.equal(store.daily(day).stepsEstimated,true);assert.equal(store.daily(day).stepCoverageMinutes,90);});
test('rhythm respects DST day lengths and splits midnight intervals',()=>{assert.equal(bounds('2026-03-29','Europe/Berlin')[1]-bounds('2026-03-29','Europe/Berlin')[0],23*hour);assert.equal(bounds('2026-10-25','Europe/Berlin')[1]-bounds('2026-10-25','Europe/Berlin')[0],25*hour);const s=summarize(day,'UTC',[{...row(),source:'x',start:base-hour,end:base+hour,data:{value:1200}}],[{id:'x',priority:1}]);assert.equal(s.steps,600);assert.equal(s.stepsEstimated,true);assert.equal(s.heart,null);assert.ok(s.missing.includes('sleep'));});
test('rhythm complete sleep and post-day sync gate final report',t=>{const {store,dev}=fixture(t);store.ingest(dev,{records:[row('s',{type:'sleep',start:base-hour,end:base+7*hour,complete:false})],deleted:[],complete:true});assert.equal(store.daily(day).ready,false);store.ingest(dev,{records:[row('s',{type:'sleep',start:base-hour,end:base+7*hour,complete:true,modified:base+8*hour})],deleted:[],complete:true});assert.equal(store.daily(day).ready,true);assert.equal(store.daily(day,base+8*hour).ready,false);store.ingest(dev,{records:[],deleted:[]});assert.equal(store.daily(day).ready,false);});
test('rhythm report is charged once under concurrent clicks, records usage and becomes stale on correction',async t=>{const {root,store,dev}=fixture(t);ready(store,dev);let calls=0,finish;const reports=new Reports(store,{completeRequest:async args=>{calls++;assert.ok(args.messages[1].content.includes('1000'));await new Promise(r=>finish=r);return {content:'Сводка',usage:{prompt_tokens:10,completion_tokens:20,total_tokens:30,prompt_cache_hit_tokens:0}};}});const running=reports.generate(day);const duplicate=await reports.generate(day);assert.equal(duplicate.status,'running');finish();const result=await running;assert.equal(result.status,'done');assert.equal(result.stale,0);await reports.generate(day);assert.equal(calls,1);const usage=combinedUsage([path.join(root,'rhythm/rhythm.sqlite')]);assert.equal(usage.periods.at(-1).providers[0].tokens,30);store.ingest(dev,{records:[row('a',{value:999,modified:base+9*hour})],deleted:[],complete:true});assert.equal(store.daily(day).report.stale,1);await assert.rejects(()=>reports.generate(day,true),{status:409});});
test('rhythm ambiguous paid failure is not automatically retried, survives restart',async t=>{const {store,dev}=fixture(t);ready(store,dev);let calls=0;const reports=new Reports(store,{completeRequest:async()=>{calls++;throw Error('provider private details');}});assert.equal((await reports.generate(day)).status,'uncertain');await reports.generate(day);reports.recover();await reports.generate(day);assert.equal(calls,1);await reports.generate(day,true);assert.equal(calls,2);assert.doesNotMatch(store.daily(day).report.error,/private/);});
test('rhythm HTTP handlers require separate bridge token, reject browser-origin ingestion and protect UI',async t=>{const {root}=fixture(t);const mod=createModule(path.join(root,'second'));t.after(()=>mod.store.db?.close());const device=mod.store.addDevice('Bridge');assert.equal((await mod.publicHandle({request:request({records:[],deleted:[]},'wrong')})).status,401);const r=request({records:[row()],deleted:[],complete:true},device.token);assert.equal((await mod.publicHandle({request:r})).status,200);const browser=request({records:[],deleted:[]},device.token);browser.headers.origin='https://attacker.test';assert.equal((await mod.publicHandle({request:browser})).status,405);assert.equal((await mod.handle({request:{method:'GET'},path:'/api',authorized:()=>false})).status,401);mod.store.revoke(device.id);assert.equal((await mod.publicHandle({request:request({records:[],deleted:[]},device.token)})).status,401);});
test('rhythm ready notification includes no measurements and deduplicates after state reload',async t=>{const {store,dev}=fixture(t);ready(store,dev);const reports=new Reports(store,{completeRequest:async()=>({content:'Private body',usage:null})});await reports.generate(day);const state={},file=path.join(store.directory,'rhythm.sqlite');const events=rhythmEvents(file,state);assert.equal(events.length,1);assert.doesNotMatch(JSON.stringify(events),/Private body|1000/);assert.equal(rhythmEvents(file,JSON.parse(JSON.stringify(state))).length,0);});
test('rhythm sleep uses stages, excludes awake time and chooses one source per day',t=>{const {store,dev}=fixture(t);store.ingest(dev,{records:[row('s',{type:'sleep',start:base,end:base+2*hour,complete:true,stages:[{start:base,end:base+hour,stage:4},{start:base+hour,end:base+2*hour,stage:7}]}),row('other',{source:'CMF',type:'sleep',start:base,end:base+3*hour,complete:true})],deleted:[]});store.priority(store.sources().find(s=>s.name.includes('Huawei')).id,0);const d=store.daily(day);assert.equal(d.sleepMinutes,60);assert.equal(d.sleepEstimated,false);});
test('rhythm integrates with hub routing: bearer can only sync, UI and settings still require login',async t=>{
 const {root}=fixture(t),mod=createModule(path.join(root,'http'));
 const {createApp}=await import('../02-hub/src/server.mjs'),{passwordHash}=await import('../02-hub/src/auth.mjs');
 const config={username:'admin',origin:'https://hub.example.com',...await passwordHash('test-password-for-rhythm')};
 const app=createApp({config,modules:new Map([['rhythm',{id:'rhythm',title:'Ритм',description:'',...mod}]])});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));
 t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));mod.store.db?.close();});
 const baseURL='http://127.0.0.1:'+app.address().port,dev=mod.store.addDevice('Bridge'),headers={'Content-Type':'application/json',Authorization:'Bearer '+dev.token};
 assert.equal((await fetch(baseURL+'/api/rhythm/sync',{method:'POST',headers,body:JSON.stringify({records:[row()],deleted:[],complete:true})})).status,200);
 assert.equal((await fetch(baseURL+'/modules/rhythm/api',{headers,redirect:'manual'})).status,303);
 assert.equal((await fetch(baseURL+'/modules/rhythm/api/config',{method:'POST',headers:{...headers,Origin:config.origin},body:JSON.stringify({zone:'UTC',auto:true}),redirect:'manual'})).status,401);
 const login=await fetch(baseURL+'/api/auth/login',{method:'POST',redirect:'manual',headers:{Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=admin&password=test-password-for-rhythm'});
 const cookie=login.headers.get('set-cookie').split(';')[0];const response=await fetch(baseURL+'/modules/rhythm/api?day='+day,{headers:{Cookie:cookie}});assert.equal(response.status,200);assert.equal((await response.json()).day.steps,1000);
 assert.equal((await fetch(baseURL+'/modules/rhythm/api/config',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:'{}'})).status,403);
 const watched=await fetch(baseURL+'/api/rhythm/sync',{method:'POST',headers,body:JSON.stringify({type:'watch'})});
 assert.equal(watched.headers.get('content-type'),'application/x-ndjson');
 const reader=watched.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/ready/);
 const commanded=await fetch(baseURL+'/modules/rhythm/api/refresh',{method:'POST',headers:{Cookie:cookie,Origin:config.origin,'Content-Type':'application/json'},body:'{}'});
 assert.equal(commanded.status,200);assert.equal((await commanded.json())[0].state,'requested');
 assert.match(new TextDecoder().decode((await reader.read()).value),/refresh/);
 await reader.cancel();mod.close();

});

test('rhythm dashboard and settings run without retired DB controls', async t => {
 const {settings}=await import('../02-hub/modules/rhythm/index.mjs');
 const {runInNewContext}=await import('node:vm');
 const {root}=fixture(t),app=createModule(path.join(root,'ui'));
 t.after(()=>app.close());app.store.configure({zone:'UTC',auto:false});app.store.addDevice('Watch');
 const html=await (await app.handle({request:{method:'GET'},path:'/',user:{username:'test'}})).text();
 assert.doesNotMatch(html,/id="rtConfig"|id="rtAdd"|id="rtSources"/);
 assert.match(settings.content,/id="rtConfig"/);assert.doesNotMatch(settings.content,/id="rtImport"/);
 assert.doesNotMatch(settings.content,/rtSync|type="file"/);assert.match(settings.content,/Huawei-аккаунт и Health Connect не нужны/);assert.match(settings.content,/снимок: 5 минут/);
 assert.doesNotMatch(html,/rtHistory|rtImport|История за 30 дней|Импорт базы/);
 const data=await (await app.handle({request:{method:'GET'},path:'/api',user:{username:'test'}})).json();
 const source=fs.readFileSync(new URL('../02-hub/modules/rhythm/rhythm.js',import.meta.url),'utf8');
 for(const content of [html,settings.content]){
  const make=(tag,text)=>({tag,textContent:text||'',value:'',children:[],get options(){return this.children;},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(){}});
  const elements=new Map([...content.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],make('div')]));
  runInNewContext(source,{setTimeout:()=>0,clearTimeout(){},window:{top:{addEventListener(){},removeEventListener(){}}},addEventListener(){},document:{getElementById:id=>elements.get(id)||null},Nexus:{node:make,request:async()=>data},Option:function(label,value){return {label,value};},TextDecoder,location:{origin:'https://hub.test'}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(elements.get('rtStatus').textContent,'');
  if(elements.has('rtZone'))assert.equal(elements.get('rtZone').value,'UTC');
  else assert.equal(elements.get('rtCards').children.length,6);
 }
});

test('retired DB importer migration keeps measurements, reports and unrelated source keys',t=>{
 const {root,store,dev}=fixture(t),other=store.addDevice('JSON source');store.ingest(dev,{records:[row()],deleted:[],complete:true});
 store.db.exec('CREATE TABLE gb_imports(device TEXT PRIMARY KEY,hash TEXT,exported INTEGER,received INTEGER,details TEXT)');
 store.db.prepare('INSERT INTO gb_imports VALUES(?,?,?,?,?)').run(dev.id,'old',base,base,'{}');
 store.db.prepare("INSERT INTO reports(day,status,summary,text,created) VALUES(?,'done','{}','Сохранённый отчёт',?)").run(day,base);
 const before=store.db.prepare('SELECT * FROM records').all();store.db.close();store.db=null;
 const next=new Rhythm(path.join(root,'rhythm'));t.after(()=>next.db?.close());next.load();
 assert.deepEqual(next.db.prepare('SELECT * FROM records').all(),before);assert.equal(next.db.prepare('SELECT text FROM reports WHERE day=?').get(day).text,'Сохранённый отчёт');
 assert.throws(()=>next.authenticate(dev.token),{status:401});assert.equal(next.authenticate(other.token).id,other.id);
 assert.equal(next.db.prepare("SELECT name FROM sqlite_master WHERE name='gb_imports'").get(),undefined);
});
test('health receiver advertises JSON, rejects retired binary upload and preserves JSON ingest',async t=>{
 const {root}=fixture(t),module=createModule(path.join(root,'api'));t.after(()=>module.store.db?.close());const device=module.store.addDevice('Тестовый источник');
 const hello=await(await module.publicHandle({request:request({type:'hello'},device.token)})).json();assert.equal(hello.format,'json');assert.equal(hello.maxRecords,500);assert.equal(hello.maxBytes,undefined);
 const binary=Readable.from([Buffer.from('SQLite format 3\0')]);binary.method='POST';binary.headers={'content-type':'application/octet-stream',authorization:'Bearer '+device.token};assert.equal((await module.publicHandle({request:binary})).status,415);
 assert.equal((await module.publicHandle({request:request({records:[row()],deleted:[],complete:true},device.token)})).status,200);
 assert.equal((await module.handle({request:request({},device.token),path:'/api/gadgetbridge'})).status,404);
 assert.equal(module.store.daily(day).steps,1000);
});

test('Band snapshots remain separate from history; SpO2 priority and retries are deterministic',t=>{
 const {store,dev}=fixture(t);const records=[row('minute',{start:base,end:base+60000,value:42}),row('band',{type:'band',start:base,end:base+1,steps:1271,battery:48}),row('oxygen',{type:'spo2',start:base,end:base+1,value:98}),row('oxygen-other',{type:'spo2',source:'Other',start:base,end:base+1,value:91})];
 store.ingest(dev,{records,deleted:[],complete:true});store.priority(store.sources().find(s=>s.name.includes('Huawei')).id,0);
 let d=store.daily(day);assert.equal(d.steps,42);assert.equal(d.band.steps,1271);assert.equal(d.band.battery,48);assert.equal(d.spo2.average,98);assert.equal(d.spo2.minutes,1);
 assert.equal(store.ingest(dev,{records,deleted:[],complete:true}).changed,0);assert.equal(store.daily(day).steps,42);
 assert.throws(()=>store.ingest(dev,{records:[{...records[1],battery:101}],deleted:[]}));
 assert.throws(()=>store.ingest(dev,{records:[{...records[1],steps:-1}],deleted:[]}));
 assert.throws(()=>store.ingest(dev,{records:[{...records[1],end:base+60000}],deleted:[]}));
});

test('extended Band data validates atomically, retries do not duplicate and detailed sleep replaces covered legacy sleep',t=>{
 const {store,dev}=fixture(t);const records=[row('stress',{type:'stress',value:42}),row('workout',{type:'activity',workout:{calories:120,distance:2000,steps:2400,duration:3600,kind:1}}),row('legacy',{type:'sleep',complete:false,stages:[{start:base+hour,end:base+2*hour,stage:0}]}),row('detail',{type:'sleep',detail:'trusleep',complete:true,stages:[{start:base+hour,end:base+1.5*hour,stage:4},{start:base+1.5*hour,end:base+2*hour,stage:6}]})];
 store.ingest(dev,{records,deleted:[],complete:true});let daily=store.daily(day);assert.equal(daily.stress.average,42);assert.equal(daily.stress.samples,1);assert.equal(daily.activityMinutes,60);assert.equal(daily.workouts[0].distance,2000);assert.equal(daily.sleepMinutes,60);assert.equal(daily.sleepComplete,true);assert.equal(daily.sleepEstimated,false);assert.equal(daily.sleepStages.light,30);assert.equal(daily.sleepStages.rem,30);
 assert.equal(store.ingest(dev,{records,deleted:[],complete:true}).changed,0);assert.equal(store.daily(day).stress.samples,1);
 assert.throws(()=>store.ingest(dev,{records:[row('new'),row('invalid-stress',{type:'stress',value:101})],deleted:[]}));assert.equal(store.db.prepare("SELECT count(*) AS n FROM records WHERE id='new'").get().n,0);
 assert.throws(()=>store.ingest(dev,{records:[row('invalid-workout',{type:'activity',workout:{duration:-1}})],deleted:[]}));
});

test('band metrics preserve decimal sleep values and detailed sport samples without double counting',t=>{
 const {store,dev}=fixture(t);const records=[row('move',{type:'movement',metrics:{calories:20,distance:100}}),row('move2',{type:'movement',metrics:{calories:20,distance:100}}),row('night',{type:'sleep',complete:false,metrics:{score:82,hrvAverage:47,oxygenAverage:97.5},dictionary:{700013468:97.5}}),row('sport',{type:'sport',workout:7,extensionMask:0,samples:[{time:base+hour,heart:80,speed:2.5,cadence:70,extensions:''}]})];
 store.ingest(dev,{records,deleted:[],complete:true});const d=store.daily(day);assert.equal(d.movement.distance,100);assert.equal(d.movement.calories,20);assert.equal(d.sleepMetrics.oxygenAverage,97.5);assert.equal(d.sport.samples,1);assert.equal(d.activityMinutes,null);
 assert.equal(store.exportDay(day).find(r=>r.type==='sport').samples[0].heart,80);assert.equal(store.ingest(dev,{records,deleted:[]}).changed,0);
 for(const extra of [{type:'sleep',complete:false,metrics:{score:101}},{type:'movement',metrics:{distance:-1}},{type:'sport',workout:7,samples:[{time:base,heart:80}]}])assert.throws(()=>store.ingest(dev,{records:[row('bad',extra)],deleted:[]}));
});

test('measurement export requires login and preserves device fields',async t=>{
 const {root}=fixture(t),app=createModule(path.join(root,'export'));t.after(()=>app.close());app.store.configure({zone:'UTC',auto:false});const dev=app.store.addDevice('Band');
 app.store.ingest(dev,{records:[row('raw',{type:'stress',value:42,deviceFields:{rriV3:'000102'}})],deleted:[]});
 const args={request:{method:'GET'},path:'/api/export',user:{username:'test'},searchParams:new URLSearchParams({day})};
 const denied=await app.handle({...args,authorized:()=>false});assert.equal(denied.status,401);
 const response=await app.handle(args);assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal((await response.json())[0].deviceFields.rriV3,'000102');
 const invalid=await app.handle({...args,searchParams:new URLSearchParams({day:'bad'})});assert.notEqual(invalid.status,200);
});

test('overlapping heart pages do not weight the same sample twice; newer correction wins', t => {
 const {store,dev}=fixture(t),time=base+hour;
 store.ingest(dev,{records:[
  row('older',{type:'heart',start:time,end:time+60000,modified:time+120000,samples:[{time,bpm:60},{time:time+30000,bpm:100}]}),
  row('newer',{type:'heart',start:time,end:time+60000,modified:time+180000,samples:[{time,bpm:80}]})
 ],deleted:[]});
 assert.equal(store.daily(day).heart.average,90);
});
test('empty high-priority sleep metrics do not hide available lower-priority metrics', t => {
 const {store,dev}=fixture(t);
 store.ingest(dev,{records:[row('first',{type:'sleep',source:'First',start:base,end:base+hour,complete:false,metrics:{}}),row('second',{type:'sleep',source:'Second',start:base,end:base+hour,complete:false,metrics:{score:80}})],deleted:[]});
 store.priority(store.sources().find(s=>s.name==='First').id,0);
 assert.equal(store.daily(day).sleepMetrics.score,80);
 assert.throws(()=>store.exportDay('2026-02-30'),{status:400});
});

test('Band 11 minute energy is converted from cal to kcal without rewriting received data', t => {
 const {store,dev}=fixture(t);
 store.ingest(dev,{records:[row('energy',{type:'movement',source:'Huawei Band 11 · fixture',metrics:{calories:12000,distance:100}})],deleted:[]});
 assert.equal(store.daily(day).movement.calories,12);
 assert.equal(store.daily(day).movement.distance,100);
 assert.equal(store.exportDay(day)[0].metrics.calories,12000);
});
test('unknown sleep stages do not become zero minutes or a completed sleep', t => {
 const {store,dev}=fixture(t);
 store.ingest(dev,{records:[row('unknown-night',{type:'sleep',complete:true,stages:[{start:base+hour,end:base+2*hour,stage:0}]})],deleted:[]});
 const d=store.daily(day);
 assert.equal(d.sleepMinutes,null);
 assert.equal(d.sleepReceived,true);
 assert.equal(d.unknownSleepMinutes,60);
 assert.equal(d.sleepComplete,false);
 assert.equal(d.ready,false);
});
test('all received types are available in the authenticated record viewer', async t => {
 const {root}=fixture(t), app=createModule(path.join(root,'viewer'));
 t.after(()=>app.close());
 const html=await (await app.handle({request:{method:'GET'},path:'/',user:{username:'test'}})).text();
 assert.match(html,/id="rtShowData"/);assert.match(html,/id="rtData"/);
 assert.equal((await app.handle({request:{method:'GET'},path:'/api/export',authorized:()=>false})).status,401);
 const {runInNewContext}=await import('node:vm');
 const make=(tag,text)=>({tag,textContent:text||'',value:'',children:[],append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},setAttribute(){}});
 const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],make('div')]));
 const data=await (await app.handle({request:{method:'GET'},path:'/api',user:{username:'test'}})).json();
 const records=['band','steps','movement','heart','spo2','sleep','stress','activity','sport'].map(type=>({type,start:base,end:base+hour,metrics:{score:88},deviceFields:{aa:'ABCD'}}));
 runInNewContext(fs.readFileSync(new URL('../02-hub/modules/rhythm/rhythm.js',import.meta.url),'utf8'),{
  setTimeout:()=>0,clearTimeout(){},addEventListener(){},
  document:{getElementById:id=>elements.get(id)||null},Nexus:{node:make,request:async route=>route.includes('/api/export')?records:data}
 });
 await new Promise(r=>setImmediate(r));
 await elements.get('rtShowData').onclick();
 assert.equal(elements.get('rtStatus').textContent,'');
 const groups=elements.get('rtData').children.filter(x=>x.tag==='details');
 assert.equal(groups.length,9);
 for(const group of groups){group.open=true;group.ontoggle();const record=group.children[1].children[0];record.open=true;record.ontoggle();assert.ok(record.children.length>1);}
});

test('Huawei sleep raw types survive export without becoming recognized sleep', t => {
 const {store,dev}=fixture(t);
 store.ingest(dev,{records:[row('unknown',{type:'sleep',complete:false,stages:[{start:base+hour,end:base+2*hour,stage:0}],deviceFields:{'04':'01'}})],deleted:[]});
 assert.equal(store.exportDay(day)[0].deviceFields['04'],'01');
 assert.equal(store.daily(day).sleepMinutes,null);
 assert.throws(()=>store.ingest(dev,{records:[row('bad',{type:'sleep',complete:false,deviceFields:{'04':'not-hex'}})],deleted:[]}));
});
