(() => {
  const median=values=>{const a=[...values].sort((a,b)=>a-b),i=Math.floor(a.length/2);return a.length?(a.length%2?a[i]:(a[i-1]+a[i])/2):null;};
  function stats(samples){
    const good=samples.filter(s=>s.ok),times=good.map(s=>s.ms),sorted=[...times].sort((a,b)=>a-b),differences=[];
    for(let i=1;i<samples.length;i++)if(samples[i].ok&&samples[i-1].ok)differences.push(Math.abs(samples[i].ms-samples[i-1].ms));
    return {sent:samples.length,failed:samples.length-good.length,median:median(times),p95:sorted.length?sorted[Math.ceil(sorted.length*.95)-1]:null,jitter:median(differences),failurePercent:samples.length?(samples.length-good.length)/samples.length*100:null};
  }
  function outages(samples,end){
    const rows=[];let start=null;
    for(const s of samples){if(!s.ok&&start===null)start=s.at;if(s.ok&&start!==null){rows.push({at:start,duration:s.at+s.ms-start,recovered:true});start=null;}}
    if(start!==null)rows.push({at:start,duration:Math.max(0,end-start),recovered:false});
    return rows;
  }
  function summarize(run){
    const baseline=stats(run.samples.filter(s=>s.phase==='idle')),loaded=stats(run.samples.filter(s=>s.phase==='load')),all=stats(run.samples),paths=[...new Set(run.samples.filter(s=>s.ok).map(s=>s.path))];
    return {baseline,loaded,all,increase:baseline.median!==null&&loaded.median!==null?loaded.median-baseline.median:null,paths,outages:outages(run.samples,run.duration)};
  }
  globalThis.NexusVPNDiagnosticStats=Object.freeze({median,stats,outages,summarize});
})();
