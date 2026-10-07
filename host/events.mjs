import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {event, direct} from './common.mjs';
export function sshEvent(line) {
  let m = /Accepted ([a-zA-Z0-9/_-]+) for ([a-zA-Z0-9._-]+) from ([0-9a-fA-F:.]+)/.exec(line);
  if (m)
    return {
      type: 'security.ssh.login_succeeded',
      details: `user=${m[2]} ip=${m[3]} method=${m[1]}`
    };
  m = /Failed ([a-zA-Z0-9/_-]+) for (?:invalid user )?([a-zA-Z0-9._-]+) from ([0-9a-fA-F:.]+)/.exec(
    line
  );
  return m
    ? {type: 'security.ssh.login_failed', details: `user=${m[2]} ip=${m[3]} method=${m[1]}`}
    : null;
}
export function watchSSH() {
  const p = spawn(
    'journalctl',
    ['-u', 'ssh.service', '-u', 'sshd.service', '-f', '-n', '0', '-o', 'cat'],
    {stdio: ['ignore', 'pipe', 'inherit']}
  );
  readline.createInterface({input: p.stdout}).on('line', (line) => {
    const e = sshEvent(line);
    if (e) event(e.type, e.details);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => p.kill(sig));
  p.on('close', (code) => {
    process.exitCode = code || 1;
  });
}
if (direct(import.meta.url)) {
  if (process.argv[2] === '--watch-ssh') watchSSH();
  else if (process.argv[2]) event(process.argv[2], process.argv[3] ?? '');
}
