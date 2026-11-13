import type { SceneSpec } from "../src/index";

/** A small but complete scene that exercises every track and camera mode. */
export function demoScene(): SceneSpec {
  return {
    version: 1,
    title: "Robot in the ruins",
    logline: "A small robot walks through an abandoned city.",
    style: "scifi",
    output: { duration: 8, fps: 24, aspect: "16:9" },
    world: { skyTop: "#27324a", skyHorizon: "#c98a5a", groundColor: "#3a3530", ambient: 0.6, exposure: 0 },
    assets: [
      { id: "robot", name: "Robot", kind: "character", prompt: "a cute small robot", rig: "humanoid", size: { meters: 1.2, axis: "height" }, actions: [{ name: "idle", actionId: 0 }], motions: [] },
      { id: "tower", name: "Tower", kind: "building", prompt: "a ruined tower", rig: "none", size: { meters: 30, axis: "height" }, actions: [], motions: [] },
      { id: "drone", name: "Drone", kind: "prop", prompt: "a hovering drone", rig: "none", size: { meters: 0.6, axis: "longest" }, actions: [], motions: [] },
      { id: "ground", name: "Ground", kind: "terrain", prompt: "cracked asphalt ground slab", rig: "none", size: { meters: 60, axis: "width" }, actions: [], motions: [] },
    ],
    objects: [
      { id: "hero", assetId: "robot", name: "Hero", position: [0, 0, -4], rotation: [0, 0, 0], scale: 1, visible: true },
      { id: "tower_a", assetId: "tower", name: "Tower A", position: [-12, 0, 10], rotation: [0, 20, 0], scale: 1, visible: true },
      { id: "tower_b", assetId: "tower", name: "Tower B", position: [26, 0, 28], rotation: [0, -35, 0], scale: 1.3, visible: true },
      { id: "scout", assetId: "drone", name: "Scout", position: [2, 2.5, 0], rotation: [0, 0, 0], scale: 1, visible: true },
      { id: "floor", assetId: "ground", name: "Floor", position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true },
    ],
    lights: [
      { id: "sun", name: "Sun", type: "sun", color: "#ffd9a8", intensity: 4, position: [10, 14, -6], target: [0, 0, 0], spotAngle: 45, castShadow: true },
      { id: "rim", name: "Rim", type: "point", color: "#6fa8ff", intensity: 800, position: [-4, 3, -6], target: [0, 0, 0], spotAngle: 45, castShadow: false },
    ],
    cameras: [
      {
        id: "wide",
        name: "Wide",
        attach: { mode: "world", objectId: null },
        smooth: true,
        keyframes: [
          { t: 0, position: [8, 3, -12], target: [0, 1, -2], fov: 45, easing: "ease_in_out" },
          { t: 4, position: [5, 2.5, -9], target: [0, 1, 0], fov: 40, easing: "ease_in_out" },
        ],
      },
      {
        id: "chase",
        name: "Chase",
        attach: { mode: "follow", objectId: "hero" },
        smooth: false,
        keyframes: [
          { t: 4, position: [-2, 1.4, -3.5], target: [0, 0.8, 1], fov: 38, easing: "linear" },
          { t: 8, position: [2, 1.2, -3], target: [0, 0.9, 1], fov: 32, easing: "ease_out" },
        ],
      },
      {
        id: "track",
        name: "Tracking",
        attach: { mode: "look_at", objectId: "scout" },
        smooth: false,
        keyframes: [{ t: 0, position: [6, 2, 6], target: [0, 0, 0], fov: 30, easing: "linear" }],
      },
    ],
    shots: [
      { id: "shot_1", name: "Establish", cameraId: "wide", start: 0, end: 4, transition: "fade", transitionDuration: 0.5 },
      { id: "shot_2", name: "Follow", cameraId: "chase", start: 4, end: 6.5, transition: "dissolve", transitionDuration: 0.6 },
      { id: "shot_3", name: "Drone", cameraId: "track", start: 6.5, end: 8, transition: "fade", transitionDuration: 0.4 },
    ],
    tracks: [
      {
        id: "hero_move",
        type: "transform",
        objectId: "hero",
        smooth: true,
        orientToPath: true,
        keyframes: [
          { t: 0, position: [0, 0, -4], easing: "linear" },
          { t: 3, position: [1.5, 0, 0], easing: "linear" },
          { t: 6, position: [0, 0, 4], easing: "ease_out" },
          { t: 8, position: [0, 0, 4], easing: "linear" },
        ],
      },
      {
        id: "hero_action",
        type: "action",
        objectId: "hero",
        clips: [
          { start: 0, end: 6, action: "walk", speed: 1, loop: true },
          { start: 6, end: 8, action: "idle", speed: 1, loop: true },
        ],
      },
      {
        id: "scout_move",
        type: "transform",
        objectId: "scout",
        smooth: false,
        orientToPath: false,
        keyframes: [
          { t: 0, position: [2, 2.5, 0], rotation: [0, 0, 0], scale: 1, easing: "linear" },
          { t: 5, position: [-3, 3, 5], rotation: [0, 180, 0], scale: 1.5, easing: "ease_in_out" },
        ],
      },
      {
        id: "scout_motion",
        type: "procedural",
        objectId: "scout",
        motions: [
          { start: 0, end: 8, kind: "hover", amplitude: 0.15, frequency: 0.8 },
          { start: 1, end: 3, kind: "wobble", amplitude: 6, frequency: 1.5 },
          { start: 2, end: 4, kind: "spin", amplitude: 0, frequency: 0.25 },
          { start: 5, end: 7, kind: "pulse", amplitude: 0.1, frequency: 2 },
        ],
      },
      {
        id: "tower_b_motion",
        type: "procedural",
        objectId: "tower_b",
        motions: [
          { start: 3, end: 5, kind: "shake", amplitude: 0.05, frequency: 6 },
          { start: 5, end: 6, kind: "hop", amplitude: 0.2, frequency: 2 },
          { start: 6, end: 7, kind: "bob", amplitude: 0.3, frequency: 1 },
          { start: 7, end: 8, kind: "sway", amplitude: 4, frequency: 1 },
        ],
      },
      {
        id: "sun_light",
        type: "light",
        lightId: "sun",
        keyframes: [
          { t: 0, intensity: 4, color: "#ffd9a8", easing: "linear" },
          { t: 8, intensity: 1.5, color: "#ff7a4a", easing: "ease_in" },
        ],
      },
    ],
  };
}
