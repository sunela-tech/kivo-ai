import { SceneSampler, activeClip, type SceneObject, type SceneSpec, type Vec3 } from "@kivo/shared";
import { Grid, OrbitControls, TransformControls, useGLTF } from "@react-three/drei";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import type { Asset } from "../lib/api";
import { editObjectTransform, keyCameraFromView, useEditor, type Selection } from "./store";

/**
 * The editor viewport: a live preview of the scene at the playhead.
 *
 * It samples the scene with the same SceneSampler the render service ports, so
 * object motion, cameras and lights here match the Blender render. Models are
 * the real Meshy GLBs (normalised to the size the scene asks for, exactly as
 * Blender does) and rigged characters play their real Meshy clips.
 */

const DEG = Math.PI / 180;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");

// Live handles the frame loop drives directly (no React re-render per frame).
const groups = new Map<string, THREE.Group>();
const players = new Map<string, (clip: { action: string; time: number; loop: boolean } | null) => void>();
const drag = { active: false, id: null as string | null };

// ───────────── models ─────────────

/** Maximum relief kept on a terrain model, in metres (same rule as the render service). */
const terrainThickness = (widthM: number) => Math.max(0.12, Math.min(0.6, widthM * 0.004));

function normalise(root: THREE.Object3D, asset: { size: { meters: number; axis: string }; kind: string }, precise: boolean): { scale: [number, number, number]; offset: THREE.Vector3 } {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root, precise);
  const size = box.getSize(new THREE.Vector3());
  const extent = asset.size.axis === "height" ? size.y : asset.size.axis === "width" ? Math.max(size.x, size.z) : Math.max(size.x, size.y, size.z);
  const s = extent > 1e-6 ? asset.size.meters / extent : 1;
  const center = box.getCenter(new THREE.Vector3());
  let squash = 1;
  let base = box.min.y;
  if (asset.kind === "terrain") {
    // Generated ground has relief; press it flat enough to stand on and put its top at ground level.
    const limit = terrainThickness(asset.size.meters);
    if (size.y * s > limit) squash = limit / (size.y * s);
    base = box.max.y;
  }
  return { scale: [s, s * squash, s], offset: new THREE.Vector3(-center.x * s, -base * s * squash, -center.z * s) };
}

function applyMaterial(root: THREE.Object3D, override: SceneObject["material"]) {
  if (!override) return;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m) => {
      const mat = (m as THREE.MeshStandardMaterial).clone();
      if (override.tint) {
        const strength = override.tintStrength ?? 0.6;
        mat.color = new THREE.Color("#ffffff").lerp(new THREE.Color(override.tint), strength);
      }
      if (override.roughness !== undefined) {
        mat.roughness = override.roughness;
        mat.roughnessMap = null;
      }
      if (override.metallic !== undefined) {
        mat.metalness = override.metallic;
        mat.metalnessMap = null;
      }
      if (override.emissive) {
        mat.emissive = new THREE.Color(override.emissive);
        mat.emissiveIntensity = override.emissiveStrength ?? 2;
        mat.emissiveMap = null;
      }
      return mat;
    });
    mesh.material = Array.isArray(mesh.material) ? materials : materials[0]!;
  });
}

function shadows(root: THREE.Object3D, receiveOnly: boolean) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = !receiveOnly;
      mesh.receiveShadow = true;
      mesh.frustumCulled = !(mesh as THREE.SkinnedMesh).isSkinnedMesh;
    }
  });
}

