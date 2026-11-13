import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLANS,
  PLAN_IDS,
  SceneSampler,
  SceneValidationError,
  STAGES,
  activeClip,
  animationToScene,
  applyDirectorOps,
  clampRenderToPlan,
  dimensionsFor,
  matchClipsToMotion,
  ease,
  normalizeScene,
  planToAssets,
  resolvePlans,
  toId,
  usagePeriod,
  type DirectorOperation,
} from "../src/index";
import { demoScene } from "./helpers";

describe("plans", () => {
  it("matches the published plan table", () => {
    const row = (id: (typeof PLAN_IDS)[number]) => {
      const p = DEFAULT_PLANS[id];
      return [p.priceCents, p.videosPerMonth, p.maxDurationSec, p.maxResolution, p.maxFps, p.concurrentJobs, p.watermark, p.meshyModel];
    };
    expect(row("free")).toEqual([0, 3, 5, "480p", 24, 1, true, "meshy-6-lite"]);
    expect(row("pro")).toEqual([900, 30, 20, "720p", 30, 2, false, "meshy-6"]);
    expect(row("ultra")).toEqual([2500, 100, 60, "1080p", 60, 4, false, "meshy-7"]);
    expect(row("studio")).toEqual([6900, 300, 180, "4k", 60, 8, false, "meshy-7.1"]);
  });

  it("orders render priority free < pro < ultra < studio", () => {
    const pr = PLAN_IDS.map((id) => DEFAULT_PLANS[id].renderPriority);
    expect([...pr].sort((a, b) => a - b)).toEqual(pr);
    expect(new Set(pr).size).toBe(4);
  });

  it("has no setting that could lock an editing feature behind a plan", () => {
    for (const id of PLAN_IDS) {
      for (const key of Object.keys(DEFAULT_PLANS[id])) {
        expect(key).not.toMatch(/advanced|editor|timeline|camera|director|simpleMode|advancedMode/i);
      }
    }
  });

  it("clamps exports to the plan and explains what changed", () => {
    const r = clampRenderToPlan({ duration: 42, fps: 60, aspect: "16:9", resolution: "4k" }, DEFAULT_PLANS.free);
    expect(r).toMatchObject({ duration: 5, fps: 24, resolution: "480p", width: 854, height: 480, watermark: true });
    expect(r.adjustments).toHaveLength(3);
    const s = clampRenderToPlan({ duration: 42, fps: 60, aspect: "16:9", resolution: "4k" }, DEFAULT_PLANS.studio);
    expect(s).toMatchObject({ duration: 42, fps: 60, width: 3840, height: 2160, watermark: false, adjustments: [] });
  });

  it("produces even dimensions for every aspect", () => {
    expect(dimensionsFor("9:16", "720p")).toEqual({ width: 720, height: 1280 });
    expect(dimensionsFor("1:1", "1080p")).toEqual({ width: 1080, height: 1080 });
    expect(dimensionsFor("21:9", "480p")).toEqual({ width: 1120, height: 480 });
    expect(dimensionsFor("4:3", "480p")).toEqual({ width: 640, height: 480 });
  });

  it("applies operator overrides and rejects bad ones", () => {
    const plans = resolvePlans(JSON.stringify({ free: { videosPerMonth: 5 } }));
    expect(plans.free.videosPerMonth).toBe(5);
    expect(plans.free.maxDurationSec).toBe(5);
    expect(plans.pro).toEqual(DEFAULT_PLANS.pro);
    expect(() => resolvePlans("{not json")).toThrow();
    expect(() => resolvePlans(JSON.stringify({ free: { maxFps: "fast" } }))).toThrow();
    expect(resolvePlans("")).toBe(DEFAULT_PLANS);
  });

  it("keys usage by UTC month", () => {
    expect(usagePeriod(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
    expect(usagePeriod(new Date("2026-12-01T00:00:00Z"))).toBe("2026-12");
  });
});

describe("stages", () => {
  it("lists the twelve pipeline stages in order", () => {
    expect(STAGES.map((s) => s.label)).toEqual([
      "Understanding prompt",
      "Planning 3D scene",
      "Generating models with Meshy",
      "Preparing textures",
      "Rigging characters",
      "Creating animations",
      "Adjusting cameras",
      "Preparing rendering",
      "Rendering video",
      "Encoding MP4",
      "Saving video",
      "Completed",
    ]);
  });
});

describe("sampler", () => {
  const spec = demoScene();
  const sampler = new SceneSampler(spec);

  it("eases", () => {
    expect(ease("linear", 0.25)).toBe(0.25);
    expect(ease("ease_in", 0.5)).toBe(0.25);
    expect(ease("ease_out", 0.5)).toBe(0.75);
    expect(ease("ease_in_out", 0.5)).toBe(0.5);
    expect(ease("hold", 0.99)).toBe(0);
  });

  it("moves objects along their path and faces travel direction", () => {
    const start = sampler.sampleObject("hero", 0);
    expect(start.position).toEqual([0, 0, -4]);
    const mid = sampler.sampleObject("hero", 1.5);
    expect(mid.position[2]).toBeGreaterThan(-4);
    expect(mid.position[2]).toBeLessThan(0);
    // Heading is between +Z (0°) and +X (90°) while moving forward and right.
    expect(mid.rotation[1]).toBeGreaterThan(0);
    expect(mid.rotation[1]).toBeLessThan(60);
    // Standing still at the end keeps the last heading instead of snapping to zero.
    const still = sampler.sampleObject("hero", 7.5);
    expect(still.position).toEqual([0, 0, 4]);
    expect(Number.isFinite(still.rotation[1])).toBe(true);
    expect(Math.abs(still.rotation[1])).toBeGreaterThan(1);
  });

  it("holds base transform for untracked objects", () => {
    expect(sampler.sampleObject("tower_a", 3)).toEqual({ position: [-12, 0, 10], rotation: [0, 20, 0], scale: 1 });
  });

  it("keeps spin rotation after the spin ends", () => {
    const after = sampler.sampleObject("scout", 4.5);
    const during = sampler.sampleObject("scout", 3);
    expect(after.rotation[1] - during.rotation[1]).toBeGreaterThan(0);
  });

  it("resolves follow and look_at cameras against the animated object", () => {
    const hero = sampler.sampleObject("hero", 5).position;
    const cam = sampler.sampleCamera("chase", 5);
    expect(cam.target[2]).toBeCloseTo(hero[2] + 1, 5);
    expect(cam.position[2]).toBeLessThan(hero[2]);
    const scout = sampler.sampleObject("scout", 7).position;
    const track = sampler.sampleCamera("track", 7);
    expect(track.position).toEqual([6, 2, 6]);
    expect(track.target).toEqual(scout);
  });

  it("animates lights", () => {
    expect(sampler.sampleLight("sun", 0).intensity).toBe(4);
    expect(sampler.sampleLight("sun", 8).intensity).toBe(1.5);
    expect(sampler.sampleLight("rim", 4).intensity).toBe(800);
  });

  it("reports shots and transitions", () => {
    expect(sampler.shotAt(0)?.id).toBe("shot_1");
    expect(sampler.shotAt(4)?.id).toBe("shot_2");
    expect(sampler.shotAt(8)?.id).toBe("shot_3");
    expect(sampler.transitionAt(0)).toEqual({ kind: "fade", level: 0 });
    expect(sampler.transitionAt(2)).toEqual({ kind: "none" });
    const dissolve = sampler.transitionAt(4);
    expect(dissolve).toMatchObject({ kind: "dissolve", fromCameraId: "wide", toCameraId: "chase" });
    expect((dissolve as { mix: number }).mix).toBeCloseTo(0.5, 5);
    const fade = sampler.transitionAt(6.5);
    expect(fade).toEqual({ kind: "fade", level: 0 });
  });

  it("finds the active skeletal clip", () => {
    expect(activeClip(spec, "hero", 2)).toMatchObject({ action: "walk", time: 2 });
    expect(activeClip(spec, "hero", 7)).toMatchObject({ action: "idle", time: 1 });
    expect(activeClip(spec, "scout", 2)).toBeNull();
  });

  it("matches the committed cross-language fixture", () => {
    const times = [0, 0.1, 0.5, 1, 1.5, 2.5, 3, 3.7, 4, 4.2, 5, 5.5, 6, 6.5, 7, 7.9, 8];
    const fixture = {
      spec,
      samples: times.map((t) => ({
        t,
        objects: Object.fromEntries(spec.objects.map((o) => [o.id, sampler.sampleObject(o.id, t)])),
        cameras: Object.fromEntries(spec.cameras.map((c) => [c.id, sampler.sampleCamera(c.id, t)])),
        lights: Object.fromEntries(spec.lights.map((l) => [l.id, sampler.sampleLight(l.id, t)])),
        shot: sampler.shotAt(t)?.id ?? null,
        transition: sampler.transitionAt(t),
      })),
    };
    const path = fileURLToPath(new URL("./fixtures/sampling.json", import.meta.url));
    const json = JSON.stringify(fixture, null, 1) + "\n";
    if (process.env.UPDATE_FIXTURES === "1" || !existsSync(path)) writeFileSync(path, json);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(json));
  });
});

describe("normalizeScene", () => {
  it("accepts a valid scene unchanged in substance", () => {
    const { spec, warnings } = normalizeScene(demoScene());
    expect(warnings).toEqual([]);
    expect(spec.objects).toHaveLength(5);
    expect(spec.shots.map((s) => [s.start, s.end])).toEqual([[0, 4], [4, 6.5], [6.5, 8]]);
  });

  it("rejects structurally invalid scenes", () => {
    expect(() => normalizeScene({ title: "x" })).toThrow(SceneValidationError);
    const bad = demoScene() as unknown as { objects: { position: unknown }[] };
    bad.objects[0]!.position = [0, "up", 0];
    expect(() => normalizeScene(bad)).toThrow(SceneValidationError);
  });

  it("removes dangling references and reports them", () => {
    const scene = demoScene();
    scene.objects.push({ id: "ghost", assetId: "missing", name: "Ghost", position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true });
    scene.tracks.push({ id: "ghost_move", type: "transform", objectId: "nobody", smooth: false, orientToPath: false, keyframes: [{ t: 0, position: [0, 0, 0], easing: "linear" }] });
    scene.shots[1]!.cameraId = "nope";
    const { spec, warnings } = normalizeScene(scene);
    expect(spec.objects.find((o) => o.id === "ghost")).toBeUndefined();
    expect(spec.tracks.find((t) => t.id === "ghost_move")).toBeUndefined();
    expect(spec.shots[1]!.cameraId).toBe("wide");
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("never fakes skeletal animation on unrigged or unavailable clips", () => {
    const scene = demoScene();
    scene.tracks.push({ id: "tower_dance", type: "action", objectId: "tower_a", clips: [{ start: 0, end: 2, action: "walk", speed: 1, loop: true }] });
    const { spec, warnings } = normalizeScene(scene, { availableClips: { robot: ["walk"] } });
    expect(spec.tracks.find((t) => t.id === "tower_dance")).toBeUndefined();
    const hero = spec.tracks.find((t) => t.type === "action" && t.objectId === "hero");
    expect(hero && hero.type === "action" && hero.clips.map((c) => c.action)).toEqual(["walk"]);
    expect(warnings.some((w) => w.includes("no skeleton"))).toBe(true);
    expect(warnings.some((w) => w.includes('"idle" is not available'))).toBe(true);
  });

  it("clamps duration and times at generation", () => {
    const { spec } = normalizeScene(demoScene(), { maxDurationSec: 5, maxFps: 24 });
    expect(spec.output.duration).toBe(5);
    expect(spec.shots.at(-1)!.end).toBe(5);
    for (const track of spec.tracks) {
      if (track.type === "transform") for (const k of track.keyframes) expect(k.t).toBeLessThanOrEqual(5);
    }
  });

  it("tiles shots with no gaps", () => {
    const scene = demoScene();
    scene.shots = [
      { id: "b", name: "", cameraId: "chase", start: 5, end: 6, transition: "cut", transitionDuration: 0 },
      { id: "a", name: "", cameraId: "wide", start: 1, end: 2, transition: "dissolve", transitionDuration: 1 },
    ];
    const { spec } = normalizeScene(scene);
    expect(spec.shots.map((s) => [s.id, s.start, s.end])).toEqual([["a", 0, 5], ["b", 5, 8]]);
    expect(spec.shots[0]!.transition).toBe("fade");
  });

  it("adds a camera and a light when none exist", () => {
    const scene = demoScene();
    scene.cameras = [];
    scene.lights = [];
    scene.shots = [];
    scene.tracks = scene.tracks.filter((t) => t.type !== "light");
    const { spec } = normalizeScene(scene);
    expect(spec.cameras).toHaveLength(1);
    expect(spec.lights).toHaveLength(1);
    expect(spec.shots).toHaveLength(1);
  });

  it("moves cameras out of models and above the ground", () => {
    const scene = demoScene();
    scene.cameras[0]!.keyframes[0]!.position = [-12, 5, 10]; // inside tower_a
    scene.cameras[0]!.keyframes[1]!.position = [5, -3, -9]; // under the ground
    const { spec, warnings } = normalizeScene(scene);
    const [k0, k1] = spec.cameras[0]!.keyframes;
    expect(Math.hypot(k0!.position[0]! + 12, k0!.position[2]! - 10)).toBeGreaterThan(10);
    expect(k1!.position[1]).toBeGreaterThanOrEqual(0.15);
    expect(warnings.some((w) => w.includes("camera keyframe"))).toBe(true);
  });
});

describe("matching clips to motion", () => {
  const moving = (seconds: number, metres: number, action = "walk") => {
    const scene = demoScene();
    scene.assets[0]!.size = { meters: 1.7, axis: "height" };
    scene.tracks = [
      { id: "hero_move", type: "transform", objectId: "hero", smooth: false, orientToPath: true, keyframes: [{ t: 0, position: [0, 0, 0], easing: "linear" }, { t: seconds, position: [0, 0, metres], easing: "linear" }] },
      { id: "hero_action", type: "action", objectId: "hero", clips: [{ start: 0, end: seconds, action, speed: 1, loop: true }] },
    ];
    return scene;
  };
  const clip = (scene: ReturnType<typeof demoScene>) => {
    const track = scene.tracks.find((t) => t.type === "action")!;
    return track.type === "action" ? track.clips[0]! : null;
  };

  it("keeps a natural walk as it is", () => {
    const scene = moving(4, 5.4); // 1.35 m/s for a 1.7 m character
    expect(matchClipsToMotion(scene, { robot: ["walk", "run", "idle"] })).toEqual([]);
    expect(clip(scene)).toMatchObject({ action: "walk", speed: 0.99 });
  });

  it("turns an impossibly fast walk into a run and says so", () => {
    const scene = moving(2, 8); // 4 m/s
    const notes = matchClipsToMotion(scene, { robot: ["walk", "run", "idle"] });
    expect(clip(scene)).toMatchObject({ action: "run", speed: 0.98 });
    expect(notes[0]).toMatch(/4\.0 m\/s.*became run/);
  });

  it("speeds up or slows down the stride when there is no better gait", () => {
    const fast = moving(2, 8);
    matchClipsToMotion(fast, { robot: ["walk"] });
    expect(clip(fast)).toMatchObject({ action: "walk", speed: 2.5 });
    const slow = moving(8, 4, "run"); // 0.5 m/s while "running"
    matchClipsToMotion(slow, { robot: ["walk", "run"] });
    expect(clip(slow)).toMatchObject({ action: "walk", speed: 0.5 });
  });

  it("replaces walking on the spot with an idle clip", () => {
    const scene = moving(3, 0);
    const notes = matchClipsToMotion(scene, { robot: ["walk", "run", "idle"] });
    expect(clip(scene)).toMatchObject({ action: "idle", speed: 1 });
    expect(notes[0]).toMatch(/stands still/);
  });

  it("leaves gestures and unrelated clips alone", () => {
    const scene = moving(2, 8, "big_wave_hello");
    expect(matchClipsToMotion(scene, { robot: ["walk", "run", "big_wave_hello"] })).toEqual([]);
    expect(clip(scene)).toMatchObject({ action: "big_wave_hello", speed: 1 });
  });
});

describe("gemini contracts", () => {
  const library = [
    { action_id: 0, name: "Idle" },
    { action_id: 41, name: "Wave Hello" },
  ];
  const plan = {
    world: { skyTop: "#112233", skyHorizon: "#445566", groundColor: "#333333", ambient: 0.8, exposure: 0 },
    assets: [
      { id: "Hero Robot!", name: "Hero", kind: "character" as const, prompt: "a small robot", rig: "humanoid" as const, sizeMeters: 1.2, sizeAxis: "height" as const, actionIds: [0, 41, 999], customMotionPrompt: "does a backflip", customMotionSeconds: 3.2 },
      { id: "car", name: "Car", kind: "vehicle" as const, prompt: "a rusty car", rig: "humanoid" as const, sizeMeters: 4, sizeAxis: "longest" as const, actionIds: [0], customMotionPrompt: "", customMotionSeconds: 0 },
      { id: "tree", name: "Tree", kind: "vegetation" as const, prompt: "a dead tree", rig: "none" as const, sizeMeters: 6, sizeAxis: "height" as const, actionIds: [], customMotionPrompt: "", customMotionSeconds: 0 },
    ],
    beats: [],
  };

  it("sanitizes ids", () => {
    expect(toId("Hero Robot!")).toBe("hero_robot");
    expect(toId("42 cats", "cat")).toBe("cat_42_cats");
    expect(toId("", "thing")).toBe("thing");
  });

  it("enforces asset and custom-motion limits and never rigs non-characters", () => {
    const { assets, notes } = planToAssets(plan, { maxAssetsPerScene: 2, maxCustomMotions: 0 }, "scifi", library);
    expect(assets.map((a) => a.id)).toEqual(["hero_robot", "car"]);
    expect(assets[0]!.actions).toEqual([{ name: "idle", actionId: 0 }, { name: "wave_hello", actionId: 41 }]);
    expect(assets[0]!.motions).toEqual([]);
    expect(assets[1]!.rig).toBe("none");
    expect(assets[1]!.actions).toEqual([]);
    expect(assets[0]!.prompt).toContain("science fiction");
    expect(notes.join(" ")).toMatch(/allows 2 per scene/);
    expect(notes.join(" ")).toMatch(/999 is not in Meshy's library/);
    expect(notes.join(" ")).toMatch(/custom-motion allowance/);
  });

  it("grants a custom motion when the plan allows it", () => {
    const { assets } = planToAssets(plan, { maxAssetsPerScene: 8, maxCustomMotions: 1 }, "cinematic", library);
    expect(assets[0]!.motions).toEqual([{ name: "custom_motion", prompt: "does a backflip", duration: 3 }]);
  });

  it("converts animation output into tracks", () => {
    const { objects, tracks } = animationToScene({
      objects: [{ id: "Hero", assetId: "hero_robot", name: "Hero", position: [0, 0, 0], rotationY: 90, scale: 1 }],
      moves: [{ objectId: "Hero", smooth: true, orientToPath: true, keyframes: [{ t: 0, position: [0, 0, 0], easing: "linear" }, { t: 4, position: [0, 0, 5], rotationY: 30, easing: "linear" }] }],
      clips: [{ objectId: "Hero", start: 0, end: 4, action: "Walk", speed: 1, loop: true }],
      procedural: [{ objectId: "Hero", start: 0, end: 1, kind: "bob", amplitude: 0.1, frequency: 2 }],
    });
    expect(objects[0]).toMatchObject({ id: "hero", rotation: [0, 90, 0] });
    expect(tracks.map((t) => t.type)).toEqual(["transform", "action", "procedural"]);
    const move = tracks[0]!;
    expect(move.type === "transform" && move.keyframes[1]!.rotation).toBeUndefined();
  });
});

describe("director operations", () => {
  const limits = { maxAssetsPerScene: 5 };

  it("changes only what was asked", () => {
    const before = demoScene();
    const ops: DirectorOperation[] = [
      { op: "set_world", world: { skyTop: "#331a33", ambient: 0.3 } },
      { op: "update_object", id: "tower_b", patch: { scale: 2 } },
    ];
    const { spec, newAssets, applied } = applyDirectorOps(before, ops, { limits });
    expect(newAssets).toEqual([]);
    expect(applied).toHaveLength(2);
    expect(spec.world.skyTop).toBe("#331a33");
    expect(spec.world.skyHorizon).toBe(before.world.skyHorizon);
    expect(spec.objects.find((o) => o.id === "tower_b")!.scale).toBe(2);
    expect(spec.assets).toEqual(before.assets);
    expect(spec.tracks).toEqual(before.tracks);
    expect(before.world.skyTop).toBe("#27324a"); // input not mutated
  });

  it("only add_asset creates Meshy work, and never for an existing model", () => {
    const { spec, newAssets, skipped } = applyDirectorOps(
      demoScene(),
      [
        { op: "add_asset", asset: { id: "lamp", name: "Street lamp", kind: "prop", prompt: "a bent street lamp", rig: "none", sizeMeters: 4, sizeAxis: "height" } },
        { op: "add_asset", asset: { id: "robot", name: "Robot again", kind: "character", prompt: "another robot", rig: "humanoid", sizeMeters: 1, sizeAxis: "height" } },
        { op: "add_object", object: { id: "lamp_1", assetId: "lamp", position: [3, 0, 3] } },
        { op: "add_asset", asset: { id: "sixth", name: "Too many", kind: "prop", prompt: "a crate", rig: "none", sizeMeters: 1, sizeAxis: "height" } },
      ],
      { limits },
    );
    expect(newAssets.map((a) => a.id)).toEqual(["lamp"]);
    expect(spec.assets).toHaveLength(5);
    expect(spec.objects.some((o) => o.id === "lamp_1")).toBe(true);
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatch(/never regenerated/);
    expect(skipped[1]).toMatch(/allows 5 distinct models/);
  });

  it("replaces a single object's motion and leaves others alone", () => {
    const before = demoScene();
    const { spec } = applyDirectorOps(
      before,
      [
        { op: "set_move", objectId: "hero", move: { smooth: false, orientToPath: true, keyframes: [{ t: 0, position: [0, 0, -4], easing: "linear" }, { t: 8, position: [0, 0, 0], easing: "linear" }] } },
        { op: "set_clips", objectId: "hero", clips: [{ start: 0, end: 8, action: "walk", speed: 0.6, loop: true }] },
      ],
      { limits },
    );
    const moves = spec.tracks.filter((t) => t.type === "transform" && t.objectId === "hero");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.type === "transform" && moves[0]!.keyframes).toHaveLength(2);
    const clips = spec.tracks.find((t) => t.type === "action" && t.objectId === "hero");
    expect(clips && clips.type === "action" && clips.clips[0]!.speed).toBe(0.6);
    expect(spec.tracks.find((t) => t.id === "scout_move")).toEqual(before.tracks.find((t) => t.id === "scout_move"));
    expect(() => normalizeScene(spec)).not.toThrow();
  });

  it("removing an object cleans up its tracks and camera attachments", () => {
    const { spec } = applyDirectorOps(demoScene(), [{ op: "remove_object", id: "hero" }], { limits });
    expect(spec.tracks.some((t) => t.type !== "light" && t.objectId === "hero")).toBe(false);
    expect(spec.cameras.find((c) => c.id === "chase")!.attach).toEqual({ mode: "world", objectId: null });
  });

  it("skips operations on things that do not exist instead of guessing", () => {
    const { applied, skipped } = applyDirectorOps(
      demoScene(),
      [{ op: "update_object", id: "nobody", patch: { scale: 2 } }, { op: "remove_camera", id: "nope" }, { op: "set_clips", objectId: "ghost", clips: [] }],
      { limits },
    );
    expect(applied).toEqual([]);
    expect(skipped).toHaveLength(3);
  });
});
