import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const root = path.dirname(fileURLToPath(import.meta.url));
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const key = process.env.NEXUS_ANDROID_KEYSTORE,
  password = process.env.NEXUS_ANDROID_PASSWORD_FILE;
if (!sdk || !key || !password)
  throw Error(
    'Нужны ANDROID_HOME, NEXUS_ANDROID_KEYSTORE и NEXUS_ANDROID_PASSWORD_FILE. См. android/README.md'
  );
const tools = path.join(sdk, 'build-tools', '35.0.0'),
  platform = path.join(sdk, 'platforms', 'android-36', 'android.jar');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-build-'));
function run(command, args, cwd = temp) {
  const result = spawnSync(command, args, {cwd, stdio: 'inherit'});
  if (result.status !== 0) throw Error('Ошибка сборки: ' + path.basename(command));
}
try {
  const classes = path.join(temp, 'classes'),
    dex = path.join(temp, 'dex'),
    generated = path.join(temp, 'generated');
  for (const d of [classes, dex, generated]) fs.mkdirSync(d);
  const unsigned = path.join(temp, 'unsigned.apk'),
    aligned = path.join(temp, 'aligned.apk');
  const resources = path.join(temp, 'resources.zip');
  run(path.join(tools, 'aapt2'), ['compile', '--dir', path.join(root, 'res'), '-o', resources]);
  run(path.join(tools, 'aapt2'), [
    'link',
    '--manifest',
    path.join(root, 'AndroidManifest.xml'),
    resources,
    '-I',
    platform,
    '--java',
    generated,
    '-o',
    unsigned
  ]);
  const sources = fs
    .readdirSync(path.join(root, 'src/xyz/nexus404/hecate'))
    .filter((n) => n.endsWith('.java'))
    .map((n) => path.join(root, 'src/xyz/nexus404/hecate', n));
  sources.push(
    ...fs
      .readdirSync(generated, {recursive: true})
      .filter((n) => n.endsWith('.java'))
      .map((n) => path.join(generated, n))
  );
  const boot = platform + path.delimiter + path.join(tools, 'core-lambda-stubs.jar');
  if (process.env.ECJ_JAR)
    run('java', [
      '-jar',
      process.env.ECJ_JAR,
      '-1.8',
      '-proc:none',
      '-bootclasspath',
      boot,
      '-d',
      classes,
      ...sources
    ]);
  else
    run('javac', [
      '-source',
      '8',
      '-target',
      '8',
      '-bootclasspath',
      boot,
      '-d',
      classes,
      ...sources
    ]);
  const bytecode = fs
    .readdirSync(classes, {recursive: true})
    .filter((n) => n.endsWith('.class'))
    .map((n) => path.join(classes, n));
  run('java', [
    '-Xmx2g',
    '-cp',
    path.join(tools, 'lib/d8.jar'),
    'com.android.tools.r8.R8',
    '--release',
    '--lib',
    platform,
    '--min-api',
    '26',
    '--output',
    dex,
    '--pg-conf',
    path.join(root, 'shrink.pro'),
    ...bytecode
  ]);
  for (const file of fs.readdirSync(dex, {recursive: true}).filter((n) => n.endsWith('.dex')))
    run(path.join(tools, 'aapt'), ['add', unsigned, file], dex);
  run(path.join(tools, 'zipalign'), ['-f', '4', unsigned, aligned]);
  const output = path.resolve(
    process.env.NEXUS_ANDROID_OUTPUT || path.join(root, '../02-hub/modules/balance/companion.apk')
  );
  run(path.join(tools, 'apksigner'), [
    'sign',
    '--v4-signing-enabled',
    'false',
    '--ks',
    key,
    '--ks-key-alias',
    'hecate',
    '--ks-pass',
    'file:' + password,
    '--out',
    output,
    aligned
  ]);
  run(path.join(tools, 'apksigner'), ['verify', '--verbose', output]);
  console.log(output + ' · ' + fs.statSync(output).size + ' байт');
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