function StaticModel({ object, asset, sceneAsset }: { object: SceneObject; asset: Asset; sceneAsset: SceneSpec["assets"][number] }) {
  const gltf = useGLTF(asset.modelUrl!);
  const { root, fit } = useMemo(() => {
    const root = gltf.scene.clone(true);
    applyMaterial(root, object.material);
    shadows(root, sceneAsset.kind === "terrain");
    return { root, fit: normalise(root, sceneAsset, false) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gltf, JSON.stringify(object.material), sceneAsset.size.meters, sceneAsset.size.axis, sceneAsset.kind]);
  return (
    <group position={fit.offset} scale={fit.scale}>
      <primitive object={root} />
    </group>
  );
}

function RiggedModel({ object, asset, sceneAsset, clipNames }: { object: SceneObject; asset: Asset; sceneAsset: SceneSpec["assets"][number]; clipNames: string[] }) {
  const base = useGLTF(asset.riggedUrl!);
  const files = useMemo(() => [...new Set(clipNames.map((n) => asset.clips?.[n]?.url).filter((u): u is string => !!u))], [clipNames, asset.clips]);
  const loaded = useGLTF(files.length ? files : [asset.riggedUrl!]);

  const { root, fit, mixer, actions } = useMemo(() => {
    const root = cloneSkinned(base.scene);
    applyMaterial(root, object.material);
    shadows(root, false);
    const fit = normalise(root, sceneAsset, true);
    const mixer = new THREE.AnimationMixer(root);
    const actions = new Map<string, THREE.AnimationAction>();
    const list = Array.isArray(loaded) ? loaded : [loaded];
    for (const name of clipNames) {
      const entry = asset.clips?.[name];
      const file = entry?.url ? list[files.indexOf(entry.url)] : undefined;
      if (!file || file.animations.length === 0) continue;
      const wanted = entry?.animation ? slug(entry.animation) : null;
      const clip = (wanted && file.animations.find((a) => slug(a.name) === wanted)) || (file.animations.length === 1 ? file.animations[0] : wanted ? file.animations.find((a) => slug(a.name).includes(wanted)) : undefined);
      if (!clip) continue;
      const action = mixer.clipAction(clip);
      action.play();
      action.setEffectiveWeight(0);
      actions.set(name, action);
    }
    return { root, fit, mixer, actions };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, loaded, clipNames.join("|"), JSON.stringify(object.material), sceneAsset.size.meters, sceneAsset.size.axis]);

  useEffect(() => {
    players.set(object.id, (clip) => {
      const target = clip ? actions.get(clip.action) : undefined;
      for (const action of actions.values()) action.setEffectiveWeight(action === target ? 1 : 0);
      if (target) {
        const length = target.getClip().duration || 1;
        target.time = clip!.loop ? clip!.time % length : Math.min(clip!.time, length - 1e-3);
      }
      mixer.update(0);
    });
    return () => {
      players.delete(object.id);
      mixer.stopAllAction();
    };
  }, [object.id, actions, mixer]);

  return (
    <group position={fit.offset} scale={fit.scale}>
      <primitive object={root} />
    </group>
  );
}

function LoadingMarker() {
  // Not a stand-in model: just a ring on the ground showing that a model is downloading.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
      <ringGeometry args={[0.35, 0.42, 32]} />
      <meshBasicMaterial color="#8b7cf6" transparent opacity={0.6} />
    </mesh>
  );
}

function ObjectNode({ object, spec, asset }: { object: SceneObject; spec: SceneSpec; asset: Asset | undefined }) {
  const ref = useRef<THREE.Group>(null);
  const select = useEditor((s) => s.select);
  const sceneAsset = spec.assets.find((a) => a.id === object.assetId);
  const clipNames = useMemo(() => {
    const names: string[] = [];
    for (const t of spec.tracks) if (t.type === "action" && t.objectId === object.id) for (const c of t.clips) if (!names.includes(c.action)) names.push(c.action);
    return names;
  }, [spec.tracks, object.id]);

  useLayoutEffect(() => {
    const group = ref.current;
    if (!group) return;
    groups.set(object.id, group);
    return () => {
      groups.delete(object.id);
    };
  }, [object.id]);

  if (!sceneAsset) return null;
  const ready = asset?.status === "ready" && !!asset.modelUrl;
  const rigged = ready && asset!.rigStatus === "rigged" && !!asset!.riggedUrl && clipNames.some((n) => asset!.clips?.[n]?.url);
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    select({ type: "object", id: object.id });
  };
  return (
    <group ref={ref} onClick={onClick} visible={object.visible}>
      {ready ? (
        <Suspense fallback={<LoadingMarker />}>
          {rigged ? <RiggedModel object={object} asset={asset!} sceneAsset={sceneAsset} clipNames={clipNames} /> : <StaticModel object={object} asset={asset!} sceneAsset={sceneAsset} />}
        </Suspense>
      ) : (
        <LoadingMarker />
      )}
    </group>
  );
}

// ───────────── world ─────────────

