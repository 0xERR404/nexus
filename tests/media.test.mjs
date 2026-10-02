import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Readable} from 'node:stream';
import {Activity} from '../02-hub/src/activity.mjs';
import {Cinema,PieceStore,validateTorrent} from '../02-hub/modules/cinema/store.mjs';
import {createModule,byteRange} from '../02-hub/modules/cinema/index.mjs';
import {handle as statistics} from '../02-hub/modules/statistics/index.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'nexus-media-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function sample(extra={}){return {session:randomUUID(),source:'cinema',item:randomUUID()+':0',title:'Movie',kind:'cinema',seq:1,playing:true,position:0,duration:100,...extra};}
test('activity counts playback, deduplicates retries and does not count seeking or long offline gaps',t=>{
 let now=100000;const a=new Activity(fixture(t),()=>now);t.after(()=>a.close());const v=sample();a.record(v);now+=10000;
 assert.equal(a.record({...v,seq:2,position:10}).seconds,10);
 assert.equal(a.record({...v,seq:2,position:10}).accepted,false);
 now+=1000;assert.equal(a.record({...v,seq:3,position:99}).seconds,0);assert.equal(a.snapshot().items[0].completed,0);
 now+=90000;assert.equal(a.record({...v,seq:4,position:100,playing:false}).seconds,0);
 assert.equal(a.snapshot().totals[0].seconds,10);
});
test('activity merges actual watched intervals, preserves completion on restart and bounds overlapping tabs',t=>{
 let now=100000;const root=fixture(t),a=new Activity(root,()=>now);t.after(()=>a.close());const v=sample(),other={...v,session:randomUUID()};a.record(v);a.record(other);
 for(let i=1;i<=9;i++){now+=10000;a.record({...v,seq:i+1,position:i*10});a.record({...other,seq:i+1,position:i*10});}
 assert.equal(a.snapshot().totals[0].seconds,90);assert.equal(a.snapshot().items[0].completed,1);
 const b=new Activity(root,()=>now);assert.equal(b.snapshot().items[0].completed,1);b.close();
 assert.throws(()=>a.record({...v,seq:100,item:randomUUID()}),{status:409});
});
test('activity pauses, validates events and does not interpret reading time as a finished book',t=>{
 let now=1000;const a=new Activity(fixture(t),()=>now);t.after(()=>a.close());const v=sample({source:'reader',kind:'book',item:randomUUID(),duration:0});
 a.record(v);now+=10000;a.record({...v,seq:2,position:10,playing:false});now+=10000;a.record({...v,seq:3,position:20,playing:false});
 assert.equal(a.snapshot().totals[0].seconds,10);assert.equal(a.snapshot().items[0].completed,0);
 assert.throws(()=>a.record({...v,position:NaN}),{status:400});assert.throws(()=>a.record({...v,kind:'cinema'}),{status:400});
});
test('cinema validates torrent metadata, files and byte ranges',()=>{
 const valid={length:10,pieceLength:16,files:[{path:'movie.mp4',length:10}],pieces:['x']};validateTorrent(valid);
 for(const p of ['../a','/etc/passwd','a/../../b','C:/a','a\\b'])assert.throws(()=>validateTorrent({...valid,files:[{path:p,length:10}]}));
 assert.throws(()=>validateTorrent({...valid,length:9*1024**3}),{status:413});assert.throws(()=>validateTorrent({...valid,private:true}));
 assert.deepEqual(byteRange('bytes=-4',10),{start:6,end:9,status:206});assert.deepEqual(byteRange('bytes=2-',10),{start:2,end:9,status:206});
 for(const r of ['bytes=-0','bytes=10-','bytes=4-3','bytes=0-1,4-5'])assert.throws(()=>byteRange(r,10),{status:416});
});
test('cinema piece store returns only written pieces and ignores torrent filenames',async t=>{
 const root=fixture(t),store=new PieceStore(4,{length:6,path:path.join(root,'cache'),files:[{path:'../../escape',length:6}]});
 await new Promise(r=>store.get(0,e=>{assert.ok(e);r();}));
 await new Promise((resolve,reject)=>store.put(0,Buffer.from('abcd'),e=>e?reject(e):resolve()));
 const part=await new Promise((resolve,reject)=>store.get(0,{offset:1,length:2},(e,b)=>e?reject(e):resolve(b)));
 assert.equal(part.toString(),'bc');assert.equal(fs.existsSync(path.join(root,'escape')),false);
 await new Promise(r=>store.put(3,Buffer.from('abcd'),e=>{assert.ok(e);r();}));
 await new Promise(r=>store.destroy(r));assert.equal(fs.existsSync(path.join(root,'cache')),false);
});
test('cinema catalog strips tracker and webseed URLs, deduplicates and persists titles',async t=>{
 const root=fixture(t),store=new Cinema(root);t.after(()=>store.close());
 const value={title:'Film',kind:'cinema',magnet:'magnet:?xt=urn:btih:'+'a'.repeat(40)+'&ws=http://127.0.0.1/secret&tr=http://private/'};
 const first=await store.add(value),second=await store.add(value);assert.equal(first.id,second.id);assert.equal(store.list().length,1);assert.equal(store.item(first.id).hash,'a'.repeat(40));assert.equal(store.item(first.id).metadata,null);
 await assert.rejects(()=>store.add({...value,magnet:'file:///etc/passwd'}),{status:400});
 await store.remove(first.id);assert.equal(store.list().length,0);
});
test('new module routes are private and statistics tolerates a failed optional source',async t=>{
 const m=createModule(path.join(fixture(t),'cinema'));t.after(()=>m.close());
 for(const route of ['/','/api','/stream/'+randomUUID()+'/0','/open'])assert.equal((await m.handle({request:{method:'GET'},path:route,authorized:()=>false})).status,401);
 assert.equal((await statistics({request:{method:'GET'},path:'/api',authorized:()=>false})).status,401);
 const a=new Activity(null);t.after(()=>a.close());const response=await statistics({request:{method:'GET'},path:'/api',activity:a,modules:new Map([['reader',{id:'reader',title:'Клио',summary:()=>{throw Error('private failure');}}]])});
 const data=await response.json();assert.equal(data.sources.find(s=>s.id==='reader').state,'stale');assert.doesNotMatch(JSON.stringify(data),/private failure/);
});
test('local torrent streams verified video bytes and ranges through the authenticated cinema handler', {timeout:20000},async t=>{
 const root=fixture(t),video=path.join(root,'fixture.mp4');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x48:d=2','-c:v','libx264','-movflags','+faststart','-y',video]);
 const {default:WebTorrent}=await import('../02-hub/node_modules/webtorrent/index.js');
 const opts={dht:false,tracker:false,lsd:false,utp:false,natUpnp:false,natPmp:false,blocklist:[]};
 const seed=new WebTorrent(opts);seed.on('error',()=>{});t.after(()=>new Promise(r=>seed.destroy(r)));
 const torrent=await new Promise((resolve,reject)=>{seed.once('error',reject);seed.seed(video,{announce:[]},resolve);});
 const mod=createModule(path.join(root,'cinema'),{client:opts});t.after(()=>mod.close());
 const item=await mod.store.add({title:'Local fixture',kind:'cinema',bytes:torrent.torrentFile});
 await mod.store.open(item.id);mod.store.active.torrent.addPeer('127.0.0.1:'+seed.torrentPort);
 const response=await mod.handle({request:{method:'GET',headers:{range:'bytes=0-511'}},path:'/stream/'+item.id+'/0',authorized:()=>true});
 assert.equal(response.status,206);assert.equal(response.headers.get('content-length'),'512');
 const bytes=Buffer.from(await response.arrayBuffer());assert.deepEqual(bytes,fs.readFileSync(video).subarray(0,512));
 assert.ok(mod.store.active.torrent.wires.length);
 for(const wire of mod.store.active.torrent.wires){wire.emit('interested');assert.equal(wire.amChoking,true);wire.piece(0,0,Buffer.alloc(512));assert.equal(wire.uploaded,0);}
 assert.equal((await mod.handle({request:{method:'HEAD',headers:{}},path:'/stream/'+item.id+'/0'})).headers.get('content-length'),String(fs.statSync(video).size));
 await mod.store.stop();assert.equal(fs.existsSync(path.join(root,'cinema/cache')),false);
});
test('activity HTTP API requires login and CSRF, validates content type and persists playback',async t=>{
 const {createApp}=await import('../02-hub/src/server.mjs'),{passwordHash}=await import('../02-hub/src/auth.mjs');
 const root=fixture(t),config={username:'admin',origin:'https://hub.test',...await passwordHash('activity-test-password')};
 const app=createApp({config,dataDirectory:root,modules:new Map([['wave',{id:'wave',title:'Аполлон',handle:()=>new Response('')} ]])});
 await new Promise(r=>app.listen(0,'127.0.0.1',r));t.after(async()=>{app.closeAllConnections();await new Promise(r=>app.close(r));});
 const base='http://127.0.0.1:'+app.address().port;
 assert.equal((await fetch(base+'/api/activity')).status,401);
 const login=await fetch(base+'/api/auth/login',{method:'POST',redirect:'manual',headers:{Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:'username=admin&password=activity-test-password'});
 const cookie=login.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:config.origin,'Content-Type':'application/json'};
 const body=JSON.stringify(sample({source:'wave',item:randomUUID(),kind:'music'}));
 assert.equal((await fetch(base+'/api/activity',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body})).status,403);
 assert.equal((await fetch(base+'/api/activity',{method:'POST',headers:{...headers,'Content-Type':'text/plain'},body})).status,415);
 assert.equal((await fetch(base+'/api/activity',{method:'POST',headers,body})).status,200);
 const data=await(await fetch(base+'/api/activity',{headers})).json();assert.equal(data.items.length,1);assert.equal(data.items[0].seconds,0);
 assert.equal((await fetch(base+'/api/activity',{method:'POST',headers,body:'{"source":"cinema"}'})).status,404);
});
test('cinema incomplete disk writes never mark a piece available',async t=>{
 const root=fixture(t),store=new PieceStore(4,{length:4,path:path.join(root,'cache')}),write=fs.writeSync;
 try {
  fs.writeSync=()=>1;
  await new Promise(resolve=>store.put(0,Buffer.from('abcd'),error=>{assert.ok(error);resolve();}));
 } finally {fs.writeSync=write;}
 await new Promise(resolve=>store.get(0,error=>{assert.ok(error);resolve();}));
 await new Promise(resolve=>store.destroy(resolve));
});

