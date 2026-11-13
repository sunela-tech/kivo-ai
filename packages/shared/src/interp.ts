import type {
  Camera,
  Easing,
  Light,
  LightTrack,
  ProceduralTrack,
  SceneObject,
  SceneSpec,
  Shot,
  TransformTrack,
  Vec3,
} from "./scene";

/**
 * Deterministic scene sampling.
 *
 * This is the definition of what a SceneSpec *means* at time t. The browser
 * preview uses it directly; the Blender service runs a line-for-line Python
 * port (services/renderer/kivo_renderer/sampling.py). test/fixtures/sampling.json
 * is generated from this file and asserted by the Python tests, so preview and
 * render cannot drift apart.
 */

export const PROCEDURAL_FADE = 0.25;
export const HEADING_WINDOW = 0.15;

export function ease(e: Easing, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  switch (e) {
    case "linear":
      return x;
    case "ease_in":
      return x * x;
    case "ease_out":
      return 1 - (1 - x) * (1 - x);
    case "ease_in_out":
      return x < 0.5 ? 2 * x * x : 1 - ((-2 * x + 2) * (-2 * x + 2)) / 2;
    case "hold":
      return 0;
  }
}

export function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

export function lerp3(a: Vec3, b: Vec3, u: number): Vec3 {
  return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
}

