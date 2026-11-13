import { z } from "zod";
import { toId, type LibraryAction } from "./llm";
import type { PlanLimits } from "./plans";
import {
  ASSET_KINDS,
  ATTACH_MODES,
  BUILTIN_CLIPS,
  EASINGS,
  LIGHT_TYPES,
  PROCEDURAL_KINDS,
  TRANSITIONS,
  cloneJson,
  styleHint,
  type SceneAsset,
  type SceneSpec,
  type Track,
} from "./scene";

/**
 * AI Director operations.
 *
 * In Advanced Mode the user types an instruction ("make the camera orbit the
 * robot"). Gemini answers with a list of these typed operations — never code,
 * never a whole new scene — so untouched models, tracks and cameras are
 * guaranteed to stay exactly as they were. Only `add_asset` causes new Meshy
 * generation.
 */

export const DIRECTOR_OPS = [
  "set_world",
  "set_output",
  "upsert_light",
  "remove_light",
  "set_light_keyframes",
  "upsert_camera",
  "remove_camera",
  "set_shots",
  "add_asset",
  "add_object",
  "update_object",
  "remove_object",
  "set_move",
  "clear_move",
  "set_clips",
  "set_procedural",
] as const;
export type DirectorOpName = (typeof DIRECTOR_OPS)[number];

type J = Record<string, unknown>;
const vec3: J = { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 };
const s = (description?: string): J => ({ type: "string", ...(description ? { description } : {}) });
const n = (description?: string): J => ({ type: "number", ...(description ? { description } : {}) });
const b = (): J => ({ type: "boolean" });
const e = (values: readonly string[]): J => ({ type: "string", enum: [...values] });
const o = (properties: Record<string, J>, required: string[] = []): J => ({ type: "object", properties, required });

export const DirectorJsonSchema: J = o(
  {
    summary: s("One or two sentences telling the user what you changed"),
    cannotDo: s("If the request cannot be done with the available operations, explain why. Otherwise empty."),
    operations: {
      type: "array",
      maxItems: 24,
      items: o(
        {
          op: e(DIRECTOR_OPS),
          id: s("Target id for remove_light, remove_camera, remove_object, update_object"),
          objectId: s("Target object for set_move, clear_move, set_clips, set_procedural"),
          lightId: s("Target light for set_light_keyframes"),
          world: o({ skyTop: s("#rrggbb"), skyHorizon: s("#rrggbb"), groundColor: s("#rrggbb"), ambient: n(), exposure: n() }),
          output: o({ duration: n("seconds") }),
          light: o(
            { id: s(), name: s(), type: e(LIGHT_TYPES), color: s("#rrggbb"), intensity: n("sun 1-8; others watts"), position: vec3, target: vec3, castShadow: b() },
            ["id", "type", "color", "intensity", "position", "target"],
          ),
          lightKeyframes: { type: "array", items: o({ t: n(), intensity: n(), color: s("#rrggbb") }, ["t", "intensity", "color"]) },
          camera: o(
            {
              id: s(),
              name: s(),
              attachMode: e(ATTACH_MODES),
              attachObjectId: s(),
              smooth: b(),
              keyframes: {
                type: "array",
                items: o({ t: n(), position: vec3, target: vec3, fov: n(), easing: e(EASINGS) }, ["t", "position", "target", "fov", "easing"]),
              },
            },
            ["id", "attachMode", "attachObjectId", "smooth", "keyframes"],
          ),
          shots: {
            type: "array",
            items: o(
              { name: s(), cameraId: s(), start: n(), end: n(), transition: e(TRANSITIONS), transitionDuration: n() },
              ["cameraId", "start", "end", "transition", "transitionDuration"],
            ),
          },
          asset: o(
            {
              id: s(),
              name: s(),
              kind: e(ASSET_KINDS),
              prompt: s("Meshy prompt for ONE single object"),
              rig: e(["humanoid", "none"]),
              sizeMeters: n(),
              sizeAxis: e(["height", "longest", "width"]),
              actionIds: { type: "array", items: { type: "integer" } },
            },
            ["id", "name", "kind", "prompt", "rig", "sizeMeters", "sizeAxis"],
          ),
          object: o({ id: s(), assetId: s(), name: s(), position: vec3, rotationY: n(), scale: n() }, ["id", "assetId", "position"]),
          patch: o({
            name: s(),
            position: vec3,
            rotationY: n("heading degrees"),
            scale: n(),
            visible: b(),
            tint: s("#rrggbb"),
            tintStrength: n("0-1"),
            roughness: n("0-1"),
            metallic: n("0-1"),
            emissive: s("#rrggbb"),
            emissiveStrength: n(),
          }),
          move: o(
            {
              smooth: b(),
              orientToPath: b(),
              keyframes: {
                type: "array",
                items: o({ t: n(), position: vec3, rotationY: n(), scale: n(), easing: e(EASINGS) }, ["t", "position", "easing"]),
              },
            },
            ["smooth", "orientToPath", "keyframes"],
          ),
          clips: {
            type: "array",
            items: o({ start: n(), end: n(), action: s(), speed: n(), loop: b() }, ["start", "end", "action", "speed", "loop"]),
          },
          motions: {
            type: "array",
            items: o({ start: n(), end: n(), kind: e(PROCEDURAL_KINDS), amplitude: n(), frequency: n() }, ["start", "end", "kind", "amplitude", "frequency"]),
          },
        },
        ["op"],
      ),
    },
  },
  ["summary", "cannotDo", "operations"],
);