test('cinema upgrade removes obsolete discovery settings and retains the catalog',async t=>{
 const root=fixture(t),store=new Cinema(root);const item=await store.add({title:'Keep',kind:'cinema',magnet:'magnet:?xt=urn:btih:'+'a'.repeat(40)});store.db.exec("CREATE TABLE settings(id INTEGER PRIMARY KEY,value TEXT);INSERT INTO settings VALUES(1,'opentrackr')");await store.close();const restored=new Cinema(root);t.after(()=>restored.close());assert.equal(restored.list()[0].id,item.id);assert.equal(restored.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'").get(),undefined);
});
test('MKV converts to playable fragmented MP4 through authenticated handler', {timeout:20000},async t=>{
 const root=fixture(t),file=path.join(root,'sample.mkv');execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x48:d=1','-c:v','libx264','-y',file]);
 const mod=createModule(path.join(root,'data'));t.after(()=>mod.close());mod.store.file=()=>({name:'sample.mkv',[Symbol.asyncIterator]:()=>fs.createReadStream(file)[Symbol.asyncIterator]()});
 const response=await mod.handle({request:{method:'GET',headers:{}},path:'/stream/'+randomUUID()+'/0',authorized:()=>true});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'video/mp4');const output=Buffer.from(await response.arrayBuffer());assert.ok(output.includes(Buffer.from('ftyp')));assert.ok(output.includes(Buffer.from('moof')));const mp4=path.join(root,'converted.mp4');fs.writeFileSync(mp4,output);execFileSync('ffmpeg',['-v','error','-i',mp4,'-f','null','-']);
});

