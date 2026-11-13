import { z } from "zod";
import type { Aspect, PlanLimits } from "./plans";
import {
  ASSET_KINDS,
  ATTACH_MODES,
  BUILTIN_CLIPS,
  EASINGS,
  LIGHT_TYPES,
  PROCEDURAL_KINDS,
  SCENE_VERSION,
  TRANSITIONS,
  styleHint,
  type AssetKind,
  type Camera,
  type Light,
  type SceneAsset,
  type SceneObject,
  type Shot,
  type Track,
  type World,
} from "./scene";

/**
 * Contracts between Kivo and Gemini.
 *
 * Each Gemini call is constrained with a JSON Schema (`responseJsonSchema`) and
 * the reply is parsed again here with zod. The JSON Schemas use only keywords
 * Gemini's structured output supports (type, properties, required, enum, items,
 * minItems/maxItems, minimum/maximum, description). Tighter rules — id format,
 * references, time ranges, plan limits — are enforced in code afterwards.
 */

type J = Record<string, unknown>;

/*
 * Gemini compiles the response schema into a grammar and rejects schemas that are
 * "too complex to serve". Numeric bounds, array length limits and long text are
 * what blow it up, so these builders deliberately emit none of them: vectors are
 * {x, y, z} objects (not length-3 arrays), numbers are unbounded, arrays are
 * unbounded. Every bound is enforced after parsing instead (zod + normalizeScene).
 */
const str = (description?: string): J => ({ type: "string", ...(description ? { description } : {}) });
const num = (description?: string, _minimum?: number, _maximum?: number): J => ({ type: "number", ...(description ? { description } : {}) });
const int = (description?: string, _minimum?: number, _maximum?: number): J => ({ type: "integer", ...(description ? { description } : {}) });
const bool = (description?: string): J => ({ type: "boolean", ...(description ? { description } : {}) });
const vec3 = (description?: string): J => ({
  type: "object",
  properties: { x: { type: "number" }, y: { type: "number" }, z: { type: "number" } },
  required: ["x", "y", "z"],
  ...(description ? { description } : {}),
});
const enumOf = (values: readonly string[], description?: string): J => ({ type: "string", enum: [...values], ...(description ? { description } : {}) });
const obj = (properties: Record<string, J>, required: string[]): J => ({ type: "object", properties, required });
const arr = (items: J, _maxItems?: number, description?: string): J => ({ type: "array", items, ...(description ? { description } : {}) });

