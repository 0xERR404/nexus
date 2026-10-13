import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {hoppingPlan,hopRanges} from '../02-hub/src/vpn-hysteria.mjs';
import {durable,readState} from '../02-hub/src/agent-protocol.mjs';
export const PORTS_CONFIG='/etc/nexus404-vpn-ports.json',PORTS_STATE='/run/nexus404-vpn-ports/applied.json';
const table='nexus404_vpn_hop';
export function validatePortPlan(plan){
  if(!Array.isArray(plan)||plan.length>32||plan.some(p=>!p||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.id))||new Set(plan.map(p=>p.id)).size!==plan.length)throw Error('Неверный план смены портов');
  return hoppingPlan(plan.map(p=>({id:p.id,port:p.port,profile:'hysteria2',hy2:{hopPorts:p.ports}})));
}
export function nftPortScript(plan,exists=false){
  plan=validatePortPlan(plan);
  const lines=exists?[`delete table inet ${table}`]:[];
  if(plan.length){
    lines.push(`table inet ${table} {`,` chain redirect_udp {`,`  type nat hook prerouting priority -101; policy accept;`);
    for(const p of plan)lines.push(`  fib daddr type local udp dport { ${p.ports.split(',').join(', ')} } redirect to :${p.port}`);
    lines.push(' }','}');
  }
  return lines.join('\n')+'\n';
}
const nft=(args,input)=>execFileSync('nft',args,{input,encoding:'utf8',timeout:10000,stdio:['pipe','pipe','pipe']});
const boot=()=>fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
export function applyPortPlan(plan,{run=nft,write=state=>durable(PORTS_STATE,state,0o644),bootId=boot}={}){
  plan=validatePortPlan(plan);let exists=false;
  try{exists=(JSON.parse(run(['--json','list','tables'])).nftables??[]).some(x=>x.table?.family==='inet'&&x.table?.name===table);}
  catch(error){if(plan.length||error.code!=='ENOENT')throw error;}
  if(plan.length||exists){const script=nftPortScript(plan,exists);run(['--check','--file','-'],script);run(['--file','-'],script);}
  // Only a successful atomic nft transaction authorizes publication of hopping profiles.
  write({boot:bootId(),plan});return plan;
}
export function assertPortsReady(connections,{read=()=>readState(PORTS_STATE,null),bootId=boot}={}){
  const required=hoppingPlan(connections),state=read();
  if(!required.length&&!state)return;
  const fail=()=>{throw Object.assign(Error('Смена портов: сохрани настройки и повтори деплой VPN-ноды для применения UDP-переадресации.'),{vpnSetup:true});};
  let installed;try{installed=validatePortPlan(state?.plan??[]);}catch{fail();}
  if(required.length&&(state?.boot!==bootId()||required.some(p=>!installed.some(x=>x.id===p.id&&x.port===p.port&&x.ports===p.ports))))fail();
  // Old redirect rules must not capture a newly selected ordinary UDP listener.
  for(const c of connections.filter(c=>c.enabled!==false&&c.profile==='hysteria2'))for(const p of installed)if(hopRanges(p.ports).some(([a,b])=>c.port>=a&&c.port<=b))fail();
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{const config=readState(PORTS_CONFIG,null);if(!config)throw Error('Нет плана портов');applyPortPlan(config.plan);}
  catch{console.error('Не удалось применить переадресацию портов VPN. Повтори деплой ноды и проверь nftables.');process.exitCode=1;}
}
