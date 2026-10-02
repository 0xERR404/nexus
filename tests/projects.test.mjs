import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {spawnSync, spawn} from 'node:child_process';
import http from 'node:http';
import vm from 'node:vm';
import {Projects} from '../02-hub/modules/projects/store.mjs';
import {validateZip} from '../02-hub/modules/projects/zip.mjs';

const fixture = (t, filename = 'install.sh', script = 'printf installed > "$NEXUS_TEST_MARKER"\n') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-projects-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'source'));
  fs.mkdirSync(path.dirname(path.join(root, 'source', filename)), {recursive:true});
  fs.writeFileSync(path.join(root, 'source', filename), script);
  const zip = path.join(root, 'release.zip');
  const result = spawnSync('zip', ['-q', zip, filename], {cwd: path.join(root, 'source')});
  assert.equal(result.status, 0);
  return {root, zip, store: new Projects(path.join(root, 'data'))};
};
const upload = (store, zip, project, version) => {
  const request = Readable.from([fs.readFileSync(zip)]);
  request.headers = {'content-length': String(fs.statSync(zip).size)};
  return store.upload(request, project.id, version, '');
};

test('projects accept a checked release, rotate links, and reject the revoked token', async (t) => {
  const f = fixture(t), project = f.store.create('Тест', 'Описание');
  const release = await upload(f.store, f.zip, project, '1.0.0');
  assert.equal(release.entrypoint, '');
  assert.match(release.sha256, /^[a-f0-9]{64}$/);
  f.store.select(project.id, release.id);
  const first = f.store.access(project.id, true).token;
  assert.equal(f.store.resolve(first).release.version, '1.0.0');
  f.store.access(project.id, false);
  assert.throws(() => f.store.resolve(first), {status: 404});
  const second = f.store.access(project.id, true).token;
  assert.notEqual(first, second);
  assert.throws(() => f.store.resolve(first), {status: 404});
  assert.equal(f.store.resolve(second).release.sha256, release.sha256);
});

test('projects reject path traversal and forged expanded size', async (t) => {
  const f = fixture(t), bytes = fs.readFileSync(f.zip);
  const badPath = Buffer.from(bytes);
  const name = Buffer.from('install.sh'), replacement = Buffer.from('../bad.txt');
  let offset = badPath.indexOf(name);
  while (offset !== -1) { replacement.copy(badPath, offset); offset = badPath.indexOf(name, offset + name.length); }
  const pathFile = path.join(f.root, 'path.zip'); fs.writeFileSync(pathFile, badPath);
  await assert.rejects(validateZip(pathFile), {status: 422});
  const huge = Buffer.from(bytes), central = huge.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  huge.writeUInt32LE(600 * 1024 * 1024, central + 24);
  const hugeFile = path.join(f.root, 'huge.zip'); fs.writeFileSync(hugeFile, huge);
  await assert.rejects(validateZip(hugeFile), {status: 422});
});

