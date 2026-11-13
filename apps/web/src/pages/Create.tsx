import { ASPECTS, RESOLUTIONS, resolutionRank, type Aspect, type Resolution } from "@kivo/shared";
import { ArrowRight, Box, Lock, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { JobProgress } from "../components/JobProgress";
import { Onboarding } from "../components/Onboarding";
import { VideoPlayer } from "../components/VideoPlayer";
import { Button, Loading, Notice, Segmented, cx } from "../components/ui";
import { ApiError, api, type Job, type Project, type Video } from "../lib/api";
import { useJob, useSession } from "../lib/session";

const DURATIONS = [3, 5, 8, 10, 15, 20, 30, 45, 60, 90, 120, 180];
const EXAMPLES = [
  "A cute robot explores an abandoned futuristic city while the camera follows it.",
  "A knight walks up to a glowing sword stuck in a stone and looks around.",
  "A tiny astronaut waves hello on a red desert planet at sunset.",
  "A paper boat drifts past giant mushrooms in a misty forest.",
];
const ASPECT_LABEL: Record<Aspect, string> = { "16:9": "Landscape", "9:16": "Portrait", "1:1": "Square", "4:3": "Classic", "21:9": "Cinema" };

type Mode = "simple" | "advanced";

export function CreatePage() {
  const { projectId } = useParams();
  const navigate = useNavigate();
  const { me, config, setPreferredMode, markOnboarded, refresh, activeJobs } = useSession();

  const [mode, setMode] = useState<Mode>(me?.user.preferredMode ?? "simple");
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("cinematic");
  const [duration, setDuration] = useState(5);
  const [aspect, setAspect] = useState<Aspect>("16:9");
  const [resolution, setResolution] = useState<Resolution>("480p");
  const [project, setProject] = useState<Project | null>(null);
  const [loadingProject, setLoadingProject] = useState(!!projectId);
  const [jobId, setJobId] = useState<string | null>(null);
  const [video, setVideo] = useState<Video | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const plan = me?.plan;
  const showWelcome = !!me && !me.user.onboarded;

  // Defaults follow the plan's export limits; the user's preferred mode is remembered.
  useEffect(() => {
    if (!plan || projectId) return;
    setDuration((d) => Math.min(d, plan.maxDurationSec));
    setResolution(plan.maxResolution);
  }, [plan, projectId]);

  // Resume an existing project: prompt, settings and any running job. Switching modes never clears these.
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    setLoadingProject(true);
    api<{ project: Project; video: Video | null; jobs: Job[] }>(`/projects/${projectId}`)
      .then((d) => {
        if (!live) return;
        setProject(d.project);
        setPrompt(d.project.prompt);
        setStyle(d.project.style);
        setDuration(d.project.duration);
        setAspect(d.project.aspect);
        setResolution(d.project.resolution);
        setVideo(d.video);
        const running = d.jobs.find((j) => j.status === "queued" || j.status === "running");
        setJobId(running?.id ?? null);
      })
      .catch((e: ApiError) => live && setError(e))
      .finally(() => live && setLoadingProject(false));
    return () => {
      live = false;
    };
  }, [projectId]);

  const { job, queue } = useJob(jobId, async (finished) => {
    await refresh();
    if (finished.status === "succeeded" && finished.projectId) {
      const d = await api<{ project: Project; video: Video | null }>(`/projects/${finished.projectId}`);
      setProject(d.project);
      setVideo(d.video);
      if (finished.result === "scene") navigate(`/editor/${finished.projectId}`);
    }
  });

  const working = !!job && (job.status === "queued" || job.status === "running");
  const outOfQuota = !!me && me.usage.remaining <= 0;
  const atConcurrency = !!me && activeJobs.length >= me.plan.concurrentJobs && !working;

  const switchMode = (next: Mode) => {
    setMode(next);
    void setPreferredMode(next); // remembered as the default; nothing about the project changes
  };

  const save = async (): Promise<Project> => {
    const body = { prompt: prompt.trim(), mode, style, duration, aspect, resolution };
    const saved = project
      ? await api<{ project: Project }>(`/projects/${project.id}`, { method: "PATCH", body })
      : await api<{ project: Project }>("/projects", { body });
    setProject(saved.project);
    if (!project) navigate(`/create/${saved.project.id}`, { replace: true });
    return saved.project;
  };

  const generate = async (render: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const p = await save();
      const started = await api<{ job: Job }>(`/projects/${p.id}/generate`, { body: { render } });
      setVideo(null);
      setJobId(started.job.id);
      await refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const durations = useMemo(() => DURATIONS.filter((d) => d <= 180), []);
  if (!me || !plan) return <Loading />;
  if (loadingProject) return <Loading label="Opening project" />;

  const canGenerate = prompt.trim().length >= 3 && !busy && !working && !outOfQuota && !atConcurrency && config.storageReady;

  return (
    <div className="mx-auto max-w-3xl">
      <Onboarding
        open={showWelcome}
        initial={mode}
        onChoose={(m) => {
          switchMode(m);
          void markOnboarded();
        }}
      />

      <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project ? project.title : "Create a video"}</h1>
          <p className="mt-1.5 text-sm text-ink-3">{mode === "simple" ? "Describe your idea. Kivo handles everything else." : "Generate an editable 3D scene, then direct it yourself."}</p>
        </div>
        <Segmented<Mode>
          label="Creation mode"
          value={mode}
          onChange={switchMode}
          options={[
            { value: "simple", label: "Simple" },
            { value: "advanced", label: "Advanced" },
          ]}
        />
      </div>

      <div className="panel p-5 sm:p-6">
        <label htmlFor="prompt" className="label">
          Your idea
        </label>
        <textarea
          id="prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={working}
          maxLength={2000}
          rows={mode === "simple" ? 5 : 3}
          placeholder="A cute robot explores an abandoned futuristic city while the camera follows it."
          className="field resize-none text-base leading-relaxed"
        />
        {!prompt && !project && (
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.slice(1).map((e) => (
              <button key={e} onClick={() => setPrompt(e)} className="rounded-full border border-line bg-night-850 px-3 py-1.5 text-left text-xs text-ink-3 transition-colors hover:border-line-2 hover:text-ink">
                {e}
              </button>
            ))}
          </div>
        )}

        <div className="mt-6 grid gap-5 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className="label">Visual style {mode === "simple" && <span className="font-normal text-ink-4">(optional)</span>}</span>
            <div className="flex flex-wrap gap-2">
              {config.styles.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setStyle(s.id)}
                  disabled={working}
                  aria-pressed={style === s.id}
                  className={cx(
                    "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                    style === s.id ? "border-violet-500 bg-violet-600/15 text-ink" : "border-line bg-night-850 text-ink-3 hover:border-line-2 hover:text-ink",
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="duration" className="label">
              Video duration
            </label>
            <select id="duration" value={duration} onChange={(e) => setDuration(Number(e.target.value))} disabled={working} className="field">
              {durations.map((d) => (
                <option key={d} value={d} disabled={d > plan.maxDurationSec}>
                  {d} seconds{d > plan.maxDurationSec ? ` — ${config.plans.find((p) => p.maxDurationSec >= d)?.name ?? "higher"} plan` : ""}
                </option>
              ))}
            </select>
          </div>

          <div>
            <span className="label">Aspect ratio</span>
            <div className="flex flex-wrap gap-2">
              {ASPECTS.map((a) => (
                <button
                  key={a}
                  onClick={() => setAspect(a)}
                  disabled={working}
                  aria-pressed={aspect === a}
                  title={ASPECT_LABEL[a]}
                  className={cx(
                    "rounded-lg border px-3 py-2 text-xs font-medium tabular-nums transition-colors",
                    aspect === a ? "border-violet-500 bg-violet-600/15 text-ink" : "border-line bg-night-850 text-ink-3 hover:border-line-2 hover:text-ink",
                  )}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>

          {mode === "advanced" && (
            <div className="sm:col-span-2">
              <span className="label">Export resolution</span>
              <div className="flex flex-wrap gap-2">
                {RESOLUTIONS.map((r) => {
                  const locked = resolutionRank(r) > resolutionRank(plan.maxResolution);
                  return (
                    <button
                      key={r}
                      onClick={() => !locked && setResolution(r)}
                      disabled={working || locked}
                      aria-pressed={resolution === r}
                      title={locked ? `Exports above ${plan.maxResolution} need a higher plan` : undefined}
                      className={cx(
                        "inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                        resolution === r ? "border-violet-500 bg-violet-600/15 text-ink" : "border-line bg-night-850 text-ink-3 hover:border-line-2 hover:text-ink",
                        locked && "opacity-50 hover:border-line hover:text-ink-3",
                      )}
                    >
                      {locked && <Lock className="size-3" />} {r}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-wrap items-center justify-between gap-4 border-t border-line pt-5">
          <p className="text-xs text-ink-3">
            {me.plan.name} plan · exports up to {plan.maxDurationSec}s at {plan.maxResolution}, {plan.maxFps} fps{plan.watermark ? ", with a Kivo watermark" : ""} · {me.usage.remaining} of {me.usage.limit} videos left
          </p>
          <div className="flex items-center gap-2">
            {mode === "advanced" && project?.hasScene && (
              <Link to={`/editor/${project.id}`}>
                <Button variant="secondary" icon={<Box className="size-4" />}>
                  Open editor
                </Button>
              </Link>
            )}
            {mode === "simple" ? (
              <Button variant="primary" size="lg" onClick={() => generate(true)} disabled={!canGenerate} loading={busy} icon={<Sparkles className="size-[18px]" />}>
                {project?.latestVideoId ? "Regenerate" : "Generate"}
              </Button>
            ) : (
              <Button variant="primary" size="lg" onClick={() => generate(false)} disabled={!canGenerate} loading={busy} icon={<Wand2 className="size-[18px]" />}>
                {project?.hasScene ? "Regenerate scene" : "Generate 3D scene"}
              </Button>
            )}
          </div>
        </div>
      </div>

      <div className="mt-5 space-y-4">
        {!config.storageReady && (
          <Notice tone="warn" title="Video generation isn't switched on yet">
            This Kivo deployment has no file storage yet (Cloudflare R2 is not enabled on its account), so 3D models and videos can't be saved. You can sign in, explore the app and manage your plan; generating starts working as soon as storage is enabled.
          </Notice>
        )}
        {error && (
          <Notice
            tone="bad"
            title={error.code === "quota_exceeded" ? "Monthly videos used up" : error.code === "concurrency_exceeded" ? "Too many jobs running" : "Couldn't start"}
            action={
              error.code === "quota_exceeded" ? (
                <Link to="/subscription">
                  <Button size="sm" variant="primary">
                    See plans
                  </Button>
                </Link>
              ) : undefined
            }
          >
            {error.message}
          </Notice>
        )}
        {!error && outOfQuota && !working && (
          <Notice
            tone="warn"
            title="You've used this month's videos"
            action={
              <Link to="/subscription">
                <Button size="sm" variant="primary">
                  See plans
                </Button>
              </Link>
            }
          >
            Your {me.plan.name} plan includes {me.usage.limit} videos a month. You can still open and edit any project in the 3D editor.
          </Notice>
        )}
        {!error && atConcurrency && !outOfQuota && (
          <Notice tone="info" title="A job is already running">
            The {me.plan.name} plan runs {me.plan.concurrentJobs} job{me.plan.concurrentJobs === 1 ? "" : "s"} at a time. <Link to="/renders" className="underline">See the render queue</Link>.
          </Notice>
        )}

        {job && (job.status !== "succeeded" || !video) && (
          <div className="panel animate-rise p-5 sm:p-6">
            <h2 className="mb-4 text-sm font-semibold">{job.willRender ? "Making your video" : "Building your scene"}</h2>
            <JobProgress job={job} queue={queue} />
            {job.status === "succeeded" && job.result === "scene" && (
              <div className="mt-4">
                <Link to={`/editor/${job.projectId}`}>
                  <Button variant="primary" icon={<ArrowRight className="size-4" />}>
                    Open the 3D editor
                  </Button>
                </Link>
              </div>
            )}
          </div>
        )}

        {video && project && (
          <div className="panel animate-rise p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-semibold">Your video</h2>
              <div className="flex items-center gap-2">
                <Link to={`/editor/${project.id}`}>
                  <Button size="sm" variant="secondary" icon={<Box className="size-3.5" />}>
                    Edit in 3D
                  </Button>
                </Link>
                <Link to={`/projects/${project.id}`}>
                  <Button size="sm" variant="ghost">
                    Project page
                  </Button>
                </Link>
              </div>
            </div>
            <VideoPlayer video={video} title={project.title} />
          </div>
        )}
      </div>
    </div>
  );
}
