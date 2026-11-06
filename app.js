const files = document.querySelector('#files'), drop = document.querySelector('#drop'), canvas = document.querySelector('#canvas'), empty = document.querySelector('#empty'), thumbs = document.querySelector('#thumbs'), count = document.querySelector('#count'), clear = document.querySelector('#clear'), download = document.querySelector('#download'), columns = document.querySelector('#columns'), gap = document.querySelector('#gap'), ratio = document.querySelector('#ratio');
let images = [];
async function addFiles(list) {
  const selected = [...list].filter(file => file.type.startsWith('image/'));
  const loaded = await Promise.all(selected.map(file => new Promise(resolve => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => resolve({img, url});
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  })));
  images.push(...loaded.filter(Boolean)); files.value = ''; render();
}
function render() {
  count.textContent = images.length ? `${images.length} ${images.length === 1 ? 'imagen seleccionada' : 'imágenes seleccionadas'}` : 'Ninguna imagen seleccionada';
  clear.hidden = !images.length; download.disabled = !images.length; empty.hidden = !!images.length; canvas.hidden = !images.length;
  thumbs.replaceChildren(...images.map(({url}) => { const img = document.createElement('img'); img.src = url; img.alt = ''; return img; }));
  document.querySelector('#gapValue').textContent = `${gap.value} px`;
  if (!images.length) { document.querySelector('#dimensions').textContent = '— × — PX'; return; }
  const cols = Number(columns.value), spacing = Number(gap.value), [rw,rh] = ratio.value.split(':').map(Number), tileWidth = 640, tileHeight = Math.round(tileWidth * rh / rw), rows = Math.ceil(images.length / cols);
  canvas.width = cols * tileWidth + (cols + 1) * spacing; canvas.height = rows * tileHeight + (rows + 1) * spacing + 54;
  const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  images.forEach(({img}, i) => { const scale = Math.max(tileWidth / img.naturalWidth, tileHeight / img.naturalHeight), sw = tileWidth / scale, sh = tileHeight / scale; ctx.drawImage(img,(img.naturalWidth-sw)/2,(img.naturalHeight-sh)/2,sw,sh,spacing+(i%cols)*(tileWidth+spacing),spacing+Math.floor(i/cols)*(tileHeight+spacing),tileWidth,tileHeight); });
  ctx.fillStyle = '#304050'; ctx.font = '18px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Generado por FrameGrid - https://lyrians.github.io/FrameGrid/', canvas.width / 2, canvas.height - 27, canvas.width - 24);
  document.querySelector('#dimensions').textContent = `${canvas.width} × ${canvas.height} PX`;
}
files.addEventListener('change', () => addFiles(files.files));
['dragenter','dragover'].forEach(name => drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave','drop'].forEach(name => drop.addEventListener(name, e => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
[columns,gap,ratio].forEach(el => el.addEventListener('input', render));
clear.addEventListener('click', () => { images.forEach(({url}) => URL.revokeObjectURL(url)); images = []; render(); });
download.addEventListener('click', () => { const a = document.createElement('a'); a.download = 'collage.png'; a.href = canvas.toDataURL('image/png'); a.click(); });


