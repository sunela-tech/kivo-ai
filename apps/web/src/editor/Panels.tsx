import { SceneSampler, type SceneSpec, type Vec3 } from "@kivo/shared";
import { Bone, Camera, Copy, Eye, EyeOff, Lightbulb, Plus, Shapes, Sun, Trash2, Video } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, IconButton, cx } from "../components/ui";
import { rigLabel } from "../pages/Assets";
import { addCamera, addLight, addObject, duplicateObject, removeObject, retileShots, uniqueId, useEditor } from "./store";

// ───────────── small form controls shared by the panels ─────────────

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-line/60 px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="eyebrow">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function Num({ value, onChange, step = 0.1, min, max, label, suffix }: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; label?: string; suffix?: string }) {
  return (
    <label className="flex min-w-0 items-center gap-1">
      {label && <span className="w-3 shrink-0 text-[10px] font-semibold text-ink-4 uppercase">{label}</span>}
      <input
        type="number"
        value={Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(max !== undefined ? Math.min(max, min !== undefined ? Math.max(min, v) : v) : min !== undefined ? Math.max(min, v) : v);
        }}
        className="field-sm min-w-0"
      />
      {suffix && <span className="shrink-0 text-[10px] text-ink-4">{suffix}</span>}
    </label>
  );
}

export function Vec({ value, onChange, step = 0.1 }: { value: number[]; onChange: (v: Vec3) => void; step?: number }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {(["x", "y", "z"] as const).map((axis, i) => (
        <Num
          key={axis}
          label={axis}
          value={value[i] ?? 0}
          step={step}
          onChange={(v) => {
            const next = [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0] as Vec3;
            next[i] = v;
            onChange(next);
          }}
        />
      ))}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="mb-2.5 last:mb-0">
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-[11px] font-medium text-ink-3">{label}</span>
        {hint && <span className="text-[10px] text-ink-4">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-9 shrink-0 cursor-pointer rounded border border-line bg-night-850 p-0.5" aria-label="Colour" />
      <input value={value} onChange={(e) => /^#[0-9a-fA-F]{6}$/.test(e.target.value) && onChange(e.target.value)} className="field-sm font-mono uppercase" maxLength={7} aria-label="Hex colour" />
    </div>
  );
}

export function Select<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[]; label?: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} className="field-sm" aria-label={label}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-3 py-1 text-[11px] text-ink-2">
      {label}
      <button role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={cx("relative h-4.5 w-8 shrink-0 rounded-full transition-colors", checked ? "bg-violet-600" : "bg-panel-3")}>
        <span className={cx("absolute top-0.5 size-3.5 rounded-full bg-white transition-all", checked ? "left-4" : "left-0.5")} />
      </button>
    </label>
  );
}

// ───────────── scene hierarchy ─────────────

function Item({ icon, label, sub, selected, onSelect, actions, dim }: { icon: ReactNode; label: string; sub?: string; selected: boolean; onSelect: () => void; actions?: ReactNode; dim?: boolean }) {
  return (
    <li className={cx("group flex items-center rounded-lg pr-1 transition-colors", selected ? "bg-violet-600/20" : "hover:bg-panel-2")}>
      <button onClick={onSelect} className={cx("flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs", selected ? "text-ink" : "text-ink-2", dim && "opacity-50")}>
        <span className={cx("shrink-0", selected ? "text-violet-300" : "text-ink-4")}>{icon}</span>
        <span className="truncate">{label}</span>
        {sub && <span className="ml-auto shrink-0 text-[10px] text-ink-4">{sub}</span>}
      </button>
      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">{actions}</span>
    </li>
  );
}

const mini = "size-6 rounded-md";

