/* The CSS table supplies the camera and the tile transforms. WebGL draws all
   solids on the table into a shared depth buffer. */
(async function () {
 const canvas = document.createElement('canvas');
 canvas.className = 'mesh-layer';
 canvas.setAttribute('aria-hidden', 'true');
 document.body.append(canvas);

 const gl = canvas.getContext('webgl', {alpha:true, antialias:true, premultipliedAlpha:false});
 if (!gl) return;
 const response = await fetch('/tiles.glb');
 if (!response.ok) throw Error('模型加载失败');
 const data = await response.arrayBuffer();
 const header = new DataView(data);
 const size = header.getUint32(12, true);
 const doc = JSON.parse(new TextDecoder().decode(new Uint8Array(data, 20, size)));
 const base = 28 + size;
 // All variants share the same solid envelope. Read its dimensions from the model.
 const bounds = doc.accessors[doc.meshes[0].primitives[0].attributes.POSITION];
 const dimensions = bounds.max.map((max, axis) => max - bounds.min[axis]);
 const [widthMm, heightMm, depthMm] = dimensions.map(metres => metres * 1000);
 const buffers = doc.bufferViews.map(view => {
  const buffer = gl.createBuffer();
  gl.bindBuffer(view.target, buffer);
  gl.bufferData(view.target, new Uint8Array(data, base + view.byteOffset, view.byteLength), gl.STATIC_DRAW);
  return buffer;
 });
 const library = new Map(doc.meshes.map(mesh => [mesh.name, mesh.primitives[0]]));

 const program = gl.createProgram();
 for (const [type, source] of [[gl.VERTEX_SHADER, `
  attribute vec3 position, normal;
  attribute vec4 color;
  uniform vec4 origin, axisX, axisY, axisZ;
  uniform vec3 dimensions;
  uniform vec3 light;
  uniform float brightness;
  varying vec3 shaded;
  void main() {
   vec3 tile = position / dimensions + .5;
   gl_Position = origin + axisX * tile.x + axisY * tile.y + axisZ * tile.z;
   vec3 linear = color.rgb * (.73 + .27 * max(dot(normalize(normal), light), 0.));
   shaded = pow(linear, vec3(1. / 2.2)) * brightness;
  }`], [gl.FRAGMENT_SHADER, `
  precision mediump float;
  varying vec3 shaded;
  void main() { gl_FragColor = vec4(shaded, 1.); }
 `]]) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(shader));
  gl.attachShader(program, shader);
 }
 gl.linkProgram(program);
 if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
 gl.useProgram(program);
 gl.uniform3fv(gl.getUniformLocation(program,'dimensions'), [dimensions[0], -dimensions[1], dimensions[2]]);
 const [origin, axisX, axisY, axisZ, light, brightness] = ['origin','axisX','axisY','axisZ','light','brightness'].map(name => gl.getUniformLocation(program,name));
 const dimBrightness = Number(getComputedStyle(document.documentElement).getPropertyValue('--tsumogiri-brightness'));
 const attributes = ['position','normal','color'].map(name => gl.getAttribLocation(program,name));
 attributes.forEach(index => gl.enableVertexAttribArray(index));
 gl.enable(gl.DEPTH_TEST);
 gl.depthFunc(gl.LEQUAL);

 function bind(slot, index) {
  const accessor = doc.accessors[index];
  gl.bindBuffer(gl.ARRAY_BUFFER, buffers[accessor.bufferView]);
  gl.vertexAttribPointer(attributes[slot], slot === 2 ? 4 : 3, accessor.componentType, !!accessor.normalized, 0, 0);
 }
 const subtract = (a, b) => a.map((value, i) => value - b[i]);
 const unit = vector => {
  const length = Math.hypot(...vector) || 1;
  return vector.map(value => value / length);
 };
 const dot = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0);
 function readPins(pins) {
  return pins.map(pin => {
   const rect = pin.getBoundingClientRect();
   return [rect.x, rect.y];
  });
 }
 function drawTile(item, weights, depths, direction, width, height) {
  const projected = item.points.map(([x, y], i) => {
   const w = weights[i];
   return [(2*x/width - 1)*w, (1 - 2*y/height)*w, depths[i], w];
  });
  const start = projected[0];
  gl.uniform4fv(origin, start);
  gl.uniform4fv(axisX, subtract(projected[1], start));
  gl.uniform4fv(axisY, subtract(projected[2], start));
  gl.uniform4fv(axisZ, subtract(projected[4], start));
  gl.uniform3fv(light, direction);
  gl.uniform1f(brightness, item.dimmed ? dimBrightness : 1);
  const mesh = item.mesh;
  bind(0, mesh.attributes.POSITION);
  bind(1, mesh.attributes.NORMAL);
  bind(2, mesh.attributes.COLOR_0);
  const indices = doc.accessors[mesh.indices];
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffers[indices.bufferView]);
  gl.drawElements(gl.TRIANGLES, indices.count, indices.componentType, 0);
 }
 function tableWeights(points, flat, center) {
  // CSS perspective maps screen displacement from the camera centre to
  // displacement / w. Remove the perspective temporarily to recover w.
  const weights = points.map((point, i) => {
   const ray = subtract(point, center), lengthSquared = dot(ray, ray);
   return lengthSquared > .25 ? dot(subtract(flat[i], center), ray) / lengthSquared : null;
  });
  return weights.map((weight, i) => {
   if (weight !== null) return weight;
   // w is affine across the cuboid. Use three other corners if this
   // corner sits on the optical axis and its screen displacement is zero.
   for (const [a,b] of [[1,2],[1,4],[2,4]]) {
    const adjacent = [weights[i^a], weights[i^b], weights[i^a^b]];
    if (adjacent.every(value => value !== null)) return adjacent[0] + adjacent[1] - adjacent[2];
   }
   return 1;
  });
 }
 function drawTable(items, camera, width, height, dpr) {
  if (!items.length) return;
  const bounds = camera.getBoundingClientRect();
  const center = [bounds.x + bounds.width/2, bounds.y + bounds.height/2];
  const zoom = bounds.width / camera.offsetWidth;
  const distance = parseFloat(getComputedStyle(camera).perspective);
  const previous = camera.style.perspective;
  camera.style.perspective = 'none';
  try {
   for (const item of items) item.flat = readPins(item.pins);
  } finally {
   camera.style.perspective = previous;
  }

  const viewport = camera.parentElement.getBoundingClientRect();
  const left = Math.max(0, Math.floor(viewport.left*dpr));
  const bottom = Math.max(0, Math.floor((height-viewport.bottom)*dpr));
  const right = Math.min(canvas.width, Math.ceil(viewport.right*dpr));
  const top = Math.min(canvas.height, Math.ceil((height-viewport.top)*dpr));
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(left, bottom, Math.max(0,right-left), Math.max(0,top-bottom));
  for (const item of items) {
   const weights = tableWeights(item.points, item.flat, center);
   const axis = i => {
    const [x,y] = subtract(item.flat[i],item.flat[0]);
    return unit([x/zoom, y/zoom, (weights[0]-weights[i])*distance]);
   };
   const worldLight = [-.28,-.40,.87];
   const direction = unit([dot(axis(1),worldLight), -dot(axis(2),worldLight), dot(axis(4),worldLight)]);
   drawTile(item, weights, weights.map(w => 2*(w-1)), direction, width, height);
  }
  gl.disable(gl.SCISSOR_TEST);
 }
 function drawInterfaceTile(item, width, height) {
  // The independent preview and form controls have their own CSS cameras.
  const p = item.points;
  const x = subtract(p[1],p[0]).map(v => v/widthMm);
  const y = subtract(p[0],p[2]).map(v => v/heightMm);
  const z = subtract(p[4],p[0]).map(v => v/depthMm);
  const area = (a,b) => a[1]*b[0] - a[0]*b[1];
  const normal = unit([area(y,z),area(z,x),area(x,y)]);
  const direction = unit([normal[0]-.3, normal[1]+.4, normal[2]+.1]);
  const depth = p.map((_,i) => -.022 * dot([i&1 ? widthMm : 0, i&2 ? -heightMm : 0, i&4 ? depthMm : 0], normal));
  gl.clear(gl.DEPTH_BUFFER_BIT);
  drawTile(item, p.map(() => 1), depth, direction, width, height);
 }

 let queued = false;
 function draw() {
  queued = false;
  const width = innerWidth, height = innerHeight, dpr = Math.min(devicePixelRatio,2);
  const pixelWidth = Math.round(width*dpr), pixelHeight = Math.round(height*dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
   canvas.width = pixelWidth;
   canvas.height = pixelHeight;
  }
  gl.viewport(0,0,pixelWidth,pixelHeight);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  const camera = document.querySelector('.camera');
  const table = [], controls = [];
  for (const tile of document.querySelectorAll('.block[data-model]')) {
   const mesh = library.get(tile.dataset.model);
   const bounds = tile.getBoundingClientRect();
   if (!mesh || !bounds.width || bounds.bottom < 0 || bounds.top > height || bounds.right < 0 || bounds.left > width) continue;
   const pins = Array.from(tile.querySelectorAll('.pin'));
   if (pins.length !== 8) continue;
   const target = camera?.contains(tile) ? table : controls;
   target.push({mesh,pins,points:readPins(pins),dimmed:tile.closest('.tsumogiri')!==null});
  }
  drawTable(table,camera,width,height,dpr);
  for (const item of controls) drawInterfaceTile(item,width,height);
 }
 function schedule() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(draw);
 }
 document.documentElement.classList.add('meshes-ready');
 new MutationObserver(schedule).observe(document.body, {childList:true,subtree:true});
 document.addEventListener('toggle',schedule,true);
 for (const event of ['resize','scroll','pointerover','pointerout']) window.addEventListener(event,schedule,true);
 canvas.addEventListener('webglcontextlost', () => document.documentElement.classList.remove('meshes-ready'));
 schedule();
})().catch(console.error);
