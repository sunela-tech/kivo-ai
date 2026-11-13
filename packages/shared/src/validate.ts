import { z } from "zod";
import { SceneSampler, type CameraSample } from "./interp";
import {
  BUILTIN_CLIPS,
  SceneSpecSchema,
  cloneJson,
  type Camera,
  type SceneAsset,
  type SceneObject,
  type SceneSpec,
  type Shot,
  type Track,
  type Vec3,
} from "./scene";

export class SceneValidationError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`Invalid scene: ${issues.slice(0, 5).join("; ")}`);
    this.name = "SceneValidationError";
    this.issues = issues;
  }
}

export interface NormalizeOptions {
  /** Hard caps applied to the scene itself (generation time). Rendering applies plan caps separately. */
  maxDurationSec?: number;
  maxFps?: number;
  maxAssets?: number;
  /**
   * Skeletal clip names that actually exist per asset id. When given, action
   * clips that reference anything else are removed (never silently faked).
   */
  availableClips?: Record<string, string[]>;
}

export interface NormalizeResult {
  spec: SceneSpec;
  warnings: string[];
}

const WORLD_LIMIT = 2000;

function clampNum(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function clampVec(v: number[], limit = WORLD_LIMIT): Vec3 {
  return [clampNum(v[0]!, -limit, limit), clampNum(v[1]!, -limit, limit), clampNum(v[2]!, -limit, limit)];
}

function round(v: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base.slice(0, 44)}_${n++}`;
  used.add(id);
  return id;
}

/** Typical half-width of an upright asset, as a fraction of its height. */
const RADIUS_PER_HEIGHT: Record<SceneAsset["kind"], number> = {
  character: 0.22,
  creature: 0.45,
  vehicle: 0.6,
  building: 0.3,
  prop: 0.4,
  furniture: 0.5,
  vegetation: 0.3,
  terrain: 0.5,
};

/** Approximate horizontal bounding radius of a placed asset, for camera clearance. */
export function assetRadius(asset: SceneAsset, scale: number): number {
  const m = asset.size.meters * scale;
  return asset.size.axis === "height" ? m * RADIUS_PER_HEIGHT[asset.kind] : m * 0.5;
}

export function assetHeight(asset: SceneAsset, scale: number): number {
  const m = asset.size.meters * scale;
  if (asset.size.axis === "height") return m;
  if (asset.kind === "terrain") return 0;
  return m * 0.5;
}

function dedupeByTime<T extends { t: number }>(keys: T[]): T[] {
  const sorted = keys.slice().sort((a, b) => a.t - b.t);
  const out: T[] = [];
  for (const k of sorted) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.t - k.t) < 1e-4) out[out.length - 1] = k;
    else out.push(k);
  }
  return out;
}

/**
 * Validate and repair a scene.
 *
 * Structural problems (wrong types, missing fields) throw SceneValidationError.
 * Recoverable problems (dangling references, out-of-range times, cameras inside
 * objects, gaps between shots) are fixed and reported as warnings.
 */
export function normalizeScene(input: unknown, options: NormalizeOptions = {}): NormalizeResult {
  const parsed = SceneSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new SceneValidationError(
      parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "scene"}: ${i.message}`),
    );
  }
  const spec = cloneJson(parsed.data) as SceneSpec;
  const warnings: string[] = [];

  // ---- output ----
  if (options.maxDurationSec && spec.output.duration > options.maxDurationSec) {
    warnings.push(`Duration reduced from ${spec.output.duration}s to ${options.maxDurationSec}s.`);
    spec.output.duration = options.maxDurationSec;
  }
  if (options.maxFps && spec.output.fps > options.maxFps) spec.output.fps = options.maxFps;
  spec.output.duration = round(spec.output.duration, 3);
  const D = spec.output.duration;
  const clampT = (t: number) => round(clampNum(t, 0, D), 4);

  // ---- assets ----
  const assetIds = new Set<string>();
  spec.assets = spec.assets.filter((a) => {
    if (assetIds.has(a.id)) {
      warnings.push(`Duplicate asset "${a.id}" removed.`);
      return false;
    }
    assetIds.add(a.id);
    return true;
  });
  if (options.maxAssets && spec.assets.length > options.maxAssets) {
    const dropped = spec.assets.slice(options.maxAssets).map((a) => a.id);
    spec.assets = spec.assets.slice(0, options.maxAssets);
    for (const id of dropped) assetIds.delete(id);
    warnings.push(`Scene limited to ${options.maxAssets} distinct models; removed: ${dropped.join(", ")}.`);
  }
  for (const a of spec.assets) {
    if (a.rig !== "humanoid") {
      if (a.actions.length || a.motions.length) warnings.push(`"${a.id}" is not a humanoid, so its skeletal clips were removed.`);
      a.actions = [];
      a.motions = [];
    }
    const names = new Set<string>(BUILTIN_CLIPS);
    a.actions = a.actions.filter((x) => (names.has(x.name) ? false : (names.add(x.name), true)));
    a.motions = a.motions.filter((x) => (names.has(x.name) ? false : (names.add(x.name), true)));
  }
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));

  // ---- objects ----
  const objectIds = new Set<string>();
  spec.objects = spec.objects.filter((o) => {
    if (!assetById.has(o.assetId)) {
      warnings.push(`Object "${o.id}" referenced unknown model "${o.assetId}" and was removed.`);
      return false;
    }
    if (objectIds.has(o.id)) {
      warnings.push(`Duplicate object "${o.id}" removed.`);
      return false;
    }
    objectIds.add(o.id);
    o.position = clampVec(o.position);
    return true;
  });
  const objectById = new Map(spec.objects.map((o) => [o.id, o]));

  // ---- lights ----
  const lightIds = new Set<string>();
  spec.lights = spec.lights.filter((l) => (lightIds.has(l.id) ? false : (lightIds.add(l.id), true)));
  if (spec.lights.length === 0) {
    spec.lights.push({
      id: uniqueId("key_sun", lightIds),
      name: "Key sun",
      type: "sun",
      color: "#fff4e0",
      intensity: 3,
      position: [6, 10, 6],
      target: [0, 0, 0],
      spotAngle: 45,
      castShadow: true,
    });
    warnings.push("No lights were defined; added a key sun.");
  }
  for (const l of spec.lights) {
    l.position = clampVec(l.position);
    l.target = clampVec(l.target);
  }

  // ---- tracks ----
  const trackIds = new Set<string>();
  const tracks: Track[] = [];
  const transformOwner = new Set<string>();
  for (const track of spec.tracks) {
    if (track.type === "light") {
      if (!lightIds.has(track.lightId)) {
        warnings.push(`Light track "${track.id}" referenced unknown light "${track.lightId}" and was removed.`);
        continue;
      }
      track.keyframes = dedupeByTime(track.keyframes.map((k) => ({ ...k, t: clampT(k.t) })));
    } else {
      const obj = objectById.get(track.objectId);
      if (!obj) {
        warnings.push(`Track "${track.id}" referenced unknown object "${track.objectId}" and was removed.`);
        continue;
      }
      const asset = assetById.get(obj.assetId)!;
      if (track.type === "transform") {
        if (transformOwner.has(track.objectId)) {
          warnings.push(`Object "${track.objectId}" had two transform tracks; kept the first.`);
          continue;
        }
        transformOwner.add(track.objectId);
        track.keyframes = dedupeByTime(
          track.keyframes.map((k) => ({
            ...k,
            t: clampT(k.t),
            position: k.position ? clampVec(k.position) : undefined,
          })),
        );
      } else if (track.type === "action") {
        const available = options.availableClips?.[asset.id];
        const declared = new Set<string>([...BUILTIN_CLIPS, ...asset.actions.map((a) => a.name), ...asset.motions.map((m) => m.name)]);
        track.clips = track.clips
          .map((c) => ({ ...c, start: clampT(c.start), end: clampT(c.end) }))
          .filter((c) => {
            if (c.end - c.start < 0.02) return false;
            if (asset.rig !== "humanoid") {
              warnings.push(`"${obj.id}" has no skeleton, so the "${c.action}" clip was removed.`);
              return false;
            }
            if (available ? !available.includes(c.action) : !declared.has(c.action)) {
              warnings.push(`Clip "${c.action}" is not available for "${obj.id}" and was removed.`);
              return false;
            }
            return true;
          })
          .sort((a, b) => a.start - b.start);
        if (track.clips.length === 0) continue;
      } else {
        track.motions = track.motions
          .map((m) => ({ ...m, start: clampT(m.start), end: clampT(m.end) }))
          .filter((m) => m.end - m.start >= 0.02);
        if (track.motions.length === 0) continue;
      }
    }
    track.id = uniqueId(track.id, trackIds);
    tracks.push(track);
  }
  spec.tracks = tracks;

  // ---- cameras ----
  const cameraIds = new Set<string>();
  spec.cameras = spec.cameras.filter((c) => (cameraIds.has(c.id) ? false : (cameraIds.add(c.id), true)));
  if (spec.cameras.length === 0) {
    spec.cameras.push(defaultCamera(spec, uniqueId("main_camera", cameraIds)));
    warnings.push("No camera was defined; added a wide establishing camera.");
  }
  for (const cam of spec.cameras) {
    if (cam.attach.mode !== "world" && (!cam.attach.objectId || !objectById.has(cam.attach.objectId))) {
      warnings.push(`Camera "${cam.id}" was attached to a missing object; it now uses world coordinates.`);
      cam.attach = { mode: "world", objectId: null };
    }
    cam.keyframes = dedupeByTime(
      cam.keyframes.map((k) => ({
        ...k,
        t: clampT(k.t),
        position: clampVec(k.position),
        target: clampVec(k.target),
        fov: clampNum(k.fov, 12, 100),
      })),
    );
  }

  // ---- attached cameras aim with offsets; characters stand on the ground (both need the final tracks) ----
  fixAttachedCameraOffsets(spec, warnings);
  groundCharacters(spec, warnings);

  // ---- shots ----
  spec.shots = normalizeShots(spec.shots, spec.cameras, D, warnings);

  // ---- camera clearance (needs the final tracks) ----
  let moved = adjustCameras(spec);

  // ---- no shot may show an empty frame ----
  if (reaimEmptyShots(spec, warnings) > 0) moved += adjustCameras(spec);
  if (moved > 0) warnings.push(`Moved ${moved} camera keyframe${moved === 1 ? "" : "s"} that were inside an object or below the ground.`);

  return { spec, warnings };
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const round3 = (a: Vec3): Vec3 => [round(a[0]), round(a[1]), round(a[2])];

