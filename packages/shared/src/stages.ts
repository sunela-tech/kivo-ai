/**
 * The generation pipeline, in order. The API reports the stage a job is
 * actually in; `progress` is only ever set where the underlying system reports
 * a real number (Meshy task progress, rendered frame counts).
 */
export const STAGES = [
  { id: "understanding_prompt", label: "Understanding prompt", detail: "Gemini reads your idea" },
  { id: "planning_scene", label: "Planning 3D scene", detail: "Gemini plans models, world and story beats" },
  { id: "generating_models", label: "Generating models with Meshy", detail: "Meshy builds each 3D model" },
  { id: "preparing_textures", label: "Preparing textures", detail: "Meshy paints the models" },
  { id: "rigging_characters", label: "Rigging characters", detail: "Skeletons and motion clips" },
  { id: "creating_animations", label: "Creating animations", detail: "Gemini choreographs movement" },
  { id: "adjusting_cameras", label: "Adjusting cameras", detail: "Shots, lighting and framing" },
  { id: "preparing_rendering", label: "Preparing rendering", detail: "Scene handed to Blender" },
  { id: "rendering_video", label: "Rendering video", detail: "Blender renders every frame" },
  { id: "encoding_mp4", label: "Encoding MP4", detail: "Frames encoded to H.264" },
  { id: "saving_video", label: "Saving video", detail: "Stored and verified" },
  { id: "completed", label: "Completed", detail: "Your video is ready" },
] as const;

export type StageId = (typeof STAGES)[number]["id"];
export const STAGE_IDS = STAGES.map((s) => s.id) as readonly StageId[];

export function stageIndex(id: StageId): number {
  return STAGE_IDS.indexOf(id);
}

export const JOB_STATUSES = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_KINDS = ["generate", "render", "director"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isTerminal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "canceled";
}

/**
 * Error codes surfaced to users. Each has a message that says what happened and
 * what to do about it.
 */
export const ERROR_MESSAGES: Record<string, string> = {
  invalid_prompt: "Kivo couldn't turn that prompt into a scene. Describe who or what is in the scene and what happens.",
  prompt_rejected: "That prompt can't be generated. Try describing a different scene.",
  quota_exceeded: "You've used all of this month's videos on your plan. Upgrade or wait for the monthly reset.",
  concurrency_exceeded: "You already have the maximum number of jobs running for your plan. Wait for one to finish or cancel it.",
  cost_ceiling: "This scene needs more 3D generation than your plan allows in one job. Simplify the prompt or use fewer distinct objects.",
  daily_ceiling: "Today's 3D generation budget is used up. Try again tomorrow.",
  gemini_unavailable: "The AI director (Gemini) is temporarily unavailable. Your quota was not charged — try again in a few minutes.",
  gemini_invalid_output: "The AI director returned a scene that failed validation. Your quota was not charged — try again or rephrase.",
  meshy_unavailable: "Meshy (3D model generation) is temporarily unavailable. Your quota was not charged — try again shortly.",
  meshy_failed: "Meshy couldn't generate one of the 3D models. Your quota was not charged — try simplifying that object.",
  meshy_credits: "3D generation is paused because the service's Meshy credits are exhausted. Your quota was not charged.",
  storage_unavailable: "Video generation isn't switched on yet: this Kivo deployment has no file storage, so models and videos can't be saved. Nothing was charged.",
  storage_full: "Kivo's file storage is full, so a new video could not be saved. Delete videos or projects you no longer need and try again. Nothing was charged.",
  storage_error: "Kivo couldn't store a file. Your quota was not charged — try again.",
  render_failed: "Blender failed while rendering. Your quota was not charged — try again; if it repeats, simplify the scene.",
  render_timeout: "Rendering took longer than your plan's time limit. Your quota was not charged — shorten the video or lower the resolution.",
  render_unavailable: "No render worker picked up the job in time. Your quota was not charged — try again shortly.",
  invalid_scene: "The scene has invalid animation data. Open it in Advanced Mode and fix the highlighted items.",
  video_invalid: "The rendered file was not a playable MP4, so it was discarded. Your quota was not charged — try again.",
  canceled: "You canceled this job. Your quota was not charged.",
  interrupted: "The job was interrupted and could not be resumed. Your quota was not charged — try again.",
  internal: "Something went wrong on our side. Your quota was not charged — try again.",
};

export function errorMessage(code: string | null | undefined): string {
  return (code && ERROR_MESSAGES[code]) || ERROR_MESSAGES.internal!;
}
