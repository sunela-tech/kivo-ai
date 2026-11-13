import { SceneSampler, cloneJson, type Camera, type Light, type SceneObject, type SceneSpec, type Track, type TransformTrack, type Vec3 } from "@kivo/shared";
import { create } from "zustand";
import { ApiError, api, type Asset, type Project, type SceneResponse } from "../lib/api";

/**
 * Editor state. The scene (SceneSpec) is the single source of truth: the
 * viewport, timeline and inspector all read it, edits replace it immutably
 * (with undo history), and it autosaves to the server, which validates it.
 */

export type Selection = { type: "object" | "light" | "camera"; id: string } | null;
export type Tool = "translate" | "rotate" | "scale";
/** "free" = orbit camera; "edit" = whatever the shot list shows at the playhead; otherwise a camera id. */
export type ViewCamera = "free" | "edit" | string;

interface EditorState {
  projectId: string | null;
  project: Project | null;
  spec: SceneSpec | null;
  assets: Record<string, Asset>;
  version: number;
  loading: boolean;
  loadError: string | null;

  selection: Selection;
  tool: Tool;
  time: number;
  playing: boolean;
  viewCamera: ViewCamera;
  /** Pose of the free (orbit) camera, kept so "keyframe from view" can capture it. */
  freeView: { position: Vec3; target: Vec3; fov: number };

  dirty: boolean;
  saving: boolean;
  saveError: string | null;
  savedAt: number | null;
  warnings: string[];
  past: SceneSpec[];
  future: SceneSpec[];

  load: (projectId: string) => Promise<void>;
  reload: () => Promise<void>;
  adopt: (response: { spec: SceneSpec; version: number }) => void;
  update: (mutate: (spec: SceneSpec) => void, options?: { history?: boolean }) => void;
  save: () => Promise<void>;
  undo: () => void;
  redo: () => void;
  select: (selection: Selection) => void;
  setTool: (tool: Tool) => void;
  setTime: (time: number) => void;
  setPlaying: (playing: boolean) => void;
  setViewCamera: (view: ViewCamera) => void;
  setFreeView: (view: EditorState["freeView"]) => void;
  reset: () => void;
}

let saveTimer: number | undefined;
const HISTORY = 60;

