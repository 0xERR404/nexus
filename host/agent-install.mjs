import fs from 'node:fs';
import {BASE,HOST,NODE,HUB,atomic,installHost,query,exec,supported,apt} from './common.mjs';
import {installEvents,installLogging} from './maintenance.mjs';
import {credentials,AGENT_DATA} from './agent.mjs';
import {installAgentControl,AGENT_CONTROL} from './agent-control.mjs';
import {readState,durable,hubAddress} from '../02-hub/src/agent-protocol.mjs';
export const agentUnit=`[Unit]
Description=NEXUS404 remote agent
After=network-online.target
Wants=network-online.target
OnFailure=nexus404-event-failure@%n.service
[Service]
User=nexus404-agent
Group=nexus404-agent
ExecStart=${NODE} ${HOST}/agent.mjs
Restart=always
RestartSec=5
TimeoutStopSec=25
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
CapabilityBoundingSet=
ReadWritePaths=${AGENT_DATA} ${AGENT_CONTROL}/requests -/var/lib/nexus404-vpn/requests
[Install]
WantedBy=multi-user.target
`;
export async function agentDependencies(ui,{inspect=query,packages=apt}={}) {
  // Only runtime tools; no security policy, SSH, firewall, swap or system upgrade.
  const required=['ca-certificates','curl','cron','logrotate','util-linux','passwd','iproute2','tzdata'];
  const missing=required.filter(name=>{const r=inspect('dpkg-query',['-W','-f=${Status}',name]);return !r.ok||r.text!=='install ok installed';});
  if(missing.length){await packages(ui,'Список пакетов','update');await packages(ui,'Компоненты агента','install','-y','--no-install-recommends',...missing);}
}
export async function installAgent(ui) {
  supported();
  if(fs.existsSync(HUB+'/config/auth.json'))throw Error('Этот VPS уже является хабом. Используй отдельный VPS для агента.');
  ui.section('Агент · компоненты и регистрация');
  await agentDependencies(ui);
  fs.mkdirSync(BASE,{recursive:true,mode:0o700});
  installHost('/opt/nexus404',{agent:true});
  if(!query('id',['nexus404-agent']).ok)await ui.run('Пользователь агента','useradd',['--system','--user-group','--home-dir',AGENT_DATA,'--no-create-home','--shell','/usr/sbin/nologin','nexus404-agent']);
  const uid=+query('id',['-u','nexus404-agent']).text,gid=+query('id',['-g','nexus404-agent']).text;
  if(!Number.isInteger(uid)||uid<=0||!Number.isInteger(gid)||gid<=0)throw Error('Неверный пользователь агента');
  await exec('systemctl',['stop','nexus404-agent.service']).catch(()=>{});
  fs.mkdirSync(AGENT_DATA,{recursive:true,mode:0o700});fs.chownSync(AGENT_DATA,uid,gid);fs.chmodSync(AGENT_DATA,0o700);
  const file=AGENT_DATA+'/credentials.json';
  if(!fs.existsSync(file)){
    const hub=hubAddress(await ui.prompt('HTTPS-адрес хаба · домен или IP с действительным сертификатом'));
    const code=await ui.prompt('Одноразовый код из Атланта',true);
    if(!/^[A-Za-z0-9_-]{32}$/.test(code))throw Error('Некорректный код регистрации');
    credentials(file,hub,code);fs.chownSync(file,uid,gid);
  }
  else if(!readState(file,null)?.id){const code=await ui.prompt('Новый код регистрации · Enter: повторить прежний',true);if(code){if(!/^[A-Za-z0-9_-]{32}$/.test(code))throw Error('Некорректный код');durable(file,{...readState(file,null),code});fs.chownSync(file,uid,gid);}}
  // Credentials and the local queue survive all ordinary upgrades and reruns.
  installAgentControl();
  for(const dir of [AGENT_CONTROL,AGENT_CONTROL+'/status']){fs.chownSync(dir,0,0);fs.chmodSync(dir,0o755);}
  fs.chownSync(AGENT_CONTROL+'/requests',uid,gid);fs.chmodSync(AGENT_CONTROL+'/requests',0o700);
  atomic(BASE+'/agent-mode','1\n');
  installEvents({managed:false});installLogging({managed:false});
  const eventDir='/opt/nexus404/hooks/events';fs.mkdirSync(eventDir,{recursive:true});
  fs.chownSync('/opt/nexus404/hooks',0,gid);fs.chmodSync('/opt/nexus404/hooks',0o750);
  fs.chownSync(eventDir,0,gid);fs.chmodSync(eventDir,0o2750);
  const log=eventDir+'/events.jsonl';if(!fs.existsSync(log))fs.writeFileSync(log,'');fs.chownSync(log,0,gid);fs.chmodSync(log,0o640);
  // Registration executes under the same account as the service, never passing secrets in argv.
  const childCode=`import {Agent} from '${HOST}/agent.mjs';const a=new Agent();try{await a.register();}finally{a.close();}`;
  await ui.run('Регистрация агента','runuser',['-u','nexus404-agent','--',NODE,'--input-type=module','-e',childCode]);
  atomic('/etc/systemd/system/nexus404-agent.service',agentUnit,0o644);
  await ui.run('Обновление служб','systemctl',['daemon-reload']);
  await ui.run('Автозапуск обслуживания','systemctl',['enable','--now','cron.service','nexus404-maintenance-control.timer','nexus404-post-reboot-cleanup.timer','nexus404-logrotate.timer']);
  await ui.run('События VPS','systemctl',['enable','--now','nexus404-ssh-events.service','nexus404-boot-event.service']);
  await ui.run('Обновление обработчика событий','systemctl',['restart','nexus404-ssh-events.service']);
  await ui.run('Автозапуск агента','systemctl',['enable','--now','nexus404-agent.service']);
  if(!query('systemctl',['is-active','--quiet','nexus404-agent.service']).ok)throw Error('Агент не запустился. Проверь journalctl -u nexus404-agent.');
  ui.line('[✓] Агент установлен. Состояние связи и настройки — в Атланте; события — в Гермесе.');
}
