import {createHash, createPublicKey, sign, verify, randomBytes} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {maintenanceConfig, maintenanceDefaults} from './maintenance-schema.mjs';
export const fail = (message, status=400) => {throw Object.assign(new Error(message), {status});};
export const digest = value => createHash('sha256').update(value).digest('hex');
export const uuid = value => typeof value==='string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
export function durable(file, value, mode=0o600) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+randomBytes(8).toString('hex');let fd;
  try {fd=fs.openSync(temp,'wx',mode);fs.fchmodSync(fd,mode);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const dir=fs.openSync(path.dirname(file),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
  finally {if(fd!==undefined)fs.closeSync(fd);fs.rmSync(temp,{force:true});}
}
export function readState(file, fallback) {try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
export function agentConfig(value) {
  if(!value||Object.keys(value).sort().join()!=='maintenance,services,timezone')fail('Неверные поля настроек');
  const {timezone,services}=value;
  if(typeof timezone!=='string'||timezone.length>80||!/^[A-Za-z0-9_+/-]+$/.test(timezone))fail('Неверный часовой пояс');
  try{new Intl.DateTimeFormat('en',{timeZone:timezone});}catch{fail('Неизвестный часовой пояс');}
  if(!Array.isArray(services)||services.length>32||services.some(s=>typeof s!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,100}\.service$/.test(s)))fail('Некорректный список служб');
  return {timezone,services:[...new Set(services)],maintenance:maintenanceConfig(value.maintenance)};
}
export const agentDefaults = () => agentConfig({timezone:'UTC',services:['ssh.service','fail2ban.service','nexus404-agent.service'],maintenance:maintenanceDefaults()});
export function publicKey(value) {
  try{if(typeof value!=='string'||value.length>200)throw Error();const key=createPublicKey({key:Buffer.from(value,'base64'),type:'spki',format:'der'});if(key.asymmetricKeyType!=='ed25519')throw Error();return key;}catch{fail('Неверный ключ');}
}
const signed = (route,time,nonce,raw) => Buffer.from(`NEXUS404-agent-v1\nPOST\n${route}\n${time}\n${nonce}\n${digest(raw)}`);
export function signedHeaders(privateKey,route,raw,now=Date.now()) {
  const time=String(now),nonce=randomBytes(24).toString('hex');
  return {'content-type':'application/json','x-nexus-time':time,'x-nexus-nonce':nonce,'x-nexus-signature':sign(null,signed(route,time,nonce,raw),privateKey).toString('base64')};
}
export function verifyRequest(key,route,raw,headers,now=Date.now()) {
  const time=headers['x-nexus-time'],nonce=headers['x-nexus-nonce'],signature=headers['x-nexus-signature'];
  if(typeof time!=='string'||!/^\d{13}$/.test(time)||Math.abs(now-Number(time))>300000||typeof nonce!=='string'||!/^[a-f0-9]{48}$/.test(nonce)||typeof signature!=='string'||signature.length>100)fail('Недействительная подпись или время',401);
  if(!verify(null,signed(route,time,nonce,raw),publicKey(key),Buffer.from(signature,'base64')))fail('Недействительная подпись',401);
  return nonce;
}
export function hubAddress(value) {
  let url;try{url=new URL(value);}catch{fail('Нужен HTTPS-адрес хаба');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/')fail('Укажи HTTPS-адрес хаба без пути и пароля');
  return url.origin;
}
export function snapshot(data, now=Date.now()) {
  if(!data||data.schema!==1||!Number.isSafeInteger(data.generated_at)||Math.abs(now-data.generated_at)>300000)fail('Неверное время замера');
  const number=(v,max=Number.MAX_SAFE_INTEGER)=>v===null?null:typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=max?v:fail('Неверное число');
  const text=(v,n=160)=>typeof v==='string'&&v.length<=n&&!/[\x00-\x1f]/.test(v)?v:fail('Неверная строка');
  const record=(o,fields)=>o===null?null:Object.fromEntries(fields.map(k=>[k,number(o?.[k],k.includes('percent')?100:undefined)]));
  const list=(a,max,fn)=>Array.isArray(a)&&a.length<=max?a.map(fn):fail('Неверный список');
  return {schema:1,generated_at:data.generated_at,server:{hostname:text(data.server?.hostname),os:text(data.server?.os),kernel:text(data.server?.kernel),cpu_model:text(data.server?.cpu_model,300),cores:number(data.server?.cores??null)},cpu:data.cpu===null?null:{...record(data.cpu,['percent','iowait_percent','steal_percent']),load:list(data.cpu?.load,3,n=>number(n))},memory:record(data.memory,['total','used','available','percent']),swap:record(data.swap,['total','used','available','percent']),uptime_seconds:number(data.uptime_seconds),disks:list(data.disks,64,d=>({...record(d,['total','used','available','reserved','percent','inodes_total','inodes_free','inodes_percent']),mount:text(d.mount,1024),fs:text(d.fs)})),network:list(data.network,64,n=>({...record(n,['rx_bytes','tx_bytes','rx_per_second','tx_per_second']),name:text(n.name)})),warnings:list(data.warnings,16,w=>text(w,60)),services:{checkedAt:number(data.services?.checkedAt),items:list(data.services?.items,32,s=>({id:text(s.id),state:text(s.state,40),detail:text(s.detail,100)}))}};
}
export function agentEvent(e) {
  if(!e||!Number.isSafeInteger(e.seq)||e.seq<1||!uuid(e.id)||!Number.isSafeInteger(e.time)||e.time<0||!['info','warning','critical'].includes(e.level))fail('Неверное событие');
  const value={seq:e.seq,id:e.id,time:e.time,level:e.level};
  for(const [key,max]of [['title',160],['body',1000],['category',40],['key',180]]){if(typeof e[key]!=='string'||e[key].length>max)fail('Неверное событие');value[key]=e[key].replace(/[\x00-\x1f\x7f]/g,' ');}
  return value;
}
