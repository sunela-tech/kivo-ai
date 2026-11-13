import { z } from "zod";
import { ASPECTS } from "./plans";

/**
 * SceneSpec — the single validated description of a Kivo production.
 *
 * Gemini writes it (through constrained JSON output), the editor edits it, and
 * the Blender service renders it from trusted templates. Nothing in it is code:
 * it is plain data, validated here and again (structurally) by the renderer.
 *
 * Conventions: right-handed, Y-up, metres, degrees, seconds. Characters face +Z
 * at zero rotation (the glTF forward axis Meshy uses). The ground is y = 0.
 */

export const SCENE_VERSION = 1;

export const IdSchema = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/, "ids are lowercase snake_case");
export const Vec3Schema = z.array(z.number().finite()).length(3);
export type Vec3 = [number, number, number];
export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb");

export const EASINGS = ["linear", "ease_in", "ease_out", "ease_in_out", "hold"] as const;
export const EasingSchema = z.enum(EASINGS);
export type Easing = (typeof EASINGS)[number];

export const ASSET_KINDS = [
  "character",
  "creature",
  "vehicle",
  "building",
  "prop",
  "furniture",
  "vegetation",
  "terrain",
] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * How an asset moves.
 * - humanoid: Meshy auto-rigging (bipeds with clear limbs only) + skeletal clips.
 * - none: no skeleton. Animated as a rigid object with keyframes and procedural motion in Blender.
 */
export const RIG_MODES = ["humanoid", "none"] as const;
export type RigMode = (typeof RIG_MODES)[number];

export const SIZE_AXES = ["height", "longest", "width"] as const;

export const AssetActionSchema = z.object({
  /** Clip name used by action tracks. */
  name: IdSchema,
  /** Meshy animation library action_id. */
  actionId: z.number().int().min(0).max(100000),
});

export const AssetMotionSchema = z.object({
  name: IdSchema,
  /** Meshy Text to Motion prompt (<= 400 chars). */
  prompt: z.string().min(3).max(400),
  /** 2–10 s in 0.5 s steps. */
  duration: z.number().min(2).max(10).multipleOf(0.5),
});

export const SceneAssetSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  kind: z.enum(ASSET_KINDS),
  /** Meshy Text to 3D prompt: one single object, <= 800 chars. */
  prompt: z.string().min(3).max(800),
  texturePrompt: z.string().max(800).optional(),
  rig: z.enum(RIG_MODES).default("none"),
  size: z.object({
    meters: z.number().min(0.02).max(2000),
    axis: z.enum(SIZE_AXES).default("height"),
  }),
  actions: z.array(AssetActionSchema).max(10).default([]),
  motions: z.array(AssetMotionSchema).max(4).default([]),
});
export type SceneAsset = z.infer<typeof SceneAssetSchema>;

export const MaterialOverrideSchema = z.object({
  tint: ColorSchema.optional(),
  tintStrength: z.number().min(0).max(1).optional(),
  roughness: z.number().min(0).max(1).optional(),
  metallic: z.number().min(0).max(1).optional(),
  emissive: ColorSchema.optional(),
  emissiveStrength: z.number().min(0).max(50).optional(),
});
export type MaterialOverride = z.infer<typeof MaterialOverrideSchema>;

export const SceneObjectSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  name: z.string().min(1).max(80),
  position: Vec3Schema,
  /** Euler XYZ, degrees. */
  rotation: Vec3Schema.default([0, 0, 0]),
  /** Uniform multiplier on top of the asset's normalized size. */
  scale: z.number().min(0.01).max(100).default(1),
  visible: z.boolean().default(true),
  material: MaterialOverrideSchema.optional(),
});
export type SceneObject = z.infer<typeof SceneObjectSchema>;

export const TransformKeyframeSchema = z.object({
  t: z.number().min(0),
  position: Vec3Schema.optional(),
  rotation: Vec3Schema.optional(),
  scale: z.number().min(0.01).max(100).optional(),
  easing: EasingSchema.default("linear"),
});
export type TransformKeyframe = z.infer<typeof TransformKeyframeSchema>;

