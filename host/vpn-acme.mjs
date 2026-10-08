import fs from 'node:fs';
import path from 'node:path';
import {query,apt,atomic,HOST,NODE} from './common.mjs';
export const CERTBOT_VERSION='5.8.0';
export const CERTBOT_ROOT='/opt/nexus404/certbot';
export const ACME_ROOT='/var/lib/nexus404-vpn/acme';
export const ACME_SOURCE=ACME_ROOT+'/config/live/nexus404-vpn';
export function supportsIP(result){return !!result?.ok&&result.text.includes('--ip-address')&&result.text.includes('--required-profile');}
export async function ensureCertbot(ui,{ip=true,inspect=query,packages=apt,root=CERTBOT_ROOT,systemCandidates=['/usr/bin/certbot','/usr/local/bin/certbot']}={}) {
  const usable=binary=>{const version=inspect(binary,['--version']);if(!version.ok)return false;return !ip||supportsIP(inspect(binary,['--help','all']));};
  const current=root+'/current/bin/certbot';
  if(usable(current))return current;
  for(const binary of systemCandidates)if(usable(binary))return binary;
  ui.line('[*] Подготавливаю совместимый Certbot '+CERTBOT_VERSION+' для этой VPN-ноды.');
  await packages(ui,'Список пакетов','update');
  await packages(ui,'Компоненты Certbot','install','-y','--no-install-recommends','python3-venv','ca-certificates');
  const version=inspect('python3',['--version']);
  const match=/Python (\d+)\.(\d+)/.exec(version.text);
  if(!version.ok||!match||+match[1]<3||(+match[1]===3&&+match[2]<10))throw Error('Certbot требует Python 3.10+: нужен Debian 12+ или Ubuntu 22.04+. Системный Python не заменён.');
  fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
  // Venv scripts contain absolute paths: never rename a prepared environment.
  const stage=fs.mkdtempSync(root+'/v'+CERTBOT_VERSION+'-');let selected=false;
  try{
    await ui.run('Изолированный Certbot','python3',['-m','venv',stage]);
    await ui.run('Установка Certbot '+CERTBOT_VERSION,stage+'/bin/python',['-m','pip','--isolated','--disable-pip-version-check','install','--no-cache-dir','--only-binary=:all:','--index-url','https://pypi.org/simple','certbot=='+CERTBOT_VERSION,'acme=='+CERTBOT_VERSION]);
    if(!usable(stage+'/bin/certbot')||!inspect(stage+'/bin/certbot',['--version']).text.includes('certbot '+CERTBOT_VERSION))throw Error('Новый Certbot не прошёл проверку версии и возможностей');
    const next=root+'/current.next';fs.rmSync(next,{force:true});fs.symlinkSync(path.basename(stage),next);fs.renameSync(next,root+'/current');selected=true;
    return current;
  }finally{if(!selected)fs.rmSync(stage,{recursive:true,force:true});}
}
export const acmeDirectories=(root=ACME_ROOT)=>['--config-dir',root+'/config','--work-dir',root+'/work','--logs-dir',root+'/logs'];
export function prepareACME({root=ACME_ROOT,write=atomic}={}){
  fs.mkdirSync(root,{recursive:true,mode:0o700});fs.chmodSync(root,0o700);
  write(root+'/config/renewal-hooks/deploy/nexus404-vpn','#!/bin/sh\nexec '+NODE+' '+HOST+'/vpn-cert.mjs --acme\n',0o700);
}
export async function installRenewal(ui,binary,{inspect=query,write=atomic,root=ACME_ROOT}={}) {
  // Only trusted installer-selected paths may appear in a root unit.
  if(!/^\/(?:usr\/(?:local\/)?bin\/certbot|opt\/nexus404\/certbot\/current\/bin\/certbot)$/.test(binary))throw Error('Неизвестный путь Certbot');
  write('/etc/systemd/system/nexus404-vpn-cert-renew.service',`[Unit]
Description=NEXUS404 VPN TLS renewal
After=network-online.target
Wants=network-online.target
OnFailure=nexus404-event-failure@%n.service
[Service]
Type=oneshot
UMask=0077
TimeoutStartSec=15min
ExecStart=${binary} renew --cert-name nexus404-vpn ${acmeDirectories(root).join(' ')} --quiet --no-random-sleep-on-renew
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${root} /var/lib/nexus404-vpn/certs /run/lock
`,0o644);
  write('/etc/systemd/system/nexus404-vpn-cert-renew.timer','[Unit]\nDescription=NEXUS404 VPN TLS renewal schedule\n[Timer]\nOnCalendar=*-*-* 00,06,12,18:00:00\nRandomizedDelaySec=10min\nPersistent=true\n[Install]\nWantedBy=timers.target\n',0o644);
  await ui.run('Обновление таймера TLS','systemctl',['daemon-reload']);
  await ui.run('Автопродление TLS','systemctl',['enable','--now','nexus404-vpn-cert-renew.timer']);
  if(!inspect('systemctl',['is-active','--quiet','nexus404-vpn-cert-renew.timer']).ok)throw Error('Таймер продления TLS не запущен');
}
