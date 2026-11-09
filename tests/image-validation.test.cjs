const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const validationSource = fs.readFileSync(path.join(root, 'image-validation.js'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8').replace(/init\(\);\s*$/, '');
const config = JSON.parse(fs.readFileSync(path.join(root, 'content.json'), 'utf8'));
function png(width = 640, height = 480) {
  const data = Buffer.alloc(41);
  Buffer.from([137,80,78,71,13,10,26,10]).copy(data);
  data.writeUInt32BE(13, 8); data.write('IHDR', 12);
  data.writeUInt32BE(width, 16); data.writeUInt32BE(height, 20);
  data.write('IDAT', 37);
  return data;
}
function jpeg(width, height) {
  return Buffer.from([255,216,255,224,0,4,0,0,255,194,0,8,8,height>>8,height&255,width>>8,width&255,0]);
}
function webp(kind, width, height) {
  const data = Buffer.alloc(30); data.write('RIFF'); data.writeUInt32LE(22,4); data.write('WEBP',8); data.write(kind,12); data.writeUInt32LE(10,16);
  if (kind === 'VP8X') { data.writeUIntLE(width-1,24,3); data.writeUIntLE(height-1,27,3); }
  if (kind === 'VP8 ') { Buffer.from([0x9d,1,0x2a]).copy(data,23); data.writeUInt16LE(width,26); data.writeUInt16LE(height,28); }
  if (kind === 'VP8L') {data[20]=0x2f; data.writeUInt32LE(((width-1) | ((height-1)<<14))>>>0,21);}
  return data;
}
function file(bytes, name = 'captura.png', type = '') {
  const blob = new Blob([bytes], {type});
  Object.defineProperty(blob, 'name', {value: name});
  return blob;
}
function harness(overrides = {}) {
  const nodes = new Map(), pending = [], revoked = [], created = [];
  const get = key => {if (!nodes.has(key)) nodes.set(key, {value:'',hidden:false,textContent:'',setAttribute(){},focus(){}});return nodes.get(key);};
  class Image {
    constructor() {this.naturalWidth=640;this.naturalHeight=480;this.onload=null;this.onerror=null;created.push(this);}
    set src(value) {this.source=value;if(value)pending.push(this);}
    get src() {return this.source;}
  }
  let urlId = 0;
  const sandbox = {document:{querySelector:get}, Image, URL:{createObjectURL:()=> 'blob:' + (++urlId),revokeObjectURL:url=>revoked.push(url)}, setTimeout,clearTimeout,console, config:structuredClone(config)};
  Object.assign(sandbox.config.limits, overrides);
  vm.createContext(sandbox);
  vm.runInContext(validationSource+'\n'+appSource, sandbox);
  vm.runInContext('content = config; render = () => {};', sandbox);
  const run = code => vm.runInContext(code, sandbox);
  return {sandbox,get,pending,revoked,created,run,api:run('ImageValidation'),limits:sandbox.config.limits};
}
async function until(predicate) {
  for (let count=0;count<50;count++) {if(predicate())return;await new Promise(setImmediate);}
  assert.fail('Expected queued work did not arrive');
}
function buffer(data) {return data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength);}
const errorCode = code => error => error.code === code;

test('reads PNG, progressive JPEG and all three WebP dimension headers', () => {
  const {api}=harness();
  for (const bytes of [png(1920,1080),jpeg(1920,1080),...['VP8X','VP8 ','VP8L'].map(kind=>webp(kind,1920,1080))]) {
    const info=api.inspectHeader(buffer(bytes));assert.equal(info.width,1920);assert.equal(info.height,1080);assert.equal(info.pixels,2073600);
  }
});
test('actual PNG assets can be inspected independently of MIME labels', async () => {
  const {api,limits}=harness();
  for (const filename of ['framegrid.png','screenshot.png','collage (1).png']) {
    const info=await api.inspect(file(fs.readFileSync(path.join(root,filename)),filename,''),limits);
    assert.ok(info.width>0&&info.height>0);assert.equal(info.mime,'image/png');
  }
});
test('rejects weight before reading any bytes and rejects empty files', async () => {
  const {api,limits}=harness();
  await assert.rejects(api.inspect({size:limits.maxFileBytes+1,slice(){assert.fail('Should not read oversized file');}},limits),errorCode('fileTooLarge'));
  await assert.rejects(api.inspect(file(Buffer.alloc(0)),limits),errorCode('emptyImage'));
});
test('rejects excessive dimensions and pixels before image decoding', async () => {
  const {api,limits}=harness();
  await assert.rejects(api.inspect(file(png(13000,1)),limits),errorCode('imageTooLarge'));
  await assert.rejects(api.inspect(file(png(6000,5000)),limits),errorCode('imageTooLarge'));
});
test('rejects unsupported, malformed, truncated and animated headers', () => {
  const {api}=harness();
  for(const bytes of [Buffer.from('<svg/>'),Buffer.from('GIF89a')]) assert.throws(()=>api.inspectHeader(buffer(bytes)),errorCode('unsupportedImage'));
  assert.throws(()=>api.inspectHeader(buffer(png().subarray(0,20))),errorCode('invalidImage'));
  assert.throws(()=>api.inspectHeader(buffer(Buffer.from([255,216,255,224,0,1]))),errorCode('invalidImage'));
  const animated=webp('VP8X',640,480);animated[20]=2;assert.throws(()=>api.inspectHeader(buffer(animated)),errorCode('animatedImage'));
  const apng=png();apng.write('acTL',37);assert.throws(()=>api.inspectHeader(buffer(apng)),errorCode('animatedImage'));
  const zero=png(0,480);assert.throws(()=>api.inspectHeader(buffer(zero)),errorCode('invalidImage'));
});
test('bounds header reads to one MiB', async () => {
  const {api,limits}=harness();let readEnd;
  const source={size:2000000,slice(start,end){readEnd=end;return new Blob([png()]);}};
  await api.inspect(source,limits);assert.equal(readEnd,1048576);
});
test('enforces count, source bytes and decoded pixels; removing images frees budget', () => {
  const {api,limits}=harness();const incoming={pixels:100};
  assert.throws(()=>api.checkBudget(incoming,10,Array.from({length:limits.maxFiles},()=>({bytes:0,pixels:0})),limits),errorCode('tooManyImages'));
  assert.throws(()=>api.checkBudget(incoming,1,[{bytes:limits.maxTotalBytes,pixels:0}],limits),errorCode('totalBytesExceeded'));
  assert.throws(()=>api.checkBudget(incoming,0,[{bytes:0,pixels:limits.maxTotalPixels}],limits),errorCode('memoryBudgetExceeded'));
  assert.doesNotThrow(()=>api.checkBudget(incoming,10,[],limits));
});
test('serializes concurrent batches, preserving paste order and one decode at a time', async () => {
  const h=harness();h.sandbox.first=[file(png(),'primera.png')];h.sandbox.second=[file(png(),'segunda.png')];
  const first=h.run('addFiles(first)'),second=h.run('addFiles(second)');
  await until(()=>h.pending.length===1);assert.equal(h.created.length,1);
  h.pending.shift().onload();await first;
  await until(()=>h.pending.length===1);assert.equal(h.created.length,2);
  h.pending.shift().onload();await second;
  assert.deepEqual(Array.from(h.run('images.map(image=>image.filename)')),['primera.png','segunda.png']);
  assert.equal(h.run('loading'),0);assert.equal(h.run('queuedFiles'),0);
});
test('invalid file reports its name and a later good file still loads', async () => {
  const h=harness();h.sandbox.batch=[file(Buffer.from('bad'),'rota.png'),file(png(),'buena.png')];const task=h.run('addFiles(batch)');
  await until(()=>h.pending.length===1);assert.equal(h.created.length,1);h.pending.shift().onload();await task;
  assert.match(h.get('#error').textContent,/rota.png/);assert.equal(h.run('images.length'),1);
});
test('count and queue limits prevent additional decodes', async () => {
  const h=harness({maxFiles:1,maxQueuedFiles:2});h.sandbox.batch=[file(png(),'uno.png'),file(png(),'dos.png'),file(png(),'tres.png')];const task=h.run('addFiles(batch)');
  await until(()=>h.pending.length===1);h.pending.shift().onload();await task;
  assert.equal(h.created.length,1);assert.equal(h.run('images.length'),1);assert.match(h.get('#error').textContent,/cola/);assert.match(h.get('#error').textContent,/dos.png/);
});
test('cancelling revokes the active URL and discards the remaining queue', async () => {
  const h=harness();h.sandbox.batch=[file(png(),'uno.png'),file(png(),'dos.png')];const task=h.run('addFiles(batch)');
  await until(()=>h.pending.length===1);h.run('cancelPendingLoads()');await task;
  assert.equal(h.created.length,1);assert.equal(h.run('images.length'),0);assert.equal(h.revoked.length,1);assert.equal(h.run('loading'),0);
});
test('decode errors and timeouts release resources', async () => {
  for(const failure of ['error','timeout']) {
    const h=harness({decodeTimeoutMs:20});h.sandbox.batch=[file(png(),'problema.png')];const task=h.run('addFiles(batch)');
    await until(()=>h.pending.length===1);if(failure==='error')h.pending.shift().onerror();await task;
    assert.equal(h.revoked.length,1);assert.equal(h.run('images.length'),0);assert.match(h.get('#error').textContent,/problema.png/);
  }
});
test('output geometry respects the configured pixel and side budgets', () => {
  const h=harness();h.run("images=Array.from({length:40},()=>({img:{naturalWidth:100,naturalHeight:12000}}));layout.ratio='original';layout.columns=1;");
  const geometry=h.run('sheetGeometry()');const width=Math.floor(geometry.width*geometry.scale),height=Math.floor(geometry.height*geometry.scale);
  assert.ok(width<=h.limits.maxCanvasDimension);assert.ok(height<=h.limits.maxCanvasDimension);assert.ok(width*height<=h.limits.maxCanvasPixels);
});
