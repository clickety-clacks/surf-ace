import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
export const PRODUCT_SOURCE='6212cff8c99ffaecac5934bb14adb41676cf0c09';
export const REQUIRED=['baseline','scaled','restored','wrong-surface','duplicate','stale-geometry','invalid-guest','delayed-send','native-drain'];
export function allowRequest(url){try{return ['file:','data:','about:'].includes(new URL(url).protocol);}catch{return false;}}
export function ownedWs(url,port){return Number.isInteger(port)&&port>0&&port<65536&&url===`ws://127.0.0.1:${port}/ws`;}
export function scriptJSON(value){return JSON.stringify(value).replaceAll('<','\\u003c').replaceAll('\u2028','\\u2028').replaceAll('\u2029','\\u2029');}
export function frameKey(frame){assert(frame&&!frame.detached,'detached native frame');const v=[frame.frameTreeNodeId,frame.processId,frame.routingId];assert(v.every(Number.isSafeInteger)&&v[0]>=0&&v[1]>0&&v[2]>=0,'native frame API missing');return v.join(':');}
function crc(bytes){let c=0xffffffff;for(const v of bytes){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
export function decodePNG(bytes){
 assert(Buffer.isBuffer(bytes)&&bytes.length<=2*1024*1024&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),'PNG bounds/signature');
 let p=8,w,h,bpp,ended=false,idat=false,idatEnded=false;const parts=[];
 while(p<bytes.length){assert(p+12<=bytes.length);const n=bytes.readUInt32BE(p),type=bytes.toString('ascii',p+4,p+8);assert(p+12+n<=bytes.length);const data=bytes.subarray(p+8,p+8+n);assert.equal(crc(bytes.subarray(p+4,p+8+n)),bytes.readUInt32BE(p+8+n),'PNG CRC');
  if(type==='IHDR'){assert.equal(p,8);assert.equal(n,13);w=data.readUInt32BE(0);h=data.readUInt32BE(4);assert(w>0&&h>0&&w<=8192&&h<=8192);assert.equal(data[8],8);assert([2,6].includes(data[9]));assert(data.subarray(10).equals(Buffer.alloc(3)));bpp=data[9]===6?4:3;assert(w*h*4<=32*1024*1024);}
  else if(type==='IDAT'){assert(w&&!idatEnded);idat=true;parts.push(data);}
  else if(type==='IEND'){assert(idat&&n===0&&p+12===bytes.length);ended=true;break;}
  else {assert(w&&!/^[A-Z]/.test(type),'unsupported critical PNG chunk');if(idat)idatEnded=true;}
  p+=12+n;
 }
 assert(ended);const stride=w*bpp,raw=inflateSync(Buffer.concat(parts),{maxOutputLength:(stride+1)*h});assert.equal(raw.length,(stride+1)*h);const pixels=Buffer.alloc(stride*h);
 const paeth=(a,b,c)=>{const x=a+b-c,A=Math.abs(x-a),B=Math.abs(x-b),C=Math.abs(x-c);return A<=B&&A<=C?a:B<=C?b:c;};
 for(let y=0;y<h;y++){const filter=raw[y*(stride+1)];assert(filter<=4);for(let x=0;x<stride;x++){const a=x>=bpp?pixels[y*stride+x-bpp]:0,b=y?pixels[(y-1)*stride+x]:0,c=y&&x>=bpp?pixels[(y-1)*stride+x-bpp]:0;const f=[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter];pixels[y*stride+x]=(raw[y*(stride+1)+1+x]+f)&255;}}
 return{width:w,height:h,pixel(x,y){assert(Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&y>=0&&x<w&&y<h);const i=y*stride+x*bpp;return[pixels[i],pixels[i+1],pixels[i+2],bpp===4?pixels[i+3]:255];}};
}
export function paintProof(png,viewport,dpr,points){const image=decodePNG(png);assert.equal(image.width,viewport.width*dpr,'backing width mismatch');assert.equal(image.height,viewport.height*dpr,'backing height mismatch');const samples=points.map(({x,y,rgb})=>{const pixel=image.pixel(Math.floor(x*dpr),Math.floor(y*dpr));assert(pixel[3]===255&&rgb.every((v,i)=>Math.abs(pixel[i]-v)<=2),'phase paint mismatch');return{x,y,pixel,rgb};});return{width:image.width,height:image.height,samples};}
export function phasePalette(n){assert(Number.isInteger(n)&&n>=1&&n<=3);return [[180+n*10,25+n*7,40+n*9],[25+n*9,180+n*11,40+n*7]];}
export function validateWhole(result){assert.equal(result.productSource,PRODUCT_SOURCE);assert.equal(result.scope,'private-fixture-native-and-paired-ws');assert.equal(result.physicalDisplay,'not-observed');assert.deepEqual(result.phases.map(v=>v.name),REQUIRED);assert(result.phases.every(v=>v.pass===true));assert.deepEqual(result.forbiddenRequests,[]);assert.equal(result.cleanup.appOwnedWindows,0);assert.equal(result.cleanup.serverStopped,true);assert.equal(result.cleanup.pendingAdapterPromises,0);return true;}
