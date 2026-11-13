import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeScene } from "@kivo/shared";
import { advanceJob } from "../src/pipeline/run";
import { KvStore, LayeredStore, R2Store, findStorage } from "../src/storage";
import { RENDER_TOKEN, createHarness, fakeMp4, type Harness } from "./harness";

/**
 * The fallback file store for accounts without R2: bytes in Workers KV, indexed in D1.
 * The same Worker code must save, verify, serve and delete files through it.
 */
let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const bytesOf = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) % 251);
const streamOf = (bytes: Uint8Array, chunk = 333) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) controller.enqueue(bytes.slice(i, i + chunk));
      controller.close();
    },
  });
const kvKeys = async () => (await h.kv.list()).keys.map((k) => k.name);
const read = async (store: KvStore, key: string, range?: { offset: number; length: number }) => new Uint8Array(await (await store.get(key, range))!.arrayBuffer());

describe("KV file store", () => {
  it("stores a file in parts and reads back exactly the same bytes, whole or by range", async () => {
    const store = new KvStore(h.kv, h.db, 1000);
    const data = bytesOf(4321);
    await store.put("users/u1/videos/a.mp4", streamOf(data), { contentType: "video/mp4", size: data.length });

    expect(await kvKeys()).toHaveLength(5); // 4 full parts + 1 partial
    expect(await store.head("users/u1/videos/a.mp4")).toMatchObject({ size: 4321, contentType: "video/mp4" });
    expect(await read(store, "users/u1/videos/a.mp4")).toEqual(data);

    // Ranges inside one part, across part boundaries, exactly one part, and to the end of the file.
    for (const [offset, length] of [[10, 50], [990, 30], [1000, 1000], [2500, 1700], [4320, 1], [0, 4321], [4000, 999]] as const) {
      const expected = data.slice(offset, offset + length);
      expect(await read(store, "users/u1/videos/a.mp4", { offset, length })).toEqual(expected);
    }
    expect(await store.get("users/u1/videos/missing.mp4")).toBeNull();
    expect(await store.head("users/u1/videos/missing.mp4")).toBeNull();
  });

  it("accepts buffers as well as streams, including an empty and an exactly-one-part file", async () => {
    const store = new KvStore(h.kv, h.db, 1000);
    await store.put("users/u2/a.bin", bytesOf(1000, 3), { contentType: "application/octet-stream" });
    await store.put("users/u2/b.bin", bytesOf(2500, 4).buffer as ArrayBuffer, { contentType: "model/gltf-binary" });
    await store.put("users/u2/empty.bin", new Uint8Array(0), { contentType: "application/octet-stream" });
    expect(await read(store, "users/u2/a.bin")).toEqual(bytesOf(1000, 3));
    expect(await read(store, "users/u2/b.bin")).toEqual(bytesOf(2500, 4));
    expect((await store.head("users/u2/empty.bin"))!.size).toBe(0);
    expect(await read(store, "users/u2/empty.bin")).toHaveLength(0);
  });

  it("replaces a file without leaving the old parts behind", async () => {
    const store = new KvStore(h.kv, h.db, 1000);
    const before = (await kvKeys()).length;
    await store.put("users/u3/v.mp4", bytesOf(3500, 5), { contentType: "video/mp4" });
    const first = (await store.head("users/u3/v.mp4"))!.etag;
    await store.put("users/u3/v.mp4", bytesOf(1200, 6), { contentType: "video/mp4" });
    expect(await read(store, "users/u3/v.mp4")).toEqual(bytesOf(1200, 6));
    expect((await store.head("users/u3/v.mp4"))!.etag).not.toBe(first);
    expect((await kvKeys()).length).toBe(before + 2);
  });

  it("rejects an upload that does not match its declared length and keeps nothing", async () => {
    const store = new KvStore(h.kv, h.db, 1000);
    const before = (await kvKeys()).length;
    await expect(store.put("users/u4/short.mp4", streamOf(bytesOf(900)), { contentType: "video/mp4", size: 2400 })).rejects.toThrow(/declared length/);
    await expect(store.put("users/u4/long.mp4", streamOf(bytesOf(2600)), { contentType: "video/mp4", size: 700 })).rejects.toThrow(/declared length/);
    expect(await store.head("users/u4/short.mp4")).toBeNull();
    expect(await store.head("users/u4/long.mp4")).toBeNull();
    expect((await kvKeys()).length).toBe(before);
  });

  it("deletes single files and whole prefixes, and reports how full it is", async () => {
    const store = new KvStore(h.kv, h.db, 1000, 10_000);
    await store.deletePrefix("users/");
    expect(await kvKeys()).toHaveLength(0);
    expect(await store.capacity()).toEqual({ usedBytes: 0, limitBytes: 10_000 });

    for (const key of ["users/a/assets/1/model.glb", "users/a/assets/1/rigged.glb", "users/a/assets/2/model.glb", "users/a/videos/r.mp4", "users/ab/videos/r.mp4"]) {
      await store.put(key, bytesOf(1500), { contentType: "application/octet-stream" });
    }
    expect((await store.capacity()).usedBytes).toBe(7500);

    await store.deletePrefix("users/a/assets/1/");
    expect(await store.head("users/a/assets/1/model.glb")).toBeNull();
    expect(await store.head("users/a/assets/1/rigged.glb")).toBeNull();
    expect(await store.head("users/a/assets/2/model.glb")).not.toBeNull();

    await store.delete(["users/a/videos/r.mp4", "users/a/never-existed"]);
    expect(await store.head("users/a/videos/r.mp4")).toBeNull();

    // A user's prefix does not reach into another user whose id merely starts the same.
    await store.deletePrefix("users/a/");
    expect(await store.head("users/a/assets/2/model.glb")).toBeNull();
    expect(await store.head("users/ab/videos/r.mp4")).not.toBeNull();
    await store.deletePrefix("users/");
    expect(await kvKeys()).toHaveLength(0);
  });

  it("keeps files saved in KV readable after R2 is turned on, and writes new files to R2", async () => {
    const kv = new KvStore(h.kv, h.db, 1000);
    await kv.put("users/m/videos/old.mp4", bytesOf(1800, 9), { contentType: "video/mp4" });
    const both = findStorage({ DB: h.db, BUCKET: h.bucket, MEDIA_KV: h.kv })!;
    expect(both).toBeInstanceOf(LayeredStore);
    expect(both.kind).toBe("r2+kv");

    expect(new Uint8Array(await (await both.get("users/m/videos/old.mp4"))!.arrayBuffer())).toEqual(bytesOf(1800, 9));
    await both.put("users/m/videos/new.mp4", bytesOf(700, 2), { contentType: "video/mp4" });
    expect(await h.bucket.head("users/m/videos/new.mp4")).not.toBeNull();
    expect(await kv.head("users/m/videos/new.mp4")).toBeNull();

    await both.deletePrefix("users/m/");
    expect(await both.head("users/m/videos/old.mp4")).toBeNull();
    expect(await both.head("users/m/videos/new.mp4")).toBeNull();

    expect(findStorage({ DB: h.db, BUCKET: h.bucket })).toBeInstanceOf(R2Store);
    expect(findStorage({ DB: h.db, MEDIA_KV: h.kv })).toBeInstanceOf(KvStore);
    expect(findStorage({ DB: h.db })).toBeNull();
  });
});

