// ISO 3166-1 alpha-2. Names come from the Node 24 bundled Russian locale.
const codes='AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const names=new Intl.DisplayNames(['ru'],{type:'region'});
export const countries=codes.map(code=>({code,name:names.of(code),flag:String.fromCodePoint(...[...code].map(c=>127397+c.charCodeAt(0)))})).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
const byCode=new Map(countries.map(c=>[c.code,c]));
export function countryCode(value=''){
  if(typeof value!=='string')throw Object.assign(Error('Выбери страну из списка'),{status:400});
  const code=value.trim().toUpperCase();
  if(code&&!byCode.has(code))throw Object.assign(Error('Выбери страну из списка'),{status:400});
  return code;
}
export const countryLabel=code=>byCode.get(code)?.flag??'';
export const connectionLabel=c=>{const country=countryLabel(c.country);return country?country+' '+c.name:c.name;};
export function proxyNames(connections){
  const used=new Set(['VPN','DIRECT','REJECT',...connections.map(c=>c.id)]),result=new Map();
  for(const c of connections){
    if(!c.country){result.set(c.id,c.id);continue;}
    // Keep labels safe in both routing-rule CSV and DNS proxy selectors.
    const base=connectionLabel(c).replace(/[,#&?=%\r\n]/g,' ');let name=base,n=1;
    while(used.has(name))name=base+' · '+(++n);
    used.add(name);result.set(c.id,name);
  }
  return result;
}