test('UDP tracker resolution pins public IPv4 and rejects local, mapped, credential and web targets',async()=>{
 const {resolveTrackers}=await import('../02-hub/modules/cinema/store.mjs');
 const result=await resolveTrackers(['udp://tracker.example:1337/announce','udp://127.0.0.1:80/a','udp://[::ffff:127.0.0.1]:80/a','http://8.8.8.8/a','udp://user:pass@8.8.8.8:80/a','udp://local.example:80/a'],async h=>h==='local.example'?['10.0.0.1']:['93.184.216.34']);
 assert.deepEqual(result,['udp://93.184.216.34:1337/announce']);
});
test('magnet trackers reach torrent engine after validation and diagnostics count discovery replies',async t=>{
 const {EventEmitter}=await import('node:events');let received;const root=fixture(t),store=new Cinema(root,{lookup:async()=>['93.184.216.34']});t.after(()=>store.close());
 const item=await store.add({title:'Discovery',kind:'cinema',magnet:'magnet:?xt=urn:btih:'+'b'.repeat(40)+'&tr=udp://tracker.example:1337/announce'});
 const torrent=new EventEmitter();Object.assign(torrent,{ready:true,files:[],destroyed:false,destroy(cb){this.destroyed=true;this.emit('close');cb?.();}});
 store.engine={add(source,options){received=options.announce;setImmediate(()=>{torrent.emit('ready');torrent.emit('trackerAnnounce');torrent.emit('dhtAnnounce');});return torrent;},destroyed:true};
 await store.open(item.id);assert.deepEqual(received,['udp://93.184.216.34:1337/announce']);assert.equal(store.status().trackers,1);assert.equal(store.status().trackerReplies,1);assert.equal(store.status().dhtReplies,1);
});

