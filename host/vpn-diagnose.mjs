import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {sleep} from './common.mjs';
const execute=promisify(execFile);
const read=file=>{try{if(fs.statSync(file).size>2*1024*1024)return null;return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
const age=(now,value)=>Number.isFinite(value)?Math.round((now-value)/1000):null;
const issue=report=>!report?.error?null:/Учёт/.test(report.error)?'accounting':/^TLS:/.test(report.error)?'tls':/Ядро не запустилось/.test(report.error)?'start':/Проверка конфигурации/.test(report.error)?'validation':'request';
export function snapshot(directory='/var/lib/nexus404-vpn',now=Date.now()){
  const report=read(directory+'/status/report.json'),bundle=read(directory+'/requests/config.json');
  let written=null;try{written=fs.statSync(directory+'/status/report.json').mtimeMs;}catch{}
  // Only allowlisted operational fields. Never serialize a raw bundle or credentials.
  return {time:new Date(now).toISOString(),reportAgeSeconds:age(now,written),sampleAgeSeconds:age(now,report?.time),
    state:['applied','rejected','expired','stopped'].includes(report?.state)?report.state:'unknown',
    issue:issue(report),
    running:report?.running===true,appliedRevision:report?.revision??null,requestedRevision:bundle?.revision??null,
    leaseRemainingSeconds:Number.isFinite(bundle?.expires)?Math.round((bundle.expires-now)/1000):null,
    requestAgeSeconds:age(now,bundle?.created),complete:report?.complete??null,
    connections:(bundle?.connections??[]).map(c=>({profile:c.profile,port:c.port,enabled:c.enabled!==false})),
    usageBytes:(report?.usage??[]).reduce((sum,u)=>sum+(Number(u.up)||0)+(Number(u.down)||0),0)};
}
async function command(file,args){
  try{const r=await execute(file,args,{timeout:10000,maxBuffer:256*1024,env:{...process.env,LC_ALL:'C.UTF-8'}});return {ok:true,text:r.stdout.trim()};}
  catch(e){return {ok:false,code:typeof e.code==='number'?e.code:null,text:String(e.stdout??'').trim()};}
}
export async function probe(url,ipv4=false,run=command){
  const r=await run('curl',['--noproxy','*',...(ipv4?['--ipv4']:[]),'-sS','-o','/dev/null','--connect-timeout','4','--max-time','8','-w','%{http_code} %{remote_ip} %{time_namelookup} %{time_connect} %{time_appconnect} %{time_starttransfer} %{time_total}',url]);
  // With no remote IP curl prints an empty field; preserve it when splitting.
  const parts=r.text.trim().split(' ');
  const number=i=>parts[i]!==undefined&&parts[i]!==''&&Number.isFinite(Number(parts[i]))?Number(parts[i]):null;
  return {url,family:ipv4?'IPv4':'auto',ok:r.ok,exit:r.ok?0:r.code,http:number(0),ip:/^[0-9a-f:.]+$/i.test(parts[1]??'')?parts[1]:null,
    dnsSeconds:number(2),tcpSeconds:number(3),tlsSeconds:number(4),firstSeconds:number(5),totalSeconds:number(6)};
}
export async function diagnoseVPN(ui,{duration=180000,interval=5000,directory='/var/lib/nexus404-vpn',outputDirectory='/var/lib/nexus404-menu',now=Date.now,pause=sleep,run=command}={}){
  fs.mkdirSync(outputDirectory,{recursive:true,mode:0o700});
  const output=path.join(outputDirectory,'vpn-stability-'+new Date(now()).toISOString().replaceAll(':','-')+'.jsonl');
  const fd=fs.openSync(output,'wx',0o600),write=data=>fs.writeSync(fd,JSON.stringify(data)+'\n');
  const service=name=>run('systemctl',['show',name,'--property=ActiveState,SubState,NRestarts,MainPID,Result']);
  ui.line('Проверка займёт около трёх минут. Оставь одно подключение Happ и открывай проблемный сайт.');
  ui.line('Сетевые пробы идут с ноды напрямую; участок Happ → нода проверяется отдельно по твоему наблюдению.');
  ui.line('Отчёт: '+output);
  const start=now();let nextProbe=0,samples=0,probes=0,failedProbes=0,unhealthy=0;
  try{
    write({type:'start',time:new Date(start).toISOString(),durationSeconds:duration/1000});
    const firewall=await run('ufw',['status','verbose']);write({type:'firewall',...firewall});
    const listeners=await run('ss',['-H','-lntu']);write({type:'listeners',...listeners});
    do{
      const row=snapshot(directory,now());
      const services=await Promise.all([service('nexus404-vpn.service'),service('nexus404-agent.service')]);
      write({type:'sample',...row,services:{vpn:services[0],agent:services[1]}});samples++;
      if(!row.running||row.state!=='applied'||row.reportAgeSeconds===null||row.reportAgeSeconds>15)unhealthy++;
      if(now()>=nextProbe){
        const results=await Promise.all([probe('https://whoer.net/',false,run),probe('https://whoer.net/',true,run),probe('https://www.gstatic.com/generate_204',true,run)]);
        write({type:'probes',time:new Date(now()).toISOString(),results});probes+=results.length;failedProbes+=results.filter(r=>!r.ok).length;nextProbe=now()+15000;
        ui.line(`${Math.round((now()-start)/1000)} с · VPN ${row.state} · разрешение ${row.leaseRemainingSeconds??'?'} с · Whoer ${results[0].ok?'HTTP '+results[0].http:'сбой '+results[0].exit}`);
      }
      if(now()-start>=duration)break;await pause(Math.min(interval,duration-(now()-start)));
    }while(now()-start<duration);
    write({type:'summary',samples,unhealthySamples:unhealthy,probes,failedProbes});
    ui.line(`Проверка завершена. Срезов: ${samples}, с отклонениями: ${unhealthy}; сетевых проб: ${probes}, ошибок: ${failedProbes}.`);
    ui.line('Пришли файл отчёта: '+output);return output;
  }finally{fs.closeSync(fd);}
}
