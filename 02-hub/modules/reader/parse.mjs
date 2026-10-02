import path from 'node:path';
import {inflateRawSync, crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {parentPort, workerData} from 'node:worker_threads';
const MB = 1024 * 1024;
const fail = (message) => {
  throw Error(message);
};
const decode = (bytes) => {
  if (bytes[0] === 255 && bytes[1] === 254)
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 254 && bytes[1] === 255)
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
};
export function entities(text) {
  return text.replace(
    /&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|laquo|raquo|shy|lsquo|rsquo|ldquo|rdquo|bull|copy|reg|euro);/gi,
    (all, code) => {
      if (code.startsWith('#')) {
        const n =
          code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
        return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)
          ? String.fromCodePoint(n)
          : '�';
      }
      return (
        {
          amp: '&',
          lt: '<',
          gt: '>',
          quot: '"',
          apos: "'",
          nbsp: ' ',
          mdash: '—',
          ndash: '–',
          hellip: '…',
          laquo: '«',
          raquo: '»',
          shy: '\u00ad',
          lsquo: '‘',
          rsquo: '’',
          ldquo: '“',
          rdquo: '”',
          bull: '•',
          copy: '©',
          reg: '®',
          euro: '€'
        }[code.toLowerCase()] || all
      );
    }
  );
}
const plain = (text) =>
  entities(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
const attrs = (text) =>
  Object.fromEntries(
    [...text.matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)].map((m) => [
      m[1].toLowerCase(),
      entities(m[3])
    ])
  );
