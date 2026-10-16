import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {imageType} from '#hub/content-store.mjs';

export const NBK_LIMIT = 192 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const FILE = /^book-[a-f0-9-]{36}\.nbk$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const error = () => { throw Object.assign(Error('NBK: файл повреждён или формат не поддерживается.'), {status:422}); };
const text = (value, max) => {
  if(typeof value !== 'string' || value.length > max || /[\x00-\x08\x0e-\x1f]/.test(value)) error();
  return value;
};
function header(value) {
  if(value?.format !== 'NBK' || value.version !== 1 || !text(value.title,180).trim() || !(value.cover === null || HASH.test(value.cover))) error();
  return {format:'NBK',version:1,title:value.title,author:text(value.author,180),cover:value.cover};
}
export function chapter(value) {
  if(!value || !Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 100) error();
  return {title:text(value.title,256),blocks:value.blocks.map(b=>{
    if(!b || !['p','heading','quote','pre','image'].includes(b.type)) error();
    const result={type:b.type,text:text(b.text,b.type === 'image' ? 200 : 4000)};
    if(b.type === 'image') {
      if(!HASH.test(b.asset)) error();
      result.asset=b.asset;
      for(const key of ['width','height']) if(b[key] !== undefined) {
        if(!Number.isInteger(b[key]) || b[key] < 1 || b[key] > 16000) error();
        result[key]=b[key];
      }
    }
    return result;
  })};
}
function asset(value) {
  if(!value || !HASH.test(value.id)) error();
  const data=Buffer.from(value.data);
  if(!data.length || data.length > 16*1024*1024 || imageType(data)[0] !== value.type) error();
  return {id:value.id,type:value.type,data};
}

// UTF-8 JSON Lines: header, chapter records, image records, integrity trailer.
// Each record occupies one physical line; embedded newlines are JSON-escaped.
export function decodeNBK(input) {
  const bytes=Buffer.from(input);
  if(!bytes.length || bytes.length > NBK_LIMIT || bytes.at(-1) !== 10) error();
  let start=0, meta, endSeen=false, textSize=0, imageSize=0;
  const chapters=[],assets=[],ids=new Set(),checksum=createHash('sha256');
  while(start<bytes.length) {
    const end=bytes.indexOf(10,start);
    if(end<0 || end-start > 23*1024*1024) error();
    const line=bytes.subarray(start,end+1);
    let record;
    try {record=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));} catch {error();}
    if(!meta) meta=header(record);
    else if(record?.kind === 'end') {
      if(end+1 !== bytes.length || record.chapters !== chapters.length || record.assets !== assets.length || record.sha256 !== checksum.digest('hex')) error();
      endSeen=true;break;
    } else if(record?.kind === 'chapter') {
      if(assets.length || chapters.length>=10000 || line.length>3*1024*1024) error();
      const c=chapter(record);
      textSize+=c.blocks.reduce((n,b)=>n+b.text.length,0);
      if(textSize>20*1024*1024) error();
      chapters.push(c);
    } else if(record?.kind === 'asset') {
      if(assets.length>=10000 || ids.has(record.id) || typeof record.data !== 'string' || record.data.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.data)) error();
      const a=asset({...record,data:Buffer.from(record.data,'base64')});
      if(a.data.toString('base64')!==record.data) error();
      imageSize+=a.data.length;if(imageSize>128*1024*1024) error();
      ids.add(a.id);assets.push(a);
    } else error();
    checksum.update(line);start=end+1;
  }
  if(!endSeen || !chapters.length || (meta.cover && !ids.has(meta.cover))) error();
  for(const c of chapters) for(const b of c.blocks) if(b.type==='image' && !ids.has(b.asset)) error();
  return {...meta,format:'nbk',chapters,assets};
}