/** A vector from the model: {x, y, z} (what the schema asks for) or [x, y, z]. Always parsed to [x, y, z]. */
export const zVec3 = z.union([
  z.array(z.coerce.number().finite()).length(3),
  z.object({ x: z.coerce.number().finite(), y: z.coerce.number().finite(), z: z.coerce.number().finite() }).transform((v) => [v.x, v.y, v.z]),
]);
const zColor = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().regex(/^#[0-9a-fA-F]{6}$/));

/** Make any string a valid scene id. */
export function toId(value: string, fallback = "item"): string {
  let s = (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!s) s = fallback;
  if (!/^[a-z]/.test(s)) s = `${fallback.replace(/[^a-z]/g, "") || "x"}_${s}`;
  return s.slice(0, 48).replace(/_+$/g, "") || fallback;
}

// ───────────────────────── 1. Understanding the prompt ─────────────────────────

export const InterpretationJsonSchema = obj(
  {
    accepted: bool("false only if the prompt cannot become a 3D animated scene (empty, nonsense, or disallowed content)"),
    rejectionReason: str("If not accepted: one short sentence for the user. Otherwise empty."),
    title: str("Short title for the video, at most 6 words"),
    logline: str("One sentence describing what happens"),
    subjects: arr(str(), 8, "Characters and key objects, most important first"),
    setting: str("Where it takes place"),
    mood: str("Mood and lighting, e.g. 'lonely, dusk, cold blue light'"),
    action: str("What moves, and how, in order"),
  },
  ["accepted", "rejectionReason", "title", "logline", "subjects", "setting", "mood", "action"],
);

export const InterpretationSchema = z.object({
  accepted: z.boolean(),
  rejectionReason: z.string().default(""),
  title: z.string().default(""),
  logline: z.string().default(""),
  subjects: z.array(z.string()).default([]),
  setting: z.string().default(""),
  mood: z.string().default(""),
  action: z.string().default(""),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;

// ───────────────────────── 2. Planning the scene ─────────────────────────

export const PlanJsonSchema = obj(
  {
    world: obj(
      {
        skyTop: str("#rrggbb sky colour overhead"),
        skyHorizon: str("#rrggbb sky colour at the horizon"),
        groundColor: str("#rrggbb colour of the far ground beyond the terrain model"),
        ambient: num("Sky light strength: 0.05 night, 0.4 dusk, 1 daylight", 0, 3),
        exposure: num("Exposure compensation in stops", -2, 2),
      },
      ["skyTop", "skyHorizon", "groundColor", "ambient", "exposure"],
    ),
    assets: arr(
      obj(
        {
          id: str("lowercase snake_case, unique"),
          name: str("Display name"),
          kind: enumOf(ASSET_KINDS),
          prompt: str("Meshy text-to-3D prompt: ONE single object, concrete shape, materials and colours. No scene, no background, no multiple objects."),
          rig: enumOf(["humanoid", "none"], "humanoid ONLY for two-legged characters with clearly separate arms and legs"),
          sizeMeters: num("Real-world size in metres along sizeAxis", 0.02, 1000),
          sizeAxis: enumOf(["height", "longest", "width"], "height for upright things, width for terrain, longest for vehicles"),
          actionIds: arr(int("action_id from the animation library"), 6, "Library clips this character needs besides walk and run (always free). Empty for rig none."),
          customMotionPrompt: str("Only if no library clip fits: describe one custom body motion. Otherwise empty."),
          customMotionSeconds: num("Length of the custom motion, 2 to 10", 0, 10),
        },
        ["id", "name", "kind", "prompt", "rig", "sizeMeters", "sizeAxis", "actionIds", "customMotionPrompt", "customMotionSeconds"],
      ),
    ),
    beats: arr(
      obj({ start: num("seconds"), end: num("seconds"), description: str("What happens and how the camera should see it") }, ["start", "end", "description"]),
      12,
    ),
  },
  ["world", "assets", "beats"],
);

export const PlanSchema = z.object({
  world: z.object({
    skyTop: zColor,
    skyHorizon: zColor,
    groundColor: zColor,
    ambient: z.coerce.number().min(0).max(5),
    exposure: z.coerce.number().min(-4).max(4),
  }),
  assets: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.enum(ASSET_KINDS),
        prompt: z.string().min(3),
        rig: z.enum(["humanoid", "none"]),
        sizeMeters: z.coerce.number().positive(),
        sizeAxis: z.enum(["height", "longest", "width"]),
        actionIds: z.array(z.coerce.number().int()).default([]),
        customMotionPrompt: z.string().default(""),
        customMotionSeconds: z.coerce.number().default(0),
      }),
    )
    .min(1),
  beats: z.array(z.object({ start: z.coerce.number(), end: z.coerce.number(), description: z.string() })).default([]),
});
export type ScenePlan = z.infer<typeof PlanSchema>;

export interface LibraryAction {
  action_id: number;
  name: string;
  category?: string;
  sub_category?: string;
}

/** Kinds that can never be rigged by Meshy, whatever Gemini asked for. */
const NEVER_RIGGED: AssetKind[] = ["vehicle", "building", "prop", "furniture", "vegetation", "terrain"];

/**
 * Turn Gemini's plan into scene assets, enforcing the plan's limits.
 * Returns the assets plus notes about anything that was reduced.
 */