function catmull(p0: number, p1: number, p2: number, p3: number, u: number): number {
  const u2 = u * u;
  const u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

export function hexToRgb(hex: string): Vec3 {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(rgb: Vec3): string {
  const c = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

interface Key<T> {
  t: number;
  v: T;
  easing: Easing;
}

/** Locate the segment containing `time`. Keys must be sorted by t. */
function locate<T>(keys: Key<T>[], time: number): { i0: number; i1: number; u: number } {
  const n = keys.length;
  if (n === 1 || time <= keys[0]!.t) return { i0: 0, i1: 0, u: 0 };
  if (time >= keys[n - 1]!.t) return { i0: n - 1, i1: n - 1, u: 0 };
  let i = 0;
  while (i < n - 2 && keys[i + 1]!.t <= time) i++;
  const k0 = keys[i]!;
  const k1 = keys[i + 1]!;
  const span = k1.t - k0.t;
  const raw = span <= 1e-9 ? 1 : (time - k0.t) / span;
  return { i0: i, i1: i + 1, u: ease(k1.easing, raw) };
}

function sampleScalar(keys: Key<number>[], time: number, fallback: number): number {
  if (keys.length === 0) return fallback;
  const { i0, i1, u } = locate(keys, time);
  return lerp(keys[i0]!.v, keys[i1]!.v, u);
}

function sampleVec(keys: Key<Vec3>[], time: number, fallback: Vec3, smooth: boolean): Vec3 {
  if (keys.length === 0) return fallback;
  const { i0, i1, u } = locate(keys, time);
  const a = keys[i0]!.v;
  const b = keys[i1]!.v;
  if (!smooth || i0 === i1) return lerp3(a, b, u);
  // A hold (identical keys) must stay put; a spline through it would overshoot.
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return a;
  const p0 = keys[Math.max(0, i0 - 1)]!.v;
  const p3 = keys[Math.min(keys.length - 1, i1 + 1)]!.v;
  return [
    catmull(p0[0], a[0], b[0], p3[0], u),
    catmull(p0[1], a[1], b[1], p3[1], u),
    catmull(p0[2], a[2], b[2], p3[2], u),
  ];
}

export interface ObjectSample {
  position: Vec3;
  rotation: Vec3;
  scale: number;
}

export interface CameraSample {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface LightSample {
  intensity: number;
  color: Vec3;
}

export type TransitionSample =
  | { kind: "none" }
  | { kind: "fade"; level: number }
  | { kind: "dissolve"; fromCameraId: string; toCameraId: string; mix: number };

function sortKeys<T>(keys: Key<T>[]): Key<T>[] {
  return keys.slice().sort((a, b) => a.t - b.t);
}

interface CompiledTransform {
  smooth: boolean;
  orientToPath: boolean;
  pos: Key<Vec3>[];
  rot: Key<Vec3>[];
  scale: Key<number>[];
}

export class SceneSampler {
  readonly spec: SceneSpec;
  private objects = new Map<string, SceneObject>();
  private transforms = new Map<string, CompiledTransform>();
  private procedurals = new Map<string, ProceduralTrack["motions"]>();
  private cameras = new Map<string, Camera>();
  private cameraKeys = new Map<string, { pos: Key<Vec3>[]; target: Key<Vec3>[]; fov: Key<number>[] }>();
  private lights = new Map<string, Light>();
  private lightKeys = new Map<string, { intensity: Key<number>[]; color: Key<Vec3>[] }>();
  private shots: Shot[];

  constructor(spec: SceneSpec) {
    this.spec = spec;
    for (const o of spec.objects) this.objects.set(o.id, o);
    for (const track of spec.tracks) {
      if (track.type === "transform") this.compileTransform(track);
      else if (track.type === "procedural") {
        const list = this.procedurals.get(track.objectId) ?? [];
        list.push(...track.motions);
        this.procedurals.set(track.objectId, list);
      } else if (track.type === "light") this.compileLight(track);
    }
    for (const c of spec.cameras) {
      this.cameras.set(c.id, c);
      const ks = c.keyframes.slice().sort((a, b) => a.t - b.t);
      this.cameraKeys.set(c.id, {
        pos: ks.map((k) => ({ t: k.t, v: k.position as Vec3, easing: k.easing })),
        target: ks.map((k) => ({ t: k.t, v: k.target as Vec3, easing: k.easing })),
        fov: ks.map((k) => ({ t: k.t, v: k.fov, easing: k.easing })),
      });
    }
    for (const l of spec.lights) this.lights.set(l.id, l);
    this.shots = spec.shots.slice().sort((a, b) => a.start - b.start);
  }

  private compileTransform(track: TransformTrack) {
    // Later tracks for the same object replace earlier ones (one transform track per object).
    const c: CompiledTransform = { smooth: track.smooth, orientToPath: track.orientToPath, pos: [], rot: [], scale: [] };
    for (const k of track.keyframes) {
      if (k.position) c.pos.push({ t: k.t, v: k.position as Vec3, easing: k.easing });
      if (k.rotation) c.rot.push({ t: k.t, v: k.rotation as Vec3, easing: k.easing });
      if (k.scale !== undefined) c.scale.push({ t: k.t, v: k.scale, easing: k.easing });
    }
    c.pos = sortKeys(c.pos);
    c.rot = sortKeys(c.rot);
    c.scale = sortKeys(c.scale);
    this.transforms.set(track.objectId, c);
  }

  private compileLight(track: LightTrack) {
    const entry = this.lightKeys.get(track.lightId) ?? { intensity: [], color: [] };
    for (const k of track.keyframes) {
      if (k.intensity !== undefined) entry.intensity.push({ t: k.t, v: k.intensity, easing: k.easing });
      if (k.color) entry.color.push({ t: k.t, v: hexToRgb(k.color), easing: k.easing });
    }
    entry.intensity = sortKeys(entry.intensity);
    entry.color = sortKeys(entry.color);
    this.lightKeys.set(track.lightId, entry);
  }

  /** Position from the transform track only (no procedural offsets). */
  private pathPosition(obj: SceneObject, c: CompiledTransform | undefined, t: number): Vec3 {
    if (!c) return obj.position as Vec3;
    return sampleVec(c.pos, t, obj.position as Vec3, c.smooth);
  }

  private heading(obj: SceneObject, c: CompiledTransform, t: number): number | null {
    const keys = c.pos;
    if (keys.length < 2) return null;
    const t0 = keys[0]!.t;
    const t1 = keys[keys.length - 1]!.t;
    const a = this.pathPosition(obj, c, Math.max(t0, Math.min(t1, t - HEADING_WINDOW)));
    const b = this.pathPosition(obj, c, Math.max(t0, Math.min(t1, t + HEADING_WINDOW)));
    let dx = b[0] - a[0];
    let dz = b[2] - a[2];
    if (dx * dx + dz * dz < 1e-8) {
      // Standing still: keep facing along the most recent move, else the next one.
      const { i0 } = locate(keys, Math.max(t0, Math.min(t1, t)));
      let found = false;
      for (let i = Math.min(i0, keys.length - 2); i >= 0 && !found; i--) {
        dx = keys[i + 1]!.v[0] - keys[i]!.v[0];
        dz = keys[i + 1]!.v[2] - keys[i]!.v[2];
        found = dx * dx + dz * dz >= 1e-8;
      }
      for (let i = Math.min(i0 + 1, keys.length - 2); i <= keys.length - 2 && !found; i++) {
        dx = keys[i + 1]!.v[0] - keys[i]!.v[0];
        dz = keys[i + 1]!.v[2] - keys[i]!.v[2];
        found = dx * dx + dz * dz >= 1e-8;
      }
      if (!found) return null;
    }
    return (Math.atan2(dx, dz) * 180) / Math.PI;
  }

  sampleObject(objectId: string, t: number): ObjectSample {
    const obj = this.objects.get(objectId);
    if (!obj) return { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
    const c = this.transforms.get(objectId);
    const position = this.pathPosition(obj, c, t).slice() as Vec3;
    const rotation = (c ? sampleVec(c.rot, t, obj.rotation as Vec3, false) : (obj.rotation as Vec3)).slice() as Vec3;
    let scale = c ? sampleScalar(c.scale, t, obj.scale) : obj.scale;
    if (c?.orientToPath) {
      const h = this.heading(obj, c, t);
      if (h !== null) rotation[1] = h;
    }
    const motions = this.procedurals.get(objectId);
    if (motions) {
      for (const m of motions) {
        if (t < m.start) continue;
        const len = Math.max(0, m.end - m.start);
        const tau = Math.min(t - m.start, len);
        const w2 = 2 * Math.PI * m.frequency;
        if (m.kind === "spin") {
          rotation[1] += 360 * m.frequency * tau;
          continue;
        }
        if (t > m.end) continue;
        const w = Math.max(0, Math.min(1, tau / PROCEDURAL_FADE, (m.end - t) / PROCEDURAL_FADE));
        const A = m.amplitude;
        switch (m.kind) {
          case "hover":
            position[1] += A * Math.sin(w2 * tau) * w;
            break;
          case "bob":
            position[1] += A * 0.5 * (1 - Math.cos(w2 * tau)) * w;
            break;
          case "hop":
            position[1] += A * Math.abs(Math.sin(Math.PI * m.frequency * tau)) * w;
            break;
          case "sway":
            rotation[2] += A * Math.sin(w2 * tau) * w;
            break;
          case "wobble":
            rotation[2] += A * Math.sin(w2 * tau) * w;
            rotation[0] += A * 0.5 * Math.sin(w2 * tau + Math.PI / 2) * w;
            break;
          case "shake":
            position[0] += A * Math.sin(w2 * tau * 1.31 + 0.7) * w;
            position[2] += A * Math.sin(w2 * tau * 1.73 + 2.1) * w;
            position[1] += A * 0.5 * Math.sin(w2 * tau * 2.17 + 4.2) * w;
            break;
          case "pulse":
            scale *= 1 + A * Math.sin(w2 * tau) * w;
            break;
        }
      }
    }
    return { position, rotation, scale: Math.max(0.001, scale) };
  }

  sampleCamera(cameraId: string, t: number): CameraSample {
    const cam = this.cameras.get(cameraId);
    const keys = this.cameraKeys.get(cameraId);
    if (!cam || !keys) return { position: [0, 2, 8], target: [0, 1, 0], fov: 40 };
    let position = sampleVec(keys.pos, t, [0, 2, 8], cam.smooth).slice() as Vec3;
    let target = sampleVec(keys.target, t, [0, 1, 0], false).slice() as Vec3;
    const fov = sampleScalar(keys.fov, t, 40);
    const attach = cam.attach;
    if (attach.mode !== "world" && attach.objectId && this.objects.has(attach.objectId)) {
      const anchor = this.sampleObject(attach.objectId, t).position;
      target = [target[0] + anchor[0], target[1] + anchor[1], target[2] + anchor[2]];
      if (attach.mode === "follow") {
        position = [position[0] + anchor[0], position[1] + anchor[1], position[2] + anchor[2]];
      }
    }
    return { position, target, fov };
  }

  sampleLight(lightId: string, t: number): LightSample {
    const light = this.lights.get(lightId);
    if (!light) return { intensity: 0, color: [1, 1, 1] };
    const keys = this.lightKeys.get(lightId);
    const base = hexToRgb(light.color);
    if (!keys) return { intensity: light.intensity, color: base };
    return {
      intensity: sampleScalar(keys.intensity, t, light.intensity),
      color: sampleVec(keys.color, t, base, false),
    };
  }

  /** Index of the shot on screen at time t (the last shot owns its end time). */
  shotIndexAt(t: number): number {
    const shots = this.shots;
    if (shots.length === 0) return -1;
    for (let i = shots.length - 1; i >= 0; i--) {
      if (t >= shots[i]!.start) return i;
    }
    return 0;
  }

  shotAt(t: number): Shot | null {
    const i = this.shotIndexAt(t);
    return i < 0 ? null : this.shots[i]!;
  }

  sortedShots(): Shot[] {
    return this.shots;
  }

  /**
   * Transition state at time t.
   * - fade: dips to black around the cut — `level` multiplies image brightness (1 = fully visible).
   * - dissolve: cross-fades the two cameras across a window centred on the cut.
   */
  transitionAt(t: number): TransitionSample {
    const shots = this.shots;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]!;
      const d = s.transitionDuration;
      if (s.transition === "cut" || d <= 1e-6) continue;
      if (i === 0) {
        if (s.transition === "fade" && t < s.start + d) {
          return { kind: "fade", level: Math.max(0, Math.min(1, (t - s.start) / d)) };
        }
        continue;
      }
      const half = d / 2;
      if (t < s.start - half || t >= s.start + half) continue;
      const prev = shots[i - 1]!;
      if (s.transition === "fade") {
        return { kind: "fade", level: Math.max(0, Math.min(1, Math.abs(t - s.start) / half)) };
      }
      return {
        kind: "dissolve",
        fromCameraId: prev.cameraId,
        toCameraId: s.cameraId,
        mix: Math.max(0, Math.min(1, (t - (s.start - half)) / d)),
      };
    }
    return { kind: "none" };
  }
}

/** The skeletal clip playing on an object at time t, with the clip-local time to show. */
export function activeClip(
  spec: SceneSpec,
  objectId: string,
  t: number,
): { action: string; time: number; loop: boolean; speed: number } | null {
  let best: { action: string; time: number; loop: boolean; speed: number; start: number } | null = null;
  for (const track of spec.tracks) {
    if (track.type !== "action" || track.objectId !== objectId) continue;
    for (const c of track.clips) {
      if (t >= c.start && t < c.end && (!best || c.start >= best.start)) {
        best = { action: c.action, time: (t - c.start) * c.speed, loop: c.loop, speed: c.speed, start: c.start };
      }
    }
  }
  if (!best) return null;
  return { action: best.action, time: best.time, loop: best.loop, speed: best.speed };
}
