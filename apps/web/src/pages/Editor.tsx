import { SceneSampler } from "@kivo/shared";
import { AlertTriangle, ArrowLeft, Box, Check, Move3d, Redo2, Rotate3d, Scaling, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DirectorPanel } from "../editor/Director";
import { Inspector } from "../editor/Inspector";
import { HierarchyPanel, ModelsPanel, ShotsPanel } from "../editor/Panels";
import { RenderPanel } from "../editor/RenderPanel";
import { Timeline } from "../editor/Timeline";
import { Viewport } from "../editor/Viewport";
import { useEditor, type Tool } from "../editor/store";
import { Button, EmptyState, IconButton, Loading, Logo, Notice, PageHeader, Segmented, Spinner, cx } from "../components/ui";
import { api, timeAgo, type Project } from "../lib/api";
import { useAsync, useSession } from "../lib/session";

/** "3D Editor" in the sidebar: pick a project to open. */
export function EditorIndexPage() {
  const { data, loading } = useAsync(() => api<{ projects: Project[] }>("/projects"), []);
  const withScene = (data?.projects ?? []).filter((p) => p.hasScene);
  return (
    <>
      <PageHeader title="3D Editor" subtitle="Open a project's scene to move objects, animate, direct cameras and light it. The editor is fully available on every plan." />
      {loading && !data ? (
        <Loading />
      ) : withScene.length === 0 ? (
        <EmptyState
          icon={<Box className="size-6" />}
          title="No scenes to edit yet"
          action={
            <Link to="/create">
              <Button variant="primary">Generate a 3D scene</Button>
            </Link>
          }
        >
          Generate a scene in Create (Simple or Advanced Mode) and it opens here.
        </EmptyState>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {withScene.map((p) => (
            <li key={p.id}>
              <Link to={`/editor/${p.id}`} className="group panel flex items-center gap-4 p-3 transition-colors hover:border-violet-500/50">
                <span className="aspect-video w-28 shrink-0 overflow-hidden rounded-lg bg-night-850">{p.thumbnailUrl && <img src={p.thumbnailUrl} alt="" className="size-full object-cover" />}</span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold group-hover:text-violet-300">{p.title}</span>
                  <span className="mt-0.5 block text-xs text-ink-3">
                    {p.duration}s · {p.aspect} · edited {timeAgo(p.updatedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function SaveState() {
  const dirty = useEditor((s) => s.dirty);
  const saving = useEditor((s) => s.saving);
  const error = useEditor((s) => s.saveError);
  const savedAt = useEditor((s) => s.savedAt);
  if (error)
    return (
      <button onClick={() => void useEditor.getState().save()} className="flex items-center gap-1.5 text-xs text-bad" title={error}>
        <AlertTriangle className="size-3.5" /> Not saved — retry
      </button>
    );
  if (saving || dirty)
    return (
      <span className="flex items-center gap-1.5 text-xs text-ink-3">
        <Spinner className="size-3.5" /> Saving
      </span>
    );
  return (
    <span className="flex items-center gap-1.5 text-xs text-ink-4">
      <Check className="size-3.5" /> {savedAt ? "Saved" : "Up to date"}
    </span>
  );
}

type LeftTab = "scene" | "models" | "shots";
type RightTab = "inspect" | "director" | "render";

function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: string }[] }) {
  return (
    <div className="flex shrink-0 border-b border-line" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.value}
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={cx("flex-1 border-b-2 px-2 py-2.5 text-[11px] font-semibold tracking-wide transition-colors", value === t.value ? "border-violet-500 text-ink" : "border-transparent text-ink-4 hover:text-ink-2")}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function EditorPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { setPreferredMode } = useSession();
  const loading = useEditor((s) => s.loading);
  const loadError = useEditor((s) => s.loadError);
  const spec = useEditor((s) => s.spec);
  const project = useEditor((s) => s.project);
  const tool = useEditor((s) => s.tool);
  const viewCamera = useEditor((s) => s.viewCamera);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const warnings = useEditor((s) => s.warnings);
  const selection = useEditor((s) => s.selection);
  const [left, setLeft] = useState<LeftTab>("scene");
  const [right, setRight] = useState<RightTab>("inspect");

  useEffect(() => {
    if (projectId) void useEditor.getState().load(projectId);
    return () => {
      void useEditor.getState().save();
      useEditor.getState().reset();
    };
  }, [projectId]);

  // Selecting something brings up its properties.
  useEffect(() => {
    if (selection) setRight("inspect");
  }, [selection]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) useEditor.getState().redo();
        else useEditor.getState().undo();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void useEditor.getState().save();
      } else if (!mod && e.key.toLowerCase() === "g") useEditor.getState().setTool("translate");
      else if (!mod && e.key.toLowerCase() === "r") useEditor.getState().setTool("rotate");
      else if (!mod && e.key.toLowerCase() === "s") useEditor.getState().setTool("scale");
      else if (e.key === "Escape") useEditor.getState().select(null);
    };
    window.addEventListener("keydown", onKey);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (useEditor.getState().dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, []);

  if (loadError)
    return (
      <div className="mx-auto max-w-md p-10">
        <Notice tone="bad" title="Couldn't open the editor">
          {loadError}
        </Notice>
        <Link to="/projects" className="mt-4 inline-block text-sm text-violet-400">
          ← Back to projects
        </Link>
      </div>
    );
  if (loading || !project) return <Loading label="Opening the 3D editor" />;
  if (!spec)
    return (
      <div className="mx-auto max-w-md p-10">
        <EmptyState
          icon={<Box className="size-6" />}
          title="This project has no scene yet"
          action={
            <Link to={`/create/${project.id}`}>
              <Button variant="primary">Generate its 3D scene</Button>
            </Link>
          }
        >
          Generate a scene first, then edit it here.
        </EmptyState>
      </div>
    );

  const sampler = new SceneSampler(spec);
  const cameraLabel = (id: string) => spec.cameras.find((c) => c.id === id)?.name ?? id;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-night-900">
      {/* Top bar */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-line bg-night-850 px-3">
        <Link to={`/projects/${project.id}`} aria-label="Back to project" className="rounded-lg p-1.5 text-ink-3 hover:bg-panel-2 hover:text-ink">
          <ArrowLeft className="size-4" />
        </Link>
        <Logo size={22} wordmark={false} />
        <span className="max-w-[26ch] truncate text-sm font-semibold">{spec.title}</span>
        <SaveState />
        <div className="flex-1" />
        <Segmented
          size="sm"
          label="Creation mode"
          value="advanced"
          onChange={(m) => {
            if (m === "simple") {
              // Switching modes keeps everything: the project, prompt, scene and models are untouched.
              void setPreferredMode("simple");
              void useEditor.getState().save();
              navigate(`/create/${project.id}`);
            }
          }}
          options={[
            { value: "simple", label: "Simple" },
            { value: "advanced", label: "Advanced" },
          ]}
        />
        <div className="flex-1" />
        <IconButton label="Undo (Ctrl+Z)" onClick={() => useEditor.getState().undo()} disabled={!canUndo}>
          <Undo2 className="size-4" />
        </IconButton>
        <IconButton label="Redo (Ctrl+Shift+Z)" onClick={() => useEditor.getState().redo()} disabled={!canRedo}>
          <Redo2 className="size-4" />
        </IconButton>
        <Button size="sm" variant="primary" onClick={() => setRight("render")}>
          Render
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left */}
        <aside className="hidden w-64 shrink-0 flex-col border-r border-line bg-panel md:flex">
          <Tabs
            value={left}
            onChange={setLeft}
            tabs={[
              { value: "scene", label: "SCENE" },
              { value: "models", label: "MODELS" },
              { value: "shots", label: "SHOTS" },
            ]}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">{left === "scene" ? <HierarchyPanel /> : left === "models" ? <ModelsPanel /> : <ShotsPanel />}</div>
        </aside>

        {/* Centre */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <Viewport />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-2.5">
              <div className="pointer-events-auto flex gap-0.5 rounded-xl border border-line bg-night-850/90 p-1 backdrop-blur">
                {(
                  [
                    ["translate", Move3d, "Move (G)"],
                    ["rotate", Rotate3d, "Rotate (R)"],
                    ["scale", Scaling, "Scale (S)"],
                  ] as [Tool, typeof Move3d, string][]
                ).map(([t, Icon, label]) => (
                  <IconButton key={t} label={label} active={tool === t} onClick={() => useEditor.getState().setTool(t)}>
                    <Icon className="size-4" />
                  </IconButton>
                ))}
              </div>
              <label className="pointer-events-auto flex items-center gap-2 rounded-xl border border-line bg-night-850/90 py-1 pr-1 pl-3 text-[11px] text-ink-3 backdrop-blur">
                View
                <select value={viewCamera} onChange={(e) => useEditor.getState().setViewCamera(e.target.value)} className="rounded-lg border-0 bg-panel-2 px-2 py-1.5 text-[11px] font-medium text-ink focus:outline-none" aria-label="Viewport camera">
                  <option value="free">Free view</option>
                  <option value="edit">Final edit ({cameraLabel(sampler.shotAt(useEditor.getState().time)?.cameraId ?? "")})</option>
                  {spec.cameras.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {warnings.length > 0 && (
              <div className="absolute bottom-2.5 left-2.5 max-w-sm rounded-xl border border-warn/30 bg-night-850/95 px-3 py-2 text-[11px] text-warn backdrop-blur">
                {warnings.slice(0, 3).map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
            )}
          </div>
          <div className="h-56 shrink-0 border-t border-line lg:h-64">
            <Timeline />
          </div>
        </div>

        {/* Right */}
        <aside className="hidden w-72 shrink-0 flex-col border-l border-line bg-panel lg:flex xl:w-80">
          <Tabs
            value={right}
            onChange={setRight}
            tabs={[
              { value: "inspect", label: "INSPECTOR" },
              { value: "director", label: "AI DIRECTOR" },
              { value: "render", label: "RENDER" },
            ]}
          />
          <div className="min-h-0 flex-1 overflow-y-auto">{right === "inspect" ? <Inspector /> : right === "director" ? <DirectorPanel /> : <RenderPanel />}</div>
        </aside>
      </div>
    </div>
  );
}