export function planToAssets(
  plan: ScenePlan,
  limits: Pick<PlanLimits, "maxAssetsPerScene" | "maxCustomMotions">,
  style: string,
  library: LibraryAction[],
): { assets: SceneAsset[]; world: World; notes: string[] } {
  const notes: string[] = [];
  const libraryById = new Map(library.map((a) => [a.action_id, a]));
  const used = new Set<string>();
  let motionsLeft = limits.maxCustomMotions;
  const hint = styleHint(style);

  let planned = plan.assets;
  if (planned.length > limits.maxAssetsPerScene) {
    notes.push(`The plan asked for ${planned.length} models; this plan allows ${limits.maxAssetsPerScene} per scene.`);
    planned = planned.slice(0, limits.maxAssetsPerScene);
  }

  const assets: SceneAsset[] = planned.map((a, index) => {
    let id = toId(a.id || a.name, `asset_${index + 1}`);
    while (used.has(id)) id = `${id.slice(0, 44)}_${index + 1}`;
    used.add(id);
    const rig = a.rig === "humanoid" && !NEVER_RIGGED.includes(a.kind) ? "humanoid" : "none";
    const clipNames = new Set<string>(BUILTIN_CLIPS);
    const actions: SceneAsset["actions"] = [];
    if (rig === "humanoid") {
      for (const actionId of a.actionIds.slice(0, 6)) {
        const entry = libraryById.get(actionId);
        if (!entry) {
          notes.push(`"${id}": animation ${actionId} is not in Meshy's library and was skipped.`);
          continue;
        }
        const name = toId(entry.name, `action_${actionId}`);
        if (clipNames.has(name)) continue;
        clipNames.add(name);
        actions.push({ name, actionId });
      }
    }
    const motions: SceneAsset["motions"] = [];
    const motionPrompt = a.customMotionPrompt.trim();
    if (rig === "humanoid" && motionPrompt.length >= 3) {
      if (motionsLeft > 0) {
        motionsLeft--;
        const duration = Math.min(10, Math.max(2, Math.round((a.customMotionSeconds || 4) * 2) / 2));
        motions.push({ name: "custom_motion", prompt: motionPrompt.slice(0, 400), duration });
      } else {
        notes.push(`"${id}": a custom motion was requested but this plan's custom-motion allowance is used up.`);
      }
    }
    const prompt = `${a.prompt.trim().replace(/\s+/g, " ")}. ${hint}`.slice(0, 800);
    return {
      id,
      name: a.name.trim().slice(0, 80) || id,
      kind: a.kind,
      prompt,
      rig,
      size: { meters: Math.min(2000, Math.max(0.02, a.sizeMeters)), axis: a.sizeAxis },
      actions,
      motions,
    };
  });

  return { assets, world: plan.world, notes };
}

// ───────────────────────── 3. Creating animations ─────────────────────────

export const AnimationJsonSchema = obj(
  {
    objects: arr(
      obj(
        {
          id: str("lowercase snake_case, unique"),
          assetId: str("One of the given asset ids"),
          name: str(),
          position: vec3("Position in metres at time 0. y = 0 is the ground."),
          rotationY: num("Heading in degrees. 0 faces +Z, 90 faces +X."),
          scale: num("Multiplier on the asset's normal size, usually 1", 0.05, 20),
        },
        ["id", "assetId", "name", "position", "rotationY", "scale"],
      ),
    ),
    moves: arr(
      obj(
        {
          objectId: str(),
          smooth: bool("Curved path through the keyframes"),
          orientToPath: bool("Turn to face the direction of travel"),
          keyframes: arr(
            obj(
              {
                t: num("seconds"),
                position: vec3(),
                rotationY: num("Optional heading in degrees"),
                scale: num("Optional scale"),
                easing: enumOf(EASINGS),
              },
              ["t", "position", "easing"],
            ),
            40,
          ),
        },
        ["objectId", "smooth", "orientToPath", "keyframes"],
      ),
    ),
    clips: arr(
      obj(
        {
          objectId: str("A rigged character"),
          start: num("seconds"),
          end: num("seconds"),
          action: str("One of that character's available clip names"),
          speed: num("Playback speed, 1 = normal", 0.2, 3),
          loop: bool(),
        },
        ["objectId", "start", "end", "action", "speed", "loop"],
      ),
    ),
    procedural: arr(
      obj(
        {
          objectId: str(),
          start: num("seconds"),
          end: num("seconds"),
          kind: enumOf(PROCEDURAL_KINDS),
          amplitude: num("metres (hover, bob, hop, shake), degrees (sway, wobble), fraction (pulse)", 0, 90),
          frequency: num("cycles per second", 0, 10),
        },
        ["objectId", "start", "end", "kind", "amplitude", "frequency"],
      ),
    ),
  },
  ["objects", "moves", "clips", "procedural"],
);

