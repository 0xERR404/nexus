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
