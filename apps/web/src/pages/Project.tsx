import { Box, Clapperboard, Copy, Play, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { JobProgress } from "../components/JobProgress";
import { VideoPlayer } from "../components/VideoPlayer";
import { Badge, Button, Loading, Modal, Notice, cx } from "../components/ui";
import { ApiError, api, timeAgo, type Job, type Project, type Video } from "../lib/api";
import { useJob, useSession } from "../lib/session";

interface Detail {
  project: Project;
  video: Video | null;
  jobs: Job[];
}

export function ProjectPage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { me, refresh } = useSession();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [history, setHistory] = useState<Video[]>([]);
  const [selected, setSelected] = useState<Video | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [title, setTitle] = useState("");

  const load = async () => {
    try {
      const [d, v] = await Promise.all([api<Detail>(`/projects/${projectId}`), api<{ videos: Video[] }>(`/projects/${projectId}/videos`)]);
      setDetail(d);
      setTitle(d.project.title);
      setHistory(v.videos);
      setSelected((cur) => v.videos.find((x) => x.id === cur?.id) ?? d.video ?? v.videos[0] ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    setDetail(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const running = detail?.jobs.find((j) => j.status === "queued" || j.status === "running") ?? null;
  const { job, queue } = useJob(running?.id, async () => {
    await Promise.all([load(), refresh()]);
  });
  const liveJob = job ?? running;
  const lastFailed = !liveJob && detail?.jobs[0]?.status === "failed" ? detail.jobs[0] : null;

  if (error) return <Notice tone="bad" title="Couldn't open this project">{error}</Notice>;
  if (!detail || !me) return <Loading label="Opening project" />;
  const { project } = detail;
  const working = !!liveJob && (liveJob.status === "queued" || liveJob.status === "running");

  const act = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setNotice(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const start = (path: string, body: unknown) =>
    act(path, async () => {
      await api(`/projects/${project.id}/${path}`, { body });
      await Promise.all([load(), refresh()]);
    });

  const rename = async () => {
    const next = title.trim();
    if (!next || next === project.title) return setTitle(project.title);
    await api(`/projects/${project.id}`, { method: "PATCH", body: { title: next } }).catch(() => setTitle(project.title));
    void load();
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <Link to="/projects" className="text-xs text-ink-3 hover:text-ink">
            ← Projects
          </Link>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={rename}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            aria-label="Project title"
            maxLength={120}
            className="mt-1 block w-full truncate rounded-lg border border-transparent bg-transparent py-1 text-2xl font-semibold tracking-tight hover:border-line focus:border-violet-500 focus:px-2 focus:outline-none"
          />
          {project.prompt && <p className="mt-1 max-w-2xl text-sm text-ink-3">“{project.prompt}”</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link to={`/editor/${project.id}`}>
            <Button variant="secondary" icon={<Box className="size-4" />} disabled={!project.hasScene}>
              Edit in 3D
            </Button>
          </Link>
          <Button variant="secondary" icon={<Play className="size-4" />} disabled={!project.hasScene || working} loading={busy === "render"} onClick={() => start("render", {})}>
            Render
          </Button>
          <Button variant="secondary" icon={<RefreshCw className="size-4" />} disabled={working || !project.prompt} loading={busy === "generate"} onClick={() => start("generate", { render: true })}>
            Regenerate
          </Button>
          <Button
            variant="ghost"
            icon={<Copy className="size-4" />}
            loading={busy === "duplicate"}
            onClick={() =>
              act("duplicate", async () => {
                const d = await api<{ project: Project }>(`/projects/${project.id}/duplicate`, { method: "POST" });
                navigate(`/projects/${d.project.id}`);
              })
            }
          >
            Duplicate
          </Button>
          <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)} aria-label="Delete project">
            Delete
          </Button>
        </div>
      </div>

      {notice && (
        <Notice tone="bad" title={notice.code === "quota_exceeded" ? "Monthly videos used up" : "That didn't work"} action={notice.code === "quota_exceeded" ? <Link to="/subscription"><Button size="sm" variant="primary">See plans</Button></Link> : undefined}>
          {notice.message}
        </Notice>
      )}
      {project.prepaidRenders > 0 && !working && (
        <Notice tone="info">This project's first render is already included — rendering it won't use another video from your month.</Notice>
      )}

      {liveJob && working && (
        <section className="panel p-5 sm:p-6">
          <h2 className="mb-4 text-sm font-semibold">{liveJob.kind === "render" ? "Rendering" : liveJob.willRender ? "Making your video" : "Building your scene"}</h2>
          <JobProgress job={liveJob} queue={queue} onCanceled={load} />
        </section>
      )}
      {lastFailed && (
        <Notice tone="bad" title="The last run failed">
          {lastFailed.error?.message}
        </Notice>
      )}

      {selected ? (
        <section>
          <VideoPlayer video={selected} title={project.title} />
        </section>
      ) : (
        !working && (
          <div className="panel flex flex-col items-center px-6 py-14 text-center">
            <Clapperboard className="size-8 text-ink-4" />
            <h3 className="mt-3 text-base font-semibold">{project.hasScene ? "No video rendered yet" : "Nothing generated yet"}</h3>
            <p className="mt-1 max-w-sm text-sm text-ink-3">{project.hasScene ? "This project has a 3D scene. Render it, or open the editor to change it first." : "Open this project in Create to generate it."}</p>
            <div className="mt-5">
              {project.hasScene ? (
                <Button variant="primary" onClick={() => start("render", {})} loading={busy === "render"} icon={<Play className="size-4" />}>
                  Render video
                </Button>
              ) : (
                <Link to={`/create/${project.id}`}>
                  <Button variant="primary">Open in Create</Button>
                </Link>
              )}
            </div>
          </div>
        )
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink-2">Render history</h2>
        {history.length === 0 ? (
          <p className="text-sm text-ink-3">Finished renders of this project appear here.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {history.map((v, i) => (
              <li key={v.id}>
                <div className={cx("panel flex items-center gap-3 p-2.5 transition-colors", selected?.id === v.id ? "border-violet-500/60" : "hover:border-line-2")}>
                  <button onClick={() => setSelected(v)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-label={`Play render ${history.length - i}`}>
                    <span className="aspect-video w-24 shrink-0 overflow-hidden rounded-lg bg-night-850">{v.thumbnailUrl && <img src={v.thumbnailUrl} alt="" className="size-full object-cover" />}</span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        Render {history.length - i} {i === 0 && <Badge tone="violet">Latest</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-ink-3">
                        {v.height}p · {v.fps} fps · {timeAgo(v.createdAt)}
                      </span>
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      act("delete-video", async () => {
                        await api(`/videos/${v.id}`, { method: "DELETE" });
                        await load();
                      })
                    }
                    aria-label="Delete this render"
                    className="rounded-lg p-2 text-ink-4 hover:bg-panel-3 hover:text-bad"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Modal open={confirmDelete} onClose={() => setConfirmDelete(false)} labelledBy="delete-title">
        <div className="p-6">
          <h2 id="delete-title" className="text-lg font-semibold">
            Delete “{project.title}”?
          </h2>
          <p className="mt-2 text-sm text-ink-3">This permanently deletes the project, its scene history, all of its rendered videos, and any 3D models no other project uses.</p>
          <div className="mt-6 flex justify-end gap-2">
            <Button onClick={() => setConfirmDelete(false)}>Keep project</Button>
            <Button
              variant="danger"
              loading={busy === "delete"}
              onClick={() =>
                act("delete", async () => {
                  await api(`/projects/${project.id}`, { method: "DELETE" });
                  await refresh();
                  navigate("/projects");
                })
              }
            >
              Delete project
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
