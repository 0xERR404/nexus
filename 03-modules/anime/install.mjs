import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
execFileSync(
  process.execPath,
  [fileURLToPath(new URL('../../menu.mjs', import.meta.url)), '--module', 'anime'],
  {stdio: 'inherit'}
);
