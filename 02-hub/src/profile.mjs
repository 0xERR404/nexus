import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {fail} from './input.mjs';

export class Profiles {
  constructor(directory) { this.directory=directory&&path.join(directory,'profiles');this.memory=new Map(); }
  file(username) { return path.join(this.directory,createHash('sha256').update(username).digest('hex')+'.json'); }
  read(username) {
    if(!this.directory)return this.memory.get(username)??{revision:0,avatar:null};
    try{return JSON.parse(fs.readFileSync(this.file(username),'utf8'));}
    catch(error){if(error.code==='ENOENT')return {revision:0,avatar:null};throw error;}
  }
  write(username,{revision,avatar}) {
    if(!Number.isSafeInteger(revision)||revision<0)throw fail('Некорректная версия профиля.');
    if(avatar!==null){
      if(typeof avatar!=='string'||avatar.length>200000||!/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(avatar))throw fail('Нужна фотография PNG.');
      const encoded=avatar.slice(22),bytes=Buffer.from(encoded,'base64');
      if(bytes.toString('base64')!==encoded||bytes.length<45||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||
        bytes.readUInt32BE(8)!==13||bytes.subarray(12,16).toString()!=='IHDR'||bytes.readUInt32BE(16)!==160||bytes.readUInt32BE(20)!==160||
        bytes.subarray(-12).toString('hex')!=='0000000049454e44ae426082')throw fail('Нужна фотография PNG размером 160 × 160.');
    }
    const current=this.read(username);
    if(current.revision!==revision)return {ok:false,profile:current};
    const next={revision:revision+1,avatar};
    if(!this.directory)this.memory.set(username,next);
    else {
      fs.mkdirSync(this.directory,{recursive:true,mode:0o700});
      const file=this.file(username),temp=file+'.'+randomUUID()+'.tmp';
      try{fs.writeFileSync(temp,JSON.stringify(next),{mode:0o600,flag:'wx'});fs.renameSync(temp,file);}
      finally{fs.rmSync(temp,{force:true});}
    }
    return {ok:true,profile:next};
  }
}
