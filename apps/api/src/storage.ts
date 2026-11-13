import { HttpError, newId, now } from "./util";

/**
 * Where Kivo keeps files: generated 3D models, thumbnails and the finished MP4s.
 *
 * Two backends, chosen by what the deployment has bound:
 *  - R2 (`BUCKET`) — the normal store.
 *  - Workers KV + D1 (`MEDIA_KV`) — the fallback for accounts where R2 is not enabled. The bytes go
 *    into KV in parts, and a row in the D1 `files` table records each file's size, type and parts.
 *
 * When both are bound, new files go to R2 and files saved earlier in KV stay readable, so turning
 * R2 on later never loses a video.
 */
export interface StoredFile {
  key: string;
  size: number;
  contentType: string;
  etag: string;
}

export interface StoredBody extends StoredFile {
  /** The requested bytes. On Workers this is a fixed-length stream, so responses carry a real Content-Length. */
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ByteRange {
  offset: number;
  length: number;
}

export interface PutOptions {
  contentType: string;
  /** The declared size of a streamed upload. A stream that turns out shorter or longer is rejected and nothing is kept. */
  size?: number;
}

export type StorageKind = "r2" | "kv" | "r2+kv";

export interface FileStore {
  readonly kind: StorageKind;
  put(key: string, data: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, options: PutOptions): Promise<void>;
  head(key: string): Promise<StoredFile | null>;
  get(key: string, range?: ByteRange): Promise<StoredBody | null>;
  delete(keys: string | string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  /** Bytes used and the most this store can hold, when it has a hard cap. */
  capacity(): Promise<{ usedBytes: number; limitBytes: number } | null>;
}

type FixedLengthCtor = new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
const Fixed = (): FixedLengthCtor | undefined => (globalThis as { FixedLengthStream?: FixedLengthCtor }).FixedLengthStream;

/** Gives a stream a known length where the runtime supports it (Workers); elsewhere returns it unchanged. */
function fixedLength(stream: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> {
  const F = Fixed();
  return F ? stream.pipeThrough(new F(length)) : stream;
}

const wrongLength = () => new HttpError(400, "storage_error", "The upload did not match its declared length.");

// ───────────── R2 ─────────────

export class R2Store implements FileStore {
  readonly kind = "r2" as const;
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, data: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, options: PutOptions): Promise<void> {
    const httpMetadata = { contentType: options.contentType };
    if (!(data instanceof ReadableStream)) {
      await this.bucket.put(key, data, { httpMetadata });
      return;
    }
    // R2 needs a stream of known length. On Workers the upload is piped straight through a
    // FixedLengthStream (a 4K video is never held in memory); elsewhere it is buffered.
    const F = Fixed();
    if (F && options.size !== undefined) {
      const fixed = new F(options.size);
      await Promise.all([this.bucket.put(key, fixed.readable, { httpMetadata }), data.pipeTo(fixed.writable)]);
      return;
    }
    const buffer = await new Response(data).arrayBuffer();
    if (options.size !== undefined && buffer.byteLength !== options.size) throw wrongLength();
    await this.bucket.put(key, buffer, { httpMetadata });
  }

  async head(key: string): Promise<StoredFile | null> {
    const object = await this.bucket.head(key);
    return object && { key, size: object.size, contentType: object.httpMetadata?.contentType ?? "application/octet-stream", etag: object.httpEtag };
  }

  async get(key: string, range?: ByteRange): Promise<StoredBody | null> {
    const object = await this.bucket.get(key, range ? { range } : undefined);
    if (!object) return null;
    return {
      key,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
      // Read lazily: a caller takes either the stream or the buffer, never both.
      get body() {
        return object.body as ReadableStream<Uint8Array>;
      },
      arrayBuffer: () => object.arrayBuffer(),
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < list.length; i += 500) await this.bucket.delete(list.slice(i, i + 500));
  }

  async deletePrefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 500 });
      if (page.objects.length) await this.bucket.delete(page.objects.map((o) => o.key));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }

  async capacity(): Promise<null> {
    return null;
  }
}

// ───────────── Workers KV + D1 index ─────────────

/** KV values may be up to 25 MiB; parts stay well under that and are held in memory one at a time. */
export const KV_PART_BYTES = 16 * 1024 * 1024;
/** Workers KV's free allowance is 1 GB; generation stops a little before that instead of failing halfway. */
export const KV_DEFAULT_LIMIT_BYTES = 900 * 1024 * 1024;

interface FileRow {
  key: string;
  size: number;
  content_type: string;
  parts: number;
  part_bytes: number;
  gen: string;
}

export class KvStore implements FileStore {
  readonly kind = "kv" as const;
  constructor(
    private readonly kv: KVNamespace,
    private readonly db: D1Database,
    private readonly partBytes = KV_PART_BYTES,
    private readonly limitBytes = KV_DEFAULT_LIMIT_BYTES,
  ) {}