export const useEditor = create<EditorState>((set, get) => ({
  projectId: null,
  project: null,
  spec: null,
  assets: {},
  version: 0,
  loading: false,
  loadError: null,
  selection: null,
  tool: "translate",
  time: 0,
  playing: false,
  viewCamera: "free",
  freeView: { position: [8, 5, -10], target: [0, 1, 0], fov: 45 },
  dirty: false,
  saving: false,
  saveError: null,
  savedAt: null,
  warnings: [],
  past: [],
  future: [],

  async load(projectId) {
    window.clearTimeout(saveTimer);
    set({ projectId, loading: true, loadError: null, spec: null, assets: {}, selection: null, time: 0, playing: false, past: [], future: [], dirty: false, saveError: null, viewCamera: "free" });
    try {
      const [detail, scene] = await Promise.all([api<{ project: Project }>(`/projects/${projectId}`), api<SceneResponse>(`/projects/${projectId}/scene`)]);
      if (get().projectId !== projectId) return;
      set({ project: detail.project, spec: scene.spec, assets: scene.assets, version: scene.version, loading: false });
    } catch (e) {
      set({ loading: false, loadError: (e as Error).message });
    }
  },

  async reload() {
    const { projectId, assets } = get();
    if (!projectId) return;
    const scene = await api<SceneResponse>(`/projects/${projectId}/scene`);
    // Keep the URLs of models that are already loaded so the viewport does not download them again.
    const merged: Record<string, Asset> = {};
    for (const [alias, asset] of Object.entries(scene.assets)) {
      const old = assets[alias];
      merged[alias] = old && old.id === asset.id && old.status === "ready" && asset.status === "ready" ? { ...asset, modelUrl: old.modelUrl, riggedUrl: old.riggedUrl, clips: old.clips } : asset;
    }
    set({ spec: scene.spec, assets: merged, version: scene.version, dirty: false, past: [], future: [] });
  },

  adopt({ spec, version }) {
    const current = get().spec;
    set({ spec, version, dirty: false, saveError: null, savedAt: Date.now(), past: current ? [...get().past, current].slice(-HISTORY) : get().past, future: [] });
  },

  update(mutate, options) {
    const current = get().spec;
    if (!current) return;
    const next = cloneJson(current);
    mutate(next);
    const history = options?.history !== false;
    set({ spec: next, dirty: true, past: history ? [...get().past, current].slice(-HISTORY) : get().past, future: history ? [] : get().future });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().save(), 1200);
  },

  async save() {
    const { projectId, spec, dirty, saving } = get();
    if (!projectId || !spec || !dirty) return;
    if (saving) {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void get().save(), 600);
      return;
    }
    set({ saving: true });
    const sent = spec;
    try {
      const res = await api<{ sceneId: string; version: number; spec: SceneSpec; warnings: string[] }>(`/projects/${projectId}/scene`, { method: "PUT", body: { spec: sent } });
      // If the user kept editing while this saved, keep their newer scene and save again.
      const stillCurrent = get().spec === sent;
      set({ saving: false, saveError: null, savedAt: Date.now(), version: res.version, warnings: res.warnings, dirty: !stillCurrent, ...(stillCurrent ? { spec: res.spec } : {}) });
      if (!stillCurrent) void get().save();
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "Couldn't save. Check your connection.";
      set({ saving: false, saveError: message });
    }
  },

  undo() {
    const { past, spec, future } = get();
    const previous = past[past.length - 1];
    if (!previous || !spec) return;
    set({ spec: previous, past: past.slice(0, -1), future: [spec, ...future].slice(0, HISTORY), dirty: true });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().save(), 800);
  },

  redo() {
    const { past, spec, future } = get();
    const next = future[0];
    if (!next || !spec) return;
    set({ spec: next, future: future.slice(1), past: [...past, spec].slice(-HISTORY), dirty: true });
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().save(), 800);
  },

  select: (selection) => set({ selection }),
  setTool: (tool) => set({ tool }),
  setTime: (time) => {
    const duration = get().spec?.output.duration ?? 0;
    set({ time: Math.min(duration, Math.max(0, time)) });
  },
  setPlaying: (playing) => set({ playing }),
  setViewCamera: (viewCamera) => set({ viewCamera }),
  setFreeView: (freeView) => set({ freeView }),
  reset: () => {
    window.clearTimeout(saveTimer);
    set({ projectId: null, project: null, spec: null, assets: {}, selection: null, past: [], future: [], dirty: false, playing: false });
  },
}));

// ───────────── pure scene edits ─────────────

const round = (n: number, places = 3) => Math.round(n * 10 ** places) / 10 ** places;
export const roundVec = (v: number[]): Vec3 => [round(v[0]!), round(v[1]!), round(v[2]!)];

export function uniqueId(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^([^a-z])/, "x$1")
      .slice(0, 40) || "item";
  if (!used.has(clean)) return clean;
  for (let i = 2; ; i++) {
    const id = `${clean.replace(/_\d+$/, "").slice(0, 40)}_${i}`;
    if (!used.has(id)) return id;
  }
}

export function transformTrack(spec: SceneSpec, objectId: string): TransformTrack | undefined {
  return spec.tracks.find((t): t is TransformTrack => t.type === "transform" && t.objectId === objectId);
}

/** Keyframes closer than half a frame count as "at" a time. */
export function atTime(spec: SceneSpec, a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.5 / spec.output.fps + 1e-6;
}

/**
 * Apply a transform edit made in the viewport or inspector.
 * An object with a movement track gets a keyframe at the playhead; an object
 * without one simply moves (its resting transform changes).
 */
