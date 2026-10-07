import fs from 'node:fs';
import {atomic,query,direct} from './common.mjs';
export function renewVPNCertificate(){
const root='/var/lib/nexus404-vpn',gid=+query('id',['-g','nexus404-vpn']).text;
if(!Number.isInteger(gid)||gid<=0)throw Error('Нет пользователя VPN');
for(const name of ['fullchain.pem','privkey.pem']){const content=fs.readFileSync('/etc/letsencrypt/live/nexus404-vpn/'+name,'utf8');if(!content.startsWith('-----BEGIN '))throw Error('Неверный сертификат');atomic(root+'/certs/'+name,content,0o640);fs.chownSync(root+'/certs/'+name,0,gid);}
atomic(root+'/certs/renewed',String(Date.now()),0o644);

}
if(direct(import.meta.url))renewVPNCertificate();
