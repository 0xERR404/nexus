import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {Readable} from 'node:stream';import {createHash} from 'node:crypto';
import {Storage} from '../02-hub/modules/storage/store.mjs';
import {ContentStore} from '../02-hub/src/content-store.mjs';
import {PhoneUploads} from '../02-hub/modules/storage/phone.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t,target='storage'){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phone-')),storage=new Storage(path.join(dir,'storage')),gallery=new ContentStore(path.join(dir,'gallery')),phone=new PhoneUploads(storage,()=>gallery);const source=phone.create({name:'Телефон',target});t.after(()=>{storage.db?.close();fs.rmSync(dir,{recursive:true,force:true});});return {storage,gallery,phone,source};}
function req(source,bytes,extra={}){const r=Readable.from([bytes]);r.method='POST';r.headers={'content-type':'application/octet-stream','content-length':String(bytes.length),authorization:'Bearer '+source.token,'x-file-name':encodeURIComponent('Папка/note.txt'),'x-content-sha256':digest(bytes),...extra};return r;}
function json(source,data){const b=Buffer.from(JSON.stringify(data));return req(source,b,{'content-type':'application/json'});}
test('phone source key only admits authenticated upload and scoped probes',async t=>{
 const f=fixture(t);assert.equal((await f.phone.handle(json(f.source,{type:'hello'}))).status,200);
 assert.equal((await f.phone.handle(req(f.source,Buffer.from('abc'),{authorization:'Bearer invalid'}))).status,401);
 assert.equal((await f.phone.handle(req(f.source,Buffer.from('abc'),{origin:'https://hub.example'}))).status,405);
 assert.equal((await f.phone.handle(json(f.source,{type:'list'}))).status,400);
 f.phone.revoke(f.source.id);assert.equal((await f.phone.handle(json(f.source,{type:'hello'}))).status,401);
});
test('phone upload preserves folders, verifies hash, deduplicates retry and does not resurrect deletion',async t=>{
 const f=fixture(t),bytes=Buffer.from('same content');const first=await f.phone.handle(req(f.source,bytes));assert.equal(first.status,201);const item=await first.json();assert.equal(f.storage.stats().files,1);
 const source=f.phone.list()[0],sub=f.storage.list().folders.find(x=>x.parent===source.destination);assert.equal(sub.name,'Папка');assert.equal(f.storage.file(item.id).folder,sub.id);
 assert.equal((await (await f.phone.handle(req(f.source,bytes))).json()).duplicate,true);assert.equal(f.storage.stats().files,1);
 assert.equal((await (await f.phone.handle(json(f.source,{type:'probe',hash:digest(bytes)}))).json()).received,true);
 f.storage.delete(item.id);f.storage.purge(item.id);assert.equal((await (await f.phone.handle(req(f.source,bytes))).json()).duplicate,true);assert.equal(f.storage.stats().files,0);
 const result=await f.phone.handle(req(f.source,Buffer.from('new content'),{'x-content-sha256':'0'.repeat(64)}));assert.equal(result.status,400);assert.equal(f.storage.stats().files,0);
 assert.equal((await f.phone.handle(req(f.source,bytes,{'x-file-name':'../bad.txt','x-content-sha256':'1'.repeat(64)}))).status,400);
});
test('revocation during upload leaves neither file nor receipt; failed receipt transaction rolls back file',async t=>{
 const f=fixture(t),bytes=Buffer.from('part one and two');const r=Readable.from((async function*(){yield bytes.subarray(0,4);f.phone.revoke(f.source.id);yield bytes.subarray(4);})());r.method='POST';r.headers=req(f.source,bytes).headers;
 assert.notEqual((await f.phone.handle(r)).status,201);assert.equal(f.storage.stats().files,0);assert.equal(f.storage.db.prepare('SELECT COUNT(*) n FROM phone_receipts').get().n,0);
 const input=req(f.source,bytes);await assert.rejects(f.storage.upload(input,'note.txt',null,()=>true,()=>{throw Error('commit failure')}),/commit failure/);assert.equal(f.storage.stats().files,0);
});
test('gallery auto upload creates a real image in its album and retry does not duplicate',async t=>{
 const f=fixture(t,'gallery');const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR4nGM8cOAAAzbAhFV00EoAAMSXAlDGsp8pAAAAAElFTkSuQmCC','base64');
 const result=await f.phone.handle(req(f.source,png,{'x-file-name':'pixel.png'}));assert.equal(result.status,201,JSON.stringify(await result.clone().json()));
 assert.equal(f.gallery.images().images.length,1);assert.equal(f.gallery.images().images[0].album,'Телефон');
 assert.equal((await (await f.phone.handle(req(f.source,png,{'x-file-name':'pixel.png'}))).json()).duplicate,true);
});
