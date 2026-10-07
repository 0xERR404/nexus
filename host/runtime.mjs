import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {query, NODE} from './common.mjs';
export function runtimeRelease(text, arch = process.arch) {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Поддерживаются Linux x64 и arm64');
  const pattern = new RegExp(
    '^([a-f0-9]{64})  (node-(v24\\.\\d+\\.\\d+)-linux-' + arch + '\\.tar\\.xz)$',
    'm'
  );
  const found = pattern.exec(text);
  if (!found) throw new Error('Не найден проверяемый релиз Node.js 24');
  return {hash: found[1], file: found[2], version: found[3]};
}
export async function updateRuntime(ui) {
  const response = await fetch('https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt', {
    signal: AbortSignal.timeout(15000),
    redirect: 'error'
  });
  if (!response.ok) throw new Error('Не удалось проверить обновление Node.js');
  const release = runtimeRelease(await response.text());
  if (query(NODE, ['--version']).text === release.version) return;
  const dir = '/opt/nexus404/runtime';
  fs.mkdirSync(dir, {recursive: true, mode: 0o755});
  fs.chmodSync('/opt/nexus404', 0o755);
  fs.chmodSync(dir, 0o755);
  const temp = fs.mkdtempSync(dir + '/.download.');
  try {
    const archive = path.join(temp, release.file);
    await ui.run('Node.js ' + release.version, 'curl', [
      '-fsSL',
      '--retry',
      '3',
      '--max-filesize',
      '200000000',
      `https://nodejs.org/dist/${release.version}/${release.file}`,
      '-o',
      archive
    ]);
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(archive)) hash.update(chunk);
    if (hash.digest('hex') !== release.hash)
      throw new Error('Контрольная сумма Node.js не совпадает');
    await ui.run('Распаковка Node.js', 'tar', ['-xJf', archive, '-C', temp]);
    const name = release.file.replace(/\.tar\.xz$/, ''),
      target = dir + '/' + name;
    const check = query(temp + '/' + name + '/bin/node', ['--version']);
    if (!check.ok || check.text !== release.version) throw new Error('Node.js не запускается');
    if (!fs.existsSync(target)) fs.renameSync(temp + '/' + name, target);
    fs.chmodSync(target, 0o755);
    const link = NODE + '.new';
    fs.rmSync(link, {force: true});
    fs.symlinkSync(target + '/bin/node', link);
    fs.renameSync(link, NODE);
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}