/**
 * Cameras attached to an object give their target (and, for "follow", their position) as an
 * offset from that object. A model sometimes writes world coordinates there instead, which
 * points the camera far away from its subject. Offsets that cannot be offsets are repaired.
 */
function fixAttachedCameraOffsets(spec: SceneSpec, warnings: string[]): void {
  const sampler = new SceneSampler(cloneJson(spec) as SceneSpec);
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));
  const objectById = new Map(spec.objects.map((o) => [o.id, o]));
  for (const cam of spec.cameras) {
    if (cam.attach.mode === "world" || !cam.attach.objectId) continue;
    const obj = objectById.get(cam.attach.objectId);
    const asset = obj && assetById.get(obj.assetId);
    if (!obj || !asset) continue;
    let fixed = 0;
    for (const key of cam.keyframes) {
      const s = sampler.sampleObject(obj.id, key.t);
      const h = Math.max(assetHeight(asset, s.scale), 0.2);
      const reach = assetRadius(asset, s.scale) + Math.max(1, h);
      const plausible = (v: Vec3) => Math.hypot(v[0], v[2]) <= reach && v[1] >= -0.5 && v[1] <= h * 1.5 + 0.5;
      if (!plausible(key.target as Vec3)) {
        const asOffset = sub(key.target as Vec3, s.position);
        key.target = plausible(asOffset) ? round3(asOffset) : [0, round(h * 0.6), 0];
        fixed++;
      }
      if (cam.attach.mode === "follow") {
        const asOffset = sub(key.position as Vec3, s.position);
        const far = len(key.position as Vec3);
        if (far > Math.max(12, 12 * h) && len(asOffset) < far * 0.5 && len(asOffset) > 0.05) {
          key.position = round3(asOffset);
          fixed++;
        }
      }
    }
    if (fixed > 0) warnings.push(`Camera "${cam.id}" was not aimed at "${obj.name || obj.id}" (its target was not relative to it); it was re-aimed.`);
  }
}

