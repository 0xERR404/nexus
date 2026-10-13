import fs from 'node:fs';
import {createInflateRaw} from 'node:zlib';

const fail = (message) => Object.assign(new Error(message), {status: 422});
const table = Uint32Array.from({length: 256}, (_, i) => {
  let n = i;
  for (let j = 0; j < 8; j++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1;
  return n >>> 0;
});
const crc = (value, bytes) => {
  for (const b of bytes) value = table[(value ^ b) & 255] ^ (value >>> 8);
  return value >>> 0;
};
const maxEntries = 2000,
  maxExpanded = 512 * 1024 * 1024,
  maxEntry = 128 * 1024 * 1024;

export async function validateZip(file) {
  const fd = fs.openSync(file, 'r');
  let entries, cdOffset, cdSize, size;
  const read = (length, offset) => {
    const buffer = Buffer.alloc(length);
    if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw fail('Обрезанный ZIP');
    return buffer;
  };
  try {
    size = fs.fstatSync(fd).size;
    if (size < 22 || size > 128 * 1024 * 1024) throw fail('ZIP — не более 128 МБ');
    const tail = read(Math.min(size, 65557), size - Math.min(size, 65557));
    let end = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (
        tail.readUInt32LE(i) === 0x06054b50 &&
        i + 22 + tail.readUInt16LE(i + 20) === tail.length
      ) {
        end = i;
        break;
      }
    if (end < 0) throw fail('ZIP не завершён');
    const e = tail.subarray(end);
    entries = e.readUInt16LE(10);
    cdSize = e.readUInt32LE(12);
    cdOffset = e.readUInt32LE(16);
    if (
      e.readUInt16LE(4) ||
      e.readUInt16LE(6) ||
      entries !== e.readUInt16LE(8) ||
      !entries ||
      entries > maxEntries ||
      cdOffset + cdSize > size - (tail.length - end)
    )
      throw fail('Неподдерживаемый формат ZIP');
    const directory = read(cdSize, cdOffset);
    const names = new Set(),
      ranges = [];
    let position = 0,
      expanded = 0;
    for (let i = 0; i < entries; i++) {
      if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50)
        throw fail('Повреждён каталог ZIP');
      const flags = directory.readUInt16LE(position + 8),
        method = directory.readUInt16LE(position + 10),
        checksum = directory.readUInt32LE(position + 16),
        compressed = directory.readUInt32LE(position + 20),
        unpacked = directory.readUInt32LE(position + 24),
        nameSize = directory.readUInt16LE(position + 28),
        extra = directory.readUInt16LE(position + 30),
        comment = directory.readUInt16LE(position + 32),
        offset = directory.readUInt32LE(position + 42);
      if (
        flags & 1 ||
        flags & ~0x808 ||
        ![0, 8].includes(method) ||
        compressed === 0xffffffff ||
        unpacked === 0xffffffff ||
        offset === 0xffffffff ||
        unpacked > maxEntry ||
        (expanded += unpacked) > maxExpanded
      )
        throw fail('Недопустимый ZIP или слишком большой объём после распаковки');
      if (position + 46 + nameSize + extra + comment > directory.length)
        throw fail('Обрезано имя файла');
      let name;
      try {
        name = new TextDecoder('utf-8', {fatal: true}).decode(
          directory.subarray(position + 46, position + 46 + nameSize)
        );
      } catch {
        throw fail('Имя файла не UTF-8');
      }
      if (
        !name ||
        name.length > 512 ||
        name.startsWith('/') ||
        name.includes('\\') ||
        /[\x00-\x1f]/.test(name) ||
        name
          .split('/')
          .some(
            (part, index, parts) =>
              part === '.' || part === '..' || (!part && index !== parts.length - 1)
          ) ||
        /^[A-Za-z]:/.test(name) ||
        names.has(name)
      )
        throw fail('Опасный или повторяющийся путь в ZIP');
      names.add(name);
      const mode = directory.readUInt32LE(position + 38) >>> 16;
      if (
        (mode & 0xf000) === 0xa000 ||
        (mode & 0xf000 && ![0x4000, 0x8000].includes(mode & 0xf000))
      )
        throw fail('Ссылки и специальные файлы в ZIP запрещены');
      const local = read(30, offset);
      if (
        local.readUInt32LE(0) !== 0x04034b50 ||
        local.readUInt16LE(6) !== flags ||
        local.readUInt16LE(8) !== method
      )
        throw fail('Повреждён заголовок файла');
      const localName = read(local.readUInt16LE(26), offset + 30);
      if (!localName.equals(directory.subarray(position + 46, position + 46 + nameSize)))
        throw fail('Имена в ZIP не совпадают');
      const start = offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28),
        stop = start + compressed;
      if (
        stop > cdOffset ||
        (method === 0 && compressed !== unpacked) ||
        (name.endsWith('/') && unpacked !== 0)
      )
        throw fail('Повреждены данные ZIP');
      ranges.push({
        start: offset,
        stop,
        data: start,
        compressed,
        unpacked,
        checksum,
        method,
        name,
        directory: name.endsWith('/') || (mode & 0xf000) === 0x4000
      });
      position += 46 + nameSize + extra + comment;
    }
    if (position !== cdSize) throw fail('Лишние записи ZIP');
    ranges.sort((a, b) => a.start - b.start);
    for (let i = 1; i < ranges.length; i++)
      if (ranges[i].start < ranges[i - 1].stop) throw fail('Пересекающиеся файлы ZIP');
    for (const entry of ranges) {
      let total = 0,
        check = 0xffffffff;
      if (entry.compressed) {
        const source = fs.createReadStream(file, {start: entry.data, end: entry.stop - 1});
        const stream = entry.method === 8 ? source.pipe(createInflateRaw()) : source;
        if (stream !== source) source.on('error', (error) => stream.destroy(error));
        try {
          for await (const chunk of stream) {
            total += chunk.length;
            if (total > entry.unpacked || total > maxEntry)
              throw fail('ZIP распаковывается сверх лимита');
            check = crc(check, chunk);
          }
        } catch {
          source.destroy();
          stream.destroy();
          throw fail('Повреждены данные ZIP');
        }
      }
      if (total !== entry.unpacked || (check ^ 0xffffffff) >>> 0 !== entry.checksum)
        throw fail('Контрольная сумма файла ZIP не совпала');
    }
    return {
      entries,
      expanded,
      files: ranges.filter((entry) => !entry.directory).map((entry) => entry.name)
    };
  } finally {
    fs.closeSync(fd);
  }
}
