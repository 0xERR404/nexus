import fs from 'node:fs';
import {createHash} from 'node:crypto';

export function companion() {
  try {
    const value = JSON.parse(
      fs.readFileSync(new URL('../modules/balance/companion.json', import.meta.url), 'utf8')
    );
    if (
      !/^\d+\.\d+\.\d+$/.test(value.version) ||
      !Number.isSafeInteger(value.code) || value.code <= 0 ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    ) return null;
    const digest = createHash('sha256')
      .update(fs.readFileSync(new URL('../modules/balance/companion.apk', import.meta.url)))
      .digest('hex');
    if (digest !== value.sha256) return null;
    return {version: value.version, code: value.code, sha256: value.sha256};
  } catch {
    return null;
  }
}
