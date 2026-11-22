/* Project each mesh through its tile's existing table transform. The eight
   reference points include the front and rear planes of the solid. */
(async function(){
 const layer=document.createElement('canvas');layer.className='mesh-layer';layer.setAttribute('aria-hidden','true');
 document.body.append(layer);
 const gl=layer.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:false});
 if(!gl)return;
 const response=await fetch('/tiles.glb');if(!response.ok)throw Error('模型加载失败');
 const data=await response.arrayBuffer(),header=new DataView(data),size=header.getUint32(12,true);
 const doc=JSON.parse(new TextDecoder().decode(new Uint8Array(data,20,size))),base=28+size;
 const buffers=doc.bufferViews.map(v=>{const b=gl.createBuffer();gl.bindBuffer(v.target,b);gl.bufferData(v.target,new Uint8Array(data,base+v.byteOffset,v.byteLength),gl.STATIC_DRAW);return b});
 const library=new Map(doc.meshes.map(m=>[m.name,m.primitives[0]]));
 const program=gl.createProgram();
 for(const [type,source] of [[gl.VERTEX_SHADER,`
 attribute vec3 p,n;attribute vec4 color;uniform vec2 corners[8],screen;uniform vec3 light;varying vec3 shaded;
 void main(){
 vec2 uv=vec2(p.x/.0205+.5,.5-p.y/.028);float z=p.z/.0165+.5;
 vec2 back=mix(mix(corners[0],corners[1],uv.x),mix(corners[2],corners[3],uv.x),uv.y);
 vec2 front=mix(mix(corners[4],corners[5],uv.x),mix(corners[6],corners[7],uv.x),uv.y);
 vec2 pos=mix(back,front,z);
 shaded=color.rgb*(.79+.23*max(dot(normalize(n),normalize(light+vec3(-.4,.55,.1))),0.));
 gl_Position=vec4(pos.x/screen.x*2.-1.,1.-pos.y/screen.y*2.,clamp(-dot(p,light)*38.,-.99,.99),1.);
 }`],[gl.FRAGMENT_SHADER,`
 precision mediump float;varying vec3 shaded;void main(){gl_FragColor=vec4(shaded,1.);}
 `]]){
 const shader=gl.createShader(type);gl.shaderSource(shader,source);gl.compileShader(shader);
 if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(shader));gl.attachShader(program,shader);
 }
 gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));gl.useProgram(program);
 const corners=gl.getUniformLocation(program,'corners[0]'),screen=gl.getUniformLocation(program,'screen'),light=gl.getUniformLocation(program,'light');
 const attrs=['p','n','color'].map(n=>gl.getAttribLocation(program,n));attrs.forEach(a=>gl.enableVertexAttribArray(a));
 function bind(i,index){const a=doc.accessors[index];gl.bindBuffer(gl.ARRAY_BUFFER,buffers[a.bufferView]);gl.vertexAttribPointer(attrs[i],i===2?4:3,a.componentType,!!a.normalized,0,0)}
 let queued=false;
 function draw(){
 queued=false;const w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio,2);
 if(layer.width!==Math.round(w*dpr)||layer.height!==Math.round(h*dpr)){layer.width=Math.round(w*dpr);layer.height=Math.round(h*dpr)}
 gl.viewport(0,0,layer.width,layer.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.uniform2f(screen,w,h);
 const items=[];
 for(const el of document.querySelectorAll('.block[data-model]')){
  const rect=el.getBoundingClientRect();if(!rect.width||rect.bottom<0||rect.top>h||rect.right<0||rect.left>w)continue;
  const points=Array.from(el.querySelectorAll('.pin'),p=>{const r=p.getBoundingClientRect();return [r.x,r.y]});
  if(points.length===8)items.push({el,points,y:rect.bottom});
 }
 items.sort((a,b)=>a.y-b.y);
 for(const {el,points} of items){
 const m=library.get(el.dataset.model);if(!m)continue;
 // The signed screen areas of the three projected basis pairs give the local viewing direction.
 const ax=points[1].map((v,i)=>(v-points[0][i])/20.5),ay=points[2].map((v,i)=>(points[0][i]-v)/28),az=points[4].map((v,i)=>(v-points[0][i])/16.5);
 const cross=(a,b)=>b[0]*a[1]-a[0]*b[1],view=[cross(ay,az),cross(az,ax),cross(ax,ay)],len=Math.hypot(...view)||1;
 gl.clear(gl.DEPTH_BUFFER_BIT);gl.uniform3fv(light,view.map(v=>v/len));gl.uniform2fv(corners,points.flat());
 bind(0,m.attributes.POSITION);bind(1,m.attributes.NORMAL);bind(2,m.attributes.COLOR_0);const a=doc.accessors[m.indices];gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,buffers[a.bufferView]);gl.drawElements(gl.TRIANGLES,a.count,a.componentType,0);
 }
 }
 function schedule(){if(!queued){queued=true;requestAnimationFrame(draw)}}
 document.documentElement.classList.add('meshes-ready');new MutationObserver(schedule).observe(document.body,{childList:true,subtree:true});
 for(const event of ['resize','scroll','pointerover','pointerout'])window.addEventListener(event,schedule,true);
 layer.addEventListener('webglcontextlost',()=>document.documentElement.classList.remove('meshes-ready'));
 schedule();
})().catch(console.error);

