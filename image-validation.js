/* Inspect bounded raster headers before allocating decoded image buffers. */
const ImageValidation = (() => {
  const HEADER_BYTES = 1024 * 1024;
  class ValidationError extends Error {
    constructor(code, values = {}) { super(code); this.code = code; this.values = values; }
  }
  const fail = code => { throw new ValidationError(code); };
  function inspectHeader(buffer) {
    const data = new Uint8Array(buffer), view = new DataView(buffer);
    const ascii = (offset, length) => String.fromCharCode(...data.slice(offset, offset + length));
    let width, height, mime;
    if (data.length >= 8 && data.slice(0, 8).every((value, index) => value === [137,80,78,71,13,10,26,10][index])) {
      if (data.length < 33 || view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') fail('invalidImage');
      width = view.getUint32(16); height = view.getUint32(20); mime = 'image/png';
      let offset = 33, foundData = false;
      while (offset + 8 <= data.length) {
        const length = view.getUint32(offset), type = ascii(offset + 4, 4);
        if (type === 'acTL') fail('animatedImage');
        if (type === 'IDAT') { foundData = true; break; }
        offset += length + 12;
      }
      if (!foundData) fail('unreadableHeader');
    } else if (data.length >= 2 && data[0] === 0xff && data[1] === 0xd8) {
      mime = 'image/jpeg';
      let offset = 2;
      while (offset < data.length) {
        if (data[offset++] !== 0xff) fail('invalidImage');
        while (offset < data.length && data[offset] === 0xff) offset++;
        if (offset >= data.length) break;
        const marker = data[offset++];
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
        if (offset + 2 > data.length) break;
        const length = view.getUint16(offset);
        if (length < 2) fail('invalidImage');
        const sof = marker >= 0xc0 && marker <= 0xcf && ![0xc4,0xc8,0xcc].includes(marker);
        if (sof) {
          if (length < 8 || offset + 7 > data.length) fail('invalidImage');
          height = view.getUint16(offset + 3); width = view.getUint16(offset + 5);
          break;
        }
        offset += length;
      }
      if (width === undefined) fail('unreadableHeader');
    } else if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
      mime = 'image/webp';
      const uint24 = offset => data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
      const kind = ascii(12, 4);
      if (kind === 'VP8X' && data.length >= 30 && view.getUint32(16, true) === 10) {
        if (data[20] & 2) fail('animatedImage');
        width = uint24(24) + 1; height = uint24(27) + 1;
      } else if (kind === 'VP8 ' && data.length >= 30 && data[23] === 0x9d && data[24] === 0x01 && data[25] === 0x2a) {
        width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff;
      } else if (kind === 'VP8L' && data.length >= 25 && data[20] === 0x2f) {
        const bits = view.getUint32(21, true);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      } else fail('invalidImage');
    } else fail('unsupportedImage');
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('invalidImage');
    return {width, height, pixels: width * height, mime};
  }
  async function inspect(file, limits) {
    if (!file.size) fail('emptyImage');
    if (file.size > limits.maxFileBytes) throw new ValidationError('fileTooLarge', {limit: Math.round(limits.maxFileBytes / 1048576)});
    let info;
    try { info = inspectHeader(await file.slice(0, HEADER_BYTES).arrayBuffer()); }
    catch (error) {
      if (error.code === 'unsupportedImage' && (/\.(png|jpe?g|webp)$/i.test(file.name || '') || ['image/png','image/jpeg','image/webp'].includes(file.type))) fail('invalidImage');
      throw error;
    }
    if (info.width > limits.maxImageDimension || info.height > limits.maxImageDimension || info.pixels > limits.maxImagePixels) {
      throw new ValidationError('imageTooLarge', {width: info.width, height: info.height, maxSide: limits.maxImageDimension, maxMP: limits.maxImagePixels / 1000000});
    }
    return info;
  }
  function checkBudget(info, bytes, images, limits) {
    if (images.length >= limits.maxFiles) throw new ValidationError('tooManyImages', {limit: limits.maxFiles});
    const totals = images.reduce((sum, image) => ({bytes: sum.bytes + image.bytes, pixels: sum.pixels + image.pixels}), {bytes: 0, pixels: 0});
    if (totals.bytes + bytes > limits.maxTotalBytes) throw new ValidationError('totalBytesExceeded', {limit: Math.round(limits.maxTotalBytes / 1048576)});
    if (totals.pixels + info.pixels > limits.maxTotalPixels) throw new ValidationError('memoryBudgetExceeded', {limit: limits.maxTotalPixels / 1000000});
  }
  return {inspect, inspectHeader, checkBudget, ValidationError};
})();
