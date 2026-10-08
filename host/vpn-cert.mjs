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
export function renewVPNCertificate({source='/etc/letsencrypt/live/nexus404-vpn',root='/var/lib/nexus404-vpn',name,gid=+query('id',['-g','nexus404-vpn']).text,owner=0,chown=fs.chownSync}={}) {
  if(!Number.isInteger(gid)||gid<=0)throw Error('Нет пользователя VPN');
  const read=file=>{if(fs.statSync(file).size>128*1024)throw Error('Слишком большой TLS-файл');return fs.readFileSync(file,'utf8');};
  const chain=read(source+'/fullchain.pem'),key=read(source+'/privkey.pem');
  validateCertificatePair(chain,key,{name});
  // Stage a complete pair before switching. A crash cannot expose a mixed certificate/key.
  const directory=fs.mkdtempSync(root+'/certs/pair-');chown(directory,owner,gid);fs.chmodSync(directory,0o750);
  const current=root+'/certs/current',next=current+'.next';
  try {
    for(const [file,content]of [['fullchain.pem',chain],['privkey.pem',key]]){atomic(directory+'/'+file,content,0o640);chown(directory+'/'+file,owner,gid);}
    fs.rmSync(next,{force:true});fs.symlinkSync(path.basename(directory),next);fs.renameSync(next,current);
    // Compatibility with existing configurations. Both links follow the same current pair.
    for(const file of ['fullchain.pem','privkey.pem']){const link=root+'/certs/'+file;fs.rmSync(link+'.next',{force:true});fs.symlinkSync('current/'+file,link+'.next');fs.renameSync(link+'.next',link);}
    atomic(root+'/certs/renewed',String(Date.now()),0o644);
    for(const entry of fs.readdirSync(root+'/certs'))if(/^pair-[A-Za-z0-9]+$/.test(entry)&&entry!==path.basename(directory))fs.rmSync(root+'/certs/'+entry,{recursive:true,force:true});
  } finally {fs.rmSync(next,{force:true});}
}
export const applyVPNCertificate=options=>withLock('/run/lock/nexus404-vpn-cert.lock',()=>{
  renewVPNCertificate(options);
  if(options?.activate)atomic((options.root??'/var/lib/nexus404-vpn')+'/tls-source.json',JSON.stringify({source:options.source}),0o600);
});
export function certificateHookSource(argument,{root='/var/lib/nexus404-vpn',lineage=process.env.RENEWED_LINEAGE}={}) {
  if(argument&&argument!=='--acme'){if(!path.isAbsolute(argument))throw Error('Нужен абсолютный каталог сертификата');return argument;}
  const expected=argument==='--acme'?ACME_SOURCE:'/etc/letsencrypt/live/nexus404-vpn';
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
