import fs from 'node:fs';
import tty from 'node:tty';
import readline from 'node:readline';
import {exec, clean} from './common.mjs';
export class UI {
  constructor(log) {
    this.log = log;
    this.open = false;
    this.tty = Boolean(process.stdout.isTTY);
    this.width = Math.max(
      24,
      Math.min(
        100,
        Number(process.env.NEXUS_UI_WIDTH) || 72,
        this.tty ? process.stdout.columns || 72 : 100
      )
    );
    this.color = this.tty && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
    if (log) {
      fs.mkdirSync(log.slice(0, log.lastIndexOf('/')), {recursive: true, mode: 0o700});
      fs.closeSync(fs.openSync(log, 'a', 0o600));
    }
  }
  paint(s, c) {
    return this.color ? `\x1b[${c}m${s}\x1b[0m` : s;
  }
  line(value = '', tone) {
    for (const raw of String(value).split('\n')) {
      let text = clean(raw);
      const status = /^\[([✓!?*])\]\s*/.exec(text);
      const choice = /^(\d+)  /.exec(text);
      let prefix = '';
      if (status) {
        const symbol = status[1] === '*' ? '·' : status[1];
        prefix = this.paint(symbol, {'✓': 32, '!': 31, '?': 95, '·': 90}[symbol]) + ' ';
        text = text.slice(status[0].length);
      } else if (choice) {
        prefix = this.paint(choice[1], 95) + '  ';
        text = text.slice(choice[0].length);
      }
      const indent = status ? 2 : choice ? 3 : 0;
      do {
        let part = Array.from(text)
          .slice(0, this.width - 4 - indent)
          .join('');
        if (text.length > part.length && part.includes(' '))
          part = part.slice(0, part.lastIndexOf(' '));
        process.stdout.write('  ' + prefix + (tone ? this.paint(part, tone) : part) + '\n');
        text = text.slice(part.length).trimStart();
        prefix = ' '.repeat(indent);
      } while (text);
    }
    if (this.log) fs.appendFileSync(this.log, clean(value) + '\n');
  }
  section(title) {
    if (this.open) this.footer();
    else process.stdout.write('\n');
    this.open = true;
    this.line(title, '1;95');
    process.stdout.write('  ' + this.paint('='.repeat(this.width - 4), 90) + '\n');
  }
  footer() {
    if (this.open) process.stdout.write('\n');
    this.open = false;
  }
  async prompt(label, secret = false) {
    this.line('[?] ' + label + (secret ? ' · ввод скрыт' : ''));
    const fd = fs.openSync('/dev/tty', 'r+');
    const input = new tty.ReadStream(fd),
      output = new tty.WriteStream(fs.openSync('/dev/tty', 'w'));
    const prompt = this.paint('  › ', 95);
    if (!secret) {
      const rl = readline.createInterface({input, output, terminal: true, prompt});
      try {
        return await new Promise((resolve, reject) => {
          rl.once('line', resolve);
          rl.once('close', () => reject(new Error('Ввод прерван')));
          rl.once('SIGINT', () => reject(new Error('Ввод прерван')));
          rl.prompt();
        });
      } finally {
        rl.close();
        input.destroy();
        output.destroy();
      }
    }
    output.write(prompt);
    let value = '';
    input.setEncoding('utf8');
    input.setRawMode(true);
    input.resume();
    try {
      return await new Promise((resolve, reject) => {
        input.on('data', (chunk) => {
          for (const char of chunk.toString()) {
            if (char === '\r' || char === '\n') {
              resolve(value);
              return;
            }
            if (char === '\u0003' || char === '\u0004') {
              reject(new Error('Ввод прерван'));
              return;
            }
            if (char === '\u007f') value = Array.from(value).slice(0, -1).join('');
            else if (char >= ' ') value += char;
          }
        });
      });
    } finally {
      input.setRawMode(false);
      output.write('\n');
      input.destroy();
      output.destroy();
    }
  }
  async confirm(label) {
    while (true) {
      const v = (await this.prompt(label + ' [y/n]')).toLowerCase();
      if (['y', 'yes'].includes(v)) return true;
      if (['n', 'no'].includes(v)) return false;
    }
  }
  async ask(label, valid, initial = '') {
    let v = initial;
    while (!valid(v)) v = await this.prompt(label);
    return v;
  }
  async run(label, command, args = [], options = {}) {
    return this.task(label, () => exec(command, args, {log: this.log, ...options}));
  }
  async task(label, fn) {
    const start = Date.now(),
      frames = Array.from('⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏');
    let n = 0;
    const elapsed = () => {
      const sec = Math.floor((Date.now() - start) / 1000);
      return (
        String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0')
      );
    };
    const draw = (symbol, tone) => {
      const time = elapsed(),
        limit = this.width - time.length - 8;
      const chars = Array.from(clean(label));
      const text = chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
      process.stdout.write(
        '\r\x1b[2K  ' +
          this.paint(symbol, tone) +
          ' ' +
          text +
          ' '.repeat(this.width - 6 - Array.from(text).length - time.length) +
          this.paint(time, 90)
      );
    };
    if (this.tty) draw(frames[0], 95);
    else this.line('[*] ' + label);
    const timer = this.tty ? setInterval(() => draw(frames[n++ % frames.length], 95), 100) : null;
    const finish = (symbol, tone) => {
      clearInterval(timer);
      if (this.tty) {
        draw(symbol, tone);
        process.stdout.write('\n');
        if (this.log) fs.appendFileSync(this.log, `[${symbol}] ${clean(label)} · ${elapsed()}\n`);
      } else this.line(`[${symbol}] ${label} · ${elapsed()}`);
    };
    try {
      const result = await fn();
      finish('✓', 32);
      return result;
    } catch (e) {
      finish('!', 31);
      throw e;
    } finally {
      clearInterval(timer);
    }
  }
}
