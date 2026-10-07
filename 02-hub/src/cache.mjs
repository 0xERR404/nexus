import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';

// Only successful, non-secret responses belong here.
export class FileCache {
  constructor(
    directory,
    {
      ttl = 86400000,
      retention = 30 * 86400000,
      maxBytes = 32 * 1024 * 1024,
      maxEntries = 512,
      now = Date.now
    } = {}
  ) {
    Object.assign(this, {directory, ttl, retention, maxBytes, maxEntries, now});
  }
  file(key) {
    return path.join(
      this.directory,
      createHash('sha256').update(String(key)).digest('hex') + '.json'
    );
  }
  get(key) {
    const file = this.file(key);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > this.maxBytes) return null;
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      const age = this.now() - record.time;
      if (!Number.isFinite(age) || age < 0 || age > this.retention) {
        fs.unlinkSync(file);
        return null;
      }
      if (typeof record.type !== 'string' || typeof record.data !== 'string') return null;
      return {
        type: record.type,
        data: Buffer.from(record.data, 'base64'),
        time: record.time,
        stale: age >= this.ttl
      };
    } catch {
      return null;
    }
  }
  put(key, value) {
    if (!Buffer.isBuffer(value.data) || !value.data.length || typeof value.type !== 'string')
      return;
    const data = JSON.stringify({
      time: this.now(),
      type: value.type,
      data: value.data.toString('base64')
    });
    if (Buffer.byteLength(data) > this.maxBytes) return;
    let temp;
    try {
      fs.mkdirSync(this.directory, {recursive: true, mode: 0o700});
      const file = this.file(key);
      temp = file + '.' + randomUUID();
      fs.writeFileSync(temp, data, {mode: 0o600, flag: 'wx'});
      fs.renameSync(temp, file);
      temp = null;
      fs.utimesSync(file, new Date(this.now()), new Date(this.now()));
      this.prune();
    } catch {
    } finally {
      if (temp) fs.rmSync(temp, {force: true});
    }
  }
  prune() {
    try {
      const files = fs
        .readdirSync(this.directory)
        .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
        .map((n) => {
          const file = path.join(this.directory, n),
            stat = fs.lstatSync(file);
          return {file, size: stat.size, time: stat.mtimeMs, regular: stat.isFile()};
        })
        .filter((f) => f.regular)
        .sort((a, b) => b.time - a.time);
      let size = 0,
        count = 0;
      for (const file of files) {
        if (
          this.now() - file.time > this.retention ||
          count >= this.maxEntries ||
          size + file.size > this.maxBytes
        )
          fs.unlinkSync(file.file);
        else {
          size += file.size;
          count++;
        }
      }
    } catch {}
  }
}
