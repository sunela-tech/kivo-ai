import { ASPECTS, EASINGS, PROCEDURAL_KINDS, SceneSampler, type Easing, type ProceduralKind, type SceneSpec } from "@kivo/shared";
import { Crosshair, Diamond, Plus, Trash2 } from "lucide-react";
import { Badge, IconButton, Notice } from "../components/ui";
import { rigLabel } from "../pages/Assets";
import { ColorInput, Field, Num, Section, Select, Toggle, Vec } from "./Panels";
import { addObjectKeyframe, atTime, editObjectTransform, keyCameraFromView, removeTrackIfEmpty, transformTrack, uniqueId, useEditor } from "./store";

const EASING_OPTIONS = EASINGS.map((e) => ({ value: e, label: { linear: "Linear", ease_in: "Ease in", ease_out: "Ease out", ease_in_out: "Ease in-out", hold: "Hold" }[e] }));
const mini = "size-6 rounded-md";

function AddButton({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button onClick={onClick} className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-line-2 py-1.5 text-[11px] text-ink-3 hover:border-violet-500/60 hover:text-ink">
      <Plus className="size-3" /> {children}
    </button>
  );
}

// ───────────── object ─────────────

function ObjectInspector({ spec, id }: { spec: SceneSpec; id: string }) {
  const time = useEditor((s) => s.time);
  const assets = useEditor((s) => s.assets);
  const { update, setTime } = useEditor.getState();
  const object = spec.objects.find((o) => o.id === id);
  if (!object) return null;
  const sceneAsset = spec.assets.find((a) => a.id === object.assetId);
  const file = assets[object.assetId];
  const track = transformTrack(spec, id);
  const sample = new SceneSampler({ ...spec, tracks: spec.tracks.filter((t) => t.type !== "procedural") }).sampleObject(id, time);
  const actionTrack = spec.tracks.find((t) => t.type === "action" && t.objectId === id);
  const motionTrack = spec.tracks.find((t) => t.type === "procedural" && t.objectId === id);
  const clipOptions = (file?.clipNames ?? []).map((c) => ({ value: c, label: c.replace(/_/g, " ") }));
  const rigged = file?.rigStatus === "rigged" && clipOptions.length > 0;
  const material = object.material ?? {};
  const setMaterial = (fields: Partial<NonNullable<typeof object.material>>) =>
    update((s) => {
      const o = s.objects.find((x) => x.id === id)!;
      o.material = { ...(o.material ?? {}), ...fields };
    });
  const onKey = !!track?.keyframes.some((k) => atTime(spec, k.t, time));

  return (
    <>
      <Section title="Object">
        <Field label="Name">
          <input value={object.name} onChange={(e) => update((s) => void (s.objects.find((x) => x.id === id)!.name = e.target.value.slice(0, 80) || object.name))} className="field-sm" aria-label="Object name" />
        </Field>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
          <span>
            Model: <span className="text-ink-2">{sceneAsset?.name ?? object.assetId}</span>
          </span>
          {file && (sceneAsset?.rig === "humanoid" || file.rigStatus === "rigged") && <Badge tone={rigLabel(file).tone}>{rigLabel(file).text}</Badge>}
        </div>
        {file?.rigNote && <p className="mt-1.5 text-[10px] leading-snug text-warn/90">{file.rigNote}</p>}
      </Section>

      <Section
        title="Transform"
        action={
          <span className="flex items-center gap-1 text-[10px] text-ink-4">
            {track ? (onKey ? "on a keyframe" : "editing adds a keyframe") : "resting pose"}
            <IconButton label="Add a movement keyframe at the playhead" className={mini} onClick={() => update((s) => addObjectKeyframe(s, id, time))}>
              <Diamond className="size-3" />
            </IconButton>
          </span>
        }
      >
        <Field label="Position" hint="metres">
          <Vec value={sample.position} onChange={(v) => update((s) => editObjectTransform(s, id, time, { position: v }))} />
        </Field>
        <Field label="Rotation" hint={track?.orientToPath ? "Y follows the path" : "degrees"}>
          <Vec value={sample.rotation} step={5} onChange={(v) => update((s) => editObjectTransform(s, id, time, { rotation: v }))} />
        </Field>
        <Field label="Scale" hint={sceneAsset ? `${(sceneAsset.size.meters * sample.scale).toFixed(2)} m ${sceneAsset.size.axis}` : undefined}>
          <Num value={sample.scale} step={0.05} min={0.01} max={100} onChange={(v) => update((s) => editObjectTransform(s, id, time, { scale: v }))} />
        </Field>
      </Section>

      <Section title="Movement">
        {!track ? (
          <p className="text-[11px] text-ink-4">This object stays in place. Add a keyframe to make it move.</p>
        ) : (
          <>
            <Toggle label="Curved path" checked={track.smooth} onChange={(v) => update((s) => void (transformTrack(s, id)!.smooth = v))} />
            <Toggle label="Face the direction of travel" checked={track.orientToPath} onChange={(v) => update((s) => void (transformTrack(s, id)!.orientToPath = v))} />
            <ul className="mt-2 space-y-1">
              {track.keyframes.map((k, i) => (
                <li key={i} className="flex items-center gap-1.5">
                  <button onClick={() => setTime(k.t)} className={`w-12 shrink-0 rounded px-1 py-1 text-left text-[11px] tabular-nums ${atTime(spec, k.t, time) ? "bg-violet-600/25 text-violet-200" : "text-ink-3 hover:text-ink"}`}>
                    {k.t.toFixed(2)}s
                  </button>
                  <Select
                    label="Easing into this keyframe"
                    value={k.easing}
                    options={EASING_OPTIONS}
                    onChange={(v) => update((s) => void (transformTrack(s, id)!.keyframes[i]!.easing = v as Easing))}
                  />
                  <IconButton
                    label="Delete keyframe"
                    className={mini}
                    onClick={() =>
                      update((s) => {
                        const t = transformTrack(s, id)!;
                        t.keyframes.splice(i, 1);
                        removeTrackIfEmpty(s, t.id);
                      })
                    }
                  >
                    <Trash2 className="size-3" />
                  </IconButton>
                </li>
              ))}
            </ul>
          </>
        )}
        <AddButton onClick={() => update((s) => addObjectKeyframe(s, id, time))}>Keyframe at playhead</AddButton>
      </Section>

      <Section title="Character animation">
        {!rigged ? (
          <p className="text-[11px] leading-relaxed text-ink-4">
            {sceneAsset?.rig === "humanoid" ? "Meshy could not rig this model, so it has no skeletal clips. Use movement and motion below." : "Only rigged humanoid characters have skeletal clips. This model moves as a rigid body — use movement and motion."}
          </p>
        ) : (
          <>
            <ul className="space-y-2">
              {(actionTrack?.type === "action" ? actionTrack.clips : []).map((c, i) => {
                const patch = (fields: Partial<typeof c>) =>
                  update((s) => {
                    const t = s.tracks.find((x) => x.id === actionTrack!.id);
                    if (t?.type === "action") Object.assign(t.clips[i]!, fields);
                  });
                return (
                  <li key={i} className="rounded-lg border border-line bg-night-850 p-2">
                    <div className="mb-1.5 flex items-center gap-1.5">
                      <Select label="Clip" value={c.action} options={clipOptions.some((o) => o.value === c.action) ? clipOptions : [...clipOptions, { value: c.action, label: `${c.action} (missing)` }]} onChange={(v) => patch({ action: v })} />
                      <IconButton
                        label="Remove clip"
                        className={mini}
                        onClick={() =>
                          update((s) => {
                            const t = s.tracks.find((x) => x.id === actionTrack!.id);
                            if (t?.type === "action") {
                              t.clips.splice(i, 1);
                              removeTrackIfEmpty(s, t.id);
                            }
                          })
                        }
                      >
                        <Trash2 className="size-3" />
                      </IconButton>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      <Num label="▸" value={c.start} step={0.1} min={0} onChange={(v) => patch({ start: v })} />
                      <Num label="◂" value={c.end} step={0.1} min={0} onChange={(v) => patch({ end: v })} />
                      <Num label="×" value={c.speed} step={0.1} min={0.1} max={4} onChange={(v) => patch({ speed: v })} />
                    </div>
                    <Toggle label="Loop" checked={c.loop} onChange={(v) => patch({ loop: v })} />
                  </li>
                );
              })}
            </ul>
            <AddButton
              onClick={() =>
                update((s) => {
                  let t = s.tracks.find((x) => x.type === "action" && x.objectId === id);
                  if (!t) {
                    t = { id: uniqueId(`${id}_action`, s.tracks.map((x) => x.id)), type: "action", objectId: id, clips: [] };
                    s.tracks.push(t);
                  }
                  if (t.type === "action") t.clips.push({ start: Math.round(time * 100) / 100, end: s.output.duration, action: clipOptions[0]!.value, speed: 1, loop: true });
                })
              }
            >
              Clip at playhead
            </AddButton>
          </>
        )}
      </Section>

      <Section title="Motion">
        <ul className="space-y-2">
          {(motionTrack?.type === "procedural" ? motionTrack.motions : []).map((m, i) => {
            const patch = (fields: Partial<typeof m>) =>
              update((s) => {
                const t = s.tracks.find((x) => x.id === motionTrack!.id);
                if (t?.type === "procedural") Object.assign(t.motions[i]!, fields);
              });
            const unit = ["sway", "wobble"].includes(m.kind) ? "°" : ["pulse"].includes(m.kind) ? "×" : m.kind === "spin" ? "" : "m";
            return (
              <li key={i} className="rounded-lg border border-line bg-night-850 p-2">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Select label="Motion" value={m.kind} options={PROCEDURAL_KINDS.map((k) => ({ value: k, label: k[0]!.toUpperCase() + k.slice(1) }))} onChange={(v) => patch({ kind: v as ProceduralKind })} />
                  <IconButton
                    label="Remove motion"
                    className={mini}
                    onClick={() =>
                      update((s) => {
                        const t = s.tracks.find((x) => x.id === motionTrack!.id);
                        if (t?.type === "procedural") {
                          t.motions.splice(i, 1);
                          removeTrackIfEmpty(s, t.id);
                        }
                      })
                    }
                  >
                    <Trash2 className="size-3" />
                  </IconButton>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <Num label="▸" value={m.start} step={0.1} min={0} suffix="s" onChange={(v) => patch({ start: v })} />
                  <Num label="◂" value={m.end} step={0.1} min={0} suffix="s" onChange={(v) => patch({ end: v })} />
                  {m.kind !== "spin" && <Num label="A" value={m.amplitude} step={0.05} min={0} suffix={unit} onChange={(v) => patch({ amplitude: v })} />}
                  <Num label="f" value={m.frequency} step={0.1} min={0} max={30} suffix={m.kind === "spin" ? "rev/s" : "Hz"} onChange={(v) => patch({ frequency: v })} />
                </div>
              </li>
            );
          })}
        </ul>
        <AddButton
          onClick={() =>
            update((s) => {
              let t = s.tracks.find((x) => x.type === "procedural" && x.objectId === id);
              if (!t) {
                t = { id: uniqueId(`${id}_motion`, s.tracks.map((x) => x.id)), type: "procedural", objectId: id, motions: [] };
                s.tracks.push(t);
              }
              if (t.type === "procedural") t.motions.push({ start: 0, end: s.output.duration, kind: "hover", amplitude: 0.1, frequency: 0.6 });
            })
          }
        >
          Hover, hop, sway, spin…
        </AddButton>
      </Section>

      <Section
        title="Material"
        action={
          object.material && (
            <button onClick={() => update((s) => void delete s.objects.find((x) => x.id === id)!.material)} className="text-[10px] text-ink-4 hover:text-ink">
              Reset
            </button>
          )
        }
      >
        <Field label="Tint">
          <ColorInput value={material.tint ?? "#ffffff"} onChange={(v) => setMaterial({ tint: v, tintStrength: material.tintStrength ?? 0.6 })} />
        </Field>
        {material.tint && (
          <Field label="Tint strength">
            <input type="range" min={0} max={1} step={0.05} value={material.tintStrength ?? 0.6} onChange={(e) => setMaterial({ tintStrength: Number(e.target.value) })} className="w-full" aria-label="Tint strength" />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Roughness">
            <Num value={material.roughness ?? 0.5} step={0.05} min={0} max={1} onChange={(v) => setMaterial({ roughness: v })} />
          </Field>
          <Field label="Metallic">
            <Num value={material.metallic ?? 0} step={0.05} min={0} max={1} onChange={(v) => setMaterial({ metallic: v })} />
          </Field>
        </div>
        <Field label="Glow">
          <ColorInput value={material.emissive ?? "#000000"} onChange={(v) => setMaterial({ emissive: v, emissiveStrength: material.emissiveStrength ?? 2 })} />
        </Field>
        {material.emissive && (
          <Field label="Glow strength">
            <Num value={material.emissiveStrength ?? 2} step={0.5} min={0} max={50} onChange={(v) => setMaterial({ emissiveStrength: v })} />
          </Field>
        )}
      </Section>
    </>
  );
}

// ───────────── camera ─────────────

function CameraInspector({ spec, id }: { spec: SceneSpec; id: string }) {
  const time = useEditor((s) => s.time);
  const viewCamera = useEditor((s) => s.viewCamera);
  const { update, setTime, setViewCamera } = useEditor.getState();
  const camera = spec.cameras.find((c) => c.id === id);
  if (!camera) return null;
  const patchCamera = (fn: (c: SceneSpec["cameras"][number]) => void) => update((s) => fn(s.cameras.find((c) => c.id === id)!));
  const objectOptions = spec.objects.map((o) => ({ value: o.id, label: o.name }));

  return (
    <>
      <Section
        title="Camera"
        action={
          <button onClick={() => setViewCamera(viewCamera === id ? "free" : id)} className="text-[10px] font-medium text-violet-400 hover:text-violet-300">
            {viewCamera === id ? "Exit camera view" : "Look through"}
          </button>
        }
      >
        <Field label="Name">
          <input value={camera.name} onChange={(e) => patchCamera((c) => void (c.name = e.target.value.slice(0, 80) || camera.name))} className="field-sm" aria-label="Camera name" />
        </Field>
        <Field label="Behaviour">
          <Select
            label="Camera behaviour"
            value={camera.attach.mode}
            onChange={(mode) =>
              update((s) => {
                const c = s.cameras.find((x) => x.id === id)!;
                // Convert every keyframe so the shot looks the same after changing behaviour.
                const sampler = new SceneSampler(s);
                const worlds = c.keyframes.map((k) => sampler.sampleCamera(id, k.t));
                const objectId = mode === "world" ? null : (c.attach.objectId ?? s.objects[0]?.id ?? null);
                c.attach = objectId ? { mode, objectId } : { mode: "world", objectId: null };
                c.keyframes.forEach((k, i) => {
                  const anchor = c.attach.objectId ? sampler.sampleObject(c.attach.objectId, k.t).position : [0, 0, 0];
                  const w = worlds[i]!;
                  const rel = (v: number[]) => [v[0]! - anchor[0]!, v[1]! - anchor[1]!, v[2]! - anchor[2]!].map((n) => Math.round(n * 1000) / 1000);
                  k.position = c.attach.mode === "follow" ? rel(w.position) : w.position.map((n) => Math.round(n * 1000) / 1000);
                  k.target = c.attach.mode === "world" ? w.target.map((n) => Math.round(n * 1000) / 1000) : rel(w.target);
                });
              })
            }
            options={[
              { value: "world", label: "Free — fixed path in the world" },
              { value: "look_at", label: "Look at — stays put, tracks an object" },
              { value: "follow", label: "Follow — travels with an object" },
            ]}
          />
        </Field>
        {camera.attach.mode !== "world" && (
          <Field label={camera.attach.mode === "follow" ? "Follows" : "Looks at"}>
            <Select label="Attached object" value={camera.attach.objectId ?? ""} options={objectOptions} onChange={(v) => patchCamera((c) => void (c.attach = { mode: c.attach.mode, objectId: v }))} />
          </Field>
        )}
        <Toggle label="Curved camera path" checked={camera.smooth} onChange={(v) => patchCamera((c) => void (c.smooth = v))} />
      </Section>

      <Section title="Keyframes">
        {camera.attach.mode !== "world" && <p className="mb-2 text-[10px] leading-snug text-ink-4">Values are offsets from “{spec.objects.find((o) => o.id === camera.attach.objectId)?.name}”{camera.attach.mode === "look_at" ? " for the target" : ""}.</p>}
        <ul className="space-y-2">
          {camera.keyframes.map((k, i) => {
            const patch = (fields: Partial<typeof k>) => patchCamera((c) => void Object.assign(c.keyframes[i]!, fields));
            return (
              <li key={i} className={`rounded-lg border p-2 ${atTime(spec, k.t, time) ? "border-violet-500/60 bg-violet-600/10" : "border-line bg-night-850"}`}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <button onClick={() => setTime(k.t)} className="text-[11px] font-semibold text-ink tabular-nums hover:text-violet-300">
                    {k.t.toFixed(2)}s
                  </button>
                  <span className="flex-1" />
                  <Select label="Easing" value={k.easing} options={EASING_OPTIONS} onChange={(v) => patch({ easing: v as Easing })} />
                  <IconButton label="Delete keyframe" className={mini} disabled={camera.keyframes.length <= 1} onClick={() => patchCamera((c) => void c.keyframes.splice(i, 1))}>
                    <Trash2 className="size-3" />
                  </IconButton>
                </div>
                <Field label="Position">
                  <Vec value={k.position} onChange={(v) => patch({ position: v })} />
                </Field>
                <Field label="Target">
                  <Vec value={k.target} onChange={(v) => patch({ target: v })} />
                </Field>
                <Field label="Field of view">
                  <Num value={k.fov} step={1} min={12} max={100} suffix="°" onChange={(v) => patch({ fov: v })} />
                </Field>
              </li>
            );
          })}
        </ul>
        <AddButton
          onClick={() => {
            const sample = new SceneSampler(spec).sampleCamera(id, time);
            update((s) => keyCameraFromView(s, id, time, sample));
          }}
        >
          Keyframe at playhead
        </AddButton>
        <button
          onClick={() => {
            const view = useEditor.getState().freeView;
            update((s) => keyCameraFromView(s, id, time, view));
          }}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-violet-600/15 py-1.5 text-[11px] font-medium text-violet-300 hover:bg-violet-600/25"
          title="Frame the shot with the free view, then capture it here"
        >
          <Crosshair className="size-3" /> Capture the free view at playhead
        </button>
      </Section>
    </>
  );
}

// ───────────── light ─────────────

function LightInspector({ spec, id }: { spec: SceneSpec; id: string }) {
  const time = useEditor((s) => s.time);
  const { update, setTime } = useEditor.getState();
  const light = spec.lights.find((l) => l.id === id);
  if (!light) return null;
  const patch = (fields: Partial<typeof light>) => update((s) => void Object.assign(s.lights.find((l) => l.id === id)!, fields));
  const track = spec.tracks.find((t) => t.type === "light" && t.lightId === id);
  const keys = track?.type === "light" ? track.keyframes : [];

  return (
    <>
      <Section title="Light">
        <Field label="Name">
          <input value={light.name} onChange={(e) => patch({ name: e.target.value.slice(0, 80) || light.name })} className="field-sm" aria-label="Light name" />
        </Field>
        <Field label="Type">
          <Select
            label="Light type"
            value={light.type}
            onChange={(v) => patch({ type: v, intensity: v === "sun" ? Math.min(light.intensity, 8) || 3 : light.type === "sun" ? 800 : light.intensity })}
            options={[
              { value: "sun", label: "Sun — parallel daylight" },
              { value: "point", label: "Point — bulb" },
              { value: "spot", label: "Spot — cone" },
              { value: "area", label: "Area — soft panel" },
            ]}
          />
        </Field>
        <Field label="Colour">
          <ColorInput value={light.color} onChange={(v) => patch({ color: v })} />
        </Field>
        <Field label="Intensity" hint={light.type === "sun" ? "strength, 1–8" : "watts"}>
          <Num value={light.intensity} step={light.type === "sun" ? 0.25 : 50} min={0} onChange={(v) => patch({ intensity: v })} />
        </Field>
        <Field label="Position">
          <Vec value={light.position} step={0.5} onChange={(v) => patch({ position: v })} />
        </Field>
        {light.type !== "point" && (
          <Field label="Aims at">
            <Vec value={light.target} step={0.5} onChange={(v) => patch({ target: v })} />
          </Field>
        )}
        {light.type === "spot" && (
          <Field label="Cone angle">
            <Num value={light.spotAngle} step={1} min={1} max={179} suffix="°" onChange={(v) => patch({ spotAngle: v })} />
          </Field>
        )}
        <Toggle label="Casts shadows" checked={light.castShadow} onChange={(v) => patch({ castShadow: v })} />
      </Section>

      <Section title="Lighting changes">
        {keys.length === 0 && <p className="text-[11px] text-ink-4">Constant. Add keyframes to change brightness or colour over time.</p>}
        <ul className="space-y-1.5">
          {keys.map((k, i) => {
            const patchKey = (fields: Partial<typeof k>) =>
              update((s) => {
                const t = s.tracks.find((x) => x.id === track!.id);
                if (t?.type === "light") Object.assign(t.keyframes[i]!, fields);
              });
            return (
              <li key={i} className="flex items-center gap-1.5">
                <button onClick={() => setTime(k.t)} className="w-12 shrink-0 text-left text-[11px] text-ink-3 tabular-nums hover:text-ink">
                  {k.t.toFixed(2)}s
                </button>
                <Num value={k.intensity ?? light.intensity} step={light.type === "sun" ? 0.25 : 50} min={0} onChange={(v) => patchKey({ intensity: v })} />
                <input type="color" value={k.color ?? light.color} onChange={(e) => patchKey({ color: e.target.value })} className="h-6 w-8 shrink-0 cursor-pointer rounded border border-line bg-night-850 p-0.5" aria-label="Keyframe colour" />
                <IconButton
                  label="Delete keyframe"
                  className={mini}
                  onClick={() =>
                    update((s) => {
                      const t = s.tracks.find((x) => x.id === track!.id);
                      if (t?.type === "light") {
                        t.keyframes.splice(i, 1);
                        removeTrackIfEmpty(s, t.id);
                      }
                    })
                  }
                >
                  <Trash2 className="size-3" />
                </IconButton>
              </li>
            );
          })}
        </ul>
        <AddButton
          onClick={() =>
            update((s) => {
              let t = s.tracks.find((x) => x.type === "light" && x.lightId === id);
              if (!t) {
                t = { id: uniqueId(`${id}_light`, s.tracks.map((x) => x.id)), type: "light", lightId: id, keyframes: [] };
                s.tracks.push(t);
                if (time > 0.01) t.keyframes.push({ t: 0, intensity: light.intensity, color: light.color, easing: "linear" });
              }
              if (t.type === "light" && !t.keyframes.some((k) => atTime(s, k.t, time))) {
                const sample = new SceneSampler(s).sampleLight(id, time);
                t.keyframes.push({ t: Math.round(time * 100) / 100, intensity: Math.round(sample.intensity * 100) / 100, color: light.color, easing: "ease_in_out" });
                t.keyframes.sort((a, b) => a.t - b.t);
              }
            })
          }
        >
          Keyframe at playhead
        </AddButton>
      </Section>
    </>
  );
}

// ───────────── scene ─────────────

function SceneInspector({ spec }: { spec: SceneSpec }) {
  const { update } = useEditor.getState();
  const world = spec.world;
  const patchWorld = (fields: Partial<typeof world>) => update((s) => void Object.assign(s.world, fields));
  return (
    <>
      <Section title="Scene">
        <Field label="Title">
          <input value={spec.title} onChange={(e) => update((s) => void (s.title = e.target.value.slice(0, 120) || spec.title))} className="field-sm" aria-label="Scene title" />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Duration" hint="seconds">
            <Num
              value={spec.output.duration}
              step={0.5}
              min={1}
              max={600}
              onChange={(v) =>
                update((s) => {
                  s.output.duration = v;
                  const last = s.shots[s.shots.length - 1];
                  if (last) last.end = v;
                })
              }
            />
          </Field>
          <Field label="Frame rate" hint="fps">
            <Select label="Frame rate" value={String(spec.output.fps)} options={[12, 24, 25, 30, 50, 60].map((f) => ({ value: String(f), label: `${f}` }))} onChange={(v) => update((s) => void (s.output.fps = Number(v)))} />
          </Field>
        </div>
        <Field label="Aspect ratio">
          <Select label="Aspect ratio" value={spec.output.aspect} options={ASPECTS.map((a) => ({ value: a, label: a }))} onChange={(v) => update((s) => void (s.output.aspect = v))} />
        </Field>
      </Section>
      <Section title="Sky and ambient light">
        <Field label="Sky overhead">
          <ColorInput value={world.skyTop} onChange={(v) => patchWorld({ skyTop: v })} />
        </Field>
        <Field label="Sky at the horizon">
          <ColorInput value={world.skyHorizon} onChange={(v) => patchWorld({ skyHorizon: v })} />
        </Field>
        <Field label="Distant ground">
          <ColorInput value={world.groundColor} onChange={(v) => patchWorld({ groundColor: v })} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Ambient" hint="0–5">
            <Num value={world.ambient} step={0.05} min={0} max={5} onChange={(v) => patchWorld({ ambient: v })} />
          </Field>
          <Field label="Exposure" hint="stops">
            <Num value={world.exposure} step={0.1} min={-4} max={4} onChange={(v) => patchWorld({ exposure: v })} />
          </Field>
        </div>
      </Section>
      <div className="p-3">
        <Notice tone="info">Select something in the viewport, hierarchy or timeline to edit it.</Notice>
      </div>
    </>
  );
}

export function Inspector() {
  const spec = useEditor((s) => s.spec)!;
  const selection = useEditor((s) => s.selection);
  if (selection?.type === "object") return <ObjectInspector spec={spec} id={selection.id} />;
  if (selection?.type === "camera") return <CameraInspector spec={spec} id={selection.id} />;
  if (selection?.type === "light") return <LightInspector spec={spec} id={selection.id} />;
  return <SceneInspector spec={spec} />;
}
