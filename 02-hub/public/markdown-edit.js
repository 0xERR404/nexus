/* Pure text edits shared by the article toolbar and its verification cases. */
globalThis.NexusMarkdownEdit = function (text, start, end, command) {
  start = Math.max(0, Math.min(text.length, start));
  end = Math.max(start, Math.min(text.length, end));
  const selected = text.slice(start, end);
  const result = (from, to, value, a = 0, b = value.length) => ({from, to, value, start: from + a, end: from + b});
  const longest = (value, char) => Math.max(0, ...[...value.matchAll(char === '`' ? /`+/g : /~/g)].map(m => m[0].length));
  const markers = {bold: '**', italic: '_', strike: '~~'};
  if (markers[command] || command === 'inline-code') {
    const marker = command === 'inline-code' ? '`'.repeat(longest(selected, '`') + 1) : markers[command];
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length > marker.length * 2)
      return result(start, end, selected.slice(marker.length, -marker.length));
    if (text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker)
      return result(start - marker.length, end + marker.length, selected);
    const content = selected || (command === 'inline-code' ? 'код' : 'текст');
    const pad = command === 'inline-code' && /^`|`$/.test(content) ? ' ' : '';
    return result(start, end, marker + pad + content + pad + marker, marker.length + pad.length, marker.length + pad.length + content.length);
  }
  if (command === 'link' || command === 'reference') {
    const label = (selected || 'текст ссылки').replace(/[\\[\]]/g, '\\$&').replace(/\n/g, ' ');
    if (command === 'reference') {
      let n = 1;
      while (text.includes('[link-' + n + ']')) n++;
      const value = '[' + label + '][link-' + n + ']' + text.slice(end) + '\n\n[link-' + n + ']: https://example.com\n';
      const url = value.lastIndexOf('https://');
      return result(start, text.length, value, url, url + 19);
    }
    const prefix = '[' + label + '](';
    return result(start, end, prefix + 'https://example.com)', prefix.length, prefix.length + 19);
  }
  if (command === 'break') return result(start, end, '  \n', 3, 3);
  if (command === 'escape') return result(start, end, (selected || '*текст*').replace(/[\\`*_{}\[\]()#+\-.!>|~]/g, '\\$&'));
  let from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  if (start === 0) from = 0;
  const to = end > start && text[end - 1] === '\n' ? end - 1 : (text.indexOf('\n', end) < 0 ? text.length : text.indexOf('\n', end));
  const content = text.slice(from, to);
  if (command === 'code' || command === 'table' || command === 'rule') {
    let value;
    if (command === 'code') {
      const fence = '`'.repeat(Math.max(3, longest(content, '`') + 1));
      value = fence + '\n' + (content || 'код') + '\n' + fence;
    } else if (command === 'table') {
      value = '| Заголовок | По центру | Справа |\n| :--- | :---: | ---: |\n| Текст | Текст | Текст |\n| Текст | Текст | Текст |';
      // A table is inserted at the cursor without consuming existing paragraphs.
      from = start;
      const before = start && text[start - 1] !== '\n' ? '\n\n' : start && text[start - 2] !== '\n' ? '\n' : '';
      const after = end < text.length ? '\n\n' : '\n';
      return result(start, end, before + value + after, before.length, before.length + value.length);
    } else {
      const before = start && text[start - 1] !== '\n' ? '\n\n' : start && text[start - 2] !== '\n' ? '\n' : '';
      return result(start, start, before + '---\n\n', before.length + 5, before.length + 5);
    }
    const before = from > 0 && text[from - 2] !== '\n' ? '\n' : '';
    const after = to < text.length && text[to + 1] !== '\n' ? '\n' : '';
    return result(from, to, before + value + after, before.length, before.length + value.length);
  }
  const lines = content.split('\n');
  const clean = line => line.replace(/^(\s*)(?:#{1,6}\s+|>\s?|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, '$1');
  const value = lines.map((line, i) => {
    if (command === 'indent') return '    ' + line;
    if (command === 'outdent') return line.replace(/^(?: {1,4}|\t)/, '');
    const plain = clean(line), indent = plain.match(/^\s*/)[0], body = plain.slice(indent.length);
    if (command === 'paragraph') return plain;
    if (/^h[1-6]$/.test(command)) return indent + '#'.repeat(Number(command[1])) + ' ' + body;
    if (command === 'quote') return '> ' + line;
    const prefix = {bullet: '- ', ordered: (i + 1) + '. ', task: '- [ ] '}[command];
    return prefix ? indent + prefix + body : line;
  }).join('\n');
  return result(from, to, value);
};