/**
 * Characters stand on the ground: models are solid shapes with no walkable roofs or ledges,
 * so a character placed in the air would simply float. One whose whole path is off the ground
 * is moved down to it, together with the cameras and lights that were set up around it.
 */
function groundCharacters(spec: SceneSpec, warnings: string[]): void {
  const before = new SceneSampler(cloneJson(spec) as SceneSpec);
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));
  for (const obj of spec.objects) {
    const asset = assetById.get(obj.assetId);
    if (!asset || asset.kind !== "character" || asset.rig !== "humanoid") continue;
    const track = spec.tracks.find((t) => t.type === "transform" && t.objectId === obj.id);
    const keyed = track && track.type === "transform" ? track.keyframes.filter((k) => k.position) : [];
    const lift = keyed.length > 0 ? Math.min(...keyed.map((k) => k.position![1]!)) : obj.position[1]!;
    if (Math.abs(lift) <= 0.05) continue;

    obj.position = [obj.position[0]!, round(Math.max(0, obj.position[1]! - lift)), obj.position[2]!];
    for (const k of keyed) k.position = [k.position![0]!, round(k.position![1]! - lift), k.position![2]!];
    if (lift < 0) continue; // it was sunk into the ground: lifting it out is all that is needed

    const h = assetHeight(asset, obj.scale);
    const r = assetRadius(asset, obj.scale);
    const wasNear = (p: Vec3, t: number, reach: number) => len(sub(p, before.sampleObject(obj.id, t).position)) <= reach;
    const lower = (v: number[], floor: number): Vec3 => [v[0]!, round(Math.max(floor, v[1]! - lift)), v[2]!];
    for (const cam of spec.cameras) {
      const mine = cam.attach.objectId === obj.id;
      if (mine && cam.attach.mode === "follow") continue; // its offsets travel with the character
      for (const key of cam.keyframes) {
        if (mine && cam.attach.mode === "look_at") {
          if (key.position[1]! >= lift * 0.5) key.position = lower(key.position, 0.3);
        } else if (cam.attach.mode === "world" && wasNear(key.target as Vec3, key.t, r + h + 3)) {
          key.target = lower(key.target, 0);
          if (key.position[1]! >= lift * 0.5) key.position = lower(key.position, 0.3);
        }
      }
    }
    for (const light of spec.lights) {
      if (light.type === "sun" || light.position[1]! < lift * 0.5 || !wasNear(light.position as Vec3, 0, Math.max(15, 8 * h))) continue;
      light.position = lower(light.position, 0.2);
      if (light.target[1]! >= lift * 0.5) light.target = lower(light.target, 0);
    }
    warnings.push(`"${obj.name || obj.id}" was placed ${round(lift, 1)} m above the ground with nothing to stand on; it was moved down to the ground.`);
  }
}