test('HTTP tracker announce encodes binary identifiers, parses peers and refuses redirects',async t=>{
 const http=await import('node:http'),{default:bencode}=await import('../02-hub/node_modules/bencode/index.js'),{announceHTTP}=await import('../02-hub/modules/cinema/store.mjs');
 let redirect=false,seen='';const server=http.createServer((req,res)=>{seen=req.url;if(redirect){res.writeHead(302,{Location:'http://127.0.0.1/private'});res.end();return;}res.end(bencode.encode({interval:120,peers:Buffer.from([93,184,216,34,26,225,127,0,0,1,0,80])}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>server.close());
 const stats={hash:'ab'.repeat(20),peerId:'cd'.repeat(20),port:6881,left:100,started:true};
 const options={lookup:async()=>['93.184.216.34'],transport:(url,opts,cb)=>http.request('http://127.0.0.1:'+server.address().port,{...opts},cb)};
 const result=await announceHTTP('http://tracker.example/ann?passkey=secret',stats,options);assert.deepEqual(result.peers,[{ip:'93.184.216.34',port:6881}]);assert.equal(result.interval,120);assert.ok(seen.includes('info_hash='+('%ab'.repeat(20))));assert.ok(seen.includes('peer_id='+('%cd'.repeat(20))));assert.ok(seen.includes('passkey=secret'));assert.ok(seen.includes('event=started'));redirect=true;await assert.rejects(()=>announceHTTP('http://tracker.example/ann',stats,options),/HTTP 302/);
 await assert.rejects(()=>announceHTTP('http://127.0.0.1/ann',stats),/публичного/);
});

test('cinema separates catalog and movie routes and removes obsolete navigation',async t=>{
 const mod=createModule(fixture(t));t.after(()=>mod.close());
 const render=async query=>(await mod.handle({request:{method:'GET'},path:'/',user:{username:'viewer'},searchParams:new URLSearchParams(query)})).text();
 const catalog=await render(''),detail=await render('id='+randomUUID());
 assert.match(catalog,/id="cinemaDetail" class="cinema-player" hidden/);assert.doesNotMatch(catalog,/id="cinemaCatalog" hidden/);
 assert.match(detail,/id="cinemaCatalog" hidden/);assert.doesNotMatch(detail,/id="cinemaDetail" class="cinema-player" hidden/);
 assert.match(detail,/Все фильмы/);assert.doesNotMatch(catalog,/Форматы и подключение|История в Дионисе|href="\/modules\/statistics\/"/);
});

test('music folder drop reads every directory batch and nested files before upload', async () => {
 const {droppedFiles}=await import('../02-hub/modules/wave/wave.js');
 const file=name=>({isFile:true,name,file:resolve=>resolve({name,size:1,lastModified:1})});
 const directory=(name,batches)=>({isDirectory:true,name,createReader(){let index=0;return {readEntries:resolve=>resolve(batches[index++]||[])};}});
 const root=directory('Music',[Array.from({length:100},(_,i)=>file(`${i}.mp3`)),[directory('Album',[[file('nested.flac')]]),file('cover.jpg')]]);
 let accessible=true;
 const item={kind:'file',webkitGetAsEntry(){assert.equal(accessible,true);return root;},getAsFile(){assert.equal(accessible,true);return null;}};
 const counts=[];
 const pending=droppedFiles({items:[item],files:[]},n=>counts.push(n));
 accessible=false;
 const files=await pending;
 assert.equal(files.length,102);
 assert.equal(files[100].name,'nested.flac');
 assert.equal(counts.at(-1),102);
});
test('music folder drop handles plain files and reports unreadable directories', async () => {
 const {droppedFiles}=await import('../02-hub/modules/wave/wave.js');
 const file={name:'track.mp3'};
 assert.deepEqual(await droppedFiles({files:[file]}),[file]);
 assert.deepEqual(await droppedFiles({items:[{kind:'file',getAsFile:()=>file}],files:[file]}),[file]);
 const entry={isDirectory:true,name:'denied',createReader:()=>({readEntries:(resolve,reject)=>reject(Error('Denied'))})};
 await assert.rejects(droppedFiles({items:[{kind:'file',webkitGetAsEntry:()=>entry}],files:[]}),/Denied/);
});

test('MKV multichannel audio becomes continuous stereo AAC-LC at 48 kHz', {timeout:20000}, async t=>{
 const root=fixture(t),file=path.join(root,'surround.mkv');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:s=64x48:d=3','-f','lavfi','-i',
  "aevalsrc='0.2*sin(2*PI*440*t)*between(t,1,2)|0.2*sin(2*PI*440*t)*between(t,1,2)|0.2*sin(2*PI*440*t)*between(t,1,2)|0|0|0':s=44100:d=3:c=5.1",
  '-c:v','libx264','-c:a','pcm_s16le','-y',file]);
 const mod=createModule(path.join(root,'data'));t.after(()=>mod.close());
 mod.store.file=()=>({name:'surround.mkv',[Symbol.asyncIterator]:()=>fs.createReadStream(file)[Symbol.asyncIterator]()});
 const response=await mod.handle({request:{method:'GET',headers:{}},path:'/stream/'+randomUUID()+'/0',authorized:()=>true});
 assert.equal(response.status,200);
 const output=path.join(root,'stereo.mp4');fs.writeFileSync(output,Buffer.from(await response.arrayBuffer()));
 const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-select_streams','a:0','-show_streams','-show_packets','-of','json',output]));
 const audio=probe.streams[0];assert.equal(audio.codec_name,'aac');assert.equal(audio.profile,'LC');assert.equal(audio.channels,2);assert.equal(audio.sample_rate,'48000');
 for(let i=1;i<probe.packets.length;i++){
  const prev=probe.packets[i-1],next=probe.packets[i];
  assert.ok(Number(next.pts_time)>Number(prev.pts_time));
  if(prev.duration_time) assert.ok(Math.abs(Number(next.pts_time)-Number(prev.pts_time)-Number(prev.duration_time))<0.00001,'audio packet gap');
 }
 const pcm=execFileSync('ffmpeg',['-v','error','-i',output,'-map','0:a:0','-f','f32le','-c:a','pcm_f32le','pipe:1'],{maxBuffer:4*1024**2});
 let peak=0,delta=0,last=0;
 for(let i=0;i<pcm.length;i+=8){const value=pcm.readFloatLE(i);assert.ok(Number.isFinite(value));peak=Math.max(peak,Math.abs(value));delta=Math.max(delta,Math.abs(value-last));last=value;}
 assert.ok(peak>0.05&&peak<1,'audible signal without clipping');
 assert.ok(delta<0.15,'no impulse on synthetic silence-to-tone transition');
});

test('cinema edits persist without replacing torrent and covers require authentication',async t=>{
 const mod=createModule(path.join(fixture(t),'data'));t.after(()=>mod.close());
 const item=await mod.store.add({title:'Old',kind:'cinema',magnet:'magnet:?xt=urn:btih:'+'d'.repeat(40)});
 const hash=mod.store.item(item.id).hash;
 mod.store.edit(item.id,{title:' New '});assert.equal(mod.store.item(item.id).title,'New');assert.equal(mod.store.item(item.id).hash,hash);
 assert.throws(()=>mod.store.edit(item.id,{title:''}));
 assert.throws(()=>mod.store.setCover(item.id,Buffer.from('<svg/>')),{status:415});
 assert.throws(()=>mod.store.setCover(item.id,Buffer.alloc(2*1024**2+1)),{status:413});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=','base64');
 mod.store.setCover(item.id,png);assert.ok(mod.store.list()[0].coverVersion);assert.equal(mod.store.list()[0].cover,undefined);
 const context={request:{method:'GET'},path:'/cover/'+item.id};
 assert.equal((await mod.handle({...context,authorized:()=>false})).status,401);
 const response=await mod.handle(context);assert.equal(response.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 mod.store.edit(item.id,{title:'New',removeCover:true});assert.equal((await mod.handle(context)).status,404);
});

test('download-only wire blocks unchoking and piece responses including allowed-fast',async()=>{
 const {downloadOnly}=await import('../02-hub/modules/cinema/store.mjs');
 const {default:Wire}=await import('../02-hub/node_modules/bittorrent-protocol/index.js');
 const wire=new Wire();wire.on('error',()=>{});wire.resume();downloadOnly(wire);
 wire.unchoke();assert.equal(wire.amChoking,true);
 wire.allowedFast(0);assert.deepEqual(wire.allowedFastSet,[]);
 wire.piece(0,0,Buffer.alloc(1024));assert.equal(wire.uploaded,0);
 wire.amChoking=false;
 wire.on('request',(index,offset,length,respond)=>respond(null,Buffer.alloc(length)));
 wire._onRequest(0,0,1024);assert.equal(wire.uploaded,0);
 wire.destroy();
});

test('Themis contains only five media sections and never requests unrelated summaries',async()=>{
 let queried=false;
 const response=await statistics({request:{method:'GET'},path:'/api',activity:{snapshot:()=>({items:[],daily:[],totals:[]})},modules:new Map([['balance',{id:'balance',summary:()=>{queried=true;return {state:'ok',items:[]};}}]])});
 const data=await response.json();assert.equal(queried,false);assert.deepEqual(data.sources.map(s=>s.id),['anime','cinema','wave','reader','trophies']);assert.equal(data.daily,undefined);
 const page=await(await statistics({request:{method:'GET'},path:'/',user:{username:'test'}})).text();assert.doesNotMatch(page,/statisticsDaily|statisticsDays|statisticsTotals|сводки модулей/);
});

test('artist artwork chooses newest album before falling back to a custom photo', async () => {
 const {catalog,artistCover}=await import('../02-hub/modules/wave/catalog.mjs');
 const tracks=[
  {id:'old',artist:'Band',title:'Old',album:'Old',year:'2000',added:30,cover:true},
  {id:'new',artist:'Band',title:'New',album:'New',year:'2025',added:10,cover:true},
  {id:'single',artist:'Band',title:'Single',album:'',year:'2026',added:40,cover:true}
 ];
 const artist=catalog(tracks).artists[0];
 assert.equal(artistCover(artist),'/modules/wave/cover/new');
 assert.equal(artistCover(artist,[{key:artist.key,photo:'custom'}]),'/modules/wave/artist-photo/custom');
 assert.equal(artistCover({...artist,tracks:tracks.map(t=>({...t,cover:false}))}),'');
});

test('Shikimori history retains actual dated events and rejects unbounded responses', async () => {
 const {normalizeHistory}=await import('../02-hub/modules/anime/store.mjs');
 const events=normalizeHistory([
  {id:1,created_at:'2026-09-01T10:00:00Z',description:'<b>Просмотрено</b> 3 эпизода',target:{id:20,name:'Anime'}},
  {id:2,created_at:'invalid',target:{id:21,name:'Unknown'}},
  {id:3,created_at:'2026-09-02T10:00:00Z',description:'Запланировано',target:{id:22,russian:'Тайтл'}}
 ]);
 assert.equal(events.length,2);
 assert.equal(events[0].detail,'Запланировано');
 assert.equal(events[1].detail,'Просмотрено 3 эпизода');
 assert.equal(events[1].href,'/modules/anime/?anime=20');
 assert.throws(()=>normalizeHistory(Array(52).fill({})));
});

test('recent games use play and unlock dates rather than sync time', async () => {
 const {TrophiesStore}=await import('../02-hub/modules/trophies/store.mjs');
 const store=Object.create(TrophiesStore.prototype);
 store.load=()=>{};store.now=()=>10000;store.account=kind=>kind==='steam'?{id:'account'}:null;
 store.rows=()=>[{id:'1',title:'Game',lastPlayed:4000,detailAt:9000,achievements:[
  {id:'a',title:'First',soft:true,date:3000},
  {id:'b',title:'Unknown date',soft:true,date:null},
  {id:'c',title:'Locked',soft:false,date:2000}
 ]}];
 const result=store.recent();
 assert.equal(result.played[0].date,4000);
 assert.equal(result.achievements.length,1);
 assert.equal(result.achievements[0].date,3000);
 assert.equal(result.achievements[0].detail,'Достижение · First');
});