  // Every write gets a fresh generation id, so a KV key is written once and never rewritten:
  // KV is eventually consistent for overwrites, but a new key is never served stale.
  private partKey(gen: string, index: number): string {
    return `files/${gen}/${index}`;
  }

  private row(key: string): Promise<FileRow | null> {
    return this.db.prepare("SELECT key, size, content_type, parts, part_bytes, gen FROM files WHERE key = ?").bind(key).first<FileRow>();
  }

  private async dropParts(gen: string, parts: number): Promise<void> {
    for (let i = 0; i < parts; i += 4) {
      await Promise.all(Array.from({ length: Math.min(4, parts - i) }, (_, j) => this.kv.delete(this.partKey(gen, i + j))));
    }
  }

  async put(key: string, data: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, options: PutOptions): Promise<void> {
    const gen = newId("f");
    let parts = 0;
    let size = 0;
    try {
      if (data instanceof ReadableStream) {
        // Fill one part at a time; each full part is written before the next is read.
        const reader = data.getReader();
        let part = new Uint8Array(Math.min(this.partBytes, Math.max(options.size ?? this.partBytes, 1)));
        let filled = 0;
        const flush = async () => {
          await this.kv.put(this.partKey(gen, parts), part.subarray(0, filled));
          parts++;
          size += filled;
          filled = 0;
        };
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          let chunk = value;
          while (chunk.byteLength > 0) {
            if (filled === part.byteLength) {
              if (part.byteLength < this.partBytes) {
                // The stream is longer than declared; grow to a full part and let the length check below reject it.
                const grown = new Uint8Array(this.partBytes);
                grown.set(part.subarray(0, filled));
                part = grown;
              } else {
                await flush();
                part = new Uint8Array(this.partBytes);
              }
            }
            const take = Math.min(chunk.byteLength, part.byteLength - filled);
            part.set(chunk.subarray(0, take), filled);
            filled += take;
            chunk = chunk.subarray(take);
          }
        }
        if (filled > 0 || parts === 0) await flush();
      } else {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        do {
          const slice = bytes.subarray(size, size + this.partBytes);
          await this.kv.put(this.partKey(gen, parts), slice);
          parts++;
          size += slice.byteLength;
        } while (size < bytes.byteLength);
      }
      if (options.size !== undefined && size !== options.size) throw wrongLength();

      const previous = await this.row(key);
      await this.db
        .prepare(
          "INSERT INTO files (key, size, content_type, parts, part_bytes, gen, created_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET size = excluded.size, content_type = excluded.content_type, parts = excluded.parts, part_bytes = excluded.part_bytes, gen = excluded.gen, created_at = excluded.created_at",
        )
        .bind(key, size, options.contentType, parts, this.partBytes, gen, now())
        .run();
      if (previous) await this.dropParts(previous.gen, previous.parts).catch(() => undefined);
    } catch (error) {
      // Nothing half-written is left behind.
      await this.dropParts(gen, parts + 1).catch(() => undefined);
      throw error;
    }
  }

  async head(key: string): Promise<StoredFile | null> {
    const row = await this.row(key);
    return row && { key, size: row.size, contentType: row.content_type, etag: `"${row.gen}"` };
  }

  async get(key: string, range?: ByteRange): Promise<StoredBody | null> {
    const row = await this.row(key);
    if (!row) return null;
    const offset = Math.min(range?.offset ?? 0, row.size);
    const end = Math.min(row.size, offset + (range?.length ?? row.size));
    const length = end - offset;
    const meta = { key, size: row.size, contentType: row.content_type, etag: `"${row.gen}"` };
    const missing = () => new Error(`stored file ${key} is missing a part`);

    let body: ReadableStream<Uint8Array>;
    if (length === 0) {
      body = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    } else {
      const first = Math.floor(offset / row.part_bytes);
      const last = Math.floor((end - 1) / row.part_bytes);
      const partLength = (i: number) => Math.min(row.part_bytes, row.size - i * row.part_bytes);
      if (first === last && offset === first * row.part_bytes && length === partLength(first)) {
        // One whole part: hand KV's own stream through untouched.
        const stream = (await this.kv.get(this.partKey(row.gen, first), "stream")) as ReadableStream<Uint8Array> | null;
        if (!stream) throw missing();
        body = stream;
      } else {
        const { kv } = this;
        const partKey = (i: number) => this.partKey(row.gen, i);
        let index = first;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        body = new ReadableStream<Uint8Array>({
          async pull(controller) {
            for (;;) {
              if (!reader) {
                if (index > last) return controller.close();
                const start = index * row.part_bytes;
                const from = Math.max(offset, start) - start;
                const to = Math.min(end, start + partLength(index)) - start;
                if (from === 0 && to === partLength(index)) {
                  const stream = (await kv.get(partKey(index), "stream")) as ReadableStream<Uint8Array> | null;
                  if (!stream) throw missing();
                  reader = stream.getReader();
                } else {
                  const buffer = await kv.get(partKey(index), "arrayBuffer");
                  if (!buffer) throw missing();
                  index++;
                  return controller.enqueue(new Uint8Array(buffer, from, to - from));
                }
              }
              const { done, value } = await reader.read();
              if (!done) return controller.enqueue(value);
              reader = null;
              index++;
            }
          },
          async cancel() {
            await reader?.cancel().catch(() => undefined);
          },
        });
      }
      body = fixedLength(body, length);
    }
    return { ...meta, body, arrayBuffer: () => new Response(body).arrayBuffer() };
  }

  private async remove(rows: FileRow[]): Promise<void> {
    for (const row of rows) await this.dropParts(row.gen, row.parts);
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50);
      await this.db
        .prepare(`DELETE FROM files WHERE key IN (${batch.map(() => "?").join(", ")})`)
        .bind(...batch.map((r) => r.key))
        .run();
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < list.length; i += 50) {
      const batch = list.slice(i, i + 50);
      const { results } = await this.db
        .prepare(`SELECT key, size, content_type, parts, part_bytes, gen FROM files WHERE key IN (${batch.map(() => "?").join(", ")})`)
        .bind(...batch)
        .all<FileRow>();
      await this.remove(results);
    }
  }

  async deletePrefix(prefix: string): Promise<void> {
    for (;;) {
      // Keys are ASCII paths, so "everything starting with prefix" is the range [prefix, prefix + U+FFFF).
      const { results } = await this.db
        .prepare("SELECT key, size, content_type, parts, part_bytes, gen FROM files WHERE key >= ? AND key < ? ORDER BY key LIMIT 50")
        .bind(prefix, `${prefix}￿`)
        .all<FileRow>();
      if (results.length === 0) return;
      await this.remove(results);
    }
  }

  async capacity(): Promise<{ usedBytes: number; limitBytes: number }> {
    const row = await this.db.prepare("SELECT COALESCE(SUM(size), 0) AS used FROM files").first<{ used: number }>();
    return { usedBytes: row?.used ?? 0, limitBytes: this.limitBytes };
  }
}

