import { z } from "zod";

/**
 * Subscription plans.
 *
 * Every plan has the full creative toolset (Simple Mode, Advanced Mode, the 3D
 * editor, the timeline, cameras, lights, AI Director). Plans differ ONLY in
 * quotas, output limits, the Meshy model used for generation, and render
 * priority. Nothing in this file may gate an editing feature.
 *
 * The values here are defaults. Operators override them at deploy time with the
 * KIVO_PLAN_OVERRIDES variable (JSON, same shape, partial) — see resolvePlans().
 */

export const PLAN_IDS = ["free", "pro", "ultra", "studio"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const RESOLUTIONS = ["480p", "720p", "1080p", "4k"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

/** Short-side pixel count for each resolution tier. */
export const RESOLUTION_SHORT_SIDE: Record<Resolution, number> = {
  "480p": 480,
  "720p": 720,
  "1080p": 1080,
  "4k": 2160,
};

export const ASPECTS = ["16:9", "9:16", "1:1", "4:3", "21:9"] as const;
export type Aspect = (typeof ASPECTS)[number];

/** Geometry models the Meshy Text to 3D API accepts for `ai_model` (standard model type). */
export const MESHY_MODELS = ["meshy-6-lite", "meshy-6", "meshy-7", "meshy-7.1"] as const;
export type MeshyModel = (typeof MESHY_MODELS)[number];

export const PlanLimitsSchema = z.object({
  id: z.enum(PLAN_IDS),
  name: z.string(),
  /** Monthly price in US cents. Billing itself is handled by Clerk; this is display + sanity only. */
  priceCents: z.number().int().min(0),
  videosPerMonth: z.number().int().min(0),
  maxDurationSec: z.number().min(1).max(600),
  maxResolution: z.enum(RESOLUTIONS),
  maxFps: z.number().int().min(12).max(120),
  concurrentJobs: z.number().int().min(1).max(64),
  watermark: z.boolean(),
  /** Higher renders first. */
  renderPriority: z.number().int().min(0).max(100),
  renderPriorityLabel: z.string(),
  /** Meshy geometry model used for this plan's generations. */
  meshyModel: z.enum(MESHY_MODELS),
  /** Faces to remesh generated models to. Keeps rigging (<= 380k tris) and the browser editor healthy. */
  targetPolycount: z.number().int().min(1000).max(300000),
  texturePbr: z.boolean(),
  /** Unique Meshy-generated models allowed in one scene. */
  maxAssetsPerScene: z.number().int().min(1).max(40),
  /** Text-to-motion clips Gemini may request per generation (10 Meshy credits each). */
  maxCustomMotions: z.number().int().min(0).max(10),
  /** Cost ceilings, in Meshy credits. */
  meshyCreditsPerJob: z.number().int().min(1),
  meshyCreditsPerDay: z.number().int().min(1),
  /** Wall-clock ceiling for one render, in minutes. */
  maxRenderMinutes: z.number().int().min(1),
});
export type PlanLimits = z.infer<typeof PlanLimitsSchema>;

export const DEFAULT_PLANS: Record<PlanId, PlanLimits> = {
  free: {
    id: "free",
    name: "Free",
    priceCents: 0,
    videosPerMonth: 3,
    maxDurationSec: 5,
    maxResolution: "480p",
    maxFps: 24,
    concurrentJobs: 1,
    watermark: true,
    renderPriority: 0,
    renderPriorityLabel: "Standard",
    meshyModel: "meshy-6-lite",
    targetPolycount: 20000,
    texturePbr: false,
    maxAssetsPerScene: 4,
    maxCustomMotions: 0,
    meshyCreditsPerJob: 120,
    meshyCreditsPerDay: 240,
    maxRenderMinutes: 20,
  },
  pro: {
    id: "pro",
    name: "Pro",
    priceCents: 900,
    videosPerMonth: 30,
    maxDurationSec: 20,
    maxResolution: "720p",
    maxFps: 30,
    concurrentJobs: 2,
    watermark: false,
    renderPriority: 10,
    renderPriorityLabel: "High",
    meshyModel: "meshy-6",
    targetPolycount: 40000,
    texturePbr: true,
    maxAssetsPerScene: 6,
    maxCustomMotions: 1,
    meshyCreditsPerJob: 300,
    meshyCreditsPerDay: 900,
    maxRenderMinutes: 45,
  },
  ultra: {
    id: "ultra",
    name: "Ultra",
    priceCents: 2500,
    videosPerMonth: 100,
    maxDurationSec: 60,
    maxResolution: "1080p",
    maxFps: 60,
    concurrentJobs: 4,
    watermark: false,
    renderPriority: 20,
    renderPriorityLabel: "Higher",
    meshyModel: "meshy-7",
    targetPolycount: 80000,
    texturePbr: true,
    maxAssetsPerScene: 8,
    maxCustomMotions: 2,
    meshyCreditsPerJob: 420,
    meshyCreditsPerDay: 2000,
    maxRenderMinutes: 120,
  },
  studio: {
    id: "studio",
    name: "Studio",
    priceCents: 6900,
    videosPerMonth: 300,
    maxDurationSec: 180,
    maxResolution: "4k",
    maxFps: 60,
    concurrentJobs: 8,
    watermark: false,
    renderPriority: 30,
    renderPriorityLabel: "Highest",
    meshyModel: "meshy-7.1",
    targetPolycount: 120000,
    texturePbr: true,
    maxAssetsPerScene: 12,
    maxCustomMotions: 4,
    meshyCreditsPerJob: 640,
    meshyCreditsPerDay: 4000,
    maxRenderMinutes: 360,
  },
};

/**
 * `meshy-7` is deprecated by Meshy and retires on 2026-12-31 (it keeps working
 * until then). When Meshy rejects a model as retired we fall forward to its
 * documented replacement instead of failing the user's job.
 */
export const MESHY_MODEL_SUCCESSOR: Partial<Record<MeshyModel, MeshyModel>> = {
  "meshy-7": "meshy-7.1",
};

/** Clerk Billing plan slug -> Kivo plan. `free_user` is Clerk's built-in default plan slug. */
export const DEFAULT_CLERK_PLAN_SLUGS: Record<string, PlanId> = {
  free_user: "free",
  free: "free",
  pro: "pro",
  ultra: "ultra",
  studio: "studio",
};

const OverridesSchema = z.partialRecord(z.enum(PLAN_IDS), PlanLimitsSchema.partial().omit({ id: true }));
export type PlanOverrides = z.infer<typeof OverridesSchema>;

/**
 * Merge operator overrides into the defaults. Invalid overrides throw: a typo in
 * a limit must never silently widen what a plan can do.
 */
export function resolvePlans(overridesJson?: string | null): Record<PlanId, PlanLimits> {
  if (!overridesJson || !overridesJson.trim()) return DEFAULT_PLANS;
  let raw: unknown;
  try {
    raw = JSON.parse(overridesJson);
  } catch {
    throw new Error("KIVO_PLAN_OVERRIDES is not valid JSON");
  }
  const overrides = OverridesSchema.parse(raw);
  const out = {} as Record<PlanId, PlanLimits>;
  for (const id of PLAN_IDS) {
    out[id] = PlanLimitsSchema.parse({ ...DEFAULT_PLANS[id], ...(overrides[id] ?? {}), id });
  }
  return out;
}

export function planRank(id: PlanId): number {
  return PLAN_IDS.indexOf(id);
}

export function resolutionRank(r: Resolution): number {
  return RESOLUTIONS.indexOf(r);
}

function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r + 1;
}

/** Pixel dimensions for an aspect ratio at a resolution tier. Always even (required by yuv420p H.264). */
export function dimensionsFor(aspect: Aspect, resolution: Resolution): { width: number; height: number } {
  const short = RESOLUTION_SHORT_SIDE[resolution];
  const [a, b] = aspect.split(":").map(Number) as [number, number];
  if (a >= b) return { width: even((short * a) / b), height: even(short) };
  return { width: even(short), height: even((short * b) / a) };
}

export interface RenderRequest {
  duration: number;
  fps: number;
  aspect: Aspect;
  resolution: Resolution;
}

export interface ClampedRender extends RenderRequest {
  width: number;
  height: number;
  watermark: boolean;
  /** Human-readable notes about anything that was reduced to fit the plan. */
  adjustments: string[];
}

/**
 * Apply a plan's output limits to a render request. This is the single place
 * export limits are enforced — the editor never is.
 */
export function clampRenderToPlan(req: RenderRequest, plan: PlanLimits): ClampedRender {
  const adjustments: string[] = [];
  let { duration, fps, resolution } = req;
  if (duration > plan.maxDurationSec) {
    adjustments.push(`Duration limited to ${plan.maxDurationSec}s on the ${plan.name} plan (scene is ${trim(duration)}s).`);
    duration = plan.maxDurationSec;
  }
  if (fps > plan.maxFps) {
    adjustments.push(`Frame rate limited to ${plan.maxFps} fps on the ${plan.name} plan.`);
    fps = plan.maxFps;
  }
  if (resolutionRank(resolution) > resolutionRank(plan.maxResolution)) {
    adjustments.push(`Resolution limited to ${plan.maxResolution} on the ${plan.name} plan.`);
    resolution = plan.maxResolution;
  }
  duration = Math.max(1, duration);
  fps = Math.max(12, Math.round(fps));
  const { width, height } = dimensionsFor(req.aspect, resolution);
  return { duration, fps, aspect: req.aspect, resolution, width, height, watermark: plan.watermark, adjustments };
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Billing period key for usage accounting, e.g. "2026-11" (UTC calendar month). */
export function usagePeriod(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Meshy credit prices (docs.meshy.ai/api/pricing). Used for cost ceilings, never for user billing. */
export const MESHY_CREDITS = {
  preview: { "meshy-6-lite": 5, "meshy-6": 20, "meshy-7": 20, "meshy-7.1": 20 } as Record<MeshyModel, number>,
  refine: 10,
  /** Image to 3D with 2K textures: geometry and texture in one task. */
  imageTo3d: { "meshy-6-lite": 15, "meshy-6": 30, "meshy-7": 30, "meshy-7.1": 30 } as Record<MeshyModel, number>,
  rig: 5,
  animationAction: 3,
  textToMotionPrime: 10,
} as const;

/**
 * Reference images a user may attach to a project. Each usable image becomes one 3D model
 * (Meshy Image to 3D), so images count against the scene's model limit; one slot is always
 * kept for the ground.
 */
export const IMAGE_UPLOAD = {
  maxPerProject: 4,
  maxBytes: 4 * 1024 * 1024,
  minSide: 64,
  maxSide: 8192,
  types: ["image/jpeg", "image/png", "image/webp"] as const,
} as const;
export type ImageType = (typeof IMAGE_UPLOAD.types)[number];

export function maxImagesFor(plan: Pick<PlanLimits, "maxAssetsPerScene">): number {
  return Math.max(1, Math.min(IMAGE_UPLOAD.maxPerProject, plan.maxAssetsPerScene - 1));
}
