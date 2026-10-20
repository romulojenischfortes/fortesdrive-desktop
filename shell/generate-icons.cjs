const fs = require('fs');
const path = require('path');
const colors = [[16,185,129],[34,160,230],[244,63,94]];
for (let state=0;state<3;state++) {
  const size=32, pixels=Buffer.alloc(size*size*4);
  const put=(x,y,color)=>{if(x<0||x>=size||y<0||y>=size)return;const offset=((size-1-y)*size+x)*4;pixels[offset]=color[2];pixels[offset+1]=color[1];pixels[offset+2]=color[0];pixels[offset+3]=255;};
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if((x-9)**2+(y-23)**2<64)put(x,y,colors[state]);
  const line=(x1,y1,x2,y2)=>{const steps=Math.max(Math.abs(x2-x1),Math.abs(y2-y1));for(let s=0;s<=steps;s++){const x=Math.round(x1+(x2-x1)*s/steps),y=Math.round(y1+(y2-y1)*s/steps);put(x,y,[255,255,255]);put(x+1,y,[255,255,255]);}};
  if(state===0){line(5,23,8,26);line(8,26,13,20);}
  if(state===1){line(9,18,9,23);line(9,23,13,24);}
  if(state===2){line(8,18,8,24);line(8,27,9,27);}
  const mask=Buffer.alloc(128,255);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(pixels[(y*size+x)*4+3])mask[y*4+(x>>3)]&=~(128>>(x&7));
  const dib=Buffer.alloc(40);dib.writeUInt32LE(40,0);dib.writeInt32LE(size,4);dib.writeInt32LE(size*2,8);dib.writeUInt16LE(1,12);dib.writeUInt16LE(32,14);dib.writeUInt32LE(pixels.length,20);
  const image=Buffer.concat([dib,pixels,mask]);
  const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(image.length,14);header.writeUInt32LE(22,18);
  fs.writeFileSync(path.join(__dirname,['synced','pending','error'][state]+'.ico'),Buffer.concat([header,image]));
}