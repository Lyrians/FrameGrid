const $ = selector => document.querySelector(selector);
const files = $('#files'), canvas = $('#canvas'), grid = $('#image-grid');
const layout = {columns: 3, gap: 16, tileWidth: 640, ratio: '4:3', background: '#ffffff', format: 'png'};
const exportFormats = {png: {mime: 'image/png', extension: 'png', label: 'PNG'}, jpeg: {mime: 'image/jpeg', extension: 'jpg', label: 'JPG'}, webp: {mime: 'image/webp', extension: 'webp', label: 'WEBP'}};
let content, images = [], loadVersion = 0, loading = 0, nextId = 0, drag = null;
let loadChain = Promise.resolve(), queuedFiles = 0, activeCancel = null;
let loadErrors = [], loadErrorCount = 0;

function text(key, values = {}) {
  const template = key.split('.').reduce((value, part) => value?.[part], content);
  if (typeof template !== 'string') throw new Error('Missing content key: ' + key);
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
}
function showError(message = '') {
  $('#error').textContent = message;
  $('#error').hidden = !message;
}
function watermark() {
  return text('download.watermark', {name: text('site.name'), url: text('site.url')});
}
async function init() {
  try {
    if (window.location.protocol === 'file:') {
      $('#startup-error').textContent = 'Para abrir FrameGrid en el equipo, ejecutá Abrir FrameGrid.cmd en la carpeta del proyecto.';
      $('#startup-error').hidden = false;
      return;
    }
    const response = await fetch('content.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('Content request failed: ' + response.status);
    content = await response.json();
    const limitKeys = ['maxFiles','maxQueuedFiles','maxFileBytes','maxTotalBytes','maxImagePixels','maxTotalPixels','maxImageDimension','maxCanvasPixels','maxCanvasDimension','decodeTimeoutMs'];
    if (limitKeys.some(key => !Number.isSafeInteger(content.limits?.[key]) || content.limits[key] <= 0)) throw new Error('Invalid image limits');
    if (content.limits.maxImagePixels > content.limits.maxTotalPixels || content.limits.maxFileBytes > content.limits.maxTotalBytes) throw new Error('Inconsistent image limits');
    const bindings = [...document.querySelectorAll('[data-text]')];
    const labels = bindings.map(element => text(element.dataset.text));
    ['upload.countOne', 'upload.countMany', 'upload.loading', 'upload.pastedName', 'preview.item', 'preview.remove', 'preview.moved', 'preview.removed', 'preview.dimensions', 'preview.scaled', 'download.label', 'settings.gapValue', 'errors.unsupportedExport', 'download.filename', 'download.watermark', 'site.url', 'errors.unsupportedFiles', 'errors.imageLoad', 'errors.render', 'errors.download'].forEach(key => text(key));
    bindings.forEach((element, index) => { element.textContent = labels[index]; });
    document.querySelectorAll('[data-label]').forEach(element => element.setAttribute('aria-label', text(element.dataset.label)));
    document.title = text('site.title');
    document.documentElement.lang = text('site.language');
    $('meta[name="description"]').content = text('site.description');
    canvas.setAttribute('aria-label', text('preview.canvas'));
    $('#load-limits').textContent = text('upload.limitSummary', {count: content.limits.maxFiles, fileMB: Math.round(content.limits.maxFileBytes / 1048576)});
    $('#filename').value = filenameBase(text('download.filename')) || 'framegrid';
    bindEvents();
    render();
    $('#app').inert = false;
  } catch (error) {
    console.error('FrameGrid initialization failed:', error);
    $('#startup-error').hidden = false;
  }
}
function updateLoading() {
  $('#app').setAttribute('aria-busy', String(loading > 0));
  $('#upload').disabled = $('#add').disabled = loading > 0;
  $('#cancel-load').hidden = !loading;
  if (loading) $('#status').textContent = text('upload.loading');
}
function reportLoadFailure(message) {
  loadErrorCount++;
  if (loadErrors.length < 8) loadErrors.push(message);
  const messages = [...loadErrors];
  if (loadErrorCount > loadErrors.length) messages.push(text('errors.additionalErrors', {count: loadErrorCount - loadErrors.length}));
  showError(messages.join('\n'));
}
function cancelPendingLoads() {
  loadVersion++;
  activeCancel?.();
}
function decodeImage(file, info) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let url, timer, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      img.onload = img.onerror = null;
      if (activeCancel === cancel) activeCancel = null;
      if (error) {
        img.src = '';
        if (url) URL.revokeObjectURL(url);
        reject(error);
      } else resolve({id: ++nextId, img, url, bytes: file.size, pixels: info.pixels, filename: file.name || text('upload.pastedName', {number: nextId})});
    };
    const cancel = () => {
      const error = new Error('Image load cancelled');
      error.name = 'AbortError';
      finish(error);
    };
    activeCancel = cancel;
    timer = setTimeout(() => finish(new ImageValidation.ValidationError('decodeTimeout')), content.limits.decodeTimeoutMs);
    img.onerror = () => finish(new ImageValidation.ValidationError('decodeFailed'));
    img.onload = () => {
      const {naturalWidth: width, naturalHeight: height} = img;
      // EXIF rotation may swap sides; it cannot increase the pixel budget.
      if (!width || !height || width * height > info.pixels || Math.max(width, height) > content.limits.maxImageDimension) {
        finish(new ImageValidation.ValidationError('invalidImage'));
      } else finish();
    };
    try {
      url = URL.createObjectURL(file.slice(0, file.size, info.mime));
      img.src = url;
    } catch (error) { finish(new ImageValidation.ValidationError('decodeFailed')); }
  });
}
async function processBatch(batch, version) {
  for (let index = 0; index < batch.length; index++) {
    if (version !== loadVersion) return;
    const file = batch[index];
    $('#status').textContent = text('upload.progress', {current: index + 1, total: batch.length});
    try {
      if (images.length >= content.limits.maxFiles) throw new ImageValidation.ValidationError('tooManyImages', {limit: content.limits.maxFiles});
      const info = await ImageValidation.inspect(file, content.limits);
      if (version !== loadVersion) return;
      ImageValidation.checkBudget(info, file.size, images, content.limits);
      const image = await decodeImage(file, info);
      if (version !== loadVersion) {
        image.img.src = '';
        URL.revokeObjectURL(image.url);
        return;
      }
      images.push(image);
    } catch (error) {
      if (version !== loadVersion || error.name === 'AbortError') return;
      const reason = error instanceof ImageValidation.ValidationError ? text('errors.' + error.code, error.values) : text('errors.unexpectedLoad');
      reportLoadFailure(text('errors.fileError', {filename: (file.name || text('upload.pastedName', {number: nextId + 1})).slice(0, 120), reason}));
    }
  }
  if (version !== loadVersion) return;
  cancelDrag();
  render();
  if (images.length) $('#editor-title').focus({preventScroll: true});
}
function addFiles(list) {
  if (!list.length) return Promise.resolve();
  if (!loading) { loadErrors = []; loadErrorCount = 0; showError(); }
  const version = loadVersion;
  const count = Math.min(list.length, Math.max(0, content.limits.maxQueuedFiles - queuedFiles));
  const batch = Array.from({length: count}, (_, index) => list[index]);
  if (count < list.length) reportLoadFailure(text('errors.queueFull', {count: list.length - count}));
  if (!count) return Promise.resolve();
  queuedFiles += count;
  loading++;
  updateLoading();
  const task = loadChain.then(() => processBatch(batch, version)).catch(error => {
    console.error('FrameGrid load failed:', error);
    if (version === loadVersion) reportLoadFailure(text('errors.unexpectedLoad'));
  }).finally(() => {
    queuedFiles -= count;
    loading--;
    files.value = '';
    updateLoading();
    if (!loading) $('#status').textContent = images.length ? text(images.length === 1 ? 'upload.countOne' : 'upload.countMany', {count: images.length}) : '';
  });
  loadChain = task;
  return task;
}
function makeTile(image, index) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.dataset.id = image.id;
  tile.style.aspectRatio = layout.ratio === 'original' ? String(image.img.naturalWidth / image.img.naturalHeight) : layout.ratio.replace(':', ' / ');
  tile.tabIndex = 0;
  tile.setAttribute('role', 'listitem');
  tile.setAttribute('aria-label', text('preview.item', {position: index + 1, filename: image.filename}));
  tile.setAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown');
  const img = document.createElement('img');
  img.src = image.url;
  img.alt = image.filename;
  img.draggable = false;
  const number = document.createElement('span');
  number.className = 'tile-number';
  number.textContent = String(index + 1).padStart(2, '0');
  const name = document.createElement('span');
  name.className = 'tile-name';
  name.textContent = image.filename;
  const remove = document.createElement('button');
  remove.className = 'remove-image';
  remove.setAttribute('aria-label', text('preview.remove', {filename: image.filename}));
  const icon = document.createElement('img');
  icon.className = 'icon';
  icon.src = 'assets/icons/xmark.svg';
  icon.alt = '';
  remove.append(icon);
  remove.addEventListener('click', () => {
    cancelDrag();
    images = images.filter(item => item.id !== image.id);
    image.img.src = '';
    URL.revokeObjectURL(image.url);
    showError();
    render();
    $('#status').textContent = text('preview.removed');
    const target = grid.children[Math.min(index, images.length - 1)] || $('#upload');
    target.focus({preventScroll: true});
  });
  tile.append(img, number, name, remove);
  tile.addEventListener('pointerdown', event => startDrag(event, tile, image));
  tile.addEventListener('keydown', event => {
    if (event.target !== tile || !event.altKey) return;
    const offsets = {ArrowLeft: -1, ArrowRight: 1, ArrowUp: -layout.columns, ArrowDown: layout.columns};
    if (!(event.key in offsets)) return;
    event.preventDefault();
    moveImage(image.id, Math.max(0, Math.min(images.length - 1, images.findIndex(item => item.id === image.id) + offsets[event.key])));
  });
  return tile;
}
function render() {
  const hasImages = images.length > 0;
  $('#landing').hidden = hasImages;
  $('#editor').hidden = !hasImages;
  grid.replaceChildren(...images.map(makeTile));
  $('#count').textContent = text(images.length === 1 ? 'upload.countOne' : 'upload.countMany', {count: images.length});
  $('#watermark').textContent = watermark();
  $('#download').disabled = !hasImages;
  $('#download-label').textContent = text('download.label', {format: exportFormats[layout.format].label});
  $('#file-extension').textContent = '.' + exportFormats[layout.format].extension;
  $('#gap-value').textContent = text('settings.gapValue', {value: layout.gap});
  if (!hasImages) { canvas.width = canvas.height = 1; return; }
  try { renderCanvas(); }
  catch (error) {
    console.error('FrameGrid render failed:', error);
    $('#download').disabled = true;
    $('#dimensions').textContent = text('preview.emptyDimensions');
    showError(text('errors.render'));
  }
}
function sheetGeometry() {
  const {columns, gap, tileWidth, ratio} = layout;
  const rows = Math.ceil(images.length / columns);
  const fixedHeight = ratio === 'original' ? null : Math.round(tileWidth * Number(ratio.split(':')[1]) / Number(ratio.split(':')[0]));
  const imageHeights = images.map(({img}) => fixedHeight ?? Math.max(1, Math.round(tileWidth * img.naturalHeight / img.naturalWidth)));
  const rowHeights = Array.from({length: rows}, (_, row) => Math.max(...imageHeights.slice(row * columns, (row + 1) * columns)));
  const width = columns * tileWidth + (columns + 1) * gap;
  const height = rowHeights.reduce((sum, value) => sum + value, 0) + (rows + 1) * gap + 54;
  const scale = Math.min(1, content.limits.maxCanvasDimension / width, content.limits.maxCanvasDimension / height, Math.sqrt(content.limits.maxCanvasPixels / (width * height)));
  return {width, height, imageHeights, rowHeights, scale};
}
function renderCanvas() {
  const {columns, gap, tileWidth, background, ratio} = layout;
  const {width, height, imageHeights, rowHeights, scale} = sheetGeometry();
  // Percentages refer to the sheet width, so the DOM and PNG share the same geometry.
  grid.style.gridTemplateColumns = 'repeat(' + columns + ', minmax(0, 1fr))';
  grid.style.gap = grid.style.padding = (gap / width * 100) + 'cqw';
  $('#sheet').style.backgroundColor = background;
  const luminance = [1, 3, 5].map(offset => parseInt(background.slice(offset, offset + 2), 16));
  const ink = (luminance[0] * 299 + luminance[1] * 587 + luminance[2] * 114) / 1000 < 140 ? '#ffffff' : '#304050';
  $('#watermark').style.cssText = 'height:' + (54 / width * 100) + 'cqw;font-size:' + (18 / width * 100) + 'cqw;color:' + ink;
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.scale(scale, scale);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);
  let y = gap;
  rowHeights.forEach((rowHeight, row) => {
    images.slice(row * columns, (row + 1) * columns).forEach(({img}, col) => {
      const index = row * columns + col;
      const x = gap + col * (tileWidth + gap), tileHeight = imageHeights[index];
      if (ratio === 'original') {
        ctx.drawImage(img, x, y, tileWidth, tileHeight);
      } else {
        const imageScale = Math.max(tileWidth / img.naturalWidth, tileHeight / img.naturalHeight);
        const sw = tileWidth / imageScale, sh = tileHeight / imageScale;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, y, tileWidth, tileHeight);
      }
    });
    y += rowHeight + gap;
  });
  ctx.fillStyle = ink; ctx.font = '18px Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(watermark(), width / 2, height - 27, width - 24);
  $('#dimensions').textContent = text('preview.dimensions', {width: canvas.width, height: canvas.height}) + (scale < 1 ? text('preview.scaled') : '');
}
function filenameBase(value) {
  return value.trim()
    .replace(/\.(png|jpe?g|webp)$/i, '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/[. ]+$/, '');
}
async function downloadSheet() {
  const button = $('#download'), format = exportFormats[layout.format];
  const base = filenameBase($('#filename').value) || filenameBase(text('download.filename')) || 'framegrid';
  const filename = base + '.' + format.extension;
  showError();
  button.disabled = true;
  try {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, format.mime, 0.92));
    if (!blob) throw new Error('Canvas export failed');
    if (blob.type !== format.mime) {
      showError(text('errors.unsupportedExport'));
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = filename;
    a.href = url;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) {
    console.error('FrameGrid download failed:', error);
    showError(text('errors.download'));
  } finally {
    button.disabled = images.length === 0;
  }
}
function moveImage(id, toIndex) {
  const fromIndex = images.findIndex(image => image.id === id);
  if (fromIndex < 0 || fromIndex === toIndex) return;
  const [image] = images.splice(fromIndex, 1);
  images.splice(toIndex, 0, image);
  showError();
  render();
  const movedTile = [...grid.children].find(tile => Number(tile.dataset.id) === id);
  movedTile?.focus({preventScroll: true});
  movedTile?.scrollIntoView({block: 'nearest', inline: 'nearest'});
  $('#status').textContent = text('preview.moved', {filename: image.filename, position: toIndex + 1});
}
function startDrag(event, tile, image) {
  if (event.button !== 0 || event.target.closest('button') || !event.isPrimary) return;
  cancelDrag();
  tile.setPointerCapture(event.pointerId);
  drag = {id: image.id, tile, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, target: tile, ghost: null, url: image.url};
}
function updateDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (!drag.ghost) {
    if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
    const rect = drag.tile.getBoundingClientRect();
    drag.ghost = document.createElement('img');
    drag.ghost.src = drag.url;
    drag.ghost.alt = '';
    drag.ghost.className = 'drag-ghost';
    drag.ghost.style.width = rect.width + 'px';
    drag.ghost.style.height = rect.height + 'px';
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    drag.tile.classList.add('is-dragging');
    document.body.append(drag.ghost);
    document.body.classList.add('is-sorting');
  }
  event.preventDefault();
  drag.ghost.style.left = event.clientX - drag.offsetX + 'px';
  drag.ghost.style.top = event.clientY - drag.offsetY + 'px';
  const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.tile');
  drag.target?.classList.remove('drop-target');
  drag.target = target && grid.contains(target) ? target : null;
  if (drag.target !== drag.tile) drag.target?.classList.add('drop-target');
  const preview = $('.preview');
  const bounds = preview.getBoundingClientRect();
  if (event.clientX >= bounds.left && event.clientX <= bounds.right &&
      event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
    if (event.clientY > bounds.bottom - 50) preview.scrollBy(0, 16);
    else if (event.clientY < bounds.top + 50) preview.scrollBy(0, -16);
  }
}
function cancelDrag() {
  if (!drag) return;
  const active = drag;
  drag = null;
  active.ghost?.remove();
  active.tile.classList.remove('is-dragging');
  active.target?.classList.remove('drop-target');
  if (active.tile.hasPointerCapture(active.pointerId)) active.tile.releasePointerCapture(active.pointerId);
  document.body.classList.remove('is-sorting');
}
function finishDrag(event) {
  if (!drag || drag.pointerId !== event.pointerId) return;
  const id = drag.id, targetId = drag.ghost && drag.target ? Number(drag.target.dataset.id) : null;
  cancelDrag();
  if (targetId !== null) moveImage(id, images.findIndex(image => image.id === targetId));
}
function bindDropZone(zone) {
  let depth = 0;
  zone.addEventListener('dragenter', event => {event.preventDefault();depth++;zone.classList.add('is-over');});
  zone.addEventListener('dragover', event => {event.preventDefault();event.dataTransfer.dropEffect = 'copy';});
  zone.addEventListener('dragleave', event => {event.preventDefault();if (--depth <= 0) {depth = 0;zone.classList.remove('is-over');}});
  zone.addEventListener('drop', event => {event.preventDefault();depth = 0;zone.classList.remove('is-over');addFiles(event.dataTransfer.files);});
}
function handlePaste(event) {
  // Leave normal text editing and paste handlers in other controls alone.
  if (event.defaultPrevented || event.target?.isContentEditable ||
      event.target?.closest?.('input, textarea, [role="textbox"]')) return;
  const clipboard = event.clipboardData;
  if (!clipboard) return;
  let pastedImages = [...(clipboard.items || [])]
    .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
    .map(item => item.getAsFile())
    .filter(Boolean);
  // Some browsers expose files without corresponding clipboard items.
  if (!pastedImages.length) {
    pastedImages = [...(clipboard.files || [])].filter(file => file.type.startsWith('image/'));
  }
  if (!pastedImages.length) return;
  event.preventDefault();
  addFiles(pastedImages);
}
function bindEvents() {
  $('#editor-title').tabIndex = -1;
  $('#upload').addEventListener('click', () => files.click());
  $('#add').addEventListener('click', () => files.click());
  files.addEventListener('change', () => addFiles(files.files));
  window.addEventListener('paste', handlePaste);
  bindDropZone($('#landing'));
  bindDropZone($('#stage'));
  window.addEventListener('dragover', event => event.preventDefault());
  window.addEventListener('drop', event => event.preventDefault());
  window.addEventListener('pointermove', updateDrag, {passive: false});
  window.addEventListener('pointerup', finishDrag);
  window.addEventListener('pointercancel', cancelDrag);
  window.addEventListener('blur', cancelDrag);
  window.addEventListener('keydown', event => {if (event.key === 'Escape') cancelDrag();});
  grid.addEventListener('lostpointercapture', () => cancelDrag());
  $('#cancel-load').addEventListener('click', () => { cancelPendingLoads(); render(); });
  $('#clear').addEventListener('click', () => {
    cancelPendingLoads();
    cancelDrag();
    images.forEach(({url, img}) => { img.src = ''; URL.revokeObjectURL(url); });
    images = [];
    showError();
    render();
    $('#upload').focus({preventScroll: true});
  });
  $('#download').addEventListener('click', downloadSheet);
  const updateLayout = () => {
    cancelDrag();
    layout.columns = Number($('#columns').value);
    layout.gap = Number($('#gap').value);
    layout.ratio = $('#ratio').value;
    layout.format = $('#format').value;
    showError();
    render();
  };
  ['#columns', '#gap', '#ratio', '#format'].forEach(selector => $(selector).addEventListener('input', updateLayout));
  $('#backgrounds').addEventListener('click', event => {
    const swatch = event.target.closest('[data-color]');
    if (!swatch) return;
    cancelDrag();
    layout.background = swatch.dataset.color;
    document.querySelectorAll('[data-color]').forEach(button => button.setAttribute('aria-pressed', String(button === swatch)));
    showError();
    render();
  });
}
init();