export const PROCEDURAL_KINDS = ["hover", "bob", "hop", "sway", "spin", "wobble", "shake", "pulse"] as const;
export type ProceduralKind = (typeof PROCEDURAL_KINDS)[number];

export const TransformTrackSchema = z.object({
  id: IdSchema,
  type: z.literal("transform"),
  objectId: IdSchema,
  /** Smooth (Catmull-Rom) position path instead of straight segments. */
  smooth: z.boolean().default(false),
  /** Turn the object to face its direction of travel. */
  orientToPath: z.boolean().default(false),
  keyframes: z.array(TransformKeyframeSchema).min(1).max(400),
});

export const ActionClipSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  /** "walk" / "run" (from Meshy rigging) or a name from the asset's actions / motions. */
  action: IdSchema,
  speed: z.number().min(0.1).max(4).default(1),
  loop: z.boolean().default(true),
});
export type ActionClip = z.infer<typeof ActionClipSchema>;

export const ActionTrackSchema = z.object({
  id: IdSchema,
  type: z.literal("action"),
  objectId: IdSchema,
  clips: z.array(ActionClipSchema).max(60),
});

export const ProceduralMotionSchema = z.object({
  start: z.number().min(0),
  end: z.number().min(0),
  kind: z.enum(PROCEDURAL_KINDS),
  /** Metres for hover/bob/hop, degrees for sway/wobble, fraction for pulse/shake. */
  amplitude: z.number().min(0).max(1000),
  /** Cycles per second (spin: revolutions per second). */
  frequency: z.number().min(0).max(30),
});
export type ProceduralMotion = z.infer<typeof ProceduralMotionSchema>;

export const ProceduralTrackSchema = z.object({
  id: IdSchema,
  type: z.literal("procedural"),
  objectId: IdSchema,
  motions: z.array(ProceduralMotionSchema).max(40),
});

export const LightKeyframeSchema = z.object({
  t: z.number().min(0),
  intensity: z.number().min(0).max(1e6).optional(),
  color: ColorSchema.optional(),
  easing: EasingSchema.default("linear"),
});

export const LightTrackSchema = z.object({
  id: IdSchema,
  type: z.literal("light"),
  lightId: IdSchema,
  keyframes: z.array(LightKeyframeSchema).min(1).max(200),
});

export const TrackSchema = z.discriminatedUnion("type", [
  TransformTrackSchema,
  ActionTrackSchema,
  ProceduralTrackSchema,
  LightTrackSchema,
]);
export type Track = z.infer<typeof TrackSchema>;
export type TransformTrack = z.infer<typeof TransformTrackSchema>;
export type ActionTrack = z.infer<typeof ActionTrackSchema>;
export type ProceduralTrack = z.infer<typeof ProceduralTrackSchema>;
export type LightTrack = z.infer<typeof LightTrackSchema>;

export const LIGHT_TYPES = ["sun", "point", "spot", "area"] as const;
export const LightSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  type: z.enum(LIGHT_TYPES),
  color: ColorSchema.default("#ffffff"),
  /** Sun: strength (≈ 1–10). Point / spot / area: watts (≈ 100–5000). */
  intensity: z.number().min(0).max(1e6),
  position: Vec3Schema,
  /** Point the light aims at (ignored for point lights). */
  target: Vec3Schema.default([0, 0, 0]),
  /** Full cone angle in degrees (spot only). */
  spotAngle: z.number().min(1).max(179).default(45),
  castShadow: z.boolean().default(true),
});
export type Light = z.infer<typeof LightSchema>;

export const CameraKeyframeSchema = z.object({
  t: z.number().min(0),
  position: Vec3Schema,
  target: Vec3Schema,
  /** Vertical field of view, degrees. */
  fov: z.number().min(8).max(120).default(40),
  easing: EasingSchema.default("ease_in_out"),
});
export type CameraKeyframe = z.infer<typeof CameraKeyframeSchema>;

/**
 * - world: keyframe position and target are world coordinates.
 * - look_at: position is world; target is an offset from the attached object's animated position.
 * - follow: position and target are both offsets from the attached object's animated position.
 */
