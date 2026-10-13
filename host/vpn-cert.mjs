import fs from 'node:fs';
import path from 'node:path';
import {isIP} from 'node:net';
import {X509Certificate,createPrivateKey} from 'node:crypto';
import {atomic,query,direct,withLock} from './common.mjs';
import {ACME_SOURCE} from './vpn-acme.mjs';
export function validateCertificatePair(chain,key,{name,now=Date.now()}={}) {
  const certificate=new X509Certificate(chain);
  if(!certificate.checkPrivateKey(createPrivateKey(key))||Date.parse(certificate.validFrom)>now||Date.parse(certificate.validTo)<=now)
    throw Error('TLS: срок сертификата или закрытый ключ неверны');
  if(name&&!(isIP(name)?certificate.checkIP(name):certificate.checkHost(name)))throw Error('TLS: сертификат не выдан на указанный IP / имя');
  return certificate;
}
export function certificateStatus(root='/var/lib/nexus404-vpn',now=Date.now()){
  const pairs=certificatePool(root,now),names=[...new Set(pairs.flatMap(p=>p.names))];
  return {ready:names.length>0,names,expires:pairs.length?Math.min(...pairs.map(p=>p.expires)):0};
}
const namesOf=c=>(c.subjectAltName??'').split(', ').flatMap(x=>x.startsWith('DNS:')?[x.slice(4)]:x.startsWith('IP Address:')?[x.slice(11)]:[]).filter(x=>/^(?:\*\.)?[a-z0-9.:-]+$/i.test(x)).map(x=>x.toLowerCase()).sort();
const readPair=directory=>{
  const read=name=>{const file=directory+'/'+name;if(fs.statSync(file).size>128*1024)throw Error('Слишком большой TLS-файл');return fs.readFileSync(file,'utf8');};
  return {chain:read('fullchain.pem'),key:read('privkey.pem')};
};
export function certificatePool(root='/var/lib/nexus404-vpn',now=Date.now()){
  let entries=[],current;try{current=fs.realpathSync(root+'/certs/current');}catch{}
  try{entries=fs.readdirSync(root+'/certs',{withFileTypes:true}).filter(e=>e.isDirectory()&&/^pair-[A-Za-z0-9]+$/.test(e.name)).map(e=>root+'/certs/'+e.name).filter(dir=>fs.existsSync(dir+'/.ready')||path.resolve(dir)===current);}catch{}
  const seen=new Set(),pairs=[];
  for(const directory of [root+'/certs',...entries])try{
    const pair=readPair(directory),certificate=validateCertificatePair(pair.chain,pair.key,{now});
    if(seen.has(certificate.fingerprint256))continue;seen.add(certificate.fingerprint256);
    pairs.push({directory,certificate,names:namesOf(certificate),expires:Date.parse(certificate.validTo)});
  }catch{}
  return pairs;
}
// Select locally: signed panel configurations never control certificate file paths.
export function selectCertificates(config,root='/var/lib/nexus404-vpn',now=Date.now()){
  const pairs=certificatePool(root,now);
  for(const inbound of config.inbounds){
    const tls=inbound.streamSettings?.tlsSettings;if(!tls)continue;
    const pair=pairs.find(p=>isIP(tls.serverName)?p.certificate.checkIP(tls.serverName):p.certificate.checkHost(tls.serverName));
    if(pair){
      // Resolve current aliases to immutable pair paths for reliable rollback.
      tls.certificates=[{certificateFile:fs.realpathSync(pair.directory+'/fullchain.pem'),keyFile:fs.realpathSync(pair.directory+'/privkey.pem')}];
    }
  }
  return config;
}
function sources(root){
  try{return JSON.parse(fs.readFileSync(root+'/tls-sources.json','utf8')).sources;}catch(e){if(e.code!=='ENOENT')throw e;}
  try{return [{source:JSON.parse(fs.readFileSync(root+'/tls-source.json','utf8')).source,names:certificateStatus(root).names}];}catch(e){if(e.code!=='ENOENT')throw e;}
  return [];
}
export function renewVPNCertificate({source='/etc/letsencrypt/live/nexus404-vpn',root='/var/lib/nexus404-vpn',name,gid=+query('id',['-g','nexus404-vpn']).text,owner=0,chown=fs.chownSync,activate=false}={}) {
  if(!Number.isInteger(gid)||gid<=0)throw Error('Нет пользователя VPN');
  const {chain,key}=readPair(source),certificate=validateCertificatePair(chain,key,{name}),names=namesOf(certificate);
  const previousSources=activate?sources(root):null;
  const existing=certificatePool(root);
  if(existing.filter(p=>JSON.stringify(p.names)!==JSON.stringify(names)).length>=32)throw Error('На ноде уже 32 TLS-сертификата. Удали неиспользуемые сертификаты перед добавлением нового.');
  // Older installations may have regular files instead of a versioned pair.
  const legacy=existing.find(p=>p.directory===root+'/certs');
  if(legacy&&!fs.lstatSync(root+'/certs/fullchain.pem').isSymbolicLink()){
    const backup=fs.mkdtempSync(root+'/certs/pair-');chown(backup,owner,gid);fs.chmodSync(backup,0o750);
    for(const [file,content]of Object.entries({'fullchain.pem':readPair(root+'/certs').chain,'privkey.pem':readPair(root+'/certs').key})){atomic(backup+'/'+file,content,0o640);chown(backup+'/'+file,owner,gid);}
    atomic(backup+'/.ready','1',0o644);
  }
  // Preserve the previously committed pair before changing the compatibility alias.
  let previous;try{previous=fs.realpathSync(root+'/certs/current');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(previous&&path.dirname(previous)===path.resolve(root+'/certs')&&/^pair-[A-Za-z0-9]+$/.test(path.basename(previous)))atomic(previous+'/.ready','1',0o644);
  // Stage a complete pair before switching. A crash cannot expose a mixed certificate/key.
  const directory=fs.mkdtempSync(root+'/certs/pair-');chown(directory,owner,gid);fs.chmodSync(directory,0o750);
  const current=root+'/certs/current',next=current+'.next';
  try {
    for(const [file,content]of [['fullchain.pem',chain],['privkey.pem',key]]){atomic(directory+'/'+file,content,0o640);chown(directory+'/'+file,owner,gid);}
    fs.rmSync(next,{force:true});fs.symlinkSync(path.basename(directory),next);fs.renameSync(next,current);
    atomic(directory+'/.ready','1',0o644);
    // Compatibility with existing configurations. Both links follow the same current pair.
    for(const file of ['fullchain.pem','privkey.pem']){const target=root+'/certs/'+file;fs.rmSync(target+'.next',{force:true});fs.symlinkSync('current/'+file,target+'.next');fs.renameSync(target+'.next',target);}
    if(activate){
      const kept=previousSources.filter(p=>p.source!==source&&JSON.stringify(p.names?.slice().sort())!==JSON.stringify(names));
      atomic(root+'/tls-sources.json',JSON.stringify({sources:[...kept,{source,names}]}),0o600);
    }
    atomic(root+'/certs/renewed',String(Date.now()),0o644);
    for(const entry of fs.readdirSync(root+'/certs',{withFileTypes:true}))if(entry.isDirectory()&&/^pair-[A-Za-z0-9]+$/.test(entry.name)&&entry.name!==path.basename(directory)){
      const target=root+'/certs/'+entry.name;let obsolete=false;
      try{const p=readPair(target);obsolete=!fs.existsSync(target+'/.ready')||JSON.stringify(namesOf(validateCertificatePair(p.chain,p.key)))===JSON.stringify(names);}catch{obsolete=true;}
      if(obsolete)fs.rmSync(target,{recursive:true,force:true});
    }
  } finally {fs.rmSync(next,{force:true});}
}
export const applyVPNCertificate=options=>withLock('/run/lock/nexus404-vpn-cert.lock',()=>{
  renewVPNCertificate(options);
  if(options?.activate)atomic((options.root??'/var/lib/nexus404-vpn')+'/tls-source.json',JSON.stringify({source:options.source}),0o600);
});
export function certificateHookSource(argument,{root='/var/lib/nexus404-vpn',lineage=process.env.RENEWED_LINEAGE}={}) {
  if(argument&&argument!=='--acme'){if(!path.isAbsolute(argument))throw Error('Нужен абсолютный каталог сертификата');return argument;}
  const expected=argument==='--acme'?(lineage||ACME_SOURCE):'/etc/letsencrypt/live/nexus404-vpn';
  try{
    const registered=JSON.parse(fs.readFileSync(root+'/tls-sources.json','utf8')).sources;
    return registered.some(p=>p.source===expected)&&(!lineage||lineage===expected)?expected:null;
  }catch(e){if(e.code!=='ENOENT')throw e;}
  let active;try{active=JSON.parse(fs.readFileSync(root+'/tls-source.json','utf8')).source;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(active!==undefined&&active!==expected)return null;
  if(argument==='--acme'&&active===undefined)return null;
  if(lineage&&lineage!==expected)return null;
  return expected;
}
if(direct(import.meta.url))await withLock('/run/lock/nexus404-vpn-cert.lock',()=>{
  // Resolve under the lock: a concurrent switch to imported TLS invalidates old hooks.
  const source=certificateHookSource(process.argv[2]);if(source)renewVPNCertificate({source});
});