test('curl installs a test project locally, while an old link stops serving bytes', async (t) => {
  const filename = "repo's folder/start anything";
  const f = fixture(t, filename, 'read -r answer\nprintf %s "$answer" > "$NEXUS_TEST_MARKER"\n');
  process.env.DATA_DIR = f.root;
  const {projects, publicHandle} = await import('../02-hub/modules/projects/index.mjs');
  const project = projects.create('Installer');
  const release = await upload(projects, f.zip, project, '1.0.0');
  projects.select(project.id, release.id);
  const token = projects.access(project.id, true).token;
  assert.equal(publicHandle({token, action:'script', method:'GET', origin:'http://localhost'}).status, 404);
  assert.equal(publicHandle({token, action:'archive', method:'HEAD', origin:'http://localhost'}).status, 200);
  await projects.launch(project.id, release.id, filename, 'sh');
  const server = http.createServer(async (req, res) => {
    const match = /^\/install\/([^/]+)\/(script|archive)$/.exec(req.url);
    const response = match
      ? publicHandle({token: match[1], action: match[2], method: req.method,
          origin: `http://127.0.0.1:${server.address().port}`})
      : new Response('Not found', {status: 404});
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const marker = path.join(f.root, 'installed');
  const source = fs.readFileSync(new URL('../02-hub/modules/projects/projects.js', import.meta.url), 'utf8');
  const expression = source.match(/release\.entrypoint\s*\?\s*(`[^`]+`)\s*:\s*`curl/)[1];
  const command = vm.runInNewContext(expression, {link:`http://127.0.0.1:${server.address().port}/install/${token}/script`});
  assert.match(command, /&& sudo sh \.\/nexus404-install\.sh$/);
  const child = spawn('sh', ['-c', command.replace('sudo sh', 'sh')],
    {cwd: f.root, env: {...process.env, NEXUS_TEST_MARKER: marker}, stdio: ['pipe', 'pipe', 'pipe']});
  child.stdin.end('installed\n');
  let error = '';
  child.stderr.on('data', (chunk) => { error += chunk.toString(); });
  const code = await new Promise((resolve) => child.once('exit', resolve));
  assert.equal(code, 0, error);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'installed');
  projects.access(project.id, false);
  const revoked = await fetch(`http://127.0.0.1:${server.address().port}/install/${token}/archive`);
  assert.equal(revoked.status, 404);
});

 test('arbitrary archive content is accepted and launch selection stays inside the archive', async t => {
  const f = fixture(t, 'docs/readme.txt'), project = f.store.create('Archive');
  const release = await upload(f.store, f.zip, project, '2');
  assert.equal(release.entrypoint, '');
  assert.deepEqual(await f.store.files(project.id, release.id), ['docs/readme.txt']);
  await assert.rejects(f.store.launch(project.id, release.id, '../outside', 'sh'));
  await assert.rejects(f.store.launch(project.id, release.id, 'docs/readme.txt', 'sh;id'));
  await f.store.launch(project.id, release.id, 'docs/readme.txt', 'node');
  assert.equal(f.store.detail(project.id).releases[0].runner, 'node');
  await f.store.launch(project.id, release.id, '', 'sh');
  assert.equal(f.store.detail(project.id).releases[0].entrypoint, '');
});

test('existing releases retain their previous installer after migration', async t => {
  const f = fixture(t), project = f.store.create('Legacy');
  await upload(f.store, f.zip, project, '1');
  f.store.db.exec('ALTER TABLE releases DROP COLUMN entrypoint; ALTER TABLE releases DROP COLUMN runner');
  f.store.db.close();
  const restored = new Projects(path.join(f.root, 'data'));
  const release = restored.detail(project.id).releases[0];
  assert.equal(release.entrypoint, 'install.sh');
  assert.equal(release.runner, 'sh');
  restored.db.close();
});

test('editing preserves releases and access; deletion removes archives, journal and token', async t => {
  const f = fixture(t), project = f.store.create('Before', 'Old description');
  const release = await upload(f.store, f.zip, project, '1');
  f.store.select(project.id, release.id);
  const {token} = f.store.access(project.id, true);
  f.store.log(project.id, '1', 'streamed');
  f.store.edit(project.id, 'After', '');
  assert.equal(f.store.detail(project.id).project.name, 'After');
  assert.equal(f.store.detail(project.id).project.description, '');
  assert.equal(f.store.resolve(token).release.id, release.id);
  assert.throws(() => f.store.edit(project.id, '', 'invalid'));
  assert.deepEqual(f.store.remove(project.id), {deleted:true, cleanupPending:false});
  assert.equal(fs.existsSync(f.store.releasePath(release.id)), false);
  assert.throws(() => f.store.resolve(token), {status:404});
  assert.throws(() => f.store.detail(project.id), {status:404});
  f.store.log(project.id, '1', 'streamed');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM deliveries').get().n, 0);
  assert.deepEqual(f.store.list(), []);
});

test('deleting a project during upload prevents an orphan release', async t => {
  const f = fixture(t), project = f.store.create('Delete during upload');
  const bytes = fs.readFileSync(f.zip);
  const request = Readable.from((async function* () {
    yield bytes.subarray(0, 10);
    f.store.remove(project.id);
    yield bytes.subarray(10);
  })());
  request.headers = {'content-length':String(bytes.length)};
  await assert.rejects(f.store.upload(request, project.id, '1', ''), {status:404});
  assert.deepEqual(fs.readdirSync(path.join(f.store.directory, 'releases')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.store.directory, 'tmp')), []);
  assert.equal(f.store.reserved, 0);
});

test('deleting a selected release revokes installation without deleting its project', async t => {
  const f=fixture(t),project=f.store.create('Keep project');
  const release=await upload(f.store,f.zip,project,'1');
  f.store.select(project.id,release.id);
  const {token}=f.store.access(project.id,true);
  f.store.removeRelease(release.id);
  assert.throws(()=>f.store.resolve(token),{status:404});
  assert.equal(f.store.detail(project.id).releases.length,0);
  assert.equal(f.store.project(project.id).selected,null);
  assert.equal(fs.existsSync(f.store.releasePath(release.id)),false);
});
