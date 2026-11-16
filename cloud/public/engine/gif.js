// A looping GIF in the six E-Ink colours. Frames are palette indices
// (0 black, 1 white, 2..5 colours); LZW as in the GIF89a specification.

import { PALETTE } from './render.js';

function lzw(pixels, minCode) {
  const out = [];
  let bitBuf = 0, bitLen = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, next = eoi + 1;
  let dict = new Map();
  const emit = (code) => {
    bitBuf |= code << bitLen; bitLen += size;
    while (bitLen >= 8) { out.push(bitBuf & 255); bitBuf >>>= 8; bitLen -= 8; }
  };
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i], key = prefix * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {                                   // table full: start over
      emit(clear);
      dict = new Map(); size = minCode + 1; next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bitLen > 0) out.push(bitBuf & 255);
  return out;
}

/** frames: Uint8Array[] of size*size palette indices -> GIF bytes */
export function encodeGIF(frames, size, fps = 8) {
  const bytes = [];
  const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  bytes.push(...Array.from('GIF89a', (c) => c.charCodeAt(0)));
  u16(size); u16(size);
  bytes.push(0xf2, 0, 0);                                  // global colour table of 8 entries
  for (let i = 0; i < 8; i++) bytes.push(...(PALETTE[i] || [255, 255, 255]));
  bytes.push(0x21, 0xff, 11, ...Array.from('NETSCAPE2.0', (c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);   // loop forever
  const delay = Math.round(100 / fps);
  for (const f of frames) {
    bytes.push(0x21, 0xf9, 4, 0x04, delay & 255, delay >> 8, 0, 0);    // disposal: leave in place
    bytes.push(0x2c); u16(0); u16(0); u16(size); u16(size); bytes.push(0);
    const data = lzw(f, 3);
    bytes.push(3);
    for (let i = 0; i < data.length; i += 255) {
      const n = Math.min(255, data.length - i);
      bytes.push(n);
      for (let j = 0; j < n; j++) bytes.push(data[i + j]);
    }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