export const AnimationSchema = z.object({
  objects: z
    .array(
      z.object({
        id: z.string(),
        assetId: z.string(),
        name: z.string().default(""),
        position: zVec3,
        rotationY: z.coerce.number().default(0),
        scale: z.coerce.number().positive().default(1),
      }),
    )
    .min(1),
  moves: z
    .array(
      z.object({
        objectId: z.string(),
        smooth: z.boolean().default(false),
        orientToPath: z.boolean().default(false),
        keyframes: z
          .array(
            z.object({
              t: z.coerce.number(),
              position: zVec3,
              rotationY: z.coerce.number().optional(),
              scale: z.coerce.number().positive().optional(),
              easing: z.enum(EASINGS).default("linear"),
            }),
          )
          .min(1),
      }),
    )
    .default([]),
  clips: z
    .array(
      z.object({
        objectId: z.string(),
        start: z.coerce.number(),
        end: z.coerce.number(),
        action: z.string(),
        speed: z.coerce.number().default(1),
        loop: z.boolean().default(true),
      }),
    )
    .default([]),
  procedural: z
    .array(
      z.object({
        objectId: z.string(),
        start: z.coerce.number(),
        end: z.coerce.number(),
        kind: z.enum(PROCEDURAL_KINDS),
        amplitude: z.coerce.number().min(0),
        frequency: z.coerce.number().min(0),
      }),
    )
    .default([]),
});
export type AnimationPlan = z.infer<typeof AnimationSchema>;

export function animationToScene(anim: AnimationPlan): { objects: SceneObject[]; tracks: Track[] } {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  const objects: SceneObject[] = anim.objects.map((o, i) => {
    let id = toId(o.id, `object_${i + 1}`);
    while (used.has(id)) id = `${id.slice(0, 44)}_${i + 1}`;
    used.add(id);
    ids.set(o.id, id);
    return {
      id,
      assetId: toId(o.assetId, "asset"),
      name: o.name.trim().slice(0, 80) || id,
      position: [o.position[0]!, Math.max(-50, o.position[1]!), o.position[2]!],
      rotation: [0, o.rotationY, 0],
      scale: Math.min(100, Math.max(0.01, o.scale)),
      visible: true,
    };
  });
  const ref = (raw: string) => ids.get(raw) ?? toId(raw, "object");
  const tracks: Track[] = [];
  const moved = new Set<string>();
  for (const m of anim.moves) {
    const objectId = ref(m.objectId);
    if (moved.has(objectId)) continue;
    moved.add(objectId);
    tracks.push({
      id: `${objectId}_move`.slice(0, 48),
      type: "transform",
      objectId,
      smooth: m.smooth,
      orientToPath: m.orientToPath,
      keyframes: m.keyframes.map((k) => ({
        t: Math.max(0, k.t),
        position: [k.position[0]!, k.position[1]!, k.position[2]!],
        ...(k.rotationY !== undefined && !m.orientToPath ? { rotation: [0, k.rotationY, 0] } : {}),
        ...(k.scale !== undefined ? { scale: Math.min(100, Math.max(0.01, k.scale)) } : {}),
        easing: k.easing,
      })),
    });
  }
  const clipsByObject = new Map<string, AnimationPlan["clips"]>();
  for (const c of anim.clips) {
    const objectId = ref(c.objectId);
    clipsByObject.set(objectId, [...(clipsByObject.get(objectId) ?? []), c]);
  }
  for (const [objectId, clips] of clipsByObject) {
    tracks.push({
      id: `${objectId}_action`.slice(0, 48),
      type: "action",
      objectId,
      clips: clips.map((c) => ({
        start: Math.max(0, c.start),
        end: Math.max(0, c.end),
        action: toId(c.action, "walk"),
        speed: Math.min(4, Math.max(0.1, c.speed)),
        loop: c.loop,
      })),
    });
  }
  const procByObject = new Map<string, AnimationPlan["procedural"]>();
  for (const p of anim.procedural) {
    const objectId = ref(p.objectId);
    procByObject.set(objectId, [...(procByObject.get(objectId) ?? []), p]);
  }
  for (const [objectId, motions] of procByObject) {
    tracks.push({
      id: `${objectId}_motion`.slice(0, 48),
      type: "procedural",
      objectId,
      motions: motions.map((p) => ({
        start: Math.max(0, p.start),
        end: Math.max(0, p.end),
        kind: p.kind,
        amplitude: Math.min(1000, p.amplitude),
        frequency: Math.min(30, p.frequency),
      })),
    });
  }
  return { objects, tracks };
}