/** Is any part of an upright object inside the camera's view, and large enough to read? */
function inFrame(cam: CameraSample, base: Vec3, height: number, radius: number, aspect: number): boolean {
  const forward = sub(cam.target, cam.position);
  const fl = len(forward);
  if (fl < 1e-6) return false;
  const f: Vec3 = [forward[0] / fl, forward[1] / fl, forward[2] / fl];
  let right = cross(f, [0, 1, 0]);
  if (len(right) < 1e-6) right = [1, 0, 0];
  const rl = len(right);
  right = [right[0] / rl, right[1] / rl, right[2] / rl];
  const up = cross(right, f);
  const tanV = Math.tan((cam.fov * Math.PI) / 360);
  const tanH = tanV * aspect;
  const margin = Math.min(radius, Math.max(height, radius)) * 0.5;
  const size = Math.max(height, radius * 2);
  // Sample the object's vertical axis; a tall tower is in frame if any stretch of it is.
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const d = sub([base[0], base[1] + (height * i) / steps, base[2]], cam.position);
    const depth = dot(d, f);
    if (depth < 0.1) continue;
    if (Math.abs(dot(d, right)) - margin > depth * tanH || Math.abs(dot(d, up)) - margin > depth * tanV) continue;
    if (size / depth >= tanV * 2 * 0.02) return true; // at least 2% of the frame height
  }
  return false;
}

function aspectRatio(aspect: string): number {
  const [w, h] = aspect.split(":").map(Number);
  return w && h ? w / h : 16 / 9;
}

