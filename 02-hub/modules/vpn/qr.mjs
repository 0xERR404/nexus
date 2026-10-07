// QR byte mode, error correction L, fixed versions 10/15. No external service receives tokens.
export function qr(text){
  const bytes=Buffer.from(text,'utf8'),v=bytes.length<=271?10:15;
  if(bytes.length>520)throw Error('Ссылка слишком длинная для QR-кода');
  const size=v*4+17,dataLength=v===10?274:523,ecc=v===10?18:22,lengths=v===10?[68,68,69,69]:[87,87,87,87,87,88];
  const bits=[];const put=(n,count)=>{for(let k=count-1;k>=0;k--)bits.push(n>>>k&1);};put(4,4);put(bytes.length,16);for(const b of bytes)put(b,8);put(0,Math.min(4,dataLength*8-bits.length));while(bits.length%8)bits.push(0);
  const data=[];for(let i=0;i<bits.length;i+=8)data.push(bits.slice(i,i+8).reduce((n,b)=>n*2+b,0));while(data.length<dataLength)data.push(data.length%2===(bits.length/8)%2?0xec:0x11);
  const exp=new Uint8Array(512),log=new Uint8Array(256);let x=1;for(let i=0;i<255;i++){exp[i]=x;log[x]=i;x<<=1;if(x&256)x^=0x11d;}for(let i=255;i<512;i++)exp[i]=exp[i-255];const mul=(a,b)=>a&&b?exp[log[a]+log[b]]:0;
  let generator=[1];for(let i=0;i<ecc;i++){const next=Array(generator.length+1).fill(0);for(let j=0;j<generator.length;j++){next[j]^=generator[j];next[j+1]^=mul(generator[j],exp[i]);}generator=next;}
  let at=0;const blocks=lengths.map(n=>{const dataBlock=data.slice(at,at+n);at+=n;const r=[...dataBlock,...Array(ecc).fill(0)];for(let i=0;i<n;i++){const factor=r[i];for(let j=0;j<generator.length;j++)r[i+j]^=mul(generator[j],factor);}return {data:dataBlock,ecc:r.slice(n)};});
  const encoded=[];for(let i=0;i<Math.max(...lengths);i++)for(const b of blocks)if(i<b.data.length)encoded.push(b.data[i]);for(let i=0;i<ecc;i++)for(const b of blocks)encoded.push(b.ecc[i]);
  const cells=Array.from({length:size},()=>Array(size).fill(null));
  const finder=(cx,cy)=>{for(let dy=-1;dy<=7;dy++)for(let dx=-1;dx<=7;dx++){const xx=cx+dx,yy=cy+dy;if(xx<0||yy<0||xx>=size||yy>=size)continue;cells[yy][xx]=dx>=0&&dx<=6&&dy>=0&&dy<=6&&(dx===0||dy===0||dx===6||dy===6||dx>=2&&dx<=4&&dy>=2&&dy<=4);}};
  finder(0,0);finder(size-7,0);finder(0,size-7);
  const positions=v===10?[6,28,50]:[6,26,48,70];for(const y of positions)for(const x of positions){if(cells[y][x]!==null)continue;for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++)cells[y+dy][x+dx]=Math.max(Math.abs(dx),Math.abs(dy))!==1;}
  for(let i=8;i<size-8;i++){if(cells[6][i]===null)cells[6][i]=i%2===0;if(cells[i][6]===null)cells[i][6]=i%2===0;}
  const bch=(value,poly,degree)=>{let r=value<<degree;for(let i=31-Math.clz32(r);i>=degree;i--)if(r>>>i&1)r^=poly<<(i-degree);return (value<<degree)|r;};
  const format=bch(8,0x537,10)^0x5412;
  for(let i=0;i<15;i++){const b=!!(format>>>i&1);cells[i<6?i:i<8?i+1:size-15+i][8]=b;cells[8][i<8?size-i-1:i<9?15-i:14-i]=b;}cells[size-8][8]=true;
  const version=bch(v,0x1f25,12);for(let i=0;i<18;i++){const b=!!(version>>>i&1);cells[Math.floor(i/3)][size-11+i%3]=b;cells[size-11+i%3][Math.floor(i/3)]=b;}
  let bit=0,up=true;for(let right=size-1;right>=1;right-=2){if(right===6)right--;for(let yy=0;yy<size;yy++){const y=up?size-1-yy:yy;for(let dx=0;dx<2;dx++){const x=right-dx;if(cells[y][x]!==null)continue;const value=bit<encoded.length*8?encoded[bit>>>3]>>>(7-bit%8)&1:0;cells[y][x]=!!(value^((x+y)%2===0?1:0));bit++;}}up=!up;}
  const squares=[];for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(cells[y][x])squares.push(`M${x+4} ${y+4}h1v1h-1z`);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size+8} ${size+8}" shape-rendering="crispEdges"><path fill="white" d="M0 0h${size+8}v${size+8}H0z"/><path fill="black" d="${squares.join('')}"/></svg>`;
}