// ───────────────────────── 4. Cameras, shots and lights ─────────────────────────

export const CinematographyJsonSchema = obj(
  {
    cameras: arr(
      obj(
        {
          id: str("lowercase snake_case, unique"),
          name: str(),
          attachMode: enumOf(ATTACH_MODES, "world: absolute coordinates. look_at: target is an offset from the object. follow: position AND target are offsets from the object."),
          attachObjectId: str("Object id for look_at / follow, else empty"),
          smooth: bool("Curved camera path"),
          keyframes: arr(
            obj(
              { t: num("seconds"), position: vec3(), target: vec3("Point the camera looks at"), fov: num("Vertical field of view in degrees", 12, 100), easing: enumOf(EASINGS) },
              ["t", "position", "target", "fov", "easing"],
            ),
            24,
          ),
        },
        ["id", "name", "attachMode", "attachObjectId", "smooth", "keyframes"],
      ),
      8,
    ),
    shots: arr(
      obj(
        {
          name: str(),
          cameraId: str(),
          start: num("seconds"),
          end: num("seconds"),
          transition: enumOf(TRANSITIONS, "Transition INTO this shot"),
          transitionDuration: num("seconds, 0 for cut", 0, 2),
        },
        ["name", "cameraId", "start", "end", "transition", "transitionDuration"],
      ),
      24,
    ),
    lights: arr(
      obj(
        {
          id: str(),
          name: str(),
          type: enumOf(LIGHT_TYPES),
          color: str("#rrggbb"),
          intensity: num("sun: 1-8. point/spot/area: watts, 200-5000", 0, 100000),
          position: vec3(),
          target: vec3("Point the light aims at"),
          castShadow: bool(),
        },
        ["id", "name", "type", "color", "intensity", "position", "target", "castShadow"],
      ),
      8,
    ),
    lightChanges: arr(
      obj({ lightId: str(), t: num("seconds"), intensity: num(undefined, 0, 100000), color: str("#rrggbb") }, ["lightId", "t", "intensity", "color"]),
      24,
      "Optional lighting changes over time. Include a keyframe at t=0 for any light that changes.",
    ),
  },
  ["cameras", "shots", "lights", "lightChanges"],
);

export const CinematographySchema = z.object({
  cameras: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(""),
        attachMode: z.enum(ATTACH_MODES).default("world"),
        attachObjectId: z.string().default(""),
        smooth: z.boolean().default(true),
        keyframes: z
          .array(
            z.object({
              t: z.coerce.number(),
              position: zVec3,
              target: zVec3,
              fov: z.coerce.number().default(40),
              easing: z.enum(EASINGS).default("ease_in_out"),
            }),
          )
          .min(1),
      }),
    )
    .min(1),
  shots: z
    .array(
      z.object({
        name: z.string().default(""),
        cameraId: z.string(),
        start: z.coerce.number(),
        end: z.coerce.number(),
        transition: z.enum(TRANSITIONS).default("cut"),
        transitionDuration: z.coerce.number().default(0),
      }),
    )
    .default([]),
  lights: z
    .array(
      z.object({
        id: z.string(),
        name: z.string().default(""),
        type: z.enum(LIGHT_TYPES),
        color: zColor.catch("#ffffff"),
        intensity: z.coerce.number().min(0),
        position: zVec3,
        target: zVec3.catch([0, 0, 0]),
        castShadow: z.boolean().default(true),
      }),
    )
    .default([]),
  lightChanges: z
    .array(z.object({ lightId: z.string(), t: z.coerce.number(), intensity: z.coerce.number().min(0), color: zColor.catch("#ffffff") }))
    .default([]),
});
export type Cinematography = z.infer<typeof CinematographySchema>;