export function editObjectTransform(spec: SceneSpec, objectId: string, time: number, patch: { position?: Vec3; rotation?: Vec3; scale?: number }): void {
  const obj = spec.objects.find((o) => o.id === objectId);
  if (!obj) return;
  const track = transformTrack(spec, objectId);
  if (!track) {
    if (patch.position) obj.position = roundVec(patch.position);
    if (patch.rotation) obj.rotation = roundVec(patch.rotation);
    if (patch.scale !== undefined) obj.scale = Math.min(100, Math.max(0.01, round(patch.scale)));
    return;
  }
  let key = track.keyframes.find((k) => atTime(spec, k.t, time));
  if (!key) {
    const sample = new SceneSampler(spec).sampleObject(objectId, time);
    key = { t: round(time, 4), position: roundVec(sample.position), easing: "linear" };
    track.keyframes.push(key);
    track.keyframes.sort((a, b) => a.t - b.t);
  }
  if (patch.position) key.position = roundVec(patch.position);
  if (patch.rotation) key.rotation = roundVec(patch.rotation);
  if (patch.scale !== undefined) key.scale = Math.min(100, Math.max(0.01, round(patch.scale)));
}

/** Add a movement keyframe at the playhead, creating the track if the object had none. */
export function addObjectKeyframe(spec: SceneSpec, objectId: string, time: number): void {
  const obj = spec.objects.find((o) => o.id === objectId);
  if (!obj) return;
  const sample = new SceneSampler(spec).sampleObject(objectId, time);
  let track = transformTrack(spec, objectId);
  if (!track) {
    track = { id: uniqueId(`${objectId}_move`, spec.tracks.map((t) => t.id)), type: "transform", objectId, smooth: false, orientToPath: false, keyframes: [] };
    if (time > 1e-3) track.keyframes.push({ t: 0, position: roundVec(obj.position), easing: "linear" });
    spec.tracks.push(track);
  }
  if (!track.keyframes.some((k) => atTime(spec, k.t, time))) {
    track.keyframes.push({ t: round(time, 4), position: roundVec(sample.position), easing: "linear" });
    track.keyframes.sort((a, b) => a.t - b.t);
  }
}

export function removeTrackIfEmpty(spec: SceneSpec, trackId: string): void {
  spec.tracks = spec.tracks.filter((t) => {
    if (t.id !== trackId) return true;
    if (t.type === "transform" || t.type === "light") return t.keyframes.length > 0;
    if (t.type === "action") return t.clips.length > 0;
    return t.motions.length > 0;
  });
}

export function addObject(spec: SceneSpec, assetId: string, name: string): string {
  const id = uniqueId(assetId, spec.objects.map((o) => o.id));
  const object: SceneObject = { id, assetId, name, position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true };
  spec.objects.push(object);
  return id;
}

export function duplicateObject(spec: SceneSpec, objectId: string): string | null {
  const source = spec.objects.find((o) => o.id === objectId);
  if (!source) return null;
  const id = uniqueId(source.id, spec.objects.map((o) => o.id));
  spec.objects.push({ ...cloneJson(source), id, name: `${source.name} copy`.slice(0, 80), position: [round(source.position[0]! + 1.5), source.position[1]!, round(source.position[2]! + 1.5)] });
  for (const track of spec.tracks.filter((t) => t.type !== "light" && t.objectId === objectId)) {
    const copy = cloneJson(track) as Exclude<Track, { type: "light" }>;
    copy.id = uniqueId(`${id}_${track.type}`, spec.tracks.map((t) => t.id));
    copy.objectId = id;
    if (copy.type === "transform") for (const k of copy.keyframes) if (k.position) k.position = [round(k.position[0]! + 1.5), k.position[1]!, round(k.position[2]! + 1.5)];
    spec.tracks.push(copy);
  }
  return id;
}

export function removeObject(spec: SceneSpec, objectId: string): void {
  spec.objects = spec.objects.filter((o) => o.id !== objectId);
  spec.tracks = spec.tracks.filter((t) => t.type === "light" || t.objectId !== objectId);
  for (const cam of spec.cameras) if (cam.attach.objectId === objectId) cam.attach = { mode: "world", objectId: null };
}

