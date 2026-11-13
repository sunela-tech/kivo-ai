import type { SceneSpec } from "@kivo/shared";
import { Diamond, Pause, Play, SkipBack, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { IconButton, cx } from "../components/ui";
import { addObjectKeyframe, keyCameraFromView, removeTrackIfEmpty, useEditor, type Selection } from "./store";
import { SceneSampler } from "@kivo/shared";

/**
 * Multi-track timeline: the edit (shots), every camera's keyframes, and per
 * object its movement keyframes, skeletal clips and procedural motion.
 * Drag keyframes and clips to retime them; click anywhere to scrub.
 */

const LABEL_W = 176;
const ROW_H = 26;

type KeyRef = { kind: "move" | "camera" | "light"; owner: string; index: number };

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Horizontal drag in timeline seconds. `onMove` receives the delta from the drag start. */
function useDrag(pps: number) {
  return useCallback(
    (e: ReactPointerEvent, handlers: { onMove: (deltaSeconds: number) => void; onEnd?: (moved: boolean) => void }) => {
      e.stopPropagation();
      e.preventDefault();
      const startX = e.clientX;
      let moved = false;
      const move = (ev: PointerEvent) => {
        const dx = ev.clientX - startX;
        if (Math.abs(dx) > 2) moved = true;
        if (moved) handlers.onMove(dx / pps);
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        handlers.onEnd?.(moved);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [pps],
  );
}

function Row({ label, sub, selected, onSelect, children }: { label: string; sub?: string; selected?: boolean; onSelect?: () => void; children: ReactNode }) {
  return (
    <div className="flex border-b border-line/40" style={{ height: ROW_H }}>
      <button
        onClick={onSelect}
        className={cx("sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-line bg-panel px-3 text-left text-[11px]", selected ? "text-violet-300" : "text-ink-2 hover:text-ink")}
        style={{ width: LABEL_W }}
      >
        <span className="truncate font-medium">{label}</span>
        {sub && <span className="shrink-0 text-ink-4">{sub}</span>}
      </button>
      <div className="relative flex-1">{children}</div>
    </div>
  );
}

export function Timeline() {
  const spec = useEditor((s) => s.spec)!;
  const time = useEditor((s) => s.time);
  const playing = useEditor((s) => s.playing);
  const selection = useEditor((s) => s.selection);
  const { setTime, setPlaying, select, update, setViewCamera } = useEditor.getState();
  const scroller = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  const [zoom, setZoom] = useState(1);
  const [activeKey, setActiveKey] = useState<KeyRef | null>(null);
  // While dragging, the moved item is previewed without touching the scene; it is committed on release.
  const [preview, setPreview] = useState<{ id: string; delta: number } | null>(null);

  const duration = spec.output.duration;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pps = Math.max(8, ((width - LABEL_W - 24) / duration) * zoom);
  const lane = duration * pps;
  const drag = useDrag(pps);
  const x = (t: number) => t * pps;
  const snap = (t: number) => Math.min(duration, Math.max(0, Math.round(t * spec.output.fps) / spec.output.fps));

  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const at = (clientX: number) => setTime(snap((clientX - rect.left) / pps));
    at(e.clientX);
    setPlaying(false);
    const move = (ev: PointerEvent) => at(ev.clientX);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const deleteKey = useCallback(
    (key: KeyRef) => {
      update((s) => {
        if (key.kind === "camera") {
          const cam = s.cameras.find((c) => c.id === key.owner);
          if (cam && cam.keyframes.length > 1) cam.keyframes.splice(key.index, 1);
        } else {
          const track = s.tracks.find((t) => t.id === key.owner);
          if (track && (track.type === "transform" || track.type === "light")) {
            track.keyframes.splice(key.index, 1);
            removeTrackIfEmpty(s, track.id);
          }
        }
      });
      setActiveKey(null);
    },
    [update],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.code === "Space") {
        e.preventDefault();
        setPlaying(!useEditor.getState().playing);
      } else if ((e.key === "Delete" || e.key === "Backspace") && activeKey) {
        e.preventDefault();
        deleteKey(activeKey);
      } else if (e.key === "ArrowRight") setTime(snap(useEditor.getState().time + 1 / spec.output.fps));
      else if (e.key === "ArrowLeft") setTime(snap(useEditor.getState().time - 1 / spec.output.fps));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey, deleteKey, spec.output.fps]);

  const ticks = useMemo(() => {
    const step = pps >= 120 ? 0.5 : pps >= 40 ? 1 : pps >= 18 ? 2 : pps >= 8 ? 5 : 10;
    const out: number[] = [];
    for (let t = 0; t <= duration + 1e-6; t += step) out.push(Math.round(t * 100) / 100);
    return out;
  }, [pps, duration]);

  const keyframe = (id: string, key: KeyRef, t: number, owner: Selection, commit: (s: SceneSpec, newT: number) => void) => {
    const shown = preview?.id === id ? snap(t + preview.delta) : t;
    const active = activeKey?.kind === key.kind && activeKey.owner === key.owner && activeKey.index === key.index;
    return (
      <button
        key={id}
        aria-label={`Keyframe at ${t.toFixed(2)} seconds`}
        title={`${shown.toFixed(2)}s — drag to retime, Delete to remove`}
        onPointerDown={(e) =>
          drag(e, {
            onMove: (delta) => setPreview({ id, delta }),
            onEnd: (moved) => {
              if (moved) {
                const delta = (useTimelinePreview.current?.id === id ? useTimelinePreview.current.delta : 0) || 0;
                update((s) => commit(s, snap(t + delta)));
              } else {
                setTime(t);
                select(owner);
              }
              setActiveKey(key);
              setPreview(null);
            },
          })
        }
        className="absolute top-1/2 z-[1] -translate-x-1/2 -translate-y-1/2 cursor-ew-resize p-1"
        style={{ left: x(shown) }}
      >
        <span className={cx("block size-2.5 rotate-45 rounded-[2px] border", active ? "border-white bg-violet-400" : "border-violet-300/70 bg-violet-600 hover:bg-violet-400")} />
      </button>
    );
  };

  // The drag handler closes over state from the render that started the drag; keep the latest preview reachable.
  const useTimelinePreview = useRef(preview);
  useTimelinePreview.current = preview;

  const bar = (id: string, start: number, end: number, label: string, tone: string, commit: (s: SceneSpec, start: number, end: number) => void, onClick?: () => void) => {
    const moving = preview?.id === id ? preview.delta : 0;
    const resizing = preview?.id === `${id}:end` ? preview.delta : 0;
    const s0 = snap(start + moving);
    const e0 = Math.max(s0 + 1 / spec.output.fps, snap(end + moving + resizing));
    return (
      <div
        key={id}
        onPointerDown={(e) =>
          drag(e, {
            onMove: (delta) => setPreview({ id, delta: Math.max(-start, Math.min(duration - end, delta)) }),
            onEnd: (moved) => {
              const delta = useTimelinePreview.current?.id === id ? useTimelinePreview.current.delta : 0;
              if (moved) update((s) => commit(s, snap(start + delta), snap(end + delta)));
              else onClick?.();
              setPreview(null);
            },
          })
        }
        title={`${label} · ${s0.toFixed(2)}–${e0.toFixed(2)}s`}
        className={cx("absolute top-1 bottom-1 flex cursor-grab items-center overflow-hidden rounded-md border px-2 text-[10px] font-medium whitespace-nowrap active:cursor-grabbing", tone)}
        style={{ left: x(s0), width: Math.max(6, x(e0) - x(s0)) }}
      >
        <span className="truncate">{label}</span>
        <span
          onPointerDown={(e) =>
            drag(e, {
              onMove: (delta) => setPreview({ id: `${id}:end`, delta: Math.max(start - end + 1 / spec.output.fps, Math.min(duration - end, delta)) }),
              onEnd: (moved) => {
                const delta = useTimelinePreview.current?.id === `${id}:end` ? useTimelinePreview.current.delta : 0;
                if (moved) update((s) => commit(s, start, snap(end + delta)));
                setPreview(null);
              },
            })
          }
          className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/20 hover:bg-white/50"
        />
      </div>
    );
  };

  const objectRows = spec.objects
    .map((object) => ({ object, tracks: spec.tracks.filter((t) => t.type !== "light" && t.objectId === object.id) }))
    .filter((r) => r.tracks.length > 0 || (selection?.type === "object" && selection.id === r.object.id));

  const addKeyAtPlayhead = () => {
    if (!selection) return;
    if (selection.type === "object") update((s) => addObjectKeyframe(s, selection.id, time));
    else if (selection.type === "camera") {
      const sample = new SceneSampler(spec).sampleCamera(selection.id, time);
      update((s) => keyCameraFromView(s, selection.id, time, sample));
    }
  };

  return (
    <div className="flex h-full flex-col bg-panel">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-line px-2">
        <IconButton label="Back to start" onClick={() => setTime(0)}>
          <SkipBack className="size-4" />
        </IconButton>
        <IconButton label={playing ? "Pause (Space)" : "Play (Space)"} onClick={() => setPlaying(!playing)} active={playing}>
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </IconButton>
        <span className="ml-2 w-28 text-xs text-ink-2 tabular-nums">
          {fmt(time)} <span className="text-ink-4">/ {fmt(duration)}</span>
        </span>
        <span className="text-[11px] text-ink-4">frame {Math.round(time * spec.output.fps) + 1}</span>
        <div className="flex-1" />
        <IconButton label="Add keyframe at playhead for the selection" onClick={addKeyAtPlayhead} disabled={!selection || selection.type === "light"}>
          <Diamond className="size-4" />
        </IconButton>
        <IconButton label="Delete selected keyframe" onClick={() => activeKey && deleteKey(activeKey)} disabled={!activeKey}>
          <Trash2 className="size-4" />
        </IconButton>
        <span className="mx-1 h-4 w-px bg-line" />
        <IconButton label="Zoom out" onClick={() => setZoom((z) => Math.max(1, z / 1.5))} disabled={zoom <= 1}>
          <ZoomOut className="size-4" />
        </IconButton>
        <IconButton label="Zoom in" onClick={() => setZoom((z) => Math.min(24, z * 1.5))}>
          <ZoomIn className="size-4" />
        </IconButton>
      </div>

      <div ref={scroller} className="relative flex-1 overflow-auto">
        <div style={{ width: LABEL_W + lane + 24 }} className="relative">
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex border-b border-line bg-panel-2" style={{ height: 22 }}>
            <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-panel-2" style={{ width: LABEL_W }} />
            <div className="relative flex-1 cursor-pointer" onPointerDown={scrub} style={{ width: lane }}>
              {ticks.map((t) => (
                <span key={t} className="absolute top-0 h-full border-l border-line-2 pl-1 text-[10px] leading-[22px] text-ink-4 tabular-nums select-none" style={{ left: x(t) }}>
                  {t}s
                </span>
              ))}
            </div>
          </div>

          <Row label="Edit" sub="shots">
            <div className="absolute inset-0" onPointerDown={scrub} />
            {spec.shots.map((shot, i) => {
              const cam = spec.cameras.find((c) => c.id === shot.cameraId);
              return (
                <button
                  key={shot.id}
                  onClick={() => {
                    setTime(shot.start);
                    setViewCamera("edit");
                    select({ type: "camera", id: shot.cameraId });
                  }}
                  title={`${shot.name || `Shot ${i + 1}`} · ${cam?.name ?? shot.cameraId} · ${shot.transition}`}
                  className={cx("absolute top-1 bottom-1 overflow-hidden rounded-md border px-2 text-left text-[10px] font-medium whitespace-nowrap", i % 2 ? "border-violet-500/40 bg-violet-600/25 text-violet-200" : "border-violet-400/40 bg-violet-500/35 text-violet-100")}
                  style={{ left: x(shot.start) + 1, width: Math.max(4, x(shot.end) - x(shot.start) - 2) }}
                >
                  {shot.transition !== "cut" && <span className="mr-1 opacity-70">{shot.transition === "fade" ? "◐" : "⧖"}</span>}
                  {cam?.name ?? shot.cameraId}
                </button>
              );
            })}
          </Row>

          {spec.cameras.map((cam) => (
            <Row key={cam.id} label={cam.name} sub="camera" selected={selection?.type === "camera" && selection.id === cam.id} onSelect={() => select({ type: "camera", id: cam.id })}>
              <div className="absolute inset-0" onPointerDown={scrub} />
              {cam.keyframes.map((k, i) =>
                keyframe(`cam:${cam.id}:${i}`, { kind: "camera", owner: cam.id, index: i }, k.t, { type: "camera", id: cam.id }, (s, t) => {
                  const c = s.cameras.find((c) => c.id === cam.id);
                  if (c?.keyframes[i]) {
                    c.keyframes[i]!.t = t;
                    c.keyframes.sort((a, b) => a.t - b.t);
                  }
                }),
              )}
            </Row>
          ))}

          {objectRows.map(({ object, tracks }) => {
            const sel: Selection = { type: "object", id: object.id };
            const selected = selection?.type === "object" && selection.id === object.id;
            if (tracks.length === 0) {
              return (
                <Row key={object.id} label={object.name} sub="no animation" selected={selected} onSelect={() => select(sel)}>
                  <div className="absolute inset-0" onPointerDown={scrub} />
                </Row>
              );
            }
            return tracks.map((track) => (
              <Row key={track.id} label={object.name} sub={track.type === "transform" ? "move" : track.type === "action" ? "clips" : "motion"} selected={selected} onSelect={() => select(sel)}>
                <div className="absolute inset-0" onPointerDown={scrub} />
                {track.type === "transform" &&
                  track.keyframes.map((k, i) =>
                    keyframe(`mv:${track.id}:${i}`, { kind: "move", owner: track.id, index: i }, k.t, sel, (s, t) => {
                      const tr = s.tracks.find((x) => x.id === track.id);
                      if (tr?.type === "transform" && tr.keyframes[i]) {
                        tr.keyframes[i]!.t = t;
                        tr.keyframes.sort((a, b) => a.t - b.t);
                      }
                    }),
                  )}
                {track.type === "action" &&
                  track.clips.map((c, i) =>
                    bar(
                      `clip:${track.id}:${i}`,
                      c.start,
                      c.end,
                      `${c.action}${c.speed !== 1 ? ` ×${c.speed}` : ""}`,
                      "border-emerald-400/40 bg-emerald-500/20 text-emerald-200",
                      (s, start, end) => {
                        const tr = s.tracks.find((x) => x.id === track.id);
                        if (tr?.type === "action" && tr.clips[i]) Object.assign(tr.clips[i]!, { start, end });
                      },
                      () => select(sel),
                    ),
                  )}
                {track.type === "procedural" &&
                  track.motions.map((m, i) =>
                    bar(
                      `mo:${track.id}:${i}`,
                      m.start,
                      m.end,
                      m.kind,
                      "border-amber-400/40 bg-amber-500/15 text-amber-200",
                      (s, start, end) => {
                        const tr = s.tracks.find((x) => x.id === track.id);
                        if (tr?.type === "procedural" && tr.motions[i]) Object.assign(tr.motions[i]!, { start, end });
                      },
                      () => select(sel),
                    ),
                  )}
              </Row>
            ));
          })}

          {spec.tracks
            .filter((t) => t.type === "light")
            .map((track) => {
              if (track.type !== "light") return null;
              const light = spec.lights.find((l) => l.id === track.lightId);
              const sel: Selection = { type: "light", id: track.lightId };
              return (
                <Row key={track.id} label={light?.name ?? track.lightId} sub="light" selected={selection?.type === "light" && selection.id === track.lightId} onSelect={() => select(sel)}>
                  <div className="absolute inset-0" onPointerDown={scrub} />
                  {track.keyframes.map((k, i) =>
                    keyframe(`lt:${track.id}:${i}`, { kind: "light", owner: track.id, index: i }, k.t, sel, (s, t) => {
                      const tr = s.tracks.find((x) => x.id === track.id);
                      if (tr?.type === "light" && tr.keyframes[i]) {
                        tr.keyframes[i]!.t = t;
                        tr.keyframes.sort((a, b) => a.t - b.t);
                      }
                    }),
                  )}
                </Row>
              );
            })}

          {/* Playhead */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-violet-400" style={{ left: LABEL_W + x(time) }}>
            <div className="absolute -top-0 -left-[5px] h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-violet-400" />
          </div>
        </div>
      </div>
    </div>
  );
}
