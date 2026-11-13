import { Hono } from "hono";
import type { AppBindings } from "../env";
import { verifySignedPath } from "../signing";
import { HttpError, bucket } from "../util";

/**
 * Private media delivery. The bucket has no public access; every object is
 * served through this route, which requires a valid, unexpired signature for
 * that exact object (issued only to its owner by authenticated API routes).
 * Range requests are supported so video can seek and stream.
 */
export const media = new Hono<AppBindings>();

function parseRange(header: string | undefined, size: number): { offset: number; length: number } | null {
  const m = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return null;
  const [, a, b] = m;
  if (a === "" && b === "") return null;
  if (a === "") {
    const suffix = Math.min(size, Number(b));
    return { offset: size - suffix, length: suffix };
  }
  const start = Number(a);
  const end = b === "" ? size - 1 : Math.min(size - 1, Number(b));
  if (start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

media.on(["GET", "HEAD"], "/o/:key", async (c) => {
  const encoded = c.req.param("key");
  await verifySignedPath(c.env, `/api/media/o/${encoded}`, c.req.query("e"), c.req.query("s"));
  let key: string;
  try {
    key = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new HttpError(400, "internal", "Malformed media link.");
  }
  if (!key.startsWith("users/") || key.includes("..")) throw new HttpError(400, "internal", "Malformed media link.");

  const head = await bucket(c.env).head(key);
  if (!head) throw new HttpError(404, "internal", "This file no longer exists.");
  const headers = new Headers({
    "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    etag: head.httpEtag,
    "x-content-type-options": "nosniff",
  });
  const download = c.req.query("dl");
  if (download) headers.set("content-disposition", `attachment; filename="${download.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80)}"`);

  const range = parseRange(c.req.header("range"), head.size);
  if (c.req.header("range") && !range) {
    headers.set("content-range", `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }
  if (c.req.method === "HEAD") {
    headers.set("content-length", String(head.size));
    return new Response(null, { status: 200, headers });
  }
  const object = await bucket(c.env).get(key, range ? { range } : undefined);
  if (!object) throw new HttpError(404, "internal", "This file no longer exists.");
  if (range) {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("content-length", String(range.length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("content-length", String(head.size));
  return new Response(object.body, { status: 200, headers });
});