describe("a deployment without R2 that stores files in KV", () => {
  const auth = { authorization: `Bearer ${RENDER_TOKEN}` };
  let k: Harness;
  beforeAll(async () => {
    k = await createHarness();
    k.env.BUCKET = undefined;
    k.env.MEDIA_KV = k.kv;
  });
  afterAll(() => k.close());

  it("reports storage as ready", async () => {
    const health = await k.json("/api/health");
    expect(health.body.configured.storage).toBe(true);
    expect(health.body.storageBackend).toBe("kv");
    expect((await k.json("/api/config")).body.storageReady).toBe(true);
  });

  it("renders: the worker downloads models, uploads the MP4, it is verified, saved and playable with seeking", async () => {
    const userId = "user_kv";
    const token = await k.token(userId, { pla: "u:pro" });
    const projectId = (await k.json("/api/projects", { token, body: { prompt: "a statue", resolution: "480p" } })).body.project.id as string;
    const t = Date.now();
    const store = findStorage(k.env)!;
    await store.put(`users/${userId}/assets/ast_kv/model.glb`, new TextEncoder().encode("glb-bytes"), { contentType: "model/gltf-binary" });
    await k.db.batch([
      k.db.prepare("INSERT INTO assets (id, user_id, cache_key, name, kind, prompt, ai_model, spec, status, model_key, created_at, updated_at, last_used_at) VALUES ('ast_kv', ?, 'key_kv', 'Hero', 'prop', 'a statue', 'meshy-6', '{}', 'ready', ?, ?, ?, ?)").bind(userId, `users/${userId}/assets/ast_kv/model.glb`, t, t, t),
      k.db.prepare("INSERT INTO project_assets (project_id, alias, asset_id) VALUES (?, 'hero', 'ast_kv')").bind(projectId),
    ]);
    const spec = normalizeScene({
      version: 1,
      title: "KV scene",
      output: { duration: 5, fps: 24, aspect: "16:9" },
      world: {},
      assets: [{ id: "hero", name: "Hero", kind: "prop", prompt: "a statue", rig: "none", size: { meters: 2, axis: "height" } }],
      objects: [{ id: "hero_1", assetId: "hero", name: "Hero", position: [0, 0, 0] }],
      lights: [{ id: "sun", name: "Sun", type: "sun", intensity: 3, position: [5, 10, 5] }],
      cameras: [{ id: "cam_a", name: "A", keyframes: [{ t: 0, position: [0, 2, -8], target: [0, 1, 0] }] }],
      shots: [{ id: "s1", cameraId: "cam_a", start: 0, end: 5 }],
      tracks: [],
    }).spec;
    expect((await k.json(`/api/projects/${projectId}/scene`, { method: "PUT", token, body: { spec } })).status).toBe(200);

    const started = await k.json(`/api/projects/${projectId}/render`, { token, body: { resolution: "480p" } });
    expect(started.status).toBe(202);
    await advanceJob(k.env, started.body.job.id);

    const claim = await k.json("/api/render/claim", { headers: auth, body: { workerId: "worker-kv" } });
    const id = claim.body.renderJobId as string;
    const file = await k.request(claim.body.assets.hero.files["model.glb"].url, { headers: auth });
    expect(file.status).toBe(200);
    expect(await file.text()).toBe("glb-bytes");

    // An upload shorter than it claims is refused, and no file is kept.
    const mp4 = fakeMp4(8192);
    const put = (kind: string, body: Uint8Array, declared = body.length) =>
      k.request(`/api/render/jobs/${id}/${kind}`, { method: "PUT", headers: { ...auth, "x-kivo-worker": "worker-kv", "content-type": kind === "video" ? "video/mp4" : "image/jpeg", "content-length": String(declared) }, raw: body });
    expect((await put("video", mp4.slice(0, 100), 8192)).status).toBe(400);
    expect(await store.head(`users/${userId}/videos/${id}.mp4`)).toBeNull();

    expect((await put("thumbnail", new Uint8Array([1, 2, 3, 4]))).status).toBe(200);
    expect((await put("video", mp4)).status).toBe(200);
    const done = { workerId: "worker-kv", width: 854, height: 480, fps: 24, frames: 120, durationSeconds: 5, bytes: mp4.length, codec: "h264", engine: "cycles-cpu", notes: [] };
    const completed = await k.json(`/api/render/jobs/${id}/complete`, { headers: auth, body: done });
    expect(completed.status).toBe(200);
    expect((await k.json(`/api/jobs/${started.body.job.id}`, { token })).body.job).toMatchObject({ status: "succeeded", stage: "completed", videoId: completed.body.videoId });

    // The MP4 is in KV (R2 was never involved), and plays through the signed URL with Range support.
    expect(await k.bucket.head(`users/${userId}/videos/${id}.mp4`)).toBeNull();
    expect((await store.head(`users/${userId}/videos/${id}.mp4`))!.size).toBe(8192);
    const detail = await k.json(`/api/projects/${projectId}`, { token });
    const played = await k.request(detail.body.video.url);
    expect(played.status).toBe(200);
    expect(played.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await played.arrayBuffer())).toEqual(mp4);
    const ranged = await k.request(detail.body.video.url, { headers: { range: "bytes=2000-2003" } });
    expect(ranged.status).toBe(206);
    expect(ranged.headers.get("content-range")).toBe("bytes 2000-2003/8192");
    expect(new TextDecoder().decode(await ranged.arrayBuffer())).toBe("mdat");
    expect((await k.request(detail.body.video.url.replace(/s=[^&]+/, "s=forged"))).status).toBe(401);

    // Deleting the project removes its files from KV as well.
    expect((await k.request(`/api/projects/${projectId}`, { method: "DELETE", token })).status).toBe(200);
    expect(await store.head(`users/${userId}/videos/${id}.mp4`)).toBeNull();
    expect(await store.head(`users/${userId}/assets/ast_kv/model.glb`)).toBeNull();
    expect((await k.kv.list()).keys).toHaveLength(0);
  });

  it("refuses new generations once the store is full, before charging", async () => {
    k.env.KV_STORAGE_LIMIT_MB = "0.001"; // ~1 KB
    const token = await k.token("user_kv_full");
    const store = findStorage(k.env)!;
    await store.put("users/user_kv_full/videos/big.mp4", new Uint8Array(4096), { contentType: "video/mp4" });
    const project = await k.json("/api/projects", { token, body: { prompt: "a robot walks through a city" } });
    const queued = k.sent.length;
    const started = await k.json(`/api/projects/${project.body.project.id}/generate`, { token, body: {} });
    expect(started.status).toBe(507);
    expect(started.body.error.code).toBe("storage_full");
    expect(started.body.error.message).toMatch(/storage is full/);
    expect((await k.json("/api/me", { token })).body.usage.used).toBe(0);
    expect(k.sent).toHaveLength(queued);
    k.env.KV_STORAGE_LIMIT_MB = undefined;
  });
});