export function HierarchyPanel() {
  const spec = useEditor((s) => s.spec)!;
  const selection = useEditor((s) => s.selection);
  const { select, update, setViewCamera } = useEditor.getState();
  const is = (type: string, id: string) => selection?.type === type && selection.id === id;

  return (
    <div>
      <Section title={`Objects · ${spec.objects.length}`}>
        {spec.objects.length === 0 ? (
          <p className="text-xs text-ink-4">Add models from the Models tab.</p>
        ) : (
          <ul className="space-y-0.5">
            {spec.objects.map((o) => {
              const asset = spec.assets.find((a) => a.id === o.assetId);
              return (
                <Item
                  key={o.id}
                  icon={<Shapes className="size-3.5" />}
                  label={o.name}
                  sub={asset?.kind}
                  dim={!o.visible}
                  selected={is("object", o.id)}
                  onSelect={() => select({ type: "object", id: o.id })}
                  actions={
                    <>
                      <IconButton label={o.visible ? "Hide" : "Show"} className={mini} onClick={() => update((s) => void (s.objects.find((x) => x.id === o.id)!.visible = !o.visible))}>
                        {o.visible ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
                      </IconButton>
                      <IconButton
                        label="Duplicate"
                        className={mini}
                        onClick={() => {
                          let id: string | null = null;
                          update((s) => void (id = duplicateObject(s, o.id)));
                          if (id) select({ type: "object", id });
                        }}
                      >
                        <Copy className="size-3" />
                      </IconButton>
                      <IconButton
                        label="Remove from scene"
                        className={mini}
                        onClick={() => {
                          update((s) => removeObject(s, o.id));
                          if (is("object", o.id)) select(null);
                        }}
                      >
                        <Trash2 className="size-3" />
                      </IconButton>
                    </>
                  }
                />
              );
            })}
          </ul>
        )}
      </Section>

      <Section
        title={`Cameras · ${spec.cameras.length}`}
        action={
          <IconButton
            label="Add a camera from the current view"
            className={mini}
            onClick={() => {
              const { freeView, time } = useEditor.getState();
              let id = "";
              update((s) => void (id = addCamera(s, freeView, time)));
              select({ type: "camera", id });
            }}
          >
            <Plus className="size-3.5" />
          </IconButton>
        }
      >
        <ul className="space-y-0.5">
          {spec.cameras.map((c) => (
            <Item
              key={c.id}
              icon={<Camera className="size-3.5" />}
              label={c.name}
              sub={c.attach.mode === "world" ? `${c.keyframes.length} keys` : c.attach.mode === "follow" ? "follows" : "looks at"}
              selected={is("camera", c.id)}
              onSelect={() => select({ type: "camera", id: c.id })}
              actions={
                <>
                  <IconButton label="Look through this camera" className={mini} onClick={() => setViewCamera(c.id)}>
                    <Video className="size-3" />
                  </IconButton>
                  <IconButton
                    label="Delete camera"
                    className={mini}
                    disabled={spec.cameras.length <= 1}
                    onClick={() => {
                      update((s) => {
                        s.cameras = s.cameras.filter((x) => x.id !== c.id);
                        for (const shot of s.shots) if (shot.cameraId === c.id) shot.cameraId = s.cameras[0]!.id;
                      });
                      if (is("camera", c.id)) select(null);
                      if (useEditor.getState().viewCamera === c.id) setViewCamera("free");
                    }}
                  >
                    <Trash2 className="size-3" />
                  </IconButton>
                </>
              }
            />
          ))}
        </ul>
      </Section>

      <Section
        title={`Lights · ${spec.lights.length}`}
        action={
          <span className="flex">
            {(["sun", "point", "spot", "area"] as const).map((type) => (
              <IconButton
                key={type}
                label={`Add ${type} light`}
                className={mini}
                onClick={() => {
                  let id = "";
                  update((s) => void (id = addLight(s, type)));
                  select({ type: "light", id });
                }}
              >
                {type === "sun" ? <Sun className="size-3.5" /> : <span className="text-[9px] font-bold uppercase">{type[0]}</span>}
              </IconButton>
            ))}
          </span>
        }
      >
        <ul className="space-y-0.5">
          {spec.lights.map((l) => (
            <Item
              key={l.id}
              icon={l.type === "sun" ? <Sun className="size-3.5" /> : <Lightbulb className="size-3.5" />}
              label={l.name}
              sub={l.type}
              selected={is("light", l.id)}
              onSelect={() => select({ type: "light", id: l.id })}
              actions={
                <IconButton
                  label="Delete light"
                  className={mini}
                  disabled={spec.lights.length <= 1}
                  onClick={() => {
                    update((s) => {
                      s.lights = s.lights.filter((x) => x.id !== l.id);
                      s.tracks = s.tracks.filter((t) => !(t.type === "light" && t.lightId === l.id));
                    });
                    if (is("light", l.id)) select(null);
                  }}
                >
                  <Trash2 className="size-3" />
                </IconButton>
              }
            />
          ))}
        </ul>
      </Section>
    </div>
  );
}

// ───────────── model library ─────────────

export function ModelsPanel() {
  const spec = useEditor((s) => s.spec)!;
  const assets = useEditor((s) => s.assets);
  const { update, select } = useEditor.getState();

  return (
    <div className="p-3">
      <p className="mb-3 text-[11px] leading-relaxed text-ink-3">The Meshy models in this project. Place a model as many times as you like — copies don't cost anything. Ask the AI Director for new models.</p>
      <ul className="space-y-2">
        {spec.assets.map((a) => {
          const file = assets[a.id];
          const uses = spec.objects.filter((o) => o.assetId === a.id).length;
          const rig = file ? rigLabel(file) : null;
          const ready = file?.status === "ready";
          return (
            <li key={a.id} className="flex gap-3 rounded-xl border border-line bg-night-850 p-2">
              <div className="size-16 shrink-0 overflow-hidden rounded-lg bg-panel-2">
                {file?.thumbnailUrl ? <img src={file.thumbnailUrl} alt="" className="size-full object-contain" /> : <div className="flex size-full items-center justify-center text-ink-4"><Shapes className="size-5" /></div>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold">{a.name}</div>
                <div className="mt-0.5 text-[10px] text-ink-4 capitalize">
                  {a.kind} · {a.size.meters} m · used {uses}×
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-1">
                  {!ready && <Badge tone={file?.status === "failed" ? "bad" : "violet"}>{file?.statusLabel ?? "Missing"}</Badge>}
                  {rig && (a.rig === "humanoid" || file?.rigStatus === "rigged") && (
                    <Badge tone={rig.tone}>
                      <Bone className="size-2.5" /> {rig.text}
                    </Badge>
                  )}
                </div>
                {file?.rigNote && <p className="mt-1 text-[10px] leading-snug text-warn/90">{file.rigNote}</p>}
              </div>
              <IconButton
                label={`Place ${a.name} in the scene`}
                disabled={!ready}
                onClick={() => {
                  let id = "";
                  update((s) => void (id = addObject(s, a.id, a.name)));
                  select({ type: "object", id });
                }}
              >
                <Plus className="size-4" />
              </IconButton>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ───────────── shot editor ─────────────

export function ShotsPanel() {
  const spec = useEditor((s) => s.spec)!;
  const time = useEditor((s) => s.time);
  const { update, setTime, setViewCamera } = useEditor.getState();
  const current = new SceneSampler(spec).shotIndexAt(time);
  const cameraOptions = spec.cameras.map((c) => ({ value: c.id, label: c.name }));

  const patch = (index: number, fields: Partial<SceneSpec["shots"][number]>) =>
    update((s) => {
      Object.assign(s.shots[index]!, fields);
      retileShots(s);
    });

  return (
    <div className="p-3">
      <p className="mb-3 text-[11px] leading-relaxed text-ink-3">The edit: which camera is on screen, and when. Shots always cover the whole video — change where a shot starts and the one before it ends there.</p>
      <ol className="space-y-2">
        {spec.shots.map((shot, i) => (
          <li key={shot.id} className={cx("rounded-xl border p-2.5", i === current ? "border-violet-500/60 bg-violet-600/10" : "border-line bg-night-850")}>
            <div className="mb-2 flex items-center gap-2">
              <button
                onClick={() => {
                  setTime(shot.start);
                  setViewCamera("edit");
                }}
                className="text-[11px] font-semibold text-ink hover:text-violet-300"
              >
                Shot {i + 1}
              </button>
              <span className="text-[10px] text-ink-4 tabular-nums">
                {shot.start.toFixed(2)}–{shot.end.toFixed(2)}s
              </span>
              <span className="flex-1" />
              <IconButton
                label="Delete shot"
                className={mini}
                disabled={spec.shots.length <= 1}
                onClick={() =>
                  update((s) => {
                    s.shots.splice(i, 1);
                    retileShots(s);
                  })
                }
              >
                <Trash2 className="size-3" />
              </IconButton>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Camera">
                <Select value={shot.cameraId} onChange={(v) => patch(i, { cameraId: v })} options={cameraOptions} label="Camera" />
              </Field>
              <Field label="Starts at">
                <Num value={shot.start} step={0.1} min={0} max={spec.output.duration} suffix="s" onChange={(v) => i > 0 && patch(i, { start: v })} />
              </Field>
              <Field label="Transition in">
                <Select
                  value={shot.transition}
                  onChange={(v) => patch(i, { transition: v, transitionDuration: v === "cut" ? 0 : shot.transitionDuration || 0.5 })}
                  options={[
                    { value: "cut", label: "Cut" },
                    { value: "fade", label: "Fade through black" },
                    ...(i > 0 ? [{ value: "dissolve" as const, label: "Dissolve" }] : []),
                  ]}
                  label="Transition"
                />
              </Field>
              <Field label="Length">
                <Num value={shot.transitionDuration} step={0.1} min={0} max={3} suffix="s" onChange={(v) => shot.transition !== "cut" && patch(i, { transitionDuration: v })} />
              </Field>
            </div>
          </li>
        ))}
      </ol>
      <button
        onClick={() =>
          update((s) => {
            const at = Math.min(s.output.duration - 0.2, Math.max(0.2, Math.round(time * 10) / 10));
            const active = s.shots[new SceneSampler(s).shotIndexAt(at)] ?? s.shots[0]!;
            s.shots.push({ id: uniqueId("shot", s.shots.map((x) => x.id)), name: "", cameraId: active.cameraId, start: at, end: s.output.duration, transition: "cut", transitionDuration: 0 });
            retileShots(s);
          })
        }
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-line-2 py-2 text-xs text-ink-3 hover:border-violet-500/60 hover:text-ink"
      >
        <Plus className="size-3.5" /> Cut a new shot at the playhead
      </button>
    </div>
  );
}
