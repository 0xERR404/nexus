import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {backupKind,backupID} from '../02-hub/src/data-backup.mjs';
import {hubPath,exec,query} from './common.mjs';

export function candidateName(id){
  if(!backupID.test(id))throw Error('Invalid candidate ID');
  return 'nexus404-check-'+id;
}

// The caller pauses the hub and event collector while taking this small snapshot.
// No hard links to mutable databases: the candidate may migrate only its own copies.
export function candidateSnapshot(hub,job,{ownership=true,link=fs.symlinkSync}={}){
  const source=hubPath(hub,'data'),target=path.join(job,'candidate-data'),entries=[];
  function scan(dir,prefix=''){
    for(const name of fs.readdirSync(dir)){
      const relative=prefix+name,file=path.join(dir,name),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())throw Error('Unsupported data file');
      if(stat.isDirectory()){scan(file,relative+'/');continue;}
      const kind=backupKind('data/'+relative);
      if(kind)entries.push({relative,file,stat,media:kind==='media'});
      if(entries.length>200000)throw Error('Too many data files');
    }
  }
  scan(source);
  const bytes=entries.filter(e=>!e.media).reduce((n,e)=>n+e.stat.size,0),disk=fs.statfsSync(job);
  if(Number(disk.bavail)*Number(disk.bsize)<bytes+512*1024*1024)throw Object.assign(Error('Insufficient candidate space'),{code:'ENOSPC'});
  fs.mkdirSync(target,{mode:0o700});
  const directories=new Set([target]);
  for(const entry of entries){
    const destination=path.join(target,entry.relative);
    fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
    for(let dir=path.dirname(destination);dir.startsWith(target);dir=path.dirname(dir))directories.add(dir);
    if(entry.media){link('/app/source-data/'+entry.relative,destination);continue;}
    const fd=fs.openSync(entry.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    try{
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.dev!==entry.stat.dev||stat.ino!==entry.stat.ino||stat.size!==entry.stat.size||stat.mtimeMs!==entry.stat.mtimeMs)throw Error('Data changed during snapshot');
      const out=fs.openSync(destination,'wx',0o600);
      try{const buffer=Buffer.alloc(1024*1024);let count,total=0;while((count=fs.readSync(fd,buffer,0,buffer.length,null))){fs.writeSync(out,buffer,0,count);total+=count;}fs.fsyncSync(out);const after=fs.fstatSync(fd);if(total!==stat.size||after.mtimeMs!==stat.mtimeMs)throw Error('Data changed during snapshot');}
      finally{fs.closeSync(out);}
    }finally{fs.closeSync(fd);}
    if(ownership)fs.chownSync(destination,1000,1000);
  }
  for(const dir of directories)if(ownership)fs.chownSync(dir,1000,1000);
  return {bytes,files:entries.length,media:entries.filter(e=>e.media).length};
}

export function candidateArgs({id,hub,job,image,version,modules}){
  const mount=(source,target,readonly=false)=>`type=bind,source=${source},target=${target}${readonly?',readonly':''}`;
  // No published ports, production network, auth file, management queues or Docker socket.
  return ['run','--name',candidateName(id),'--network','none','--read-only','--user','1000:1000',
    '--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256',
    '--memory','1g','--memory-swap','1g','--cpus','1','--log-driver','none',
    '--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--env','DATA_DIR=/app/data',
    '--mount',mount(path.join(job,'candidate-data'),'/app/data'),
    '--mount',mount(hubPath(hub,'data'),'/app/source-data',true),
    '--mount',mount(path.join(job,'stage/modules'),'/app/modules',true),
    '--mount',mount(fileURLToPath(new URL('./update-probe.mjs',import.meta.url)),'/check.mjs',true),
    '--entrypoint','node',image,'/check.mjs',version,JSON.stringify(modules)];
}

export async function removeCandidate(id,run=exec,inspect=query){
  const name=candidateName(id),found=inspect('docker',['container','ls','-a','--filter','name=^/'+name+'$','--format','{{.Names}}']);
  if(!found.ok)throw Error('Cannot check candidate cleanup');
  if(!found.text)return;
  if(found.text!==name)throw Error('Unexpected candidate container');
  // --force also terminates a container orphaned by a timed out Docker client.
  await run('docker',['rm','--force',name]);
}

export async function checkCandidate(options,{run=exec,log}={}){
  let failure;
  try{await run('docker',candidateArgs(options),{timeout:180000,log});}
  catch(error){failure=Object.assign(Error('Candidate verification failed'),{code:'ECANDIDATE',cause:error});}
  // Docker reports failure if run never created the container. In that case inspect first.
  // The caller's finally/recovery path repeats cleanup, using inspect for absence.
  if(failure)throw failure;
}
