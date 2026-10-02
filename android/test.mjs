import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const framework = process.env.ANDROID_TEST_JAR;
if (!framework || !fs.existsSync(framework)) {
  throw Error(
    'Укажи ANDROID_TEST_JAR: полный Android framework JAR для JVM-тестов (не SDK android.jar). См. android/README.md'
  );
}
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hecate-tests-'));
function run(command, args) {
  const result = spawnSync(command, args, {stdio: 'inherit'});
  if (result.status !== 0) throw Error('Не прошли тесты: ' + path.basename(command));
}
try {
  const sources = fs
    .readdirSync(path.join(root, 'src/xyz/nexus404/hecate'))
    .filter((name) => name.endsWith('.java'))
    .map((name) => path.join(root, 'src/xyz/nexus404/hecate', name));
  const tests = fs
    .readdirSync(path.join(root, 'tests'))
    .filter((name) => name.endsWith('Test.java'))
    .sort();
  const options = [
    '-proc:none',
    '-cp',
    framework,
    '-d',
    temp,
    ...sources,
    ...tests.map((name) => path.join(root, 'tests', name))
  ];
  if (process.env.ECJ_JAR) run('java', ['-jar', process.env.ECJ_JAR, '-1.8', ...options]);
  else run('javac', ['-source', '8', '-target', '8', ...options]);
  for (const test of tests)
    run('java', [
      '-cp',
      temp + path.delimiter + framework,
      'xyz.nexus404.hecate.' + test.slice(0, -5)
    ]);
  console.log(
    `${tests.length} JVM-наборов пройдено. Bluetooth и Android lifecycle требуют проверки на телефоне.`
  );
} finally {
  fs.rmSync(temp, {recursive: true, force: true});
}
