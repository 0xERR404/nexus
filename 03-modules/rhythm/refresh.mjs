import {randomUUID} from 'node:crypto';

// Ephemeral commands, never a measurement receipt. One stream per source.
export class Refresh {
  constructor(store, now = Date.now) { this.store=store; this.now=now; this.channels=new Map(); this.requests=new Map(); }
  watch(device, authenticate) {
    this.channels.get(device.id)?.close();
    let channel;
    const body=new ReadableStream({
      start: controller => {
        let timer, closed=false;
        const close=()=>{if(closed)return;closed=true;clearInterval(timer);if(this.channels.get(device.id)===channel)this.channels.delete(device.id);try{controller.close();}catch{}};
        channel={close,send: value=>{if(closed)return;try{authenticate();controller.enqueue(new TextEncoder().encode(JSON.stringify(value)+'\n'));}catch{close();}}};
        this.channels.set(device.id,channel);
        channel.send({type:'ready'});
        const pending=this.requests.get(device.id);
        if(pending?.state==='requested' && this.now()-pending.at<180000)channel.send({type:'refresh',id:pending.id});
        if(closed)return;
        const started=this.now();
        timer=setInterval(()=>{if(this.now()-started>=1800000)close();else channel.send({type:'ping'});},120000);timer.unref();
      },
      cancel:()=>channel?.close()
    });
    return new Response(body,{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store, no-transform','X-Accel-Buffering':'no'}});
  }
  request() {
    const now=this.now();
    for(const device of this.store.devices()) {
      if(device.revoked)continue;
      const channel=this.channels.get(device.id);

      const old=this.requests.get(device.id);
      if(old && (now-old.at<60000 || (['requested','reading','queued'].includes(old.state)&&now-old.at<180000)))continue;
      const next={id:randomUUID(),at:now,state:'requested'};
      this.requests.set(device.id,next);channel?.send({type:'refresh',id:next.id});
    }
    return this.status();
  }
  acknowledge(device, data) {
    const current=this.requests.get(device.id);
    const order=['requested','reading','queued','delivered'];
    if(!current || current.id!==data.id || this.now()-current.at>180000)return {ok:false};
    if(!['reading','queued','delivered','failed'].includes(data.state))return {ok:false};
    if(current.state==='failed' || current.state==='delivered')return {ok:current.state===data.state};
    if(data.state!=='failed' && order.indexOf(data.state)<order.indexOf(current.state))return {ok:true};
    current.state=data.state;return {ok:true};
  }
  status() {
    return this.store.devices().filter(d=>!d.revoked).map(d=>{
      const r=this.requests.get(d.id);
      return {device:d.id,name:d.name,online:this.channels.has(d.id),state:r?(this.now()-r.at>180000 && ['requested','reading','queued'].includes(r.state)?'timeout':r.state):'idle',at:r?.at??0,lastSync:d.last_sync};
    });
  }
  revoke(id) {this.channels.get(id)?.close();this.requests.delete(id);}
  close() {for(const c of this.channels.values())c.close();this.requests.clear();}
}
