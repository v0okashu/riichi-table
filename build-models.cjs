/* Manufacture a closed rounded shell and recessed, vertex-coloured face in metres.
   Input is a 684 x 520 BGRA sampling of the cleaned reference atlas. */
const fs=require('node:fs');
const pixels=fs.readFileSync(process.argv[2]);
if(pixels.length!==684*520*4)throw Error('Expected a 684 x 520 BGRA atlas');
const toLinear=channel=>{
 const srgb=channel/255;
 return Math.round(255*(srgb<=.04045?srgb/12.92:((srgb+.055)/1.055)**2.4));
};
const W=76,H=104, parts=[],views=[],accessors=[],meshes=[],nodes=[];
let length=0;
function accessor(array,type,count,target,min,max){
 const bytes=Buffer.from(array.buffer,array.byteOffset,array.byteLength);
 views.push({buffer:0,byteOffset:length,byteLength:bytes.length,target});
 parts.push(bytes);length+=bytes.length;
 const pad=(4-length%4)%4;parts.push(Buffer.alloc(pad));length+=pad;
 accessors.push({bufferView:views.length-1,componentType:array instanceof Float32Array?5126:array instanceof Uint16Array?5123:5121,count,type,...(array instanceof Uint8Array?{normalized:true}:{}),...(min?{min,max}:{})});
 return accessors.length-1;
}
function makeTile(id,col,row){
 const pos=[],rgb=[],idx=[],norm=[];
 function vertex(x,y,z,c){pos.push(x*.001,-y*.001,z*.001);rgb.push(...c.map(toLinear),255);return rgb.length/4-1}
 function face(a,b,c){idx.push(a,c,b)}
 const width=20.5,height=28,d=16.5,ivory=[252,250,238],amber=[225,167,59],seam=[170,119,32];
 function xy(u,v,inset){
  const x=(u-.5)*(width-2*inset),y=(v-.5)*(height-2*inset);
  const r=1.75-inset*.55,dx=Math.max(0,Math.abs(x)-(width/2-inset-r)),dy=Math.max(0,Math.abs(y)-(height/2-inset-r));
  const f=dx&&dy?Math.max(dx,dy)/Math.hypot(dx,dy):1;
  return [x-Math.sign(x)*dx*(1-f),y-Math.sign(y)*dy*(1-f)];
 }
 const flat=id==='back'||id==='z5',nx=flat?12:W-1,ny=flat?16:H-1;
 for(let y=0;y<=ny;y++)for(let x=0;x<=nx;x++){
  const u=x/nx,v=y/ny,off=((row*H+Math.round(v*(H-1)))*684+col*W+Math.round(u*(W-1)))*4;
  const pigment=[pixels[off+2],pixels[off+1],pixels[off]];
  const ink=flat?0:Math.max(0,Math.min(1,(249-Math.min(...pigment))/190));
  const color=flat?(id==='back'?amber:ivory):pigment.map((v,i)=>Math.round(v*ivory[i]/255));
  vertex(...xy(u,v,.72),d/2-.46*ink*ink*(3-2*ink),color);
  if(x&&y){const k=y*(nx+1)+x;face(k-nx-2,k-nx-1,k);face(k-nx-2,k,k-1)}
 }
 let rim=[];
 for(let x=0;x<=nx;x++)rim.push(x);
 for(let y=1;y<=ny;y++)rim.push(y*(nx+1)+nx);
 for(let x=nx-1;x>=0;x--)rim.push(ny*(nx+1)+x);
 for(let y=ny-1;y>0;y--)rim.push(y*(nx+1));
 const uv=rim.map(i=>[(i%(nx+1))/nx,Math.floor(i/(nx+1))/ny]);
 for(const [inset,z,c] of [
  [.48,8.21,ivory],[.21,8.06,ivory],[.06,7.79,ivory],[0,7.52,ivory],
  [0,-4.42,ivory],[.045,-4.5,seam],[0,-4.58,amber],
  [0,-7.52,amber],[.06,-7.79,amber],[.21,-8.06,amber],[.48,-8.21,amber],[.72,-8.25,amber]
 ]){
  const ring=uv.map(([u,v])=>vertex(...xy(u,v,inset),z,c));
  rim.forEach((a,i)=>{const j=(i+1)%rim.length;face(a,ring[j],rim[j]);face(a,ring[i],ring[j])});rim=ring;
 }
 const center=vertex(0,0,-d/2,amber);
 rim.forEach((a,i)=>face(a,center,rim[(i+1)%rim.length]));
 norm.push(...new Float32Array(pos.length));
 for(let i=0;i<idx.length;i+=3){const [a,b,c]=idx.slice(i,i+3).map(k=>3*k);
 const ux=pos[b]-pos[a],uy=pos[b+1]-pos[a+1],uz=pos[b+2]-pos[a+2],vx=pos[c]-pos[a],vy=pos[c+1]-pos[a+1],vz=pos[c+2]-pos[a+2];
 for(const k of [a,b,c]){norm[k]+=uy*vz-uz*vy;norm[k+1]+=uz*vx-ux*vz;norm[k+2]+=ux*vy-uy*vx}}
 for(let k=0;k<norm.length;k+=3){const n=Math.hypot(...norm.slice(k,k+3))||1;for(let j=0;j<3;j++)norm[k+j]/=n}
 const n=pos.length/3;
 const attributes={POSITION:accessor(new Float32Array(pos),'VEC3',n,34962,[-.01025,-.014,-.00825],[.01025,.014,.00825]),NORMAL:accessor(new Float32Array(norm),'VEC3',n,34962),COLOR_0:accessor(new Uint8Array(rgb),'VEC4',n,34962)};
 // glTF vertex attributes require four-byte alignment between successive vertices.
 const color=accessors[attributes.COLOR_0],view=views[color.bufferView];
 meshes.push({name:id,primitives:[{attributes,indices:accessor(new Uint16Array(idx),'SCALAR',idx.length,34963),material:0}]});
 nodes.push({mesh:meshes.length-1,name:id,translation:[col*.026,-row*.035,0]});
}
for(const [row,s] of [...'mpsz'].entries())for(let i=1;i<=(s==='z'?7:9);i++)makeTile(s+i,i-1,row);
for(const [col,s] of [...'mps'].entries())makeTile(s+'0',col,4);
makeTile('back',8,4);
const json=Buffer.from(JSON.stringify({asset:{version:'2.0',generator:'Riichi engraved tile modeller'},scene:0,scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,materials:[{name:'Pigmented resin',pbrMetallicRoughness:{metallicFactor:0,roughnessFactor:.38}}],buffers:[{byteLength:length}],bufferViews:views,accessors}));
const chunk=(data,type,fill)=>{const pad=(4-data.length%4)%4,h=Buffer.alloc(8);h.writeUInt32LE(data.length+pad);h.writeUInt32LE(type,4);return Buffer.concat([h,data,Buffer.alloc(pad,fill)])};
const chunks=[chunk(json,0x4e4f534a,32),chunk(Buffer.concat(parts),0x004e4942,0)],header=Buffer.alloc(12);
header.write('glTF');header.writeUInt32LE(2,4);header.writeUInt32LE(12+chunks.reduce((s,b)=>s+b.length,0),8);
fs.writeFileSync('tiles.glb',Buffer.concat([header,...chunks]));
