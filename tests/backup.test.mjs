import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCipheriv, randomBytes} from 'node:crypto';
import {check} from '../tools/backup/restore-check.mjs';
import {prune} from '../tools/backup/backup-schedule.mjs';

test('encrypted archive authenticates and extracts data only with the correct key', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-backup-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(root + '/source/opt/nexus404/hub-platform/data', {recursive: true});
  fs.writeFileSync(root + '/source/opt/nexus404/hub-platform/data/ledger.sqlite', 'sample private data');
  const tar = spawnSync('tar', ['-C', root + '/source', '-cf', '-', 'opt'], {maxBuffer: 1024 * 1024});
  assert.equal(tar.status, 0);
  const key = randomBytes(32), nonce = randomBytes(12);
  fs.writeFileSync(root + '/key', key);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const archive = root + '/backup.nexus';
  fs.writeFileSync(archive, Buffer.concat([
    Buffer.from('NEXUS404-BACKUP-1\n'), nonce, cipher.update(tar.stdout), cipher.final(), cipher.getAuthTag()
  ]));
  await check(archive, root + '/key', root + '/restored');
  assert.equal(fs.readFileSync(root + '/restored/opt/nexus404/hub-platform/data/ledger.sqlite', 'utf8'), 'sample private data');
  const broken = fs.readFileSync(archive);
  broken[40] ^= 1;
  fs.writeFileSync(archive, broken);
  await assert.rejects(check(archive, root + '/key', root + '/failed'));
  assert.equal(fs.existsSync(root + '/failed'), false);
});

test('retention keeps two newest backups and leaves unrelated files alone', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-retention-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const names = ['20260901T000000Z', '20260902T000000Z', '20260903T000000Z'];
  for (const name of names) {
    const file = path.join(dir, `nexus404-${name}.nexus`);
    fs.writeFileSync(file, 'archive');
    fs.utimesSync(file, new Date('2026-09-01'), new Date('2026-09-01'));
  }
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'keep');
  prune(dir, 14, Date.parse('2026-09-29'));
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    'nexus404-20260902T000000Z.nexus',
    'nexus404-20260903T000000Z.nexus',
    'unrelated.txt'
  ]);
});

test('backup destinations reject system roots and aliases before changing permissions', async (t) => {
  const {backupDirectory} = await import('../tools/backup/backup-schedule.mjs');
  for (const dir of ['/', '/etc', '/var/lib', '/opt/nexus404', '/opt/nexus404/hub-platform/data', '/var/lib/nexus404-signal'])
    assert.throws(() => backupDirectory(dir));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-paths-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.symlinkSync('/etc', root + '/alias');
  assert.throws(() => backupDirectory(root + '/alias'));
  assert.equal(backupDirectory(root + '/backups'), root + '/backups');
});

test('restored encrypted hub accepts original login and preserves module data, source key and uploaded bytes', async t => {
  const {createApp} = await import('../02-hub/src/server.mjs');
  const {passwordHash} = await import('../02-hub/src/auth.mjs');
  const {createModule} = await import('../02-hub/modules/rhythm/index.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-restore-live-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const original = path.join(root, 'source/opt/nexus404/hub-platform');
  fs.mkdirSync(original + '/config', {recursive: true});
  const config = {username: 'admin', origin: 'https://restore.test', ...await passwordHash('restore-fixture-password')};
  fs.writeFileSync(original + '/config/auth.json', JSON.stringify(config));
  const source = createModule(original + '/data/rhythm');
  const device = source.store.addDevice('restore fixture');
  source.store.configure({zone:'UTC', auto:false});
  const start = Date.parse('2026-10-01T12:00:00Z');
  source.store.ingest(device, {records:[{id:'restore-record', source:'test-band', type:'steps', start, end:start+60000, modified:start+60000, value:321}], deleted:[], complete:true});
  source.store.db.close();
  fs.mkdirSync(original + '/data/storage/files', {recursive:true});
  const payload = randomBytes(4096);
  fs.writeFileSync(original + '/data/storage/files/fixture.bin', payload);
  const key = randomBytes(32), nonce = randomBytes(12);
  fs.writeFileSync(root + '/key', key, {mode:0o600});
  const tar = spawnSync('tar', ['-C', root + '/source', '-cf', '-', 'opt'], {maxBuffer:16*1024*1024});
  assert.equal(tar.status, 0);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  fs.writeFileSync(root + '/backup.nexus', Buffer.concat([Buffer.from('NEXUS404-BACKUP-1\n'), nonce, cipher.update(tar.stdout), cipher.final(), cipher.getAuthTag()]));
  await check(root + '/backup.nexus', root + '/key', root + '/restored');
  fs.rmSync(root + '/source', {recursive:true}); // The app cannot read the original installation.
  const restored = root + '/restored/opt/nexus404/hub-platform';
  assert.deepEqual(fs.readFileSync(restored + '/data/storage/files/fixture.bin'), payload);
  const module = createModule(restored + '/data/rhythm');
  const app = createApp({config:JSON.parse(fs.readFileSync(restored + '/config/auth.json')), dataDirectory:restored + '/data', modules:new Map([['rhythm', {id:'rhythm', title:'Асклепий', ...module}]])});
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.closeAllConnections(); await new Promise(resolve => app.close(resolve)); module.store.db.close(); });
  const base = 'http://127.0.0.1:' + app.address().port;
  assert.equal((await fetch(base + '/modules/rhythm/api?day=2026-10-01', {redirect:'manual'})).status, 303);
  const login = await fetch(base + '/api/auth/login', {method:'POST', redirect:'manual', headers:{Origin:config.origin, 'Content-Type':'application/x-www-form-urlencoded'}, body:'username=admin&password=restore-fixture-password'});
  assert.ok(login.headers.get('set-cookie'));
  const data = await fetch(base + '/modules/rhythm/api?day=2026-10-01', {headers:{Cookie:login.headers.get('set-cookie').split(';')[0]}});
  assert.equal(data.status, 200);
  assert.equal((await data.json()).day.steps, 321);
  assert.equal(module.store.authenticate(device.token).id, device.id);
});