export function cinematographyToScene(
  cine: Cinematography,
  objectIdMap: (raw: string) => string | null,
): { cameras: Camera[]; shots: Shot[]; lights: Light[]; tracks: Track[] } {
  const camIds = new Map<string, string>();
  const used = new Set<string>();
  const cameras: Camera[] = cine.cameras.map((c, i) => {
    let id = toId(c.id, `camera_${i + 1}`);
    while (used.has(id)) id = `${id.slice(0, 44)}_${i + 1}`;
    used.add(id);
    camIds.set(c.id, id);
    const attachObject = c.attachMode === "world" ? null : objectIdMap(c.attachObjectId);
    return {
      id,
      name: c.name.trim().slice(0, 80) || `Camera ${i + 1}`,
      attach: attachObject ? { mode: c.attachMode, objectId: attachObject } : { mode: "world", objectId: null },
      smooth: c.smooth,
      keyframes: c.keyframes.map((k) => ({
        t: Math.max(0, k.t),
        position: [k.position[0]!, k.position[1]!, k.position[2]!],
        target: [k.target[0]!, k.target[1]!, k.target[2]!],
        fov: Math.min(100, Math.max(12, k.fov)),
        easing: k.easing,
      })),
    };
  });
  const shots: Shot[] = cine.shots.map((s, i) => ({
    id: `shot_${i + 1}`,
    name: s.name.trim().slice(0, 80) || `Shot ${i + 1}`,
    cameraId: camIds.get(s.cameraId) ?? toId(s.cameraId, "camera"),
    start: Math.max(0, s.start),
    end: Math.max(0, s.end),
    transition: s.transition,
    transitionDuration: Math.min(3, Math.max(0, s.transitionDuration)),
  }));
  const lightIds = new Map<string, string>();
  const usedLights = new Set<string>();
  const lights: Light[] = cine.lights.map((l, i) => {
    let id = toId(l.id, `light_${i + 1}`);
    while (usedLights.has(id)) id = `${id.slice(0, 44)}_${i + 1}`;
    usedLights.add(id);
    lightIds.set(l.id, id);
    return {
      id,
      name: l.name.trim().slice(0, 80) || `Light ${i + 1}`,
      type: l.type,
      color: l.color,
      intensity: Math.min(1e6, l.intensity),
      position: [l.position[0]!, l.position[1]!, l.position[2]!],
      target: [l.target[0]!, l.target[1]!, l.target[2]!],
      spotAngle: 45,
      castShadow: l.castShadow,
    };
  });
  const byLight = new Map<string, Cinematography["lightChanges"]>();
  for (const change of cine.lightChanges) {
    const id = lightIds.get(change.lightId);
    if (!id) continue;
    byLight.set(id, [...(byLight.get(id) ?? []), change]);
  }
  const tracks: Track[] = [];
  for (const [lightId, changes] of byLight) {
    tracks.push({
      id: `${lightId}_light`.slice(0, 48),
      type: "light",
      lightId,
      keyframes: changes.map((c) => ({ t: Math.max(0, c.t), intensity: c.intensity, color: c.color, easing: "ease_in_out" as const })),
    });
  }
  return { cameras, shots, lights, tracks };
}

/** Assemble the raw scene from the validated parts. Run normalizeScene on the result. */
export function assembleScene(parts: {
  title: string;
  logline: string;
  style: string;
  output: { duration: number; fps: number; aspect: Aspect };
  world: World;
  assets: SceneAsset[];
  objects: SceneObject[];
  tracks: Track[];
  cameras: Camera[];
  shots: Shot[];
  lights: Light[];
}) {
  return {
    version: SCENE_VERSION,
    title: parts.title.trim().slice(0, 120) || "Untitled",
    logline: parts.logline.trim().slice(0, 400),
    style: parts.style,
    output: parts.output,
    world: parts.world,
    assets: parts.assets,
    objects: parts.objects,
    lights: parts.lights,
    cameras: parts.cameras,
    shots: parts.shots,
    tracks: parts.tracks,
  };
}