export const ATTACH_MODES = ["world", "look_at", "follow"] as const;

export const CameraSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(80),
  attach: z
    .object({
      mode: z.enum(ATTACH_MODES),
      objectId: IdSchema.nullable(),
    })
    .default({ mode: "world", objectId: null }),
  smooth: z.boolean().default(true),
  keyframes: z.array(CameraKeyframeSchema).min(1).max(200),
});
export type Camera = z.infer<typeof CameraSchema>;

export const TRANSITIONS = ["cut", "fade", "dissolve"] as const;
export const ShotSchema = z.object({
  id: IdSchema,
  name: z.string().max(80).default(""),
  cameraId: IdSchema,
  start: z.number().min(0),
  end: z.number().min(0),
  /** Transition INTO this shot. The first shot's transition fades in from black when "fade". */
  transition: z.enum(TRANSITIONS).default("cut"),
  transitionDuration: z.number().min(0).max(3).default(0),
});
export type Shot = z.infer<typeof ShotSchema>;

export const WorldSchema = z.object({
  skyTop: ColorSchema.default("#5b8fd6"),
  skyHorizon: ColorSchema.default("#cfe3f5"),
  groundColor: ColorSchema.default("#4a4a48"),
  /** Strength of sky lighting (0 = none, 1 = daylight). */
  ambient: z.number().min(0).max(5).default(1),
  /** Exposure compensation in stops. */
  exposure: z.number().min(-4).max(4).default(0),
});
export type World = z.infer<typeof WorldSchema>;

export const OutputSchema = z.object({
  duration: z.number().min(1).max(600),
  fps: z.number().int().min(12).max(120),
  aspect: z.enum(ASPECTS),
});

export const SceneSpecSchema = z.object({
  version: z.literal(SCENE_VERSION).default(SCENE_VERSION),
  title: z.string().min(1).max(120),
  logline: z.string().max(400).default(""),
  style: z.string().max(60).default("cinematic"),
  output: OutputSchema,
  world: WorldSchema.default(WorldSchema.parse({})),
  assets: z.array(SceneAssetSchema).max(40),
  objects: z.array(SceneObjectSchema).max(300),
  lights: z.array(LightSchema).max(24),
  cameras: z.array(CameraSchema).max(24),
  shots: z.array(ShotSchema).max(80),
  tracks: z.array(TrackSchema).max(600),
});
export type SceneSpec = z.infer<typeof SceneSpecSchema>;

/** Visual styles offered in Simple Mode. `promptHint` is appended to Meshy prompts and given to Gemini. */
export const VISUAL_STYLES = [
  { id: "cinematic", label: "Cinematic", promptHint: "realistic, detailed, cinematic film look" },
  { id: "stylized", label: "Stylized", promptHint: "stylized 3D animation film look, clean shapes, appealing proportions" },
  { id: "toon", label: "Cartoon", promptHint: "cartoon style, bold simple shapes, bright saturated colors" },
  { id: "lowpoly", label: "Low poly", promptHint: "low poly style, flat shaded facets, minimal detail" },
  { id: "clay", label: "Clay", promptHint: "handmade clay stop-motion style, soft matte surfaces" },
  { id: "scifi", label: "Sci-fi", promptHint: "science fiction style, hard surface detail, emissive accents" },
  { id: "fantasy", label: "Fantasy", promptHint: "fantasy storybook style, ornate, painterly textures" },
] as const;
export type VisualStyleId = (typeof VISUAL_STYLES)[number]["id"];
export const VISUAL_STYLE_IDS = VISUAL_STYLES.map((s) => s.id) as readonly string[];

export function styleHint(id: string): string {
  return VISUAL_STYLES.find((s) => s.id === id)?.promptHint ?? VISUAL_STYLES[0].promptHint;
}

/** Clip names that come free with every successful Meshy rig. */
export const BUILTIN_CLIPS = ["walk", "run"] as const;

/** Scenes are plain JSON data, so a JSON round-trip is an exact deep copy. */
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
