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
  const cols = Number(columns.value), spacing = Number(gap.value), tileWidth = 640, rows = Math.ceil(images.length / cols);
  const original = ratio.value === 'original';
  const [rw, rh] = original ? [1, 1] : ratio.value.split(':').map(Number);
  const fixedHeight = Math.round(tileWidth * rh / rw);
  const rowHeights = Array.from({length: rows}, (_, row) => original
    ? Math.max(...images.slice(row * cols, (row + 1) * cols).map(({img}) => Math.max(1, Math.round(tileWidth * img.naturalHeight / img.naturalWidth))))
    : fixedHeight);
  const width = cols * tileWidth + (cols + 1) * spacing;
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + (rows + 1) * spacing + 54;
  const outputScale = Math.min(1, 32767 / width, 32767 / height, Math.sqrt(100000000 / (width * height)));
  canvas.width = Math.max(1, Math.floor(width * outputScale));
  canvas.height = Math.max(1, Math.floor(height * outputScale));
  const ctx = canvas.getContext('2d');
  ctx.scale(outputScale, outputScale);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height);
  let y = spacing;
  rowHeights.forEach((rowHeight, row) => {
    images.slice(row * cols, (row + 1) * cols).forEach(({img}, col) => {
      const x = spacing + col * (tileWidth + spacing);
      if (original) {
        const imageHeight = Math.max(1, Math.round(tileWidth * img.naturalHeight / img.naturalWidth));
        ctx.drawImage(img, x, y, tileWidth, imageHeight);
      } else {
        const scale = Math.max(tileWidth / img.naturalWidth, fixedHeight / img.naturalHeight);
        const sw = tileWidth / scale, sh = fixedHeight / scale;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, tileWidth, fixedHeight);
      }
    });
    y += rowHeight + spacing;
  });
  ctx.fillStyle = '#304050'; ctx.font = '18px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('Generado por FrameGrid - https://lyrians.github.io/FrameGrid/', width / 2, height - 27, width - 24);
  document.querySelector('#dimensions').textContent = `${canvas.width} × ${canvas.height} PX${outputScale < 1 ? " · ajustado al límite del navegador" : ""}`;
}
files.addEventListener('change', () => addFiles(files.files));
['dragenter','dragover'].forEach(name => drop.addEventListener(name, e => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave','drop'].forEach(name => drop.addEventListener(name, e => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
[columns,gap,ratio].forEach(el => el.addEventListener('input', render));
clear.addEventListener('click', () => { images.forEach(({url}) => URL.revokeObjectURL(url)); images = []; render(); });
download.addEventListener('click', () => { const a = document.createElement('a'); a.download = 'collage.png'; a.href = canvas.toDataURL('image/png'); a.click(); });


