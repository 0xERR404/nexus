import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {Storage, MAX_FILE} from '../02-hub/modules/storage/store.mjs';
import {handle} from '../02-hub/modules/storage/index.mjs';
import {renderArticle} from '../02-hub/src/content-module.mjs';

const fixture = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-storage-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return new Storage(dir);
};
const upload = (store, bytes, filename = 'note.txt', length = bytes.length) => {
  const request = Readable.from([bytes]);
  request.headers = {'content-length': String(length)};
  return store.upload(request, filename, null);
};

test('storage retains original name separately, searches, references and trash', async (t) => {
  const store = fixture(t);
  const folder = store.createFolder('Документы');
  const item = await upload(store, Buffer.from('example text'));
  assert.match(item.id, /^[a-f0-9-]{36}$/);
  assert.equal(fs.existsSync(path.join(store.directory, 'blobs', 'note.txt')), false);
  assert.equal(store.list('note').files[0].name, 'note.txt');
  store.attach(item.id, 'project', folder.id);
  assert.deepEqual(store.references(item.id).map(({kind, object}) => ({kind, object})),
    [{kind: 'project', object: folder.id}]);
  store.move(item.id, folder.id, 1);
  assert.throws(() => store.rename(item.id, 'changed.txt', 1), {status: 409});
  store.delete(item.id);
  assert.throws(() => store.file(item.id), {status: 404});
  store.restore(item.id);
  assert.equal(store.file(item.id).folder, folder.id);
  store.delete(item.id); store.purge(item.id);
  assert.equal(store.stats().used, 0);
  assert.equal(fs.existsSync(path.join(store.directory, 'blobs', item.id)), false);
});

test('storage rejects incomplete upload, unsupported content, and oversized files without remnants', async (t) => {
  const store = fixture(t);
  await assert.rejects(upload(store, Buffer.from('short'), 'short.txt', 9));
  await assert.rejects(upload(store, Buffer.from('<html>danger</html>'), 'page.html'), {status: 415});
  await assert.rejects(upload(store, Buffer.from('x'), 'huge.txt', MAX_FILE + 1), {status: 413});
  assert.deepEqual(fs.readdirSync(path.join(store.directory, 'tmp')), []);
  assert.equal(store.stats().used, 0);
});

test('storage blocks direct file routes without authentication', async () => {
  const result = await handle({request: {method: 'GET'}, path: '/file/00000000-0000-0000-0000-000000000001',
    authorized: () => false});
  assert.equal(result.status, 401);
});

test('articles link to authorized stored files without inserting unsafe HTML', () => {
  const id = '00000000-0000-0000-0000-000000000001';
  const html = renderArticle(`[Документ <script>](file:${id})`);
  assert.match(html, new RegExp('/modules/storage/file/' + id));
  assert.doesNotMatch(html, /<script>/);
});

test('storage validates the entire UTF-8 text and clears rejected partial uploads', async (t) => {
  const store = fixture(t);
  for (const suffix of [Buffer.from([0]), Buffer.from([255]), Buffer.from([0xd0])]) {
    await assert.rejects(upload(store, Buffer.concat([Buffer.alloc(600, 65), suffix])), {status: 415});
    assert.equal(store.stats().used, 0);
    assert.equal(store.reserved, 0);
    assert.deepEqual(fs.readdirSync(path.join(store.directory, 'tmp')), []);
  }
  const request = Readable.from([Buffer.from([0xd0]), Buffer.from([0x90])]);
  request.headers = {'content-length': '2'};
  const file = await store.upload(request, 'letter.txt', null);
  store.delete(file.id); store.restore(file.id);
  assert.throws(() => store.rename(file.id, 'stale.txt', 1), {status: 409});
});