const zVec3 = z.array(z.coerce.number().finite()).length(3);
const zColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);

const OperationSchema = z.object({
  op: z.enum(DIRECTOR_OPS),
  id: z.string().optional(),
  objectId: z.string().optional(),
  lightId: z.string().optional(),
  world: z
    .object({
      skyTop: zColor.optional(),
      skyHorizon: zColor.optional(),
      groundColor: zColor.optional(),
      ambient: z.coerce.number().min(0).max(5).optional(),
      exposure: z.coerce.number().min(-4).max(4).optional(),
    })
    .optional(),
  output: z.object({ duration: z.coerce.number().min(1).max(600).optional() }).optional(),
  light: z
    .object({
      id: z.string(),
      name: z.string().optional(),
      type: z.enum(LIGHT_TYPES),
      color: zColor,
      intensity: z.coerce.number().min(0).max(1e6),
      position: zVec3,
      target: zVec3,
      castShadow: z.boolean().optional(),
    })
    .optional(),
  lightKeyframes: z.array(z.object({ t: z.coerce.number().min(0), intensity: z.coerce.number().min(0), color: zColor })).optional(),
  camera: z
    .object({
      id: z.string(),
      name: z.string().optional(),
      attachMode: z.enum(ATTACH_MODES),
      attachObjectId: z.string().default(""),
      smooth: z.boolean().default(true),
      keyframes: z
        .array(z.object({ t: z.coerce.number().min(0), position: zVec3, target: zVec3, fov: z.coerce.number(), easing: z.enum(EASINGS) }))
        .min(1),
    })
    .optional(),
  shots: z
    .array(
      z.object({
        name: z.string().optional(),
        cameraId: z.string(),
        start: z.coerce.number().min(0),
        end: z.coerce.number().min(0),
        transition: z.enum(TRANSITIONS),
        transitionDuration: z.coerce.number().min(0).max(3),
      }),
    )
    .optional(),
  asset: z
    .object({
      id: z.string(),
      name: z.string(),
      kind: z.enum(ASSET_KINDS),
      prompt: z.string().min(3),
      rig: z.enum(["humanoid", "none"]),
      sizeMeters: z.coerce.number().positive(),
      sizeAxis: z.enum(["height", "longest", "width"]),
      actionIds: z.array(z.coerce.number().int()).optional(),
    })
    .optional(),
  object: z
    .object({
      id: z.string(),
      assetId: z.string(),
      name: z.string().optional(),
      position: zVec3,
      rotationY: z.coerce.number().optional(),
      scale: z.coerce.number().positive().optional(),
    })
    .optional(),
  patch: z
    .object({
      name: z.string().optional(),
      position: zVec3.optional(),
      rotationY: z.coerce.number().optional(),
      scale: z.coerce.number().positive().optional(),
      visible: z.boolean().optional(),
      tint: zColor.optional(),
      tintStrength: z.coerce.number().min(0).max(1).optional(),
      roughness: z.coerce.number().min(0).max(1).optional(),
      metallic: z.coerce.number().min(0).max(1).optional(),
      emissive: zColor.optional(),
      emissiveStrength: z.coerce.number().min(0).max(50).optional(),
    })
    .optional(),
  move: z
    .object({
      smooth: z.boolean().default(false),
      orientToPath: z.boolean().default(false),
      keyframes: z
        .array(
          z.object({
            t: z.coerce.number().min(0),
            position: zVec3,
            rotationY: z.coerce.number().optional(),
            scale: z.coerce.number().positive().optional(),
            easing: z.enum(EASINGS).default("linear"),
          }),
        )
        .min(1),
    })
    .optional(),
  clips: z
    .array(
      z.object({
        start: z.coerce.number().min(0),
        end: z.coerce.number().min(0),
        action: z.string(),
        speed: z.coerce.number().min(0.1).max(4).default(1),
        loop: z.boolean().default(true),
      }),
    )
    .optional(),
  motions: z
    .array(
      z.object({
        start: z.coerce.number().min(0),
        end: z.coerce.number().min(0),
        kind: z.enum(PROCEDURAL_KINDS),
        amplitude: z.coerce.number().min(0).max(1000),
        frequency: z.coerce.number().min(0).max(30),
      }),
    )
    .optional(),
});
export type DirectorOperation = z.infer<typeof OperationSchema>;