export function archive(bytes) {
  if (bytes.length > 64 * MB || bytes.length < 22) fail('EPUB: неверный размер архива.');
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (
      bytes.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + bytes.readUInt16LE(i + 20) === bytes.length
    ) {
      end = i;
      break;
    }
  if (end < 0) fail('EPUB: не найден каталог архива.');
  const count = bytes.readUInt16LE(end + 10),
    size = bytes.readUInt32LE(end + 12),
    offset = bytes.readUInt32LE(end + 16);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    bytes.readUInt16LE(end + 8) !== count ||
    count > 10000 ||
    offset + size > end
  )
    fail('EPUB: многотомные и ZIP64 архивы не поддерживаются.');
  const entries = new Map(),
    ranges = [];
  let pos = offset,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > offset + size || bytes.readUInt32LE(pos) !== 0x02014b50)
      fail('EPUB: повреждён каталог.');
    const flags = bytes.readUInt16LE(pos + 8),
      method = bytes.readUInt16LE(pos + 10),
      checksum = bytes.readUInt32LE(pos + 16),
      compressed = bytes.readUInt32LE(pos + 20),
      expanded = bytes.readUInt32LE(pos + 24),
      n = bytes.readUInt16LE(pos + 28),
      extra = bytes.readUInt16LE(pos + 30),
      comment = bytes.readUInt16LE(pos + 32),
      local = bytes.readUInt32LE(pos + 42);
    if (
      pos + 46 + n + extra + comment > offset + size ||
      flags & 0x41 ||
      ![0, 8].includes(method) ||
      bytes.readUInt16LE(pos + 34) ||
      expanded > 16 * MB ||
      compressed > 64 * MB
    )
      fail('EPUB: зашифрованный или слишком большой файл внутри книги.');
    const name = new TextDecoder('utf-8', {fatal: true}).decode(
      bytes.subarray(pos + 46, pos + 46 + n)
    );
    if (
      !name ||
      /[\\\x00-\x1f]/.test(name) ||
      name.startsWith('/') ||
      name.split('/').includes('..') ||
      entries.has(name)
    )
      fail('EPUB: некорректный путь.');
    if (
      local + 30 > offset ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 6) !== flags
    )
      fail('EPUB: повреждён заголовок файла.');
    const length = bytes.readUInt16LE(local + 26),
      start = local + 30 + length + bytes.readUInt16LE(local + 28);
    if (
      start + compressed > offset ||
      new TextDecoder('utf-8', {fatal: true}).decode(
        bytes.subarray(local + 30, local + 30 + length)
      ) !== name
    )
      fail('EPUB: повреждён файл.');
    total += expanded;
    if (total > 128 * MB) fail('EPUB: после распаковки книга больше 128 МБ.');
    entries.set(name, {start, compressed, expanded, method, checksum});
    ranges.push([local, start + compressed]);
    pos += 46 + n + extra + comment;
  }
  ranges.sort((a, b) => a[0] - b[0]);
  if (ranges.some((r, i) => i && r[0] < ranges[i - 1][1])) fail('EPUB: пересекающиеся файлы.');
  if (pos !== offset + size) fail('EPUB: повреждён каталог.');
  return {
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) fail('EPUB: отсутствует ' + name.slice(0, 100));
      const input = bytes.subarray(e.start, e.start + e.compressed),
        output =
          e.method === 8
            ? inflateRawSync(input, {maxOutputLength: Math.max(1, e.expanded)})
            : input;
      if (output.length !== e.expanded || crc32(output) !== e.checksum)
        fail('EPUB: ошибка проверки файла.');
      return output;
    }
  };
}
export function reference(base, value) {
  let decoded;
  try {
    decoded = decodeURIComponent(value.split('#')[0].split('?')[0]);
  } catch {
    return null;
  }
  if (!decoded || /^[\w+.-]+:/.test(decoded) || decoded.startsWith('/') || /[\\\0]/.test(decoded))
    return null;
  const result = path.posix.normalize(path.posix.join(path.posix.dirname(base), decoded));
  return result === '..' || result.startsWith('../') ? null : result;
}
export function blocksFromHTML(html, image) {
  html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '');
  const blocks = [];
  let text = '',
    type = 'p',
    skip = [],
    bodySeen = /<body\b/i.test(html),
    inBody = !bodySeen;
  const flush = () => {
    const clean = entities(text).replace(/\r/g, '').trim();
    if (clean) {
      for (let i = 0; i < clean.length; i += 4000)
        blocks.push({type, text: clean.slice(i, i + 4000)});
    }
    text = '';
    type = 'p';
  };
  const forbidden = new Set([
    'script',
    'style',
    'head',
    'iframe',
    'object',
    'svg',
    'math',
    'form',
    'audio',
    'video',
    'noscript'
  ]);
  for (const token of html.matchAll(/<[^>]*>|[^<]+/g)) {
    const v = token[0];
    if (!v.startsWith('<')) {
      if (inBody && !skip.length) text += v;
      continue;
    }
    const match = /^<\s*(\/?)\s*([\w:-]+)/.exec(v);
    if (!match) continue;
    const closing = !!match[1],
      tag = match[2].toLowerCase().split(':').at(-1);
    if (skip.length) {
      if (closing && tag === skip.at(-1)) skip.pop();
      else if (!closing && forbidden.has(tag) && !v.endsWith('/>')) skip.push(tag);
      continue;
    }
    if (forbidden.has(tag)) {
      if (!closing && !v.endsWith('/>')) skip.push(tag);
      continue;
    }
    if (tag === 'body') {
      flush();
      inBody = !closing;
      continue;
    }
    if (!inBody) continue;
    if (tag === 'img' && !closing) {
      flush();
      const a = attrs(v),
        asset = image(a.src || '');
      if (asset) blocks.push({type: 'image', asset, text: a.alt?.slice(0, 200) || ''});
      continue;
    }
    if (tag === 'br') {
      text += '\n';
      continue;
    }
    if (
      [
        'p',
        'div',
        'section',
        'article',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'li',
        'blockquote',
        'pre',
        'tr'
      ].includes(tag)
    ) {
      flush();
      if (!closing)
        type = /^h[1-6]$/.test(tag)
          ? 'heading'
          : tag === 'blockquote'
            ? 'quote'
            : tag === 'pre'
              ? 'pre'
              : 'p';
    } else if (tag === 'td' || tag === 'th') text += ' ';
  }
  flush();
  return blocks;
}
function pages(blocks, title) {
  const result = [];
  let chunk = [],
    length = 0;
  for (const block of blocks) {
    if (chunk.length && (length + block.text.length > 24000 || chunk.length >= 100)) {
      result.push({
        title: title + (result.length ? ' · ' + (result.length + 1) : ''),
        blocks: chunk
      });
      chunk = [];
      length = 0;
    }
    chunk.push(block);
    length += block.text.length;
  }
  if (chunk.length)
    result.push({title: title + (result.length ? ' · ' + (result.length + 1) : ''), blocks: chunk});
  return result;
}
function dimensions(data, type) {
  let width = 0,
    height = 0;
  if (type === 'image/png' && data.length >= 24) {
    width = data.readUInt32BE(16);
    height = data.readUInt32BE(20);
  } else if (type === 'image/gif' && data.length >= 10) {
    width = data.readUInt16LE(6);
    height = data.readUInt16LE(8);
  } else if (type === 'image/webp' && data.length >= 30) {
    const kind = data.subarray(12, 16).toString();
    if (kind === 'VP8X') {
      width = 1 + data.readUIntLE(24, 3);
      height = 1 + data.readUIntLE(27, 3);
    }
    if (kind === 'VP8 ') {
      width = data.readUInt16LE(26) & 0x3fff;
      height = data.readUInt16LE(28) & 0x3fff;
    }
    if (kind === 'VP8L') {
      width = 1 + (data[21] | ((data[22] & 63) << 8));
      height = 1 + ((data[22] >> 6) | (data[23] << 2) | ((data[24] & 15) << 10));
    }
  } else if (type === 'image/jpeg') {
    let p = 2;
    while (p + 4 < data.length) {
      if (data[p++] !== 255) break;
      while (data[p] === 255) p++;
      const marker = data[p++];
      if (marker === 217 || marker === 218) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > data.length) break;
      const n = data.readUInt16BE(p);
      if (n < 2 || p + n > data.length) break;
      if (
        [192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) &&
        n >= 7
      ) {
        height = data.readUInt16BE(p + 3);
        width = data.readUInt16BE(p + 5);
        break;
      }
      p += n;
    }
  }
  if (!width || !height || Math.max(width, height) > 16000 || width * height > 40000000)
    fail('EPUB: изображение повреждено или больше 40 мегапикселей.');
  return {width, height};
}
export function parseBook(input, name) {
  const bytes = Buffer.from(input),
    format = name.toLowerCase().endsWith('.epub')
      ? 'epub'
      : name.toLowerCase().endsWith('.txt')
        ? 'txt'
        : null;
  if (!format) fail('Поддерживаются EPUB и TXT.');
  const fallback = name.replace(/\.[^.]+$/, '').slice(0, 180);
  if (format === 'txt') {
    if (bytes.length > 16 * MB) fail('TXT: максимум 16 МБ.');
    const source = decode(bytes)
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n');
    if (!source.trim() || /[\x00-\x08\x0e-\x1f]/.test(source))
      fail('TXT: пустой файл или неподдерживаемая кодировка.');
    const blocks = source.split(/\n\s*\n/).flatMap((t) => {
      const result = [];
      t = t.trim();
      for (let i = 0; i < t.length; i += 4000) result.push({type: 'p', text: t.slice(i, i + 4000)});
      return result;
    });
    const chapters = pages(blocks, 'Часть');
    chapters.forEach((c, i) => (c.title = 'Часть ' + (i + 1)));
    return {format, title: fallback, author: '', chapters, assets: [], cover: null};
  }
  const zip = archive(bytes);
  if (zip.read('mimetype').toString().trim() !== 'application/epub+zip') fail('Это не EPUB.');
  if (zip.has('META-INF/encryption.xml')) {
    const encryption = zip.read('META-INF/encryption.xml').toString();
    if (
      [...encryption.matchAll(/<(?:[\w-]+:)?EncryptionMethod\b([^>]*)>/g)].some(
        (m) =>
          !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(
            attrs(m[1]).algorithm
          )
      )
    )
      fail('EPUB с DRM не поддерживается.');
  }
  const xml = (file) => {
    const s = decode(zip.read(file));
    if (/<!ENTITY\b|<!DOCTYPE[^>]*\[/i.test(s))
      fail('EPUB: объявления XML-сущностей не поддерживаются.');
    return s;
  };
  const container = xml('META-INF/container.xml'),
    root = /<(?:[\w-]+:)?rootfile\b([^>]*)>/i.exec(container),
    opf = root && reference('root', attrs(root[1])['full-path'] || '');
  if (!opf) fail('EPUB: не найден файл описания.');
  const packageXML = xml(opf);
  if (
    /<(?:[\w-]+:)?meta\b[^>]*property\s*=\s*["']rendition:layout["'][^>]*>\s*pre-paginated/i.test(
      packageXML
    )
  )
    fail('EPUB с фиксированной вёрсткой пока не поддерживается.');
  const field = (name) =>
    plain(
      new RegExp(
        '<(?:[\\w-]+:)?' + name + '\\b[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?' + name + '>',
        'i'
      ).exec(packageXML)?.[1] || ''
    );
  const manifest = new Map();
  for (const m of packageXML.matchAll(/<(?:[\w-]+:)?item\b([^>]*)>/gi)) {
    const a = attrs(m[1]),
      file = reference(opf, a.href || '');
    if (a.id && file) manifest.set(a.id, {...a, file});
  }
  const spine = [...packageXML.matchAll(/<(?:[\w-]+:)?itemref\b([^>]*)>/gi)]
    .map((m) => manifest.get(attrs(m[1]).idref))
    .filter(Boolean);
  if (!spine.length || spine.length > 2000)
    fail('EPUB: отсутствует или слишком большое оглавление.');
  const assets = [],
    assetMap = new Map();
  const image = (file) => {
    if (!file || !zip.has(file)) return null;
    if (assetMap.has(file)) return assetMap.get(file);
    const data = zip.read(file);
    let type;
    if (data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) type = 'image/jpeg';
    else if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      type = 'image/png';
    else if (/^GIF8[79]a/.test(data.subarray(0, 6).toString())) type = 'image/gif';
    else if (
      data.subarray(0, 4).toString() === 'RIFF' &&
      data.subarray(8, 12).toString() === 'WEBP'
    )
      type = 'image/webp';
    if (!type) return null;
    const id = createHash('sha256').update(file).digest('hex');
    assets.push({id, type, data, ...dimensions(data, type)});
    assetMap.set(file, id);
    return id;
  };
  let coverItem = [...manifest.values()].find((i) =>
    i.properties?.split(/\s+/).includes('cover-image')
  );
  if (!coverItem) {
    const meta = [...packageXML.matchAll(/<(?:[\w-]+:)?meta\b([^>]*)>/gi)]
      .map((m) => attrs(m[1]))
      .find((a) => a.name === 'cover');
    coverItem = manifest.get(meta?.content);
  }
  const cover = image(coverItem?.file),
    chapters = [];
  let total = 0;
  for (const item of spine) {
    if (!['application/xhtml+xml', 'text/html'].includes(item['media-type']))
      fail('EPUB: неподдерживаемый формат главы.');
    const source = xml(item.file),
      blocks = blocksFromHTML(source, (src) => image(reference(item.file, src)));
    total += blocks.reduce((n, b) => n + b.text.length, 0);
    if (total > 20 * MB) fail('EPUB: текст книги больше 20 млн символов.');
    const title =
      blocks.find((b) => b.type === 'heading')?.text.slice(0, 160) ||
      'Глава ' + (chapters.length + 1);
    chapters.push(...pages(blocks, title));
  }
  if (!chapters.length || chapters.length > 10000)
    fail('EPUB: нет текста или слишком много частей.');
  for (const chapter of chapters)
    for (const block of chapter.blocks)
      if (block.type === 'image') {
        const asset = assets.find((a) => a.id === block.asset);
        block.width = asset.width;
        block.height = asset.height;
      }
  return {
    format,
    title: field('title').slice(0, 180) || fallback,
    author: field('creator').slice(0, 180),
    chapters,
    assets,
    cover
  };
}
if (parentPort) {
  try {
    parentPort.postMessage({book: parseBook(workerData.bytes, workerData.name)});
  } catch (e) {
    parentPort.postMessage({error: e.message.slice(0, 240)});
  }
}