test('storage disk-full failure releases quota and removes the incomplete blob', async (t) => {
  const store = fixture(t);
  store.load();
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function(file, ...args) {
    if (typeof file === 'number') throw Object.assign(new Error('disk full'), {code: 'ENOSPC'});
    return write.call(this, file, ...args);
  });
  await assert.rejects(upload(store, Buffer.from('text')), {status: 507});
  assert.equal(store.reserved, 0);
  assert.equal(store.stats().used, 0);
  assert.deepEqual(fs.readdirSync(path.join(store.directory, 'tmp')), []);
  assert.deepEqual(fs.readdirSync(path.join(store.directory, 'blobs')), []);
});

test('hub file inventory isolates failed sources and deletes only registered files with authorization', async () => {
  let removed = null;
  const modules = new Map([
    ['wave',{title:'Аполлон',uploads:()=>[{id:'track',name:'Song',href:'/modules/wave/'}],removeUpload:id=>{removed=id;}}],
    ['broken',{title:'Недоступен',uploads:()=>{throw Error('private path');}}]
  ]);
  const response = await handle({request:{method:'GET'},path:'/api/modules',modules});
  const result = await response.json();
  assert.equal(result.files[0].source,'wave');
  assert.deepEqual(result.errors,['Недоступен']);
  const remove = (id,authorized=()=>true) => {
    const request=Readable.from([Buffer.from(JSON.stringify({source:'wave',id}))]);
    request.method='POST'; request.headers={'content-type':'application/json'};
    return handle({request,path:'/api/modules/delete',modules,authorized});
  };
  assert.equal((await remove('track',()=>false)).status,401);
  assert.equal((await remove('../outside')).status,404);
  assert.equal(removed,null);
  assert.equal((await remove('track')).status,200);
  assert.equal(removed,'track');
});

test('storage folder deletion moves descendants to trash and restores files safely to root',async t=>{
 const s=fixture(t),parent=s.createFolder('Родитель'),child=s.createFolder('Вложенная',parent.id),other=s.createFolder('Другая');
 const a=await upload(s,Buffer.from('a')),b=await upload(s,Buffer.from('b')),c=await upload(s,Buffer.from('c'));
 s.move(a.id,parent.id,1);s.move(b.id,child.id,1);s.move(c.id,other.id,1);
 assert.equal(s.deleteFolder(parent.id).files,2);
 assert.deepEqual(s.list().files.map(f=>f.id),[c.id]);assert.equal(s.trash().length,2);
 assert.equal(s.list().folders.length,1);s.restore(b.id);assert.equal(s.file(b.id).folder,null);
});
test('storage upload cannot commit into a folder removed during upload',async t=>{
 const s=fixture(t),folder=s.createFolder('Удаляемая');
 const stream=Readable.from((async function*(){yield Buffer.from('a');s.deleteFolder(folder.id);yield Buffer.from('b');})());stream.headers={'content-length':'2'};
 await assert.rejects(s.upload(stream,'test.txt',folder.id),{status:404});assert.equal(s.stats().files,0);assert.equal(s.reserved,0);
});
test('module folder removal only deletes confirmed IDs, reports partial errors and rechecks auth',async()=>{
 const removed=[],module={uploads:()=>[{id:'a'},{id:'b'},{id:'new'}],removeUpload:async id=>{if(id==='b')throw Object.assign(Error('Используется'),{status:409});removed.push(id);}},modules=new Map([['wave',module]]);
 const call=(ids,authorized=()=>true)=>{const request=Readable.from([Buffer.from(JSON.stringify({source:'wave',ids}))]);request.method='POST';request.headers={'content-type':'application/json'};return handle({request,path:'/api/modules/delete-many',modules,authorized});};
 const result=await(await call(['a','b','missing','a'])).json();assert.deepEqual(removed,['a']);assert.equal(result.errors.length,1);assert.equal(result.errors[0].id,'b');assert.ok(!removed.includes('new'));
 assert.equal((await call(['new'],()=>false)).status,401);assert.equal((await call(Array(1001).fill('a'))).status,400);
});