export const DirectorResponseSchema = z.object({
  summary: z.string().default(""),
  cannotDo: z.string().default(""),
  operations: z.array(OperationSchema).max(40).default([]),
});
export type DirectorResponse = z.infer<typeof DirectorResponseSchema>;

export interface ApplyResult {
  spec: SceneSpec;
  /** Assets that did not exist before and must be generated by Meshy. */
  newAssets: SceneAsset[];
  applied: string[];
  skipped: string[];
}

/**
 * Apply director operations to a scene. Pure: returns a new spec.
 * Operations that reference things that do not exist are skipped and reported,
 * never guessed. Run normalizeScene on the result.
 */
export function applyDirectorOps(
  input: SceneSpec,
  operations: DirectorOperation[],
  ctx: { limits: Pick<PlanLimits, "maxAssetsPerScene">; library?: LibraryAction[] },
): ApplyResult {
  const spec = cloneJson(input);
  const applied: string[] = [];
  const skipped: string[] = [];
  const newAssets: SceneAsset[] = [];
  const libraryById = new Map((ctx.library ?? []).map((a) => [a.action_id, a]));

  const findObject = (raw?: string) => (raw ? spec.objects.find((x) => x.id === raw || x.id === toId(raw)) : undefined);
  const dropTracks = (pred: (t: Track) => boolean) => {
    spec.tracks = spec.tracks.filter((t) => !pred(t));
  };
  const trackId = (base: string) => {
    const used = new Set(spec.tracks.map((t) => t.id));
    let id = base.slice(0, 48);
    let i = 2;
    while (used.has(id)) id = `${base.slice(0, 44)}_${i++}`;
    return id;
  };

  for (const op of operations) {
    switch (op.op) {
      case "set_world": {
        if (!op.world) {
          skipped.push("set_world: no values given");
          break;
        }
        spec.world = { ...spec.world, ...Object.fromEntries(Object.entries(op.world).filter(([, v]) => v !== undefined)) };
        applied.push("Updated the sky and ambient light");
        break;
      }
      case "set_output": {
        if (op.output?.duration) {
          spec.output.duration = op.output.duration;
          applied.push(`Set duration to ${op.output.duration}s`);
        } else skipped.push("set_output: no duration given");
        break;
      }
      case "upsert_light": {
        if (!op.light) {
          skipped.push("upsert_light: no light given");
          break;
        }
        const id = toId(op.light.id, "light");
        const existing = spec.lights.find((l) => l.id === id);
        const light = {
          id,
          name: op.light.name?.slice(0, 80) || existing?.name || id,
          type: op.light.type,
          color: op.light.color,
          intensity: op.light.intensity,
          position: op.light.position as [number, number, number],
          target: op.light.target as [number, number, number],
          spotAngle: existing?.spotAngle ?? 45,
          castShadow: op.light.castShadow ?? existing?.castShadow ?? true,
        };
        if (existing) Object.assign(existing, light);
        else if (spec.lights.length < 24) spec.lights.push(light);
        else {
          skipped.push("upsert_light: the scene already has the maximum number of lights");
          break;
        }
        applied.push(`${existing ? "Updated" : "Added"} light "${light.name}"`);
        break;
      }
      case "remove_light": {
        const id = op.id ?? op.lightId;
        const before = spec.lights.length;
        spec.lights = spec.lights.filter((l) => l.id !== id);
        if (spec.lights.length === before) skipped.push(`remove_light: no light "${id}"`);
        else {
          dropTracks((t) => t.type === "light" && t.lightId === id);
          applied.push(`Removed light "${id}"`);
        }
        break;
      }
      case "set_light_keyframes": {
        const id = op.lightId ?? op.id;
        if (!id || !spec.lights.some((l) => l.id === id) || !op.lightKeyframes?.length) {
          skipped.push(`set_light_keyframes: no light "${id}" or no keyframes`);
          break;
        }
        dropTracks((t) => t.type === "light" && t.lightId === id);
        spec.tracks.push({
          id: trackId(`${id}_light`),
          type: "light",
          lightId: id,
          keyframes: op.lightKeyframes.map((k) => ({ t: k.t, intensity: k.intensity, color: k.color, easing: "ease_in_out" as const })),
        });
        applied.push(`Animated light "${id}"`);
        break;
      }
      case "upsert_camera": {
        if (!op.camera) {
          skipped.push("upsert_camera: no camera given");
          break;
        }
        const id = toId(op.camera.id, "camera");
        const attachObject = op.camera.attachMode === "world" ? undefined : findObject(op.camera.attachObjectId);
        const existing = spec.cameras.find((c) => c.id === id);
        const camera = {
          id,
          name: op.camera.name?.slice(0, 80) || existing?.name || id,
          attach: attachObject ? { mode: op.camera.attachMode, objectId: attachObject.id } : { mode: "world" as const, objectId: null },
          smooth: op.camera.smooth,
          keyframes: op.camera.keyframes.map((k) => ({
            t: k.t,
            position: k.position as [number, number, number],
            target: k.target as [number, number, number],
            fov: Math.min(100, Math.max(12, k.fov)),
            easing: k.easing,
          })),
        };
        if (existing) Object.assign(existing, camera);
        else if (spec.cameras.length < 24) spec.cameras.push(camera);
        else {
          skipped.push("upsert_camera: the scene already has the maximum number of cameras");
          break;
        }
        applied.push(`${existing ? "Updated" : "Added"} camera "${camera.name}"`);
        break;
      }
      case "remove_camera": {
        if (spec.cameras.length <= 1 || !spec.cameras.some((c) => c.id === op.id)) {
          skipped.push(`remove_camera: cannot remove "${op.id}"`);
          break;
        }
        spec.cameras = spec.cameras.filter((c) => c.id !== op.id);
        applied.push(`Removed camera "${op.id}"`);
        break;
      }
      case "set_shots": {
        if (!op.shots?.length) {
          skipped.push("set_shots: no shots given");
          break;
        }
        spec.shots = op.shots.map((sh, i) => ({
          id: `shot_${i + 1}`,
          name: sh.name?.slice(0, 80) || `Shot ${i + 1}`,
          cameraId: toId(sh.cameraId, "camera"),
          start: sh.start,
          end: sh.end,
          transition: sh.transition,
          transitionDuration: sh.transitionDuration,
        }));
        applied.push(`Re-cut the video into ${spec.shots.length} shot${spec.shots.length === 1 ? "" : "s"}`);
        break;
      }
      case "add_asset": {
        if (!op.asset) {
          skipped.push("add_asset: no asset given");
          break;
        }
        const id = toId(op.asset.id || op.asset.name, "asset");
        if (spec.assets.some((a) => a.id === id)) {
          skipped.push(`add_asset: "${id}" already exists (existing models are never regenerated)`);
          break;
        }
        if (spec.assets.length >= ctx.limits.maxAssetsPerScene) {
          skipped.push(`add_asset: this plan allows ${ctx.limits.maxAssetsPerScene} distinct models per scene`);
          break;
        }
        const rig = op.asset.rig === "humanoid" && (op.asset.kind === "character" || op.asset.kind === "creature") ? "humanoid" : "none";
        const names = new Set<string>(BUILTIN_CLIPS);
        const actions: SceneAsset["actions"] = [];
        if (rig === "humanoid") {
          for (const actionId of (op.asset.actionIds ?? []).slice(0, 6)) {
            const entry = libraryById.get(actionId);
            if (!entry) continue;
            const name = toId(entry.name, `action_${actionId}`);
            if (names.has(name)) continue;
            names.add(name);
            actions.push({ name, actionId });
          }
        }
        const asset: SceneAsset = {
          id,
          name: op.asset.name.slice(0, 80) || id,
          kind: op.asset.kind,
          prompt: `${op.asset.prompt.trim().replace(/\s+/g, " ")}. ${styleHint(spec.style)}`.slice(0, 800),
          rig,
          size: { meters: Math.min(2000, Math.max(0.02, op.asset.sizeMeters)), axis: op.asset.sizeAxis },
          actions,
          motions: [],
        };
        spec.assets.push(asset);
        newAssets.push(asset);
        applied.push(`Requested a new model: "${asset.name}"`);
        break;
      }
      case "add_object": {
        if (!op.object) {
          skipped.push("add_object: no object given");
          break;
        }
        const assetId = toId(op.object.assetId, "asset");
        if (!spec.assets.some((a) => a.id === assetId)) {
          skipped.push(`add_object: no model "${assetId}"`);
          break;
        }
        let id = toId(op.object.id, "object");
        let i = 2;
        while (spec.objects.some((x) => x.id === id)) id = `${toId(op.object.id, "object").slice(0, 44)}_${i++}`;
        if (spec.objects.length >= 300) {
          skipped.push("add_object: the scene already has the maximum number of objects");
          break;
        }
        spec.objects.push({
          id,
          assetId,
          name: op.object.name?.slice(0, 80) || id,
          position: op.object.position as [number, number, number],
          rotation: [0, op.object.rotationY ?? 0, 0],
          scale: Math.min(100, Math.max(0.01, op.object.scale ?? 1)),
          visible: true,
        });
        applied.push(`Placed "${id}"`);
        break;
      }
      case "update_object": {
        const target = findObject(op.id ?? op.objectId);
        if (!target || !op.patch) {
          skipped.push(`update_object: no object "${op.id ?? op.objectId}" or nothing to change`);
          break;
        }
        const p = op.patch;
        if (p.name) target.name = p.name.slice(0, 80);
        if (p.position) target.position = p.position as [number, number, number];
        if (p.rotationY !== undefined) target.rotation = [target.rotation[0]!, p.rotationY, target.rotation[2]!];
        if (p.scale !== undefined) target.scale = Math.min(100, Math.max(0.01, p.scale));
        if (p.visible !== undefined) target.visible = p.visible;
        const material = { ...(target.material ?? {}) };
        let touched = false;
        for (const key of ["tint", "tintStrength", "roughness", "metallic", "emissive", "emissiveStrength"] as const) {
          if (p[key] !== undefined) {
            (material as Record<string, unknown>)[key] = p[key];
            touched = true;
          }
        }
        if (p.tint && p.tintStrength === undefined && material.tintStrength === undefined) material.tintStrength = 0.6;
        if (p.emissive && p.emissiveStrength === undefined && material.emissiveStrength === undefined) material.emissiveStrength = 2;
        if (touched) target.material = material;
        applied.push(`Updated "${target.name}"`);
        break;
      }
      case "remove_object": {
        const target = findObject(op.id ?? op.objectId);
        if (!target) {
          skipped.push(`remove_object: no object "${op.id ?? op.objectId}"`);
          break;
        }
        spec.objects = spec.objects.filter((x) => x.id !== target.id);
        dropTracks((t) => t.type !== "light" && t.objectId === target.id);
        for (const cam of spec.cameras) if (cam.attach.objectId === target.id) cam.attach = { mode: "world", objectId: null };
        applied.push(`Removed "${target.name}"`);
        break;
      }
      case "set_move": {
        const target = findObject(op.objectId ?? op.id);
        if (!target || !op.move) {
          skipped.push(`set_move: no object "${op.objectId ?? op.id}" or no path`);
          break;
        }
        const move = op.move;
        dropTracks((t) => t.type === "transform" && t.objectId === target.id);
        spec.tracks.push({
          id: trackId(`${target.id}_move`),
          type: "transform",
          objectId: target.id,
          smooth: move.smooth,
          orientToPath: move.orientToPath,
          keyframes: move.keyframes.map((k) => ({
            t: k.t,
            position: k.position as [number, number, number],
            ...(k.rotationY !== undefined && !move.orientToPath ? { rotation: [0, k.rotationY, 0] as [number, number, number] } : {}),
            ...(k.scale !== undefined ? { scale: Math.min(100, Math.max(0.01, k.scale)) } : {}),
            easing: k.easing,
          })),
        });
        applied.push(`Changed how "${target.name}" moves`);
        break;
      }
      case "clear_move": {
        const target = findObject(op.objectId ?? op.id);
        if (!target) {
          skipped.push(`clear_move: no object "${op.objectId ?? op.id}"`);
          break;
        }
        dropTracks((t) => t.type === "transform" && t.objectId === target.id);
        applied.push(`"${target.name}" now stays in place`);
        break;
      }
      case "set_clips": {
        const target = findObject(op.objectId ?? op.id);
        if (!target || !op.clips) {
          skipped.push(`set_clips: no object "${op.objectId ?? op.id}" or no clips`);
          break;
        }
        dropTracks((t) => t.type === "action" && t.objectId === target.id);
        if (op.clips.length) {
          spec.tracks.push({
            id: trackId(`${target.id}_action`),
            type: "action",
            objectId: target.id,
            clips: op.clips.map((c) => ({ start: c.start, end: c.end, action: toId(c.action, "walk"), speed: c.speed, loop: c.loop })),
          });
        }
        applied.push(`Changed the animation clips on "${target.name}"`);
        break;
      }
      case "set_procedural": {
        const target = findObject(op.objectId ?? op.id);
        if (!target || !op.motions) {
          skipped.push(`set_procedural: no object "${op.objectId ?? op.id}" or no motions`);
          break;
        }
        dropTracks((t) => t.type === "procedural" && t.objectId === target.id);
        if (op.motions.length) {
          spec.tracks.push({ id: trackId(`${target.id}_motion`), type: "procedural", objectId: target.id, motions: op.motions });
        }
        applied.push(`Changed the motion of "${target.name}"`);
        break;
      }
    }
  }
  return { spec, newAssets, applied, skipped };
}