export function addCamera(spec: SceneSpec, view: { position: Vec3; target: Vec3; fov: number }, time: number): string {
  const id = uniqueId("camera", spec.cameras.map((c) => c.id));
  const camera: Camera = {
    id,
    name: `Camera ${spec.cameras.length + 1}`,
    attach: { mode: "world", objectId: null },
    smooth: true,
    keyframes: [{ t: round(time, 4), position: roundVec(view.position), target: roundVec(view.target), fov: Math.round(view.fov), easing: "ease_in_out" }],
  };
  spec.cameras.push(camera);
  return id;
}

export function addLight(spec: SceneSpec, type: Light["type"]): string {
  const id = uniqueId(type, spec.lights.map((l) => l.id));
  spec.lights.push({
    id,
    name: `${type[0]!.toUpperCase()}${type.slice(1)} light`,
    type,
    color: "#ffffff",
    intensity: type === "sun" ? 3 : 800,
    position: type === "sun" ? [6, 10, -4] : [2, 3, -2],
    target: [0, 0.5, 0],
    spotAngle: 45,
    castShadow: true,
  });
  return id;
}

/** World-space pose of a camera keyframe (resolving look_at / follow attachment). */
export function cameraKeyWorld(spec: SceneSpec, camera: Camera, index: number): { position: Vec3; target: Vec3 } {
  const key = camera.keyframes[index]!;
  if (camera.attach.mode === "world" || !camera.attach.objectId) return { position: key.position as Vec3, target: key.target as Vec3 };
  const anchor = new SceneSampler(spec).sampleObject(camera.attach.objectId, key.t).position;
  const add = (v: number[]): Vec3 => [v[0]! + anchor[0], v[1]! + anchor[1], v[2]! + anchor[2]];
  return { position: camera.attach.mode === "follow" ? add(key.position) : (key.position as Vec3), target: add(key.target) };
}

/** Set a camera keyframe at the playhead from a world-space view (e.g. the free camera). */
export function keyCameraFromView(spec: SceneSpec, cameraId: string, time: number, view: { position: Vec3; target: Vec3; fov: number }): void {
  const camera = spec.cameras.find((c) => c.id === cameraId);
  if (!camera) return;
  const anchor: Vec3 = camera.attach.mode !== "world" && camera.attach.objectId ? new SceneSampler(spec).sampleObject(camera.attach.objectId, time).position : [0, 0, 0];
  const sub = (v: Vec3): Vec3 => roundVec([v[0] - anchor[0], v[1] - anchor[1], v[2] - anchor[2]]);
  const position = camera.attach.mode === "follow" ? sub(view.position) : roundVec(view.position);
  const target = camera.attach.mode === "world" ? roundVec(view.target) : sub(view.target);
  const existing = camera.keyframes.find((k) => atTime(spec, k.t, time));
  if (existing) Object.assign(existing, { position, target, fov: Math.round(view.fov) });
  else {
    camera.keyframes.push({ t: round(time, 4), position, target, fov: Math.round(view.fov), easing: "ease_in_out" });
    camera.keyframes.sort((a, b) => a.t - b.t);
  }
}

/** Keep the shot list tiling [0, duration] after an edit. */
export function retileShots(spec: SceneSpec): void {
  const d = spec.output.duration;
  const shots = spec.shots.filter((s) => s.start < d - 1e-3).sort((a, b) => a.start - b.start);
  if (shots.length === 0) {
    spec.shots = [{ id: "shot_1", name: "Shot 1", cameraId: spec.cameras[0]!.id, start: 0, end: d, transition: "cut", transitionDuration: 0 }];
    return;
  }
  shots[0]!.start = 0;
  shots.forEach((s, i) => {
    s.end = i + 1 < shots.length ? shots[i + 1]!.start : d;
    if (s.transition === "cut") s.transitionDuration = 0;
  });
  spec.shots = shots.filter((s) => s.end - s.start > 0.04);
}