/**
 * A finished video must show something. For every shot, check that at least one model is in
 * the camera's view at the start, middle or end of the shot; a camera that films only sky or
 * bare ground for a whole shot is re-aimed at the shot's subject. Returns how many were fixed.
 */
export function reaimEmptyShots(spec: SceneSpec, warnings: string[] = []): number {
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));
  const subjects = spec.objects.filter((o) => o.visible && assetById.get(o.assetId) && assetById.get(o.assetId)!.kind !== "terrain");
  if (subjects.length === 0) return 0;
  const aspect = aspectRatio(spec.output.aspect);
  const hero: SceneObject =
    subjects.find((o) => assetById.get(o.assetId)!.rig === "humanoid") ??
    subjects.find((o) => ["character", "creature"].includes(assetById.get(o.assetId)!.kind)) ??
    subjects[0]!;

  let sampler = new SceneSampler(spec);
  const sees = (cameraId: string, t: number) => {
    const cam = sampler.sampleCamera(cameraId, t);
    return subjects.some((o) => {
      const asset = assetById.get(o.assetId)!;
      const s = sampler.sampleObject(o.id, t);
      return inFrame(cam, s.position, assetHeight(asset, s.scale), assetRadius(asset, s.scale), aspect);
    });
  };

  let fixed = 0;
  const done = new Set<string>();
  for (const shot of spec.shots) {
    const cam = spec.cameras.find((c) => c.id === shot.cameraId);
    if (!cam || done.has(cam.id)) continue;
    const edge = Math.min(0.05, (shot.end - shot.start) / 4);
    if ([shot.start + edge, (shot.start + shot.end) / 2, shot.end - edge].some((t) => sees(cam.id, t))) continue;

    const subject = (cam.attach.mode !== "world" && subjects.find((o) => o.id === cam.attach.objectId)) || hero;
    const asset = assetById.get(subject.assetId)!;
    const keys = cam.keyframes.map((key) => {
      const world = sampler.sampleCamera(cam.id, key.t).position;
      const s = sampler.sampleObject(subject.id, key.t);
      const h = Math.max(assetHeight(asset, s.scale), 0.2);
      const r = assetRadius(asset, s.scale);
      const aim: Vec3 = [s.position[0], s.position[1] + h * 0.6, s.position[2]];
      // The distance at which the subject fills about 70% of the frame height.
      const ideal = (Math.max(h, r * 2) * 1.4) / (2 * Math.tan((key.fov * Math.PI) / 360));
      let position = world;
      const away = len(sub(world, aim));
      if (away > ideal * 6 || away < r * 1.15 + 0.2) {
        // Far too distant (or inside the subject): stand in front of it instead, on the side the camera was on.
        let dx = world[0] - s.position[0];
        let dz = world[2] - s.position[2];
        let flat = Math.hypot(dx, dz);
        if (flat < 0.05) {
          const heading = (s.rotation[1] * Math.PI) / 180;
          dx = Math.sin(heading);
          dz = Math.cos(heading);
          flat = 1;
        }
        position = [s.position[0] + (dx / flat) * ideal * 1.2, Math.max(0.3, s.position[1] + h * 0.7), s.position[2] + (dz / flat) * ideal * 1.2];
      }
      return { ...key, position: round3(position), target: [0, round(h * 0.6), 0] as Vec3 };
    });
    cam.attach = { mode: "look_at", objectId: subject.id };
    cam.keyframes = keys;
    done.add(cam.id);
    fixed++;
    warnings.push(`Camera "${cam.name || cam.id}" showed no models during "${shot.name || shot.id}"; it was re-aimed at "${subject.name || subject.id}".`);
    sampler = new SceneSampler(spec);
  }
  return fixed;
}

function defaultCamera(spec: SceneSpec, id: string): Camera {
  let radius = 4;
  let height = 1.6;
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));
  for (const o of spec.objects) {
    const a = assetById.get(o.assetId);
    if (!a || a.kind === "terrain") continue;
    radius = Math.max(radius, Math.hypot(o.position[0]!, o.position[2]!) + assetRadius(a, o.scale));
    height = Math.max(height, assetHeight(a, o.scale));
  }
  const dist = Math.min(400, radius * 2.2 + 3);
  return {
    id,
    name: "Main camera",
    attach: { mode: "world", objectId: null },
    smooth: true,
    keyframes: [
      { t: 0, position: [dist * 0.6, Math.max(1.6, height * 0.9), dist], target: [0, Math.max(0.8, height * 0.45), 0], fov: 40, easing: "ease_in_out" },
    ],
  };
}

