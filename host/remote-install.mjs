import fs from 'node:fs';
import {BASE} from './common.mjs';
import {installAgent} from './agent-install.mjs';
import {installVPNNode} from './vpn-install.mjs';
export async function installRemote(ui,{agent=installAgent,node=installVPNNode,hasVPN=()=>fs.existsSync(BASE+'/vpn-mode')}={}) {
  ui.section('Удалённый VPS · установка и обновление');
  ui.line('1  Агент · мониторинг, события и обслуживание');
  ui.line('2  Агент + VPN-нода');
  ui.line('0  Назад');
  ui.line('Домен VPS не нужен. Потребуются адрес хаба и одноразовый код из Атланта.');
  ui.line('Базовая настройка запускается отдельно через пункт 1 главного меню.');
  const choice=await ui.ask('Режим',v=>['0','1','2'].includes(v));
  if(choice==='0')return;
  if(choice==='2')return node(ui);
  if(hasVPN())ui.line('[*] Обновится только агент; установленная VPN-нода сохраняется. Для обновления обоих выбери режим 2.');
  return agent(ui);
}
