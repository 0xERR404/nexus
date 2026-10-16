// Trusted host-side probe, mounted read-only into an isolated candidate container.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export async function probe({root='/app',data='/app/data',directory='/app/modules',version,expected=[]}={}){
  process.env.DATA_DIR=data;
  const read=name=>JSON.parse(fs.readFileSync(path.join(root,name),'utf8'));
  if(read('package.json').version!==version||read('package.json').hubDataSchema!==1)throw Error('Candidate version/schema mismatch');
  const nativeFetch=globalThis.fetch;
  let origin;
  globalThis.fetch=(url,...args)=>{if(!origin||new URL(url).origin!==origin)throw Error('Candidate external request blocked');return nativeFetch(url,...args);};
  let app,modules;
  const load=name=>import(pathToFileURL(path.join(root,'src',name+'.mjs')));
  function integrity(dir){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);
      if(entry.isSymbolicLink())continue; // Payloads are read-only mounts, not databases.
      if(entry.isDirectory()){integrity(file);continue;}
      if(entry.name.endsWith('.json'))JSON.parse(fs.readFileSync(file,'utf8'));
      if(/\.(?:sqlite|db)$/.test(entry.name)){
        const db=new DatabaseSync(file,{readOnly:true});
        try{const rows=db.prepare('PRAGMA integrity_check').all();if(rows.length!==1||Object.values(rows[0])[0]!=='ok')throw Error('Candidate database integrity failed');}finally{db.close();}
      }
    }
  }
  try{
    integrity(data);
    const {loadModules}=await load('modules');
    modules=await loadModules(directory,{start:false});
    if(modules.diagnostics.some(d=>d.state==='error')||modules.size!==expected.length||expected.some(id=>!modules.has(id)))throw Error('Candidate modules failed to load');
    const {createApp}=await load('server'),{passwordHash}=await load('auth');
    const password=randomBytes(32).toString('hex'),config={username:'candidate',...await passwordHash(password),origin:'http://127.0.0.1'};
    const scratch=path.join(data,'.candidate-probe');fs.mkdirSync(scratch);
    app=createApp({config,modules,dataDirectory:data,securityFile:path.join(scratch,'security.json'),sessionsFile:path.join(scratch,'sessions.json'),dashboardFile:path.join(data,'dashboard.json')});
    await new Promise((resolve,reject)=>{app.once('error',reject);app.listen(0,'127.0.0.1',resolve);});
    origin='http://127.0.0.1:'+app.address().port;
    const request=(route,options={})=>nativeFetch(origin+route,{redirect:'manual',signal:AbortSignal.timeout(15000),...options});
    if((await request('/api/modules')).status!==401)throw Error('Candidate authentication failed');
    const login=await request('/api/auth/login',{method:'POST',headers:{Origin:config.origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({username:config.username,password})});
    const cookie=login.headers.getSetCookie().find(s=>s.startsWith('nexus_dev_session='))?.split(';')[0];
    await login.arrayBuffer();
    if(login.status!==303||!cookie)throw Error('Candidate login failed');
    for(const route of ['/login','/app.css','/workspace.js','/','/settings','/api/modules',...expected.map(id=>'/modules/'+id+'/')]){
      const response=await request(route,{headers:route==='/login'?{}:{Cookie:cookie}});
      const bytes=await response.arrayBuffer();
      if(response.status!==200||!bytes.byteLength)throw Error('Candidate route failed: '+route);
      console.log('OK '+route);
    }
    integrity(data);
    console.log('Candidate passed: '+version+'; modules: '+modules.size);
  }finally{
    if(app){const {closeApp}=await load('server');await closeApp(app,modules);}
    else if(modules)await Promise.allSettled([...modules.values()].map(m=>m.close?.()));
    globalThis.fetch=nativeFetch;
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const deadline=setTimeout(()=>{console.error('Candidate check timed out');process.exit(1);},150000);
  probe({version:process.argv[2],expected:JSON.parse(process.argv[3]||'[]')}).then(()=>{clearTimeout(deadline);process.exit(0);},error=>{console.error(error.message);process.exit(1);});
}