function Sky({ world }: { world: SceneSpec["world"] }) {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: { top: { value: new THREE.Color() }, horizon: { value: new THREE.Color() }, ground: { value: new THREE.Color() } },
        vertexShader: "varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader:
          "uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir; void main() { float h = normalize(vDir).y; vec3 c = h < 0.0 ? ground : mix(horizon, top, clamp(h, 0.0, 1.0)); gl_FragColor = vec4(c, 1.0); \n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n }",
      }),
    [],
  );
  useEffect(() => {
    material.uniforms.top!.value.set(world.skyTop);
    material.uniforms.horizon!.value.set(world.skyHorizon);
    material.uniforms.ground!.value.set(world.groundColor);
  }, [material, world.skyTop, world.skyHorizon, world.groundColor]);
  return (
    <>
      <mesh material={material} renderOrder={-1} frustumCulled={false}>
        <sphereGeometry args={[9000, 32, 16]} />
      </mesh>
      <hemisphereLight args={[world.skyTop, world.groundColor, world.ambient * 1.6]} />
    </>
  );
}

const lightRefs = new Map<string, THREE.Light>();

function LightNode({ light, free }: { light: SceneSpec["lights"][number]; free: boolean }) {
  const select = useEditor((s) => s.select);
  const selected = useEditor((s) => s.selection?.type === "light" && s.selection.id === light.id);
  const target = useMemo(() => new THREE.Object3D(), []);
  const ref = useRef<THREE.Light>(null);
  useLayoutEffect(() => {
    target.position.set(light.target[0]!, light.target[1]!, light.target[2]!);
    target.updateMatrixWorld();
    const l = ref.current;
    if (l) lightRefs.set(light.id, l);
    return () => {
      lightRefs.delete(light.id);
    };
  }, [light, target]);
  const position = light.position as Vec3;
  const common = { ref: ref as never, position, color: light.color, castShadow: light.castShadow };
  return (
    <>
      <primitive object={target} />
      {light.type === "sun" && (
        <directionalLight {...common} target={target} intensity={light.intensity} shadow-mapSize={[2048, 2048]} shadow-bias={-0.0004} shadow-normalBias={0.04}>
          <orthographicCamera attach="shadow-camera" args={[-45, 45, 45, -45, 0.5, 400]} />
        </directionalLight>
      )}
      {light.type === "point" && <pointLight {...common} intensity={light.intensity / 10} decay={2} />}
      {light.type === "spot" && <spotLight {...common} target={target} intensity={light.intensity / 6} angle={(light.spotAngle * DEG) / 2} penumbra={0.3} decay={2} />}
      {light.type === "area" && <pointLight {...common} intensity={light.intensity / 12} decay={2} />}
      {free && (
        <mesh
          position={position}
          onClick={(e) => {
            e.stopPropagation();
            select({ type: "light", id: light.id });
          }}
        >
          <sphereGeometry args={[0.22, 12, 8]} />
          <meshBasicMaterial color={selected ? "#a78bfa" : light.color} wireframe />
        </mesh>
      )}
    </>
  );
}

const cameraGizmos = new Map<string, THREE.Group>();

function CameraGizmo({ id }: { id: string }) {
  const select = useEditor((s) => s.select);
  const selected = useEditor((s) => s.selection?.type === "camera" && s.selection.id === id);
  const ref = useRef<THREE.Group>(null);
  useLayoutEffect(() => {
    if (ref.current) cameraGizmos.set(id, ref.current);
    return () => {
      cameraGizmos.delete(id);
    };
  }, [id]);
  const color = selected ? "#a78bfa" : "#7f879f";
  return (
    <group
      ref={ref}
      onClick={(e) => {
        e.stopPropagation();
        select({ type: "camera", id });
      }}
    >
      <mesh>
        <boxGeometry args={[0.34, 0.24, 0.4]} />
        <meshBasicMaterial color={color} wireframe />
      </mesh>
      <mesh position={[0, 0, 0.36]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.2, 0.3, 4]} />
        <meshBasicMaterial color={color} wireframe />
      </mesh>
    </group>
  );
}

// ───────────── frame loop ─────────────

function heldClip(spec: SceneSpec, objectId: string, t: number): { action: string; time: number; loop: boolean } | null {
  let best: { start: number; end: number; action: string; speed: number } | null = null;
  for (const track of spec.tracks) {
    if (track.type !== "action" || track.objectId !== objectId) continue;
    for (const c of track.clips) if (c.end <= t && (!best || c.end > best.end)) best = c;
  }
  return best ? { action: best.action, time: (best.end - best.start) * best.speed, loop: false } : null;
}

