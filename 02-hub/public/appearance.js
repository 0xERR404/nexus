(() => {
  const key='nexus-carbon-appearance-v1', root=document.documentElement;
  const defaults={background:'code',motion:'static',color:'#becb8c',transparency:67};
  const hex=v=>typeof v==='string'&&/^#?[0-9a-f]{6}$/i.test(v.trim())?'#'+v.trim().replace('#','').toLowerCase():null;
  const transparency=v=>typeof v==='number'&&Number.isFinite(v)?Math.max(0,Math.min(100,Math.round(v))):defaults.transparency;
  const clean=v=>({background:['ribbons','code','network','scanner'].includes(v?.background)?v.background:defaults.background,motion:['static','animated'].includes(v?.motion)?v.motion:defaults.motion,color:hex(v?.color)||defaults.color,transparency:v?.glass===false?0:transparency(v?.transparency)});
  const read=()=>{try{return clean(JSON.parse(localStorage.getItem(key)));}catch{return {...defaults};}};
  let prefs=read(),canvas,ctx,frame=0,last=0,phase=0,observer;
  const embedded=parent!==window, reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const rgb=value=>value.slice(1).match(/../g).map(v=>parseInt(v,16));
  const mix=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));
  const luminance=c=>c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
  const css=(c,a=1)=>`rgba(${c.join(',')},${a})`;
  let palette,previewTimer=0;
  function theme(color=prefs.color){
    const raw=rgb(color);let accent=raw.slice();
    // Keep small links readable on the dark panels, including black/blue input.
    while((luminance(accent)+.05)/(luminance([25,27,26])+.05)<7)accent=mix(accent,[255,255,255],.06);
    palette={raw,accent,light:mix(accent,[255,255,255],.35),custom:color!==defaults.color};
    const values={
      '--accent':css(accent),'--theme-secondary':css(mix(accent,[145,145,145],.4)),'--accent-rgb':accent.join(','),'--accent-soft':css(accent,.071),
      '--accent-glow':css(accent,.141),'--button-active':css(accent,.141),'--track':css(accent,.141),
      '--theme-solid':css(mix([22,22,22],raw,.035)),
      '--theme-control':css(mix([14,14,14],raw,.025),46/255),
      '--dialog-glass':css(mix([19,19,19],raw,.03),.96),
      '--surface-raised':css(accent,24/255),'--line':css(mix(accent,[255,255,255],.5),56/255),
      '--line-strong':css(mix(accent,[255,255,255],.65),115/255),'--line-soft':css(accent,25/255),
      '--heat-0':css(mix([20,20,20],accent,.07)),'--heat-1':css(mix([20,20,20],accent,.25)),
      '--heat-2':css(mix([20,20,20],accent,.6)),'--heat-3':css(accent),'--heat-4':css(mix(accent,[255,255,255],.4))
    };
    for(const [name,value] of Object.entries(values))palette.custom?root.style.setProperty(name,value):root.style.removeProperty(name);
    root.dataset.carbonColor=color;surfaces(prefs.transparency);
  }
  function surfaces(value){
    const amount=transparency(value),alpha=amount===67?84/255:1-amount/100;
    root.dataset.carbonGlass=String(amount>0);
    // A single transparency preference applies to every surface.
    root.style.setProperty('--theme-surface',css(palette.custom?mix([22,22,22],palette.raw,.035):[25,27,25],alpha));
    root.style.setProperty('--dialog-glass',css(palette.custom?mix([22,22,22],palette.raw,.035):[25,27,25],alpha));
    root.dataset.carbonTransparency=String(amount);
  }
  function previewTree(method,value,scope=window){
    try{scope.NexusAppearance?.[method]?.(value);for(const frame of scope.document.querySelectorAll('iframe'))previewTree(method,value,frame.contentWindow);}catch{/* Skip other origins. */}
  }
  function previewTransparency(value,scope=window){previewTree('previewTransparency',value,scope);}
  function previewColor(value){
    const color=hex(value);if(!color||root.dataset.carbonColor===color)return;
    const opacity=Number(root.dataset.carbonTransparency);theme(color);surfaces(opacity);
    scenery=null;paint();thumbnails();
  }
  function hsl(value){
    const [r,g,b]=rgb(value).map(v=>v/255),max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min,l=(max+min)/2;
    const h=!d?0:(max===r?(g-b)/d+(g<b?6:0):max===g?(b-r)/d+2:(r-g)/d+4)*60;
    return [h,d?d/(1-Math.abs(2*l-1)):0,l];
  }
  function hueColor(h,basis){
    let [,s,l]=hsl(basis);if(s<.01){s=.5;l=.67;}
    const c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs(h/60%2-1)),m=l-c/2;
    const channels=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
    return '#'+channels.map(v=>Math.round((v+m)*255).toString(16).padStart(2,'0')).join('');
  }
  function syncHue(form,value){
    form.dataset.hueBase=value;form.elements.hue.value=Math.round(hsl(value)[0])%360;
    form.elements.hue.setAttribute('aria-valuetext',form.elements.hue.value+'°, '+value.toUpperCase());
  }
  function syncTransparency(form){
    const input=form.elements.transparency;
    input.setAttribute('aria-valuetext',input.value+'%');
    document.getElementById('appearanceTransparencyValue').value=input.value+'%';
    document.getElementById('appearanceTransparencyNote').textContent='';
  }
  function attributes(){theme();root.dataset.carbonBackground=prefs.background;root.dataset.carbonMotion=prefs.motion;}
  attributes();
  let scenery, silk, silkFailed=false;
  // One scene renderer. The main iframe receives the already rendered pixels so
  // its own backdrop-filter can blur beneath each card, not the entire page.
  function mirror(){
    const frame=document.getElementById('hubFrame');if(!frame||!canvas)return;
    try{
      const doc=frame.contentDocument;if(!doc?.body||!doc.documentElement.classList.contains('carbon-embedded'))return;
      let copy=doc.getElementById('carbonBackdrop');
      if(!copy){copy=doc.createElement('canvas');copy.id='carbonBackdrop';copy.setAttribute('aria-hidden','true');doc.body.prepend(copy);}
      const r=frame.getBoundingClientRect(),sx=canvas.width/innerWidth,sy=canvas.height/innerHeight;
      const w=Math.max(1,Math.round(r.width*sx)),h=Math.max(1,Math.round(r.height*sy));
      if(copy.width!==w)copy.width=w;if(copy.height!==h)copy.height=h;copy.style.width=r.width+'px';copy.style.height=r.height+'px';
      const g=copy.getContext('2d',{alpha:false});g.drawImage(canvas,-r.left*sx,-r.top*sy);
    }catch{/* The frame may be navigating; never inspect another origin. */}
  }
  function silkRenderer(){
    const c=document.createElement('canvas'),gl=c.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false,preserveDrawingBuffer:true});
    if(!gl)return null;
    const vertex=`attribute vec2 uv;uniform float time;uniform float band;uniform float aspect;varying vec3 normal;varying vec3 pos;varying float edge;
      vec3 cloth(vec2 p){
        float u=p.x,v=p.y, t=time*.065;
        float twist=u*8.8+band*1.7+t;
        float width=.29+.22*pow(sin(u*4.2+band),2.);
        float fold=.05*sin(v*5.+u*9.+band)*pow(sin(u*6.+band),2.);
        return vec3((u-.5)*5.2,
          (u-.5)*1.5+.44*sin(u*7.+band*1.8+t*.4)+(band-1.5)*.61+v*width*cos(twist),
          .32*cos(u*7.+band*1.5)+v*width*sin(twist)+fold);
      }
      void main(){pos=cloth(uv);normal=normalize(cross(cloth(uv+vec2(.002,0.))-pos,cloth(uv+vec2(0.,.002))-pos));edge=uv.y;
        float angle=.27*sin(band*2.+.4);pos.xy=mat2(cos(angle),-sin(angle),sin(angle),cos(angle))*pos.xy;float perspective=1.+pos.z*.22;gl_Position=vec4(pos.x*.85/aspect,pos.y*.90,pos.z*.1,perspective);}`;
    const fragment=`precision mediump float;varying vec3 normal;varying vec3 pos;varying float edge;uniform vec3 tint;uniform float customColor;
      void main(){vec3 n=normalize(normal);if(!gl_FrontFacing)n=-n;
        vec3 light=normalize(vec3(-.3,.7,1.));float diffuse=abs(dot(n,light));
        float sheen=pow(abs(dot(n,normalize(light+vec3(0.,0.,1.)))),12.);
        float rim=pow(1.-abs(n.z),3.);float grain=.5+.5*sin(edge*240.+pos.x*22.);
        vec3 olive=vec3(.36,.385,.255)*(.22+diffuse*.72)+vec3(.68,.71,.45)*sheen*.68+vec3(.18,.20,.13)*rim;
        olive=mix(olive,tint*(.12+diffuse*.38+sheen*.60+rim*.16),customColor);olive+=grain*.006;float alpha=(.58+diffuse*.23)*(1.-smoothstep(.96,1.,abs(edge)));
        gl_FragColor=vec4(olive,alpha);}`;
    function shader(type,source){const sh=gl.createShader(type);gl.shaderSource(sh,source);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS))throw Error('Background shader unavailable');return sh;}
    const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))return null;gl.useProgram(program);
    const points=[];const nx=160,ny=28;
    for(let x=0;x<nx;x++)for(let y=0;y<ny;y++){const u=x/nx,v=y/ny*2-1,du=1/nx,dv=2/ny;points.push(u,v,u+du,v,u,v+dv,u,v+dv,u+du,v,u+du,v+dv);}
    gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());gl.bufferData(gl.ARRAY_BUFFER,new Float32Array(points),gl.STATIC_DRAW);
    const attr=gl.getAttribLocation(program,'uv');gl.enableVertexAttribArray(attr);gl.vertexAttribPointer(attr,2,gl.FLOAT,false,0,0);
    const time=gl.getUniformLocation(program,'time'),band=gl.getUniformLocation(program,'band'),aspect=gl.getUniformLocation(program,'aspect');
    const tint=gl.getUniformLocation(program,'tint'),customColor=gl.getUniformLocation(program,'customColor');
    gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    c.addEventListener('webglcontextlost',e=>{e.preventDefault();silkFailed=true;silk=null;paint();});
    return (w,h,t)=>{if(c.width!==w||c.height!==h){c.width=w;c.height=h;gl.viewport(0,0,w,h);}gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.uniform3fv(tint,palette.accent.map(v=>v/255));gl.uniform1f(customColor,palette.custom?1:0);gl.uniform1f(time,t);gl.uniform1f(aspect,w/h);for(let i=0;i<4;i++){gl.uniform1f(band,i);gl.drawArrays(gl.TRIANGLES,0,points.length/2);}return c;};
  }
  function fallbackSilk(w,h,t){
    // No WebGL / lost context: soft curved filaments, still supports static mode.
    for(let b=0;b<4;b++)for(let j=0;j<48;j++){
      const v=j/47*2-1;ctx.beginPath();
      for(let i=0;i<=100;i++){const u=i/100,x=(u*1.4-.2)*w,y=h*(1.1-u*1.4+(b-1.5)*.24+Math.sin(u*7+b*1.8+t*.02)*.2+v*.10*Math.cos(u*8+b+t*.065));i?ctx.lineTo(x,y):ctx.moveTo(x,y);}
      ctx.strokeStyle=`rgba(${(palette.custom?palette.accent:[181,191,125]).join(',')},${.013+Math.pow(Math.abs(Math.sin(v*2+b)),6)*.018})`;ctx.lineWidth=2;ctx.stroke();
    }
  }
  const noise=n=>{const v=Math.sin(n*127.1+311.7)*43758.5453;return v-Math.floor(v);};
  const surface=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
  const assets=new Map();
  const positions={code:[.5,.5],network:[.47,.58],scanner:[.43,.50]};
  let failedAsset='';
  function requestAsset(theme){
    if(assets.has(theme))return assets.get(theme);
    const item={image:new Image(),ready:false};assets.set(theme,item);
    item.image.onload=()=>{item.ready=true;failedAsset='';scenery=null;if(prefs.background===theme){paint();run();syncControls(false);}else thumbnails();};
    item.image.onerror=()=>{item.error=true;failedAsset=theme;if(prefs.background===theme){run();syncControls(false);}};
    item.image.src=`/backgrounds/${theme}-reference.webp`;return item;
  }
  function fitImage(image,w,h){
    const scale=Math.max(w/image.width,h/image.height),[px,py]=positions[prefs.background]||[.5,.5];
    return {x:(w-image.width*scale)*px,y:(h-image.height*scale)*py,w:image.width*scale,h:image.height*scale};
  }
  function recolour(g,w,h){
    // Recolour the cached bitmap once, never in the animation loop. The original
    // reference remains untouched and resetting restores its exact pixels.
    if(palette.custom){
      const pixels=g.getImageData(0,0,w,h),d=pixels.data,a=palette.accent;
      const level=a[0]*.2126+a[1]*.7152+a[2]*.0722;
      for(let i=0;i<d.length;i+=4){const light=d[i]*.2126+d[i+1]*.7152+d[i+2]*.0722;
        for(let j=0;j<3;j++)d[i+j]=light<=level?light*a[j]/level:a[j]+(255-a[j])*(light-level)/(255-level||1);
      }
      g.putImageData(pixels,0,0);
    }
  }
  function thumbnails(){
    for(const el of document.querySelectorAll('.background-thumb')){
      const theme=['code','network','scanner'].find(t=>el.classList.contains('background-'+t));
      if(!theme)continue;
      if(!palette.custom){el.style.removeProperty('background-image');continue;}
      const item=requestAsset(theme);if(!item.ready)continue;
      const c=surface(180,120),g=c.getContext('2d');g.drawImage(item.image,0,0,180,120);recolour(g,180,120);el.style.backgroundImage=`url("${c.toDataURL()}")`;
    }
  }
  function foundation(w,h,image){
    const c=surface(w,h),g=c.getContext('2d');g.fillStyle='#080b09';g.fillRect(0,0,w,h);
    if(!image)return c;
    c.fit=fitImage(image,w,h);const f=c.fit;g.drawImage(image,f.x,f.y,f.w,f.h);
    recolour(g,w,h);
    if(prefs.background==='scanner'){
      c.mask=surface(w,h);const q=c.mask.getContext('2d'),pixels=g.getImageData(0,0,w,h),d=pixels.data;
      for(let i=0;i<d.length;i+=4){const light=d[i]*.25+d[i+1]*.65+d[i+2]*.10;const tint=palette.custom?palette.light:[211,221,153];d[i]=tint[0];d[i+1]=tint[1];d[i+2]=tint[2];d[i+3]=Math.min(200,Math.max(0,(light-14)*4));}
      q.putImageData(pixels,0,0);c.sweep=surface(w,h);
    }
    if(prefs.background==='code'){
      c.flow=surface(w,h);const q=c.flow.getContext('2d');q.drawImage(c,0,0);
      const pixels=g.getImageData(0,0,w,h).data,energy=new Float32Array(w);
      for(let x=0;x<w;x++)for(let y=0;y<h;y+=6){const i=(y*w+x)*4;energy[x]+=pixels[i]+pixels[i+1];}
      c.streams=[];const gap=Math.max(18,Math.round(29*f.w/image.width));let left=0;
      while(left<w){let right=Math.min(w,left+gap),value=Infinity;
        const low=Math.max(left+10,right-Math.round(gap*.35)),high=Math.min(w,right+Math.round(gap*.4));
        if(right<w)for(let x=low;x<high;x++){if(energy[x]<value){right=x;value=energy[x];}}
        c.streams.push({x:left,width:right-left,speed:h*(.003+.007*noise(left+71))});left=right;
      }
      q.globalCompositeOperation='destination-in';const edge=q.createLinearGradient(0,0,0,h);edge.addColorStop(0,'#0000');edge.addColorStop(.035,'#000');edge.addColorStop(.965,'#000');edge.addColorStop(1,'#0000');q.fillStyle=edge;q.fillRect(0,0,w,h);
    }
    return c;
  }
  function glow(g,x,y,r,alpha){
    const light=g.createRadialGradient(x,y,0,x,y,r);light.addColorStop(0,`rgba(${(palette.custom?palette.light:[228,237,172]).join(',')},${alpha})`);light.addColorStop(.18,`rgba(${(palette.custom?palette.accent:[195,210,118]).join(',')},${alpha*.35})`);light.addColorStop(1,css(palette.accent,0));g.fillStyle=light;g.fillRect(x-r,y-r,r*2,r*2);
  }
  const networkPaths=[
    [[434,391],[558,442],[640,492]],
    [[172,496],[370,615],[550,733]],
    [[566,780],[714,883]],
    [[844,243],[1017,316],[1167,382]],
    [[1038,521],[1239,625],[1398,708]],
    [[1305,440],[1457,494],[1664,606]],
    [[1178,306],[1321,365],[1438,417]]
  ].map(path=>path.map(([x,y])=>[x/1672,y/941]));
  function pointAlong(points,k){
    const lengths=points.slice(1).map((p,i)=>Math.hypot(p[0]-points[i][0],p[1]-points[i][1]));
    let distance=k*lengths.reduce((a,b)=>a+b,0);
    for(let i=0;i<lengths.length;i++){if(distance<=lengths[i]||i===lengths.length-1){const f=lengths[i]?distance/lengths[i]:0;return [points[i][0]+(points[i+1][0]-points[i][0])*f,points[i][1]+(points[i+1][1]-points[i][1])*f];}distance-=lengths[i];}
    return points[0];
  }
  function paint(){
    if(!ctx)return;
    const w=canvas.width,h=canvas.height,t=phase,theme=prefs.background;
    const item=theme==='ribbons'?null:requestAsset(theme);
    if(item&&!item.ready)return;
    if(!scenery||scenery.width!==w||scenery.height!==h||scenery.theme!==theme){scenery=foundation(w,h,item?.image);scenery.theme=theme;}
    ctx.globalCompositeOperation='source-over';ctx.globalAlpha=1;ctx.drawImage(scenery,0,0);
    if(theme==='ribbons'){
      if(!silk&&!silkFailed){try{silk=silkRenderer();if(!silk)silkFailed=true;}catch{silkFailed=true;}}
      canvas.dataset.renderer=silk?'webgl':'canvas';if(silk)ctx.drawImage(silk(w,h,t),0,0);else fallbackSilk(w,h,t);
    }else if(theme==='code'){
      canvas.dataset.renderer='reference-flow';
      if(t>0){ctx.fillStyle='#080b09';ctx.fillRect(0,0,w,h);for(const stream of scenery.streams){const shift=(t*stream.speed)%h;ctx.drawImage(scenery.flow,stream.x,0,stream.width,h,stream.x,shift,stream.width,h);ctx.drawImage(scenery.flow,stream.x,0,stream.width,h,stream.x,shift-h,stream.width,h);}}
    }else if(theme==='network'){
      canvas.dataset.renderer='reference-pulses';const f=scenery.fit;
      ctx.save();ctx.translate(f.x,f.y);ctx.scale(f.w,f.h);ctx.lineCap='round';
      for(let i=0;i<networkPaths.length;i++){
        const path=networkPaths[i],cycle=(t/(9+noise(i+11)*8)+noise(i+40))%1,alpha=Math.sin(cycle*Math.PI)*.72;
        for(let trail=9;trail>=0;trail--){const a=pointAlong(path,Math.max(0,cycle-trail*.008)),b=pointAlong(path,Math.max(0,cycle-(trail-1)*.008));ctx.beginPath();ctx.moveTo(...a);ctx.lineTo(...b);ctx.strokeStyle=`rgba(${(palette.custom?palette.light:[220,232,152]).join(',')},${alpha*(1-trail/10)})`;ctx.lineWidth=1.1/f.w;ctx.stroke();}
        const p=pointAlong(path,cycle);ctx.save();ctx.scale(1/f.w,1/f.h);glow(ctx,p[0]*f.w,p[1]*f.h,12,alpha*.4);ctx.restore();
      }
      ctx.restore();
    }else if(theme==='scanner'){
      canvas.dataset.renderer='reference-scan';const sweep=scenery.sweep,q=sweep.getContext('2d');
      const position=((t/32+.38)%1)*1.55-.25,y=position*h,slope=.17;
      q.clearRect(0,0,w,h);q.save();q.transform(1,slope,0,1,0,-w*slope*.5);
      const band=q.createLinearGradient(0,y-85,0,y+65);band.addColorStop(0,'#0000');band.addColorStop(.40,'#0002');band.addColorStop(.60,'#000b');band.addColorStop(.67,'#000f');band.addColorStop(.74,'#0005');band.addColorStop(1,'#0000');q.fillStyle=band;q.fillRect(0,y-85,w,150);q.restore();
      q.globalCompositeOperation='source-in';q.drawImage(scenery.mask,0,0);q.globalCompositeOperation='source-over';
      ctx.save();ctx.globalCompositeOperation='screen';ctx.drawImage(sweep,0,0);ctx.globalAlpha=.35;ctx.filter='blur(8px)';ctx.drawImage(sweep,0,0);ctx.filter='none';ctx.globalAlpha=1;
      ctx.transform(1,slope,0,1,0,-w*slope*.5);const beam=ctx.createLinearGradient(0,y-45,0,y+30);beam.addColorStop(0,(palette.custom?css(palette.light,0):'#b7c47200'));beam.addColorStop(.52,(palette.custom?css(palette.light,10/255):'#c6d5820a'));beam.addColorStop(.60,(palette.custom?css(palette.light,34/255):'#e0e9a422'));beam.addColorStop(.63,(palette.custom?css(palette.light,19/255):'#dce69813'));beam.addColorStop(1,(palette.custom?css(palette.light,0):'#b7c47200'));ctx.fillStyle=beam;ctx.fillRect(0,y-45,w,75);ctx.restore();
    }
    mirror();
  }
  const active=()=> (prefs.background==='ribbons'||assets.get(prefs.background)?.ready)&&prefs.motion==='animated'&&!reduced.matches&&!document.hidden&&!document.body?.classList.contains('reader-focus')&&!document.body?.classList.contains('chat-focus')&&root.dataset.perfEffect!=='animation';
  function tick(now){frame=0;if(!active())return;if(now-last>=50){phase+=Math.min((now-last)/1000,.15);last=now;paint();}frame=requestAnimationFrame(tick);}
  function run(){mirror();cancelAnimationFrame(frame);frame=0;last=performance.now();if(!embedded&&active())frame=requestAnimationFrame(tick);}
  function resize(){if(!canvas)return;const scale=Math.min(devicePixelRatio||1,1.5,1800/innerWidth,1400/innerHeight);canvas.width=Math.round(innerWidth*scale);canvas.height=Math.round(innerHeight*scale);canvas.style.width=innerWidth+'px';canvas.style.height=innerHeight+'px';paint();}
  function apply(value){clearTimeout(previewTimer);previewTimer=0;const old=root.dataset.carbonColor;prefs=clean(value);if(old!==prefs.color)scenery=null;if(assets.get(prefs.background)?.error)assets.delete(prefs.background);failedAsset='';attributes();if(prefs.motion==='static')phase=0;paint();run();syncControls();}
  function syncControls(fields=true){thumbnails();const form=document.getElementById('appearanceForm');if(!form)return;const state=document.getElementById('appearanceStatus');if(failedAsset===prefs.background&&state)state.textContent='Фон не загрузился. Нажми «Сохранить», чтобы повторить.';if(fields){form.elements.color.value=prefs.color.toUpperCase();syncHue(form,prefs.color);form.elements.color.setCustomValidity('');form.elements.background.value=prefs.background;form.elements.motion.value=prefs.motion;form.elements.transparency.value=prefs.transparency;syncTransparency(form);}document.getElementById('appearanceMotionNote').textContent=reduced.matches?'В системе включено уменьшение движения: фон останется статичным.':'';}
  window.NexusAppearance={get:()=>({...prefs}),refresh:()=>apply(read()),previewTransparency:surfaces,previewColor,mirror};
  addEventListener('storage',e=>{if(e.key===key||e.key===null)apply(read());});
  addEventListener('message',e=>{if(e.origin!==location.origin||e.data?.type!=='nexus:appearance')return;apply(read());});
  reduced.addEventListener('change',()=>{syncControls(false);run();});
  document.addEventListener('visibilitychange',run);addEventListener('pagehide',()=>cancelAnimationFrame(frame));addEventListener('pageshow',()=>{apply(read());});
  function init(){
    if(!embedded){canvas=document.createElement('canvas');canvas.id='carbonBackground';canvas.setAttribute('aria-hidden','true');document.body.prepend(canvas);ctx=canvas.getContext('2d',{alpha:false});resize();addEventListener('resize',resize);observer=new MutationObserver(run);observer.observe(document.body,{attributes:true,attributeFilter:['class']});const hub=document.getElementById('hubFrame');if(hub){hub.addEventListener('load',()=>requestAnimationFrame(mirror));new ResizeObserver(mirror).observe(hub);}run();}
    else {root.classList.add('carbon-embedded');try{parent.NexusAppearance?.mirror?.();}catch{}}
    syncControls();
    const form=document.getElementById('appearanceForm');
    if(form){
      const input=form.elements.color,hue=form.elements.hue;
      const showColor=()=>{if(!previewTimer)previewTimer=setTimeout(()=>{previewTimer=0;previewTree('previewColor',input.value,embedded?parent:window);},100);document.getElementById('appearanceStatus').textContent='Предпросмотр. Нажми «Сохранить».';};
      const slider=form.elements.transparency;
      slider.addEventListener('input',()=>{syncTransparency(form);previewTransparency(Number(slider.value),embedded?parent:window);document.getElementById('appearanceStatus').textContent='Предпросмотр. Нажми «Сохранить».';});
      // Leaving without saving restores the saved material in the persistent shell.
      addEventListener('pagehide',()=>{clearTimeout(previewTimer);const saved=read();previewTree('previewColor',saved.color,embedded?parent:window);previewTransparency(saved.transparency,embedded?parent:window);});
      input.addEventListener('input',()=>{const value=hex(input.value);input.setCustomValidity(value?'':'Введи 6 символов HEX, например #BECB8C.');if(value){syncHue(form,value);showColor();}});
      hue.addEventListener('input',()=>{input.value=hueColor(Number(hue.value),form.dataset.hueBase||defaults.color).toUpperCase();input.setCustomValidity('');hue.setAttribute('aria-valuetext',hue.value+'°, '+input.value);showColor();});
      document.getElementById('appearanceColorReset').addEventListener('click',()=>{input.value=defaults.color.toUpperCase();syncHue(form,defaults.color);input.setCustomValidity('');showColor();document.getElementById('appearanceStatus').textContent='Оливковый цвет выбран. Нажми «Сохранить».';});
    }
    form?.addEventListener('submit',e=>{
      e.preventDefault();const f=e.currentTarget,next=clean({background:f.elements.background.value,motion:f.elements.motion.value,color:f.elements.color.value,transparency:Number(f.elements.transparency.value)});
      try{localStorage.setItem(key,JSON.stringify(next));apply(next);if(embedded)parent.postMessage({type:'nexus:appearance'},location.origin);for(const f of document.querySelectorAll('iframe'))f.contentWindow?.postMessage({type:'nexus:appearance'},location.origin);document.getElementById('appearanceStatus').textContent='Сохранено на этом устройстве.';}catch{document.getElementById('appearanceStatus').textContent='Браузер не разрешил сохранить оформление.';}
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