export function nbkPath(directory, index) {
  if(!FILE.test(index?.file)) error();
  return path.join(directory,index.file);
}
export function syncDirectory(directory) {
  if(process.platform==='win32')return;
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function verifyNBK(directory,index) {
  const file=nbkPath(directory,index);
  if(fs.statSync(file).size !== index.bytes || index.bytes > NBK_LIMIT) error();
  const fd=fs.openSync(file,'r'),sum=createHash('sha256'),buffer=Buffer.alloc(1024*1024);
  try {let n;while((n=fs.readSync(fd,buffer))>0)sum.update(buffer.subarray(0,n));} finally {fs.closeSync(fd);}
  if(sum.digest('hex') !== index.sha256) error();
}
export function readRecord(directory,index,range) {
  if(!range || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length) || range.offset<0 || range.length<1 || range.length>23*1024*1024 || range.offset+range.length>index.bytes) error();
  const fd=fs.openSync(nbkPath(directory,index),'r'),bytes=Buffer.alloc(range.length);
  try {let read=0;while(read<bytes.length){const n=fs.readSync(fd,bytes,read,bytes.length-read,range.offset+read);if(!n)error();read+=n;}} finally {fs.closeSync(fd);}
  if(hash(bytes)!==range.sha256) error();
  return JSON.parse(bytes.toString('utf8'));
}
export function readChapter(directory,index,i) {return chapter(readRecord(directory,index,index.chapters[i]));}
export function readAsset(directory,index,id) {
  const value=readRecord(directory,index,index.assets[id]);
  if(value.kind!=='asset'||value.id!==id)error();
  return {type:value.type,data:Buffer.from(value.data,'base64')};
}
export function writeNBK(directory,book) {
  const file='book-'+randomUUID()+'.nbk',temp=path.join(directory,'.'+file),target=path.join(directory,file);
  const index={file,bytes:0,sha256:'',chapters:[],assets:{},cover:book.cover??null};
  let fd,success=false,textSize=0,imageSize=0;
  const sum=createHash('sha256'),full=createHash('sha256'),ids=new Set(),references=new Set();
  function write(record,integrity=true) {
    const bytes=Buffer.from(JSON.stringify(record)+'\n');
    if(index.bytes+bytes.length>NBK_LIMIT)throw Object.assign(Error('NBK: книга после преобразования больше 192 МБ.'),{status:413});
    const range={offset:index.bytes,length:bytes.length,sha256:hash(bytes)};
    fs.writeFileSync(fd,bytes);index.bytes+=bytes.length;full.update(bytes);if(integrity)sum.update(bytes);
    return range;
  }
  try {
    fd=fs.openSync(temp,'wx',0o600);
    write(header({format:'NBK',version:1,title:book.title,author:book.author,cover:index.cover}));
    for(const value of book.chapters) {
      const c=chapter(value);
      if(index.chapters.length>=10000)error();
      textSize+=c.blocks.reduce((n,b)=>n+b.text.length,0);if(textSize>20*1024*1024)error();
      for(const b of c.blocks)if(b.type==='image')references.add(b.asset);
      index.chapters.push(write({kind:'chapter',...c}));
    }
    for(const value of book.assets) {
      const a=asset(value);if(ids.has(a.id)||ids.size>=10000)error();ids.add(a.id);
      imageSize+=a.data.length;if(imageSize>128*1024*1024)error();
      index.assets[a.id]=write({kind:'asset',id:a.id,type:a.type,data:a.data.toString('base64')});
    }
    if(!index.chapters.length || (index.cover&&!ids.has(index.cover)) || [...references].some(id=>!ids.has(id)))error();
    write({kind:'end',chapters:index.chapters.length,assets:ids.size,sha256:sum.digest('hex')},false);
    index.sha256=full.digest('hex');fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    fs.renameSync(temp,target);syncDirectory(directory);verifyNBK(directory,index);success=true;
    return index;
  } finally {
    if(fd!==undefined)fs.closeSync(fd);
    fs.rmSync(temp,{force:true});if(!success)fs.rmSync(target,{force:true});
  }
}
