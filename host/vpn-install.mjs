import fs from 'node:fs';
import {prepareTCP} from './vpn-network.mjs';
import {hoppingPlan,hopRanges} from '../02-hub/src/vpn-hysteria.mjs';
import {validatePortPlan,PORTS_CONFIG} from './vpn-ports.mjs';
import os from 'node:os';
import {isIP} from 'node:net';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BASE,HOST,NODE,HUB,ROOT,atomic,query,exec,supported,apt,sleep} from './common.mjs';
import {applyVPNCertificate} from './vpn-cert.mjs';
import {ensureCertbot,prepareACME,acmeDirectories,installRenewal,certificateName,certificateSource} from './vpn-acme.mjs';
import {installAgent} from './agent-install.mjs';
import {installModule} from './platform.mjs';
import {readState,durable} from '../02-hub/src/agent-protocol.mjs';
import {CORE_VERSION,NODE_VERSION,PROFILES,API_PORT,integer,hostname,check} from '../02-hub/src/vpn-protocol.mjs';
export const VPN_DIR='/var/lib/nexus404-vpn';
export const vpnUnit=`[Unit]
Description=NEXUS404 VPN node
After=network-online.target nexus404-vpn-ports.service
Requires=nexus404-vpn-ports.service
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
  supported();check(!fs.existsSync(BASE+'/agent-mode'),'Панель нельзя установить на VPS агента');check(fs.existsSync(HUB+'/config/auth.json'),'Сначала установи хаб: Хаб и модули → Установить / настроить хаб');
  await installModule(ui,'vpn');ui.line('[✓] Арго установлен в хаб. VPN-ядро здесь не устанавливается.');
}
export async function installVPNNode(ui,{update=false}={}){
  supported();check(!fs.existsSync(HUB+'/config/auth.json'),'VPN-нода устанавливается только на отдельном VPS');
  if(update)check(fs.existsSync(BASE+'/vpn-mode'),'Сначала установи VPN-ноду через --vpn-node');
  if(!update)await installAgent(ui);
  ui.section('VPN-нода · ядро и TLS');
  const identity=readState('/var/lib/nexus404-agent/credentials.json',null);check(identity?.id,'Сначала зарегистрируй агент');
  if(!query('id',['nexus404-vpn']).ok)await ui.run('Пользователь VPN','useradd',['--system','--user-group','--home-dir',VPN_DIR,'--no-create-home','--shell','/usr/sbin/nologin','nexus404-vpn']);
  const uid=+query('id',['-u','nexus404-vpn']).text,gid=+query('id',['-g','nexus404-vpn']).text,agent=+query('id',['-u','nexus404-agent']).text,agentGroup=+query('id',['-g','nexus404-agent']).text;
  check([uid,gid,agent,agentGroup].every(n=>Number.isInteger(n)&&n>0));
  for(const [folder,owner,group,mode]of [['',0,0,0o755],['private',uid,gid,0o700],['status',uid,agentGroup,0o2750],['requests',agent,gid,0o2750],['certs',0,gid,0o750]]){const dir=path.join(VPN_DIR,folder);fs.mkdirSync(dir,{recursive:true});fs.chownSync(dir,owner,group);fs.chmodSync(dir,mode);}
  installVPNRuntime();
  prepareTCP(ui);
  if(update)await ui.run('Обновление обмена с хабом','systemctl',['restart','nexus404-agent.service']);
  durable(VPN_DIR+'/settings.json',{node:identity.id},0o644);
  const arch={x64:'64',arm64:'arm64-v8a'}[os.arch()];check(arch,'VPN-нода поддерживает amd64 и arm64');
  const target='/opt/nexus404/vpn';fs.mkdirSync(target,{recursive:true,mode:0o755});fs.chmodSync(target,0o755);
  if(!query('unzip',['-v']).ok){await apt(ui,'Список пакетов','update');await apt(ui,'Распаковка пакета ядра','install','-y','--no-install-recommends','unzip');}
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
  if(!update)await configureNodeTLS(ui);
  await deployVPNPorts(ui,{node:identity.id,update,configureHopping:plan=>installVPNPortHopping(ui,plan)});
  atomic('/etc/systemd/system/nexus404-vpn.service',vpnUnit,0o644);atomic(BASE+'/vpn-mode',CORE_VERSION+'\n');
  await ui.run('Обновление служб','systemctl',['daemon-reload']);await ui.run('Автозапуск VPN-ноды','systemctl',['enable','nexus404-vpn.service']);const restartAt=Date.now();await ui.run('Применение обновления VPN','systemctl',['restart','nexus404-vpn.service']);
  check(query('systemctl',['is-active','--quiet','nexus404-vpn.service']).ok,'VPN-служба не запустилась. Проверь journalctl -u nexus404-vpn.');
  const runtime=await verifyVPNRuntime({since:restartAt});
  ui.line('[✓] VPN-нода '+runtime.nodeVersion+' запущена. Trojan TCP, XHTTP и gRPC поддерживаются.');
  if(runtime.state==='rejected')ui.line('[!] Конфигурация отклонена: '+runtime.error+'. Подробности — в Арго.');
  else ui.line('Статус применения подключений — в Арго. Хаб на VPS не установлен.');
}

export const VPN_RUNTIME_FILES=['host/common.mjs','host/agent.mjs','host/agent-http.mjs','host/vpn-node.mjs','host/vpn-network.mjs','host/vpn-acme.mjs','host/vpn-ports.mjs','host/vpn-cert.mjs','02-hub/src/agent-protocol.mjs','02-hub/src/vpn-protocol.mjs','02-hub/src/vpn-hysteria.mjs','02-hub/src/vpn-transport.mjs'];
export function installVPNRuntime({source=ROOT,target='/opt/nexus404'}={}){
  // Validate the complete set before replacing any runtime file.
  const files=VPN_RUNTIME_FILES.map(name=>({name,data:fs.readFileSync(path.join(source,name))}));
  for(const {name,data}of files){
    const destination=path.join(target,name);fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o755});
    if(path.resolve(source,name)!==path.resolve(destination))atomic(destination,data,0o644);
    fs.chmodSync(destination,0o644);
    check(fs.readFileSync(destination).equals(data),'Не удалось обновить компонент VPN-ноды');
  }
}
export async function verifyVPNRuntime({since,directory=VPN_DIR,read=readState,now=Date.now,pause=sleep,timeout=30000}={}){
  const deadline=now()+timeout;
  while(now()<deadline){
    const report=read(directory+'/status/report.json',null);
    if(report?.nodeVersion===NODE_VERSION&&report.startedAt>=since&&Object.keys(PROFILES).every(p=>report.capabilities?.profiles?.includes(p))&&report.capabilities?.hysteriaOptions===1)return report;
    await pause(250);
  }
  throw Error('Новая версия VPN-ноды не подтвердила запуск. Обновление не завершено; проверь журнал nexus404-vpn.');
}

export async function deployVPNPorts(ui,{node,update=false,directory=VPN_DIR,read=readState,inspect=query,configureHopping}={}){
  const bundle=read(directory+'/requests/config.json',null),ports=new Set(['443/tcp','443/udp']);
  if(bundle){
    check(bundle.node===node&&Array.isArray(bundle.connections)&&bundle.connections.length<=32,'Не удалось определить порты VPN: неверное задание ноды');
    for(const c of bundle.connections){
      check(c&&c.node===node&&Object.hasOwn(PROFILES,c.profile),'Не удалось определить профиль подключения VPN');
      if(c.enabled===false)continue;
      check(integer(c.port,1,65535)&&![22,80,API_PORT].includes(c.port),'Неверный или зарезервированный порт VPN');
      ports.add(c.port+'/'+(c.profile==='hysteria2'?'udp':'tcp'));
    }
  }
  const plan=hoppingPlan(bundle?.connections??[]);
  for(const p of plan)for(const [a,b] of hopRanges(p.ports))ports.add((a===b?a:a+':'+b)+'/udp');
  ui.line('Порты VPN при установке и обновлении: '+[...ports].join(', ')+'.');
  if(!update){
    const extra=await ui.prompt('Дополнительные порты, например 8443/tcp,8443/udp · Enter — указанные выше');
    if(extra.trim())for(const port of extra.split(','))ports.add(port.trim());
  }
  const applied=await openVPNPorts(ui,[...ports].join(','),{inspect});
  if(configureHopping)await configureHopping(plan);
  if(applied)ui.line('[✓] Правила UFW для VPN применены. Эти же порты должны быть разрешены в firewall провайдера.');
  return applied;
}

export async function openVPNPorts(ui,ports,{inspect=query}={}) {
  const list=[...new Set(ports.split(',').map(x=>x.trim()))];
  check(list.length<=576&&list.every(p=>{const m=/^([1-9]\d{0,4})(?::([1-9]\d{0,4}))?\/(?:tcp|udp)$/.exec(p);return m&&+m[1]<=65535&&(!m[2]||+m[2]>=+m[1]&&+m[2]<=65535);}), 'Неверный список портов');
  const firewall=inspect('ufw',['status']);
  if(!firewall.ok||!firewall.text.includes('Status: active')){ui.line('[*] UFW не активен. Разреши '+list.join(', ')+' в своём firewall и панели VPS. Скрипт не включает и не заменяет firewall.');return false;}
  for(const port of list)await ui.run('Порт VPN '+port,'ufw',['allow',port]);
  return true;
}
export async function installVPNPortHopping(ui,plan,{inspect=query,packages=apt,write=atomic}={}){
  plan=validatePortPlan(plan);
  if(plan.length&&!inspect('nft',['--version']).ok){await packages(ui,'Список пакетов','update');await packages(ui,'Смена портов Hysteria 2','install','-y','--no-install-recommends','nftables');}
  write(PORTS_CONFIG,JSON.stringify({plan})+'\n',0o600);
  write('/etc/systemd/system/nexus404-vpn-ports.service',`[Unit]
