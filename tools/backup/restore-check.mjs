#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Writable} from 'node:stream';
import {spawn} from 'node:child_process';
import {createDecipheriv} from 'node:crypto';
import {pipeline} from 'node:stream/promises';

const header = Buffer.from('NEXUS404-BACKUP-1\n');
const usage =
  'Использование: node tools/backup/restore-check.mjs архив.nexus ключ [новый-тестовый-каталог]';

export async function check(archive, keyFile, destination) {
  const key = fs.readFileSync(keyFile);
  if (key.length !== 32) throw new Error('Ожидается 32-байтовый ключ');
  const fd = fs.openSync(archive, 'r');
  let nonce, tag, size;
  try {
    size = fs.fstatSync(fd).size;
    if (size < header.length + 12 + 16) throw new Error('Архив слишком короткий');
    const prefix = Buffer.alloc(header.length + 12);
    fs.readSync(fd, prefix, 0, prefix.length, 0);
    if (!prefix.subarray(0, header.length).equals(header))
      throw new Error('Неизвестный формат архива');
    nonce = prefix.subarray(header.length);
    tag = Buffer.alloc(16);
    fs.readSync(fd, tag, 0, 16, size - 16);
  } finally {
    fs.closeSync(fd);
  }

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const source = fs.createReadStream(archive, {start: header.length + 12, end: size - 17});
  if (!destination) {
    await pipeline(
      source,
      decipher,
      new Writable({
        write(_chunk, _encoding, done) {
          done();
        }
      })
    );
    return console.log('Архив и ключ прошли проверку подлинности');
  }
  const target = path.resolve(destination);
  if (target === '/' || !path.isAbsolute(destination)) {
    source.destroy();
    throw new Error('Нужен абсолютный путь нового тестового каталога');
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus404-authenticated-'));
  const plaintext = path.join(staging, 'backup.tar');
  let created = false,
    success = false,
    tar;
  try {
    // Распаковываем только приватную копию, для которой уже проверен GCM-тег.
    await pipeline(source, decipher, fs.createWriteStream(plaintext, {flags: 'wx', mode: 0o600}));
    fs.mkdirSync(target, {mode: 0o700});
    created = true;
    tar = spawn(
      'tar',
      ['-x', '--no-same-owner', '--no-same-permissions', '-C', target, '-f', plaintext],
      {stdio: ['ignore', 'ignore', 'pipe']}
    );
    let errors = '';
    tar.stderr.on('data', (chunk) => {
      errors = (errors + chunk.toString()).slice(-4096);
    });
    await new Promise((resolve, reject) => {
      tar.on('error', reject);
      tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error('tar: ' + errors))));
    });
    success = true;
    console.log(`Архив распакован в тестовый каталог: ${target}`);
  } finally {
    if (created && !success) fs.rmSync(target, {recursive: true, force: true});
    fs.rmSync(staging, {recursive: true, force: true});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length < 4 || process.argv.length > 5) {
    console.error(usage);
    process.exitCode = 2;
  } else
    check(...process.argv.slice(2)).catch((e) => {
      console.error('Проверка не удалась:', e.message);
      process.exitCode = 1;
    });
}
