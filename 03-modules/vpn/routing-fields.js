(() => {
  const ipRule=r=>r.type==='ip'||r.type==='geoip';
  const display=r=>({domain:'full:',suffix:'domain:',geosite:'geosite:',geoip:'geoip:',ip:''}[r.type]??'')+r.value;
  function parseField(text,field){
    text=String(text??'').trim();if(!text)return [];
    const label=field==='ip'?'IP':'Домены';
    text=text.replace(new RegExp('^"'+(field==='ip'?'ip':'domain')+'"\\s*:\\s*'),'');
    let values;
    if(text.startsWith('[')){
      try{values=JSON.parse(text.replace(/,\s*$/,''));}catch{throw Error(label+': незавершённый или неверный JSON-массив');}
      if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))throw Error(label+': нужен массив строк');
    }else values=text.split(/[,\r\n]+/).map(v=>v.trim()).filter(Boolean).map(v=>{
      if(v.startsWith('"')){try{return JSON.parse(v);}catch{throw Error(label+': неверные кавычки в строке '+v);}}
      return v;
    });
    return [...new Set(values.map(v=>v.trim()))].map(value=>{
      if(!value||/[\s"{}\[\],]/.test(value))throw Error(label+': неверная запись '+value);
      const p=/^(geosite|geoip|domain|full):(.+)$/i.exec(value);
      if(p){const prefix=p[1].toLowerCase();if((field==='ip')!==(prefix==='geoip'))throw Error(label+': запись '+value+' нужно перенести в другое поле');return {type:{geosite:'geosite',geoip:'geoip',domain:'suffix',full:'domain'}[prefix],value:p[2]};}
      return {type:field==='ip'?'ip':'suffix',value};
    });
  }
  function groups(rules){
    const result=[];
    for(const rule of rules){
      let block=result.at(-1);
      // Keep an IP-before-domain boundary intact: DNS resolution and priorities matter.
      if(!block||block.target!==rule.target||block.exception!==!!rule.exception||(!ipRule(rule)&&block.ips.length)){
        block={target:rule.target,exception:!!rule.exception,domains:[],ips:[]};result.push(block);
      }
      block[ipRule(rule)?'ips':'domains'].push(display(rule));
    }
    return result;
  }
  function rules(blocks){return blocks.flatMap(b=>[...parseField(b.domains,'domain'),...parseField(b.ips,'ip')].map(r=>({...r,target:b.target,exception:!!b.exception})));}
  globalThis.NexusVPNRouting=Object.freeze({parseField,groups,rules,display});
})();