function Driver({ spec, onFade }: { spec: SceneSpec; onFade: (opacity: number) => void }) {
  const sampler = useMemo(() => new SceneSampler(spec), [spec]);
  const { camera, gl } = useThree();
  const lastFade = useRef(-1);
  const lookAt = useMemo(() => new THREE.Vector3(), []);

  useEffect(() => {
    gl.toneMappingExposure = 2 ** spec.world.exposure;
  }, [gl, spec.world.exposure]);

  useFrame((_, delta) => {
    const state = useEditor.getState();
    let t = state.time;
    if (state.playing) {
      t += Math.min(delta, 0.1);
      if (t >= spec.output.duration) t = 0;
      useEditor.setState({ time: t });
    }

    for (const object of spec.objects) {
      const group = groups.get(object.id);
      if (!group) continue;
      if (!(drag.active && drag.id === object.id)) {
        const s = sampler.sampleObject(object.id, t);
        group.position.set(s.position[0], s.position[1], s.position[2]);
        group.rotation.set(s.rotation[0] * DEG, s.rotation[1] * DEG, s.rotation[2] * DEG, "XYZ");
        group.scale.setScalar(s.scale);
      }
      const player = players.get(object.id);
      if (player) player(activeClip(spec, object.id, t) ?? heldClip(spec, object.id, t));
    }

    for (const light of spec.lights) {
      const node = lightRefs.get(light.id);
      if (!node) continue;
      const s = sampler.sampleLight(light.id, t);
      const scale = light.type === "sun" ? 1 : light.type === "spot" ? 1 / 6 : light.type === "area" ? 1 / 12 : 1 / 10;
      node.intensity = s.intensity * scale;
      node.color.setRGB(s.color[0], s.color[1], s.color[2], THREE.SRGBColorSpace);
    }

    for (const cam of spec.cameras) {
      const gizmo = cameraGizmos.get(cam.id);
      if (!gizmo || (drag.active && drag.id === cam.id)) continue;
      const s = sampler.sampleCamera(cam.id, t);
      gizmo.position.set(s.position[0], s.position[1], s.position[2]);
      gizmo.lookAt(s.target[0], s.target[1], s.target[2]);
    }

    let fade = 0;
    if (state.viewCamera !== "free") {
      const id = state.viewCamera === "edit" ? sampler.shotAt(t)?.cameraId : state.viewCamera;
      if (id) {
        const s = sampler.sampleCamera(id, t);
        const persp = camera as THREE.PerspectiveCamera;
        persp.position.set(s.position[0], s.position[1], s.position[2]);
        lookAt.set(s.target[0], s.target[1], s.target[2]);
        persp.up.set(0, 1, 0);
        persp.lookAt(lookAt);
        if (Math.abs(persp.fov - s.fov) > 1e-3) {
          persp.fov = s.fov;
          persp.updateProjectionMatrix();
        }
      }
      if (state.viewCamera === "edit") {
        const tr = sampler.transitionAt(t);
        if (tr.kind === "fade") fade = 1 - tr.level;
      }
    }
    if (Math.abs(fade - lastFade.current) > 0.004) {
      lastFade.current = fade;
      onFade(fade);
    }
  });
  return null;
}

function FreeControls({ enabled }: { enabled: boolean }) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera } = useThree();
  const setFreeView = useEditor((s) => s.setFreeView);

  // Returning from a camera view restores the free camera where the user left it.
  useEffect(() => {
    if (!enabled) return;
    const view = useEditor.getState().freeView;
    const persp = camera as THREE.PerspectiveCamera;
    persp.position.set(...view.position);
    persp.fov = view.fov;
    persp.updateProjectionMatrix();
    controls.current?.target.set(...view.target);
    controls.current?.update();
  }, [enabled, camera]);

  return (
    <OrbitControls
      ref={controls}
      makeDefault
      enabled={enabled}
      enableDamping
      dampingFactor={0.12}
      maxPolarAngle={Math.PI * 0.495}
      minDistance={0.3}
      maxDistance={600}
      onEnd={() => {
        const c = controls.current;
        if (!c || !enabled) return;
        const persp = camera as THREE.PerspectiveCamera;
        setFreeView({ position: [persp.position.x, persp.position.y, persp.position.z], target: [c.target.x, c.target.y, c.target.z], fov: persp.fov });
      }}
    />
  );
}