Description=NEXUS404 VPN UDP port forwarding
After=network-pre.target ufw.service nftables.service
Before=nexus404-vpn.service
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${NODE} ${HOST}/vpn-ports.mjs
RuntimeDirectory=nexus404-vpn-ports
RuntimeDirectoryMode=0755
UMask=0022
NoNewPrivileges=true
CapabilityBoundingSet=CAP_NET_ADMIN
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/run/nexus404-vpn-ports
[Install]
WantedBy=multi-user.target
`,0o644);
  await ui.run('Служба смены портов','systemctl',['daemon-reload']);
  await ui.run('Автозапуск переадресации','systemctl',['enable','nexus404-vpn-ports.service']);
  await ui.run('Применение UDP-переадресации','systemctl',['restart','nexus404-vpn-ports.service']);
}

export function certificateArguments(address,email,{ip=false,help=''}={}) {
  hostname(address);check(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Неверный email');
  if(ip){check(isIP(address),'Нужен публичный IPv4 / IPv6');check(help.includes('--ip-address')&&help.includes('--required-profile'),'Certbot не прошёл проверку поддержки IP-сертификатов');}
  return ['certonly','--standalone','--preferred-challenges','http','--non-interactive','--agree-tos','--email',email,'--cert-name',certificateName(address),...(ip?['--ip-address',address,'--required-profile','shortlived']:['-d',address]),'--keep-until-expiring'];
}
function copyCertificateRuntime(){
  for(const name of ['vpn-cert','vpn-acme']){const source=ROOT+'/host/'+name+'.mjs',target=HOST+'/'+name+'.mjs';if(source!==target)fs.copyFileSync(source,target);fs.chmodSync(target,0o644);}
}
export async function configureNodeTLS(ui,{inspect=query,packages=apt,renew=applyVPNCertificate,write=atomic,copy=copyCertificateRuntime,ensure=ensureCertbot,prepare=prepareACME,schedule=installRenewal}={}) {
  ui.line('Reality работает без собственного TLS-сертификата. Для Cloudflare нужен сертификат на домен.');
  ui.line('Действующие сертификаты других IP / доменов сохраняются. Подключение получает сертификат по своему SNI.');
  ui.line('Trojan / Hysteria 2: 1 — TLS на IP, 2 — готовый сертификат, 3 — свой домен (необязательно).');
  const mode=await ui.ask('TLS · Enter — сохранить текущий / настроить позже',v=>['','1','2','3'].includes(v),'?');
  if(!mode)return;
  if(mode==='2'){
    const source=await ui.prompt('Абсолютный каталог с fullchain.pem и privkey.pem');
    check(path.isAbsolute(source),'Нужен абсолютный путь');
    const name=hostname(await ui.prompt('IP или имя из сертификата'));
    await renew({source,name,activate:true});
    // Keep renewal of other registered certificates; the hook ignores replaced sources.
    write('/etc/letsencrypt/renewal-hooks/deploy/nexus404-vpn','#!/bin/sh\nexec '+NODE+' '+HOST+'/vpn-cert.mjs\n',0o755);
    ui.line('[✓] TLS установлен. Клиенты должны доверять его CA. Продление — своим ACME-клиентом и вызовом nexus404-node /opt/nexus404/host/vpn-cert.mjs /каталог/сертификата.');
    return;
  }
  const address=hostname(await ui.prompt(mode==='1'?'Публичный IP этого VPS':'Домен, указывающий на этот VPS'));
  if(mode==='1')check(isIP(address),'Нужен IPv4 или IPv6, без домена');
  else check(!isIP(address)&&address.includes('.'),'Нужен полный домен. Для сертификата на IP выбери вариант 1.');
  const email=await ui.prompt('Email для Let’s Encrypt');
  // Validate input before installing an optional component.
  certificateArguments(address,email);
  const binary=await ensure(ui,{ip:mode==='1',inspect,packages});
  const args=certificateArguments(address,email,{ip:mode==='1',help:inspect(binary,['--help','all']).text});
  ui.line('Для выпуска и продления нужен свободный TCP/80, доступный из Интернета. IP-сертификат короткоживущий; порт нужен и впоследствии.');
  const port=inspect('ss',['-H','-ltn','sport = :80']);check(port.ok&&!port.text,'TCP/80 занят или проверка недоступна. Освободи порт либо импортируй сертификат.');
  await openVPNPorts(ui,'80/tcp',{inspect});
  copy();prepare({write});
  await ui.run('Выпуск TLS',binary,[...args,...acmeDirectories()]);
  write('/etc/letsencrypt/renewal-hooks/deploy/nexus404-vpn','#!/bin/sh\nexec '+NODE+' '+HOST+'/vpn-cert.mjs\n',0o755);
  await renew({source:certificateSource(address),name:address,activate:true});
  await schedule(ui,binary,{inspect,write});
}
