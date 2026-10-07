import fs from 'node:fs';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {read, saveJSON, direct, sleep} from './common.mjs';
export function cpuCounters(text) {
  const rows = text.trim().split('\n'),
    values = rows[0].trim().split(/\s+/).slice(1, 9).map(Number);
  if (!rows[0].startsWith('cpu ') || values.length !== 8 || values.some((v) => !Number.isFinite(v)))
    throw new Error('cpu');
  return {values, cores: rows.filter((r) => /^cpu\d+ /.test(r)).length};
}
export function cpuUsage(old, now) {
  const empty = {percent: null, iowait_percent: null, steal_percent: null};
  if (!old) return empty;
  const d = now.map((n, i) => n - old[i]);
  d[4] = Math.max(0, d[4]);
  const total = d.reduce((a, b) => a + b, 0);
  if (total <= 0 || d.some((n) => n < 0)) return empty;
  const pct = (n) => Math.round((1000 * n) / total) / 10;
  return {percent: pct(total - d[3] - d[4]), iowait_percent: pct(d[4]), steal_percent: pct(d[7])};
}
export function memoryUsage(text) {
  const fields = Object.fromEntries(
    text
      .trim()
      .split('\n')
      .map((row) => {
        const p = row.split(/[:\s]+/);
        return [p[0], Number(p[1]) * 1024];
      })
  );
  function usage(total, available) {
    if (!Number.isFinite(total) || !Number.isFinite(available)) throw new Error('memory');
    available = Math.min(total, Math.max(0, available));
    return {
      total,
      used: total - available,
      available,
      percent: total ? Math.round((1000 * (total - available)) / total) / 10 : null
    };
  }
  return {
    memory: usage(fields.MemTotal, fields.MemAvailable),
    swap: usage(fields.SwapTotal, fields.SwapFree)
  };
}
export function networkCounters(text) {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((r) => r.includes(':'))
      .map((r) => {
        const [name, ...rest] = r.split(':');
        const v = rest.join(':').trim().split(/\s+/).map(Number);
        return [name.trim(), [v[0], v[8]]];
      })
      .filter(
        ([n, v]) => n !== 'lo' && !/^(veth|docker|br-|virbr)/.test(n) && v.every(Number.isFinite)
      )
  );
}
export function networkUsage(old, current, elapsed) {
  return Object.entries(current)
    .sort()
    .map(([name, [rx, tx]]) => {
      const prev = old?.[name],
        valid = prev && elapsed > 0 && rx >= prev[0] && tx >= prev[1];
      return {
        name,
        rx_bytes: rx,
        tx_bytes: tx,
        rx_per_second: valid ? Math.round((rx - prev[0]) / elapsed) : null,
        tx_per_second: valid ? Math.round((tx - prev[1]) / elapsed) : null
      };
    });
}
export function mountpoints(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const a = left.split(' '),
      b = right.split(' ');
    const mount = a[4]?.replace(/\\([0-7]{3})/g, (_, n) => String.fromCharCode(parseInt(n, 8)));
    if (!mount) continue;
    if (
      mount !== '/' &&
      (!/^(ext[234]|xfs|btrfs|zfs|f2fs|bcachefs|jfs|reiserfs)$/.test(b[0]) ||
        /^\/(proc|sys|dev|run|var\/lib\/docker)\//.test(mount))
    )
      continue;
    rows.push({mount, device: a[2], fs: b[0]});
  }
  rows.sort((a, b) =>
    a.mount === '/' ? -1 : b.mount === '/' ? 1 : a.mount.length - b.mount.length
  );
  const seen = new Set();
  return rows
    .filter((r) => {
      if (seen.has(r.device)) return false;
      seen.add(r.device);
      return true;
    })
    .slice(0, 64);
}
export function diskUsage(text, stat = fs.statfsSync) {
  const disks = [],
    failed = [];
  for (const {mount, fs: kind} of mountpoints(text)) {
    try {
      const s = stat(mount),
        total = s.blocks * s.bsize,
        free = s.bfree * s.bsize,
        available = Math.max(0, s.bavail * s.bsize);
      disks.push({
        mount,
        fs: kind,
        total,
        used: total - free,
        available,
        reserved: Math.max(0, free - available),
        percent: total ? Math.round((1000 * (total - free)) / total) / 10 : null,
        inodes_total: s.files,
        inodes_free: s.ffree,
        inodes_percent: s.files ? Math.round((1000 * (s.files - s.ffree)) / s.files) / 10 : null
      });
    } catch {
      failed.push(mount);
    }
  }
  return {disks, failed};
}
export class Collector {
  constructor(proc = '/proc') {
    this.proc = proc;
    this.previousCpu = null;
    this.previousNet = null;
    this.previousTime = null;
    this.identity = {
      hostname: os.hostname(),
      kernel: os.release(),
      os: read('/etc/os-release').match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? 'Linux',
      cpu_model: read(proc + '/cpuinfo').match(/^(?:model name|Hardware)\s*:\s*(.+)$/m)?.[1] ?? ''
    };
  }
  sample() {
    const now = performance.now(),
      elapsed = this.previousTime === null ? null : (now - this.previousTime) / 1000;
    const data = {
      schema: 1,
      generated_at: Date.now(),
      interval_seconds: 5,
      server: {...this.identity},
      cpu: null,
      memory: null,
      swap: null,
      uptime_seconds: null,
      disks: [],
      network: [],
      warnings: []
    };
    try {
      const {values, cores} = cpuCounters(read(this.proc + '/stat'));
      data.cpu = {
        ...cpuUsage(this.previousCpu, values),
        load: read(this.proc + '/loadavg')
          .split(/\s+/)
          .slice(0, 3)
          .map(Number)
      };
      data.server.cores = cores;
      this.previousCpu = values;
    } catch {
      this.previousCpu = null;
      data.warnings.push('cpu');
    }
    try {
      Object.assign(data, memoryUsage(read(this.proc + '/meminfo')));
    } catch {
      data.warnings.push('memory');
    }
    const uptime = read(this.proc + '/uptime');
    if (uptime && Number.isFinite(Number(uptime.split(' ')[0])))
      data.uptime_seconds = Number(uptime.split(' ')[0]);
    else data.warnings.push('uptime');
    try {
      const text = read(this.proc + '/net/dev');
      if (!text) throw new Error('network');
      const net = networkCounters(text);
      data.network = networkUsage(this.previousNet, net, elapsed);
      this.previousNet = net;
    } catch {
      this.previousNet = null;
      data.warnings.push('network');
    }
    try {
      const text = read(this.proc + '/self/mountinfo');
      if (!text) throw new Error('disks');
      const {disks, failed} = diskUsage(text);
      data.disks = disks;
      if (failed.length) data.warnings.push('disks_partial');
    } catch {
      data.warnings.push('disks');
    }
    this.previousTime = now;
    return data;
  }
}
export async function runCollector(directory = '/var/lib/nexus404-metrics', once = false) {
  const c = new Collector();
  const history = new MetricsHistory(directory);
  let serviceAt=0,services=[];
  let running = true;
  process.on('SIGTERM', () => {
    running = false;
  });
  process.on('SIGINT', () => {
    running = false;
  });
  while (running) {
    const started = performance.now();
    const sample=c.sample();
    if(sample.generated_at-serviceAt>=60000){services=serviceStates();serviceAt=sample.generated_at;}
    sample.services={checkedAt:serviceAt,items:services};
    saveJSON(directory + '/pulse.json', sample, 0o644);
    history.add(sample);
    if (once) break;
    while (running && performance.now() - started < 5000) await sleep(200);
  }
}
export function serviceStates(run=execFileSync, units=['docker.service','nexus404-pulse.service','ssh.service','fail2ban.service']) {
  if(!Array.isArray(units)||units.length>32||units.some(v=>! /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,100}\.service$/.test(v)))throw Error('Invalid service list');
  if(!units.length)return [];
  try {
    const output=run('systemctl',['show',...units,'--no-pager','--property=Id,LoadState,ActiveState,SubState'],{encoding:'utf8',timeout:1500,maxBuffer:16384,stdio:['ignore','pipe','ignore']});
    return output.trim().split(/\n\s*\n/).map(block=>Object.fromEntries(block.split('\n').map(line=>{const i=line.indexOf('=');return [line.slice(0,i),line.slice(i+1)];}))).filter(row=>units.includes(row.Id)).map(row=>({id:row.Id,state:row.LoadState==='not-found'?'not-found':row.ActiveState||'unknown',detail:row.SubState||''}));
  }catch{return units.map(id=>({id,state:'unknown',detail:''}));}
}
export class MetricsHistory {
  constructor(directory){
    this.file=directory+'/pulse-history.json';this.points=[];
    try{if(fs.statSync(this.file).size<=4*1024*1024){const data=JSON.parse(fs.readFileSync(this.file,'utf8'));if(data.schema===1&&Array.isArray(data.points))this.points=data.points.filter(p=>Number.isFinite(p.time)).slice(-10081);}}catch{}
  }
  add(data){
    const time=data.generated_at;
    if(!Number.isFinite(time))return false;
    const last=this.points.at(-1);
    if(last&&time>=last.time&&time-last.time<60000)return false;
    const percent=n=>Number.isFinite(n)&&n>=0&&n<=100?n:null;
    const disks=Array.isArray(data.disks)?data.disks:[];
    const disk=disks.find(d=>d.mount==='/')??disks[0];
    this.points=this.points.filter(p=>p.time>=time-7*86400000&&p.time<time);
    this.points.push({time,cpu:percent(data.cpu?.percent),memory:percent(data.memory?.percent),disk:percent(disk?.percent),uptime:Number.isFinite(data.uptime_seconds)?data.uptime_seconds:null});
    if(this.points.length>10081)this.points=this.points.slice(-10081);
    saveJSON(this.file,{schema:1,generated_at:time,interval:60000,points:this.points},0o644);return true;
  }
}
if (direct(import.meta.url))
  runCollector(
    process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : undefined,
    process.argv.includes('--once')
  ).catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