export function normalizeShots(input: Shot[], cameras: Camera[], duration: number, warnings: string[] = []): Shot[] {
  const cameraIds = new Set(cameras.map((c) => c.id));
  const first = cameras[0]!.id;
  let shots = input
    .map((s) => ({ ...s }))
    .filter((s) => s.start < duration - 1e-3)
    .sort((a, b) => a.start - b.start);
  for (const s of shots) {
    if (!cameraIds.has(s.cameraId)) {
      warnings.push(`Shot "${s.id}" used a missing camera; it now uses "${first}".`);
      s.cameraId = first;
    }
  }
  if (shots.length === 0) {
    return [{ id: "shot_1", name: "Shot 1", cameraId: first, start: 0, end: duration, transition: "cut", transitionDuration: 0 }];
  }
  // Tile [0, duration] with no gaps or overlaps: each shot runs until the next one starts.
  shots[0]!.start = 0;
  const tiled: Shot[] = [];
  for (let i = 0; i < shots.length; i++) {
    const s = shots[i]!;
    const nextStart = i + 1 < shots.length ? shots[i + 1]!.start : duration;
    s.start = round(clampNum(s.start, 0, duration), 4);
    s.end = round(clampNum(nextStart, 0, duration), 4);
    if (s.end - s.start < 0.04) continue;
    tiled.push(s);
  }
  if (tiled.length === 0) {
    return [{ id: "shot_1", name: "Shot 1", cameraId: first, start: 0, end: duration, transition: "cut", transitionDuration: 0 }];
  }
  tiled[0]!.start = 0;
  tiled[tiled.length - 1]!.end = duration;
  const ids = new Set<string>();
  for (let i = 0; i < tiled.length; i++) {
    const s = tiled[i]!;
    s.id = uniqueId(s.id, ids);
    const len = s.end - s.start;
    const prevLen = i > 0 ? tiled[i - 1]!.end - tiled[i - 1]!.start : len;
    const maxT = i === 0 ? len * 0.5 : Math.min(len, prevLen) * 0.9;
    if (s.transition === "cut") s.transitionDuration = 0;
    else s.transitionDuration = round(clampNum(s.transitionDuration || 0.5, 0, Math.max(0, maxT)), 3);
    if (i === 0 && s.transition === "dissolve") s.transition = "fade";
  }
  return tiled;
}

/**
 * Keep cameras usable: never under the ground, never inside a model, never
 * looking at themselves. Returns how many keyframes were moved.
 */
export function adjustCameras(spec: SceneSpec): number {
  const sampler = new SceneSampler(spec);
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));
  let moved = 0;
  for (const cam of spec.cameras) {
    for (const key of cam.keyframes) {
      const anchor: Vec3 =
        cam.attach.mode !== "world" && cam.attach.objectId ? sampler.sampleObject(cam.attach.objectId, key.t).position : [0, 0, 0];
      const follow = cam.attach.mode === "follow";
      let world: Vec3 = follow
        ? [key.position[0]! + anchor[0], key.position[1]! + anchor[1], key.position[2]! + anchor[2]]
        : (key.position.slice() as Vec3);
      const before = world.slice() as Vec3;

      if (world[1] < 0.15) world[1] = 0.15;
      for (const obj of spec.objects) {
        const asset = assetById.get(obj.assetId);
        if (!asset || asset.kind === "terrain" || !obj.visible) continue;
        const s = sampler.sampleObject(obj.id, key.t);
        const r = assetRadius(asset, s.scale);
        const h = assetHeight(asset, s.scale);
        // Vertical capsule test: only push when the camera is inside the model's silhouette volume.
        if (world[1] > s.position[1] + h + 0.2 || world[1] < s.position[1] - 0.2) continue;
        const dx = world[0] - s.position[0];
        const dz = world[2] - s.position[2];
        const d = Math.hypot(dx, dz);
        const min = r * 1.15 + 0.2;
        if (d >= min) continue;
        const ux = d < 1e-4 ? 0 : dx / d;
        const uz = d < 1e-4 ? 1 : dz / d;
        world = [s.position[0] + ux * min, world[1], s.position[2] + uz * min];
      }
      const changed = Math.hypot(world[0] - before[0], world[1] - before[1], world[2] - before[2]) > 1e-4;
      if (changed) {
        moved++;
        key.position = follow
          ? [round(world[0] - anchor[0]), round(world[1] - anchor[1]), round(world[2] - anchor[2])]
          : [round(world[0]), round(world[1]), round(world[2])];
      }
      // A camera must not look at its own position.
      const tgt: Vec3 =
        cam.attach.mode === "world" ? (key.target as Vec3) : [key.target[0]! + anchor[0], key.target[1]! + anchor[1], key.target[2]! + anchor[2]];
      if (Math.hypot(tgt[0] - world[0], tgt[1] - world[1], tgt[2] - world[2]) < 0.05) {
        key.target = [key.target[0]!, key.target[1]!, key.target[2]! - 1];
        moved++;
      }
    }
  }
  return moved;
}