// ───────────── R2 with files left in KV from before R2 was enabled ─────────────

export class LayeredStore implements FileStore {
  readonly kind = "r2+kv" as const;
  constructor(
    private readonly primary: FileStore,
    private readonly earlier: FileStore,
  ) {}

  async put(key: string, data: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array, options: PutOptions): Promise<void> {
    await this.primary.put(key, data, options);
    await this.earlier.delete(key).catch(() => undefined);
  }

  async head(key: string): Promise<StoredFile | null> {
    return (await this.primary.head(key)) ?? this.earlier.head(key);
  }

  async get(key: string, range?: ByteRange): Promise<StoredBody | null> {
    return (await this.primary.get(key, range)) ?? this.earlier.get(key, range);
  }

  async delete(keys: string | string[]): Promise<void> {
    await this.primary.delete(keys);
    await this.earlier.delete(keys);
  }

  async deletePrefix(prefix: string): Promise<void> {
    await this.primary.deletePrefix(prefix);
    await this.earlier.deletePrefix(prefix);
  }

  capacity(): Promise<{ usedBytes: number; limitBytes: number } | null> {
    return this.primary.capacity();
  }
}

// ───────────── selection ─────────────

export interface StorageEnv {
  DB: D1Database;
  BUCKET?: R2Bucket;
  MEDIA_KV?: KVNamespace;
  KV_STORAGE_LIMIT_MB?: string;
}

/** The deployment's file store, or null when it has none. */
export function findStorage(env: StorageEnv): FileStore | null {
  const r2 = env.BUCKET ? new R2Store(env.BUCKET) : null;
  const limit = Number(env.KV_STORAGE_LIMIT_MB);
  const kv = env.MEDIA_KV ? new KvStore(env.MEDIA_KV, env.DB, KV_PART_BYTES, Number.isFinite(limit) && limit > 0 ? limit * 1024 * 1024 : KV_DEFAULT_LIMIT_BYTES) : null;
  if (r2 && kv) return new LayeredStore(r2, kv);
  return r2 ?? kv;
}

/**
 * The file store, or a clear error when this deployment has none.
 * Generation cannot work without it, so it is refused up front instead of failing halfway.
 */
export function storage(env: StorageEnv): FileStore {
  const store = findStorage(env);
  if (!store) throw new HttpError(503, "storage_unavailable");
  return store;
}

/** Refuses new work when a capped store (KV) is nearly full, before any model is generated or anything is charged. */
export async function requireStorageRoom(env: StorageEnv): Promise<FileStore> {
  const store = storage(env);
  const capacity = await store.capacity();
  if (capacity && capacity.usedBytes >= capacity.limitBytes) throw new HttpError(507, "storage_full");
  return store;
}
