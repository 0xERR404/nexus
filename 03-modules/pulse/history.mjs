import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
export async function readHistory(file,hours=24,now=Date.now()) {
  const range=[1,6,24,168].includes(Number(hours))?Number(hours):24,from=now-range*3600000;
  try{
    const target=path.join(path.dirname(file),'pulse-history.json');
    if((await stat(target)).size>4*1024*1024)throw Error('oversized');
    const data=JSON.parse(await readFile(target,'utf8'));
    if(data.schema!==1||!Array.isArray(data.points)||data.points.length>10081)throw Error('invalid');
    const number=n=>Number.isFinite(n)&&n>=0&&n<=100?n:null;
    const input=data.points.filter(p=>Number.isFinite(p.time)&&p.time>=from&&p.time<=now).sort((a,b)=>a.time-b.time);
    const width=Math.max(60000,Math.ceil(range*3600000/360));
    const buckets=new Map();
    for(const p of input){const key=Math.floor((p.time-from)/width);if(!buckets.has(key))buckets.set(key,[]);buckets.get(key).push(p);}
    const points=[];
    for(const [bucket,rows] of buckets){
      const avg=key=>{const values=rows.map(r=>number(r[key])).filter(v=>v!==null);return values.length?values.reduce((a,b)=>a+b,0)/values.length:null;};
      const last=rows.at(-1);points.push({time:last.time,bucket,cpu:avg('cpu'),memory:avg('memory'),disk:avg('disk'),uptime:Number.isFinite(last.uptime)?last.uptime:null});
    }
    return {available:true,from,to:now,hours:range,interval:width,first:input[0]?.time??null,last:input.at(-1)?.time??null,samples:input.length,points,stale:!input.length||now-input.at(-1).time>180000};
  }catch{return {available:false,from,to:now,hours:range,interval:60000,points:[],samples:0,stale:true};}
}
