// Minimal PNG writer for INKOS pictures.
//   black-and-white: greyscale, bit depth 1 (1 = white), like the Python app
//   colour:          indexed, bit depth 4, a PLTE of exactly six entries
// Compression uses the platform's zlib (CompressionStream 'deflate').

import { PALETTE } from './render.js';

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC[n] = c >>> 0;
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** pixels: Uint8Array of palette indices (0 black, 1 white, 2..5 colours) */
export async function encodePNG(pixels, size, color) {
  const bitDepth = color ? 4 : 1;
  const rowBytes = Math.ceil((size * bitDepth) / 8);
  const raw = new Uint8Array((rowBytes + 1) * size);
  for (let y = 0; y < size; y++) {
    const o = y * (rowBytes + 1) + 1;              // filter byte 0 ("None") precedes each row
    for (let x = 0; x < size; x++) {
      const v = pixels[y * size + x];
      if (color) raw[o + (x >> 1)] |= (x & 1 ? v : v << 4);
      else if (v === 1) raw[o + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdr[8] = bitDepth; ihdr[9] = color ? 3 : 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr)];
  if (color) parts.push(chunk('PLTE', new Uint8Array(PALETTE.flat())));
  parts.push(chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