/**
 * Match locomotion clips to how fast a character actually travels.
 *
 * A director can ask a character to cross 8 m in 2 s while playing a strolling
 * walk cycle, which makes its feet skate. For each walk/run clip this measures
 * the real ground speed over the clip, switches walk↔run when the other gait
 * fits better, switches to an idle clip when the character is not moving at
 * all, and sets the playback speed so stride and travel agree. Returns notes
 * describing what it changed. Applied to AI-directed scenes, never to a
 * user's manual edits.
 */
export function matchClipsToMotion(spec: SceneSpec, availableClips: Record<string, string[]> = {}): string[] {
  const notes: string[] = [];
  const pathOnly = new SceneSampler({ ...spec, tracks: spec.tracks.filter((t) => t.type !== "procedural") });
  const assetById = new Map(spec.assets.map((a) => [a.id, a]));
  const objectById = new Map(spec.objects.map((o) => [o.id, o]));
  for (const track of spec.tracks) {
    if (track.type !== "action") continue;
    const obj = objectById.get(track.objectId);
    const asset = obj && assetById.get(obj.assetId);
    if (!obj || !asset) continue;
    const have = new Set(availableClips[asset.id] ?? [...BUILTIN_CLIPS, ...asset.actions.map((a) => a.name)]);
    const height = (asset.size.axis === "height" ? asset.size.meters : 1.7) * obj.scale;
    // Typical ground speed of Meshy's walk and run cycles, per metre of character height.
    const nominal = { walk: 0.8 * height, run: 2.4 * height };
    const idle = [...have].find((c) => c === "idle" || c.startsWith("idle"));
    for (const clip of track.clips) {
      if (clip.action !== "walk" && clip.action !== "run") continue;
      const length = clip.end - clip.start;
      if (length <= 0.05) continue;
      const steps = Math.max(2, Math.ceil(length * 12));
      let distance = 0;
      let previous = pathOnly.sampleObject(obj.id, clip.start).position;
      for (let i = 1; i <= steps; i++) {
        const p = pathOnly.sampleObject(obj.id, clip.start + (length * i) / steps).position;
        distance += Math.hypot(p[0] - previous[0], p[2] - previous[2]);
        previous = p;
      }
      const speed = distance / length;
      if (speed < 0.05 * height) {
        if (idle) {
          notes.push(`"${obj.name}" stands still from ${clip.start}s to ${clip.end}s, so its ${clip.action} clip became "${idle}".`);
          clip.action = idle;
          clip.speed = 1;
        }
        continue;
      }
      const before = clip.action;
      if (clip.action === "walk" && speed > 1.9 * nominal.walk && have.has("run")) clip.action = "run";
      else if (clip.action === "run" && speed < 0.55 * nominal.run && have.has("walk")) clip.action = "walk";
      clip.speed = round(clampNum(speed / nominal[clip.action as "walk" | "run"], 0.5, 2.5), 2);
      if (before !== clip.action) notes.push(`"${obj.name}" moves at ${speed.toFixed(1)} m/s, so its ${before} clip became ${clip.action}.`);
    }
  }
  return notes;
}

/** zod helper: readable issue list. */
export function zodIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "value"}: ${i.message}`);
}
