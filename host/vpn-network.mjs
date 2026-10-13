import fs from 'node:fs';
import {query,atomic} from './common.mjs';
export function tcpCapabilities({platform=process.platform,read=fs.readFileSync}={}) {
  if(platform!=='linux')return {bbr:false};
  try{
    const algorithms=name=>read('/proc/sys/net/ipv4/tcp_'+name+'_congestion_control','utf8').trim().split(/\s+/);
    // The VPN service is unprivileged: available alone is not sufficient.
    return {bbr:algorithms('available').includes('bbr')&&algorithms('allowed').includes('bbr')};
  }catch{return {bbr:false};}
}
export function prepareTCP(ui,{inspect=query,write=atomic,capabilities=tcpCapabilities}={}) {
  const loaded=inspect('modprobe',['tcp_bbr']),ready=capabilities().bbr;
  if(loaded.ok&&ready){
    try{write('/etc/modules-load.d/nexus404-vpn-bbr.conf','tcp_bbr\n',0o644);}
    catch{ui.line('[*] Не удалось сохранить автозагрузку BBR. После перезагрузки поддержка будет проверена заново.');}
  }
  ui.line(ready?'[✓] BBR доступен для TCP-соединений VPN.':'[*] BBR недоступен: VPN использует системный алгоритм TCP.');
  return {bbr:ready};
}