function Gizmo({ spec, selection }: { spec: SceneSpec; selection: NonNullable<Selection> }) {
  const tool = useEditor((s) => s.tool);
  const update = useEditor((s) => s.update);
  const [target, setTarget] = useState<THREE.Object3D | null>(null);
  const before = useRef<{ sampled: Vec3; base: Vec3 } | null>(null);

  // The handle is found after the node mounts (models load asynchronously).
  useFrame(() => {
    const next = selection.type === "object" ? groups.get(selection.id) : selection.type === "camera" ? cameraGizmos.get(selection.id) : null;
    if ((next ?? null) !== target) setTarget(next ?? null);
  });
  if (!target || selection.type === "light") return null;
  const mode = selection.type === "camera" ? "translate" : tool;

  return (
    <TransformControls
      object={target}
      mode={mode}
      size={0.8}
      onMouseDown={() => {
        drag.active = true;
        drag.id = selection.id;
        const state = useEditor.getState();
        if (selection.type === "object") {
          // Remember the procedural offset at this moment so it is not baked into the keyframe.
          const withMotion = new SceneSampler(spec).sampleObject(selection.id, state.time).position;
          const pathOnly = new SceneSampler({ ...spec, tracks: spec.tracks.filter((t) => t.type !== "procedural") }).sampleObject(selection.id, state.time).position;
          before.current = { sampled: withMotion, base: pathOnly };
        }
      }}
      onMouseUp={() => {
        const state = useEditor.getState();
        const t = state.time;
        if (selection.type === "object") {
          const b = before.current;
          const offset: Vec3 = b ? [b.sampled[0] - b.base[0], b.sampled[1] - b.base[1], b.sampled[2] - b.base[2]] : [0, 0, 0];
          const position: Vec3 = [target.position.x - offset[0], target.position.y - offset[1], target.position.z - offset[2]];
          const e = new THREE.Euler().setFromQuaternion(target.quaternion, "XYZ");
          const patch =
            mode === "translate" ? { position } : mode === "rotate" ? { rotation: [e.x / DEG, e.y / DEG, e.z / DEG] as Vec3 } : { scale: (target.scale.x + target.scale.y + target.scale.z) / 3 };
          update((s) => editObjectTransform(s, selection.id, t, patch));
        } else if (selection.type === "camera") {
          const sample = new SceneSampler(spec).sampleCamera(selection.id, t);
          update((s) => keyCameraFromView(s, selection.id, t, { position: [target.position.x, target.position.y, target.position.z], target: sample.target, fov: sample.fov }));
        }
        drag.active = false;
        drag.id = null;
      }}
    />
  );
}

// ───────────── component ─────────────

export function Viewport() {
  const spec = useEditor((s) => s.spec);
  const assets = useEditor((s) => s.assets);
  const selection = useEditor((s) => s.selection);
  const viewCamera = useEditor((s) => s.viewCamera);
  const select = useEditor((s) => s.select);
  const [fade, setFade] = useState(0);
  if (!spec) return null;
  const free = viewCamera === "free";
  const [aw, ah] = spec.output.aspect.split(":").map(Number) as [number, number];

  return (
    <div className="relative flex size-full items-center justify-center overflow-hidden bg-night-950">
      <div className="relative max-h-full max-w-full" style={free ? { width: "100%", height: "100%" } : { aspectRatio: `${aw} / ${ah}`, height: "100%", maxWidth: "100%" }}>
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [8, 5, -10], fov: 45, near: 0.05, far: 20000 }}
          gl={{ antialias: true, toneMapping: THREE.AgXToneMapping }}
          onPointerMissed={() => select(null)}
        >
          <Sky world={spec.world} />
          {spec.lights.map((light) => (
            <LightNode key={light.id} light={light} free={free} />
          ))}
          {spec.objects.map((object) => (
            <ObjectNode key={object.id} object={object} spec={spec} asset={assets[object.assetId]} />
          ))}
          {free && spec.cameras.map((cam) => <CameraGizmo key={cam.id} id={cam.id} />)}
          {free && <Grid infiniteGrid position={[0, 0.005, 0]} cellSize={1} sectionSize={5} cellColor="#2a3350" sectionColor="#4a5788" fadeDistance={90} fadeStrength={1.5} cellThickness={0.6} sectionThickness={1} />}
          <FreeControls enabled={free} />
          {free && selection && <Gizmo spec={spec} selection={selection} />}
          <Driver spec={spec} onFade={setFade} />
        </Canvas>
        {fade > 0 && <div className="pointer-events-none absolute inset-0 bg-black" style={{ opacity: fade }} />}
        {!free && <div className="pointer-events-none absolute inset-0 rounded-sm ring-1 ring-violet-500/40" />}
      </div>
    </div>
  );
}
