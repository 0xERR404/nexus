import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BASE,HOST,NODE,HUB,ROOT,atomic,query,exec,supported} from './common.mjs';
import {renewVPNCertificate} from './vpn-cert.mjs';
import {installAgent} from './agent-install.mjs';
import {installModule} from './platform.mjs';
import {readState,durable} from '../02-hub/src/agent-protocol.mjs';
import {CORE_VERSION,hostname,check} from '../02-hub/src/vpn-protocol.mjs';
export const VPN_DIR='/var/lib/nexus404-vpn';
export const vpnUnit=`[Unit]
Description=NEXUS404 VPN node
After=network-online.target
Wants=network-online.target
OnFailure=nexus404-event-failure@%n.service
[Service]
User=nexus404-vpn
Group=nexus404-vpn
SupplementaryGroups=nexus404-agent
ExecStart=${NODE} ${HOST}/vpn-node.mjs
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
UMask=0027
NoNewPrivileges=true
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
ReadWritePaths=${VPN_DIR}/private ${VPN_DIR}/status
[Install]
WantedBy=multi-user.target
`;
export async function installVPNPanel(ui){
  supported();check(!fs.existsSync(BASE+'/agent-mode'),'Панель нельзя установить на VPS агента');check(fs.existsSync(HUB+'/config/auth.json'),'Сначала установи хаб через пункт 5');
  await installModule(ui,'vpn');ui.line('[✓] Арго установлен в хаб. VPN-ядро здесь не устанавливается.');
}
export async function installVPNNode(ui,{baseSetup=true,update=false}={}){
  supported();check(!fs.existsSync(HUB+'/config/auth.json'),'VPN-нода устанавливается только на отдельном VPS');
  if(!update)await installAgent(ui,{baseSetup});
  ui.section('VPN-нода · ядро и TLS');
  const identity=readState('/var/lib/nexus404-agent/credentials.json',null);check(identity?.id,'Сначала зарегистрируй агент');
  if(!query('id',['nexus404-vpn']).ok)await ui.run('Пользователь VPN','useradd',['--system','--home-dir',VPN_DIR,'--no-create-home','--shell','/usr/sbin/nologin','nexus404-vpn']);
  const uid=+query('id',['-u','nexus404-vpn']).text,gid=+query('id',['-g','nexus404-vpn']).text,agent=+query('id',['-u','nexus404-agent']).text,agentGroup=+query('id',['-g','nexus404-agent']).text;
  check([uid,gid,agent,agentGroup].every(n=>Number.isInteger(n)&&n>0));
  for(const [folder,owner,group,mode]of [['',0,0,0o755],['private',uid,gid,0o700],['status',uid,agentGroup,0o2750],['requests',agent,gid,0o2750],['certs',0,gid,0o750]]){const dir=path.join(VPN_DIR,folder);fs.mkdirSync(dir,{recursive:true});fs.chownSync(dir,owner,group);fs.chmodSync(dir,mode);}
  for(const file of ['host/vpn-node.mjs','02-hub/src/vpn-protocol.mjs']){const target='/opt/nexus404/'+file;fs.copyFileSync(ROOT+'/'+file,target);fs.chmodSync(target,0o644);}
  durable(VPN_DIR+'/settings.json',{node:identity.id},0o644);
  const arch={x64:'64',arm64:'arm64-v8a'}[os.arch()];check(arch,'VPN-нода поддерживает amd64 и arm64');
  const target='/opt/nexus404/vpn';fs.mkdirSync(target,{recursive:true,mode:0o755});fs.chmodSync(target,0o755);
  if(!query('unzip',['-v']).ok)await ui.run('Распаковка пакета ядра','apt-get',['install','-y','--no-install-recommends','unzip']);
  const temporary=fs.mkdtempSync('/tmp/nexus404-vpn-');
  try{
    const name=`Xray-linux-${arch}.zip`,url=`https://github.com/XTLS/Xray-core/releases/download/v${CORE_VERSION}/${name}`;
    await ui.run('Загрузка закреплённой версии Xray','curl',['--fail','--location','--proto','=https','--proto-redir','=https','--connect-timeout','15','--max-time','180','-o',temporary+'/'+name,url]);
    await ui.run('Контрольная сумма Xray','curl',['--fail','--location','--proto','=https','--proto-redir','=https','--connect-timeout','15','--max-time','60','-o',temporary+'/checksum',url+'.dgst']);
    const digest=createHash('sha256').update(fs.readFileSync(temporary+'/'+name)).digest('hex'),reference=fs.readFileSync(temporary+'/checksum','utf8');
    check(new RegExp('(?:^|[^a-f0-9])'+digest+'(?:[^a-f0-9]|$)','i').test(reference),'Контрольная сумма Xray не совпала');
    await exec('unzip',['-q',temporary+'/'+name,'xray','LICENSE','-d',temporary+'/unpacked']);
    const verified=query(temporary+'/unpacked/xray',['version']);check(verified.ok&&verified.text.includes('Xray '+CORE_VERSION),'Неверная версия ядра');
    // Install atomically; a failed download never replaces the working executable.
    for(const name of ['xray','LICENSE']){fs.copyFileSync(temporary+'/unpacked/'+name,target+'/'+name+'.next');fs.chmodSync(target+'/'+name+'.next',name==='xray'?0o755:0o644);fs.renameSync(target+'/'+name+'.next',target+'/'+name);}
  }finally{fs.rmSync(temporary,{recursive:true,force:true});}
  if(!update){
    ui.line('Reality не требует сертификата. Trojan и Hysteria 2 требуют домен этой ноды и TLS.');
    if((await ui.prompt('Выпустить TLS через Let’s Encrypt? 1 — да, Enter — позже'))==='1'){
      const domain=hostname(await ui.prompt('Домен, указывающий на этот VPS')),email=await ui.prompt('Email для Let’s Encrypt');check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Неверный email');
      await ui.run('Certbot для TLS','apt-get',['install','-y','--no-install-recommends','certbot']);
      if(query('ufw',['status']).text.includes('Status: active'))await ui.run('HTTP-проверка сертификата','ufw',['allow','80/tcp']);
      await ui.run('Выпуск сертификата','certbot',['certonly','--standalone','--non-interactive','--agree-tos','--email',email,'--cert-name','nexus404-vpn','-d',domain,'--keep-until-expiring']);
      fs.copyFileSync(ROOT+'/host/vpn-cert.mjs',HOST+'/vpn-cert.mjs');fs.chmodSync(HOST+'/vpn-cert.mjs',0o644);
      // Fixed hook, no remotely supplied shell command or path.
      atomic('/etc/letsencrypt/renewal-hooks/deploy/nexus404-vpn','#!/bin/sh\nexec '+NODE+' '+HOST+'/vpn-cert.mjs\n',0o755);
      renewVPNCertificate();await ui.run('Автообновление TLS','systemctl',['enable','--now','certbot.timer']);
    }
    ui.line('Порты VPN открываются здесь явно. Панель не меняет firewall удалёнными командами.');
    const ports=await ui.prompt('Разрешённые порты: например 443/tcp,443/udp · Enter — не менять');
    if(ports){const list=ports.split(',').map(x=>x.trim());check(list.length<=32&&list.every(p=>/^(?:[1-9]\d{0,4})\/(?:tcp|udp)$/.test(p)&&+p.split('/')[0]<=65535),'Неверный список портов');for(const port of list)await ui.run('Порт VPN '+port,'ufw',['allow',port]);}
  }
  fs.copyFileSync(ROOT+'/host/vpn-cert.mjs',HOST+'/vpn-cert.mjs');fs.chmodSync(HOST+'/vpn-cert.mjs',0o644);
  atomic('/etc/systemd/system/nexus404-vpn.service',vpnUnit,0o644);atomic(BASE+'/vpn-mode',CORE_VERSION+'\n');
  await ui.run('Обновление служб','systemctl',['daemon-reload']);await ui.run('Автозапуск VPN-ноды','systemctl',['enable','--now','nexus404-vpn.service']);await ui.run('Применение обновления VPN','systemctl',['restart','nexus404-vpn.service']);
  ui.line('[✓] VPN-нода готова. В Арго выбери этот агент и добавь подключения. Хаб на VPS не установлен.');
}
