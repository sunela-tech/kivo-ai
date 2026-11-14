/**
 * Preparing an image in the browser before it is uploaded.
 *
 * Phone photos are far larger than Kivo needs, so each image is scaled down to at most
 * 1536 px on its longest side first. That keeps uploads quick and well under the server's
 * limit, and it is plenty for Meshy to build a 3D model from. The server still checks
 * every file itself.
 */
const MAX_SIDE = 1536;
const ACCEPTED = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_ACCEPT = ACCEPTED.join(",");

export interface PreparedImage {
  blob: Blob;
  name: string;
  width: number;
  height: number;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  if (!ACCEPTED.includes(file.type)) throw new Error(`"${file.name}" is not a JPG, PNG or WebP image.`);
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`"${file.name}" could not be opened as an image.`);
  }
  try {
    if (bitmap.width < 64 || bitmap.height < 64) throw new Error(`"${file.name}" is too small: at least 64 pixels on each side.`);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser cannot prepare images.");
    ctx.imageSmoothingQuality = "high";

    // PNG and WebP may have a transparent background, which helps Meshy isolate the object: keep it.
    let blob: Blob | null = null;
    if (file.type !== "image/jpeg") {
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await toBlob(canvas, "image/png");
      if (blob && blob.size > 3.5 * 1024 * 1024) blob = null; // a photo saved as PNG: JPEG is the better container
    }
    if (!blob) {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await toBlob(canvas, "image/jpeg", 0.9);
    }
    if (!blob) throw new Error(`"${file.name}" could not be prepared for upload.`);
    return { blob, name: file.name, width, height };
  } finally {
    bitmap.close();
  }
}
