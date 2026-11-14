import { IMAGE_UPLOAD, type ImageType } from "@kivo/shared";

/**
 * Uploaded reference images are checked by their bytes, never by the file name or the
 * Content-Type the browser sent: the file must really be a JPEG, PNG or WebP, and its
 * pixel size is read from the header so absurd dimensions are refused before anything
 * is stored or sent to Gemini and Meshy.
 */
export interface SniffedImage {
  type: ImageType;
  width: number;
  height: number;
}

const ascii = (b: Uint8Array, at: number, text: string) => text.split("").every((ch, i) => b[at + i] === ch.charCodeAt(0));

function png(b: Uint8Array): SniffedImage | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 33 || !sig.every((v, i) => b[i] === v) || !ascii(b, 12, "IHDR")) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { type: "image/png", width: view.getUint32(16), height: view.getUint32(20) };
}

function jpeg(b: Uint8Array): SniffedImage | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++; // fill byte
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i += 2; // markers without a length
      continue;
    }
    const length = (b[i + 2]! << 8) | b[i + 3]!;
    if (length < 2) return null;
    // SOF0..SOF15 carry the frame size, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { type: "image/jpeg", height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    if (marker === 0xda || marker === 0xd9) return null; // image data began without a frame header
    i += 2 + length;
  }
  return null;
}

function webp(b: Uint8Array): SniffedImage | null {
  if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
  if (ascii(b, 12, "VP8X")) {
    const width = 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16));
    const height = 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16));
    return { type: "image/webp", width, height };
  }
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { type: "image/webp", width: (b[26]! | (b[27]! << 8)) & 0x3fff, height: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24);
    return { type: "image/webp", width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
}

/** The real type and pixel size of an image file, or null when it is not a JPEG, PNG or WebP. */
export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}

/** Why an upload cannot be used, or null when it is fine. */
export function imageProblem(bytes: Uint8Array, sniffed: SniffedImage | null): string | null {
  if (bytes.byteLength === 0) return "The file is empty.";
  if (bytes.byteLength > IMAGE_UPLOAD.maxBytes) return `The image is larger than ${Math.round(IMAGE_UPLOAD.maxBytes / (1024 * 1024))} MB.`;
  if (!sniffed) return "The file is not a JPG, PNG or WebP image.";
  if (sniffed.width < IMAGE_UPLOAD.minSide || sniffed.height < IMAGE_UPLOAD.minSide) return `The image is too small: it must be at least ${IMAGE_UPLOAD.minSide} pixels on each side.`;
  if (sniffed.width > IMAGE_UPLOAD.maxSide || sniffed.height > IMAGE_UPLOAD.maxSide) return `The image is too large: at most ${IMAGE_UPLOAD.maxSide} pixels on each side.`;
  return null;
}

export const IMAGE_EXTENSION: Record<ImageType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

export function uploadKey(userId: string, projectId: string, imageId: string, type: ImageType): string {
  return `users/${userId}/uploads/${projectId}/${imageId}.${IMAGE_EXTENSION[type]}`;
}

/** Base64 without building a giant intermediate string on Workers (nodejs_compat) or Node. */
export function toBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString("base64");
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export interface ProjectImageRow {
  id: string;
  project_id: string;
  user_id: string;
  storage_key: string;
  content_type: string;
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  name: string;
  created_at: number;
}
