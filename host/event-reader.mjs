import fs from 'node:fs';
export function readEvents(file, state, limit = 256 * 1024, maxAge = 3600000) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const s = fs.fstatSync(fd);
    let offset = state.inode === s.ino && state.offset <= s.size ? state.offset : 0;
    if (!Number.isFinite(offset)) offset = Math.max(0, s.size - limit);
    const start = offset;
    const buffer = Buffer.alloc(Math.min(limit, s.size - offset));
    const n = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const content = buffer.subarray(0, n),
      end = content.lastIndexOf(10);
    state.inode = s.ino;
    if (end < 0) {
      state.offset = n === limit ? offset + n : offset;
      return [];
    }
    state.offset = start + end + 1;
    return content
      .subarray(0, end)
      .toString('utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const e = JSON.parse(line);
          return typeof e.type === 'string' && Number.isFinite(Date.parse(e.time)) && Date.now() - Date.parse(e.time) < maxAge ? [e] : [];
        } catch {
          return [];
        }
      });
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
