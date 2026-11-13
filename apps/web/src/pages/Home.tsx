import { useUser } from "@clerk/react";
import { Clapperboard, Film, Plus, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { JobProgress } from "../components/JobProgress";
import { ProjectCard } from "../components/ProjectCard";
import { Badge, Button, EmptyState, Loading, Notice } from "../components/ui";
import { api, timeAgo, type Project, type Video } from "../lib/api";
import { useAsync, useSession } from "../lib/session";

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="panel p-5">
      <div className="eyebrow">{label}</div>
      <div className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-3">{hint}</div>}
    </div>
  );
}

export function HomePage() {
  const { user } = useUser();
  const { me, loading, error, activeJobs } = useSession();
  const projects = useAsync(() => api<{ projects: Project[] }>("/projects"), [activeJobs.length]);
  const videos = useAsync(() => api<{ videos: Video[] }>("/videos"), [activeJobs.length]);

  if (loading && !me) return <Loading />;
  if (!me) return <Notice tone="bad" title="Couldn't load your account">{error}</Notice>;

  const name = user?.firstName || user?.username || "there";
  const reset = new Date(me.usage.resetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" });

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Welcome back, {name}</h1>
          <p className="mt-2 text-sm text-ink-3">What will you bring to life today?</p>
        </div>
        <Link to="/create">
          <Button variant="primary" size="lg" icon={<Plus className="size-[18px]" />}>
            New Video
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Videos left this month" value={`${me.usage.remaining} of ${me.usage.limit}`} hint={`Resets ${reset}`} />
        <Stat label="Active jobs" value={`${activeJobs.length} of ${me.plan.concurrentJobs}`} hint="running at once on your plan" />
        <Stat label="Completed videos" value={String(me.counts.videos)} hint={`${me.counts.projects} project${me.counts.projects === 1 ? "" : "s"}`} />
        <div className="panel flex flex-col justify-between p-5">
          <div>
            <div className="eyebrow">Plan</div>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-2xl font-semibold tracking-tight">{me.plan.name}</span>
              <Badge tone="violet">{me.plan.renderPriorityLabel} priority</Badge>
            </div>
            <div className="mt-1 text-xs text-ink-3">
              Up to {me.plan.maxDurationSec}s · {me.plan.maxResolution} · {me.plan.maxFps} fps
            </div>
          </div>
          <Link to="/subscription" className="mt-3 text-xs font-medium text-violet-400 hover:text-violet-300">
            {me.plan.id === "studio" ? "Manage subscription" : "Compare plans"} →
          </Link>
        </div>
      </div>

      {activeJobs.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-semibold text-ink-2">In progress</h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {activeJobs.map((job) => (
              <div key={job.id} className="panel p-5">
                <div className="mb-3 flex items-center justify-between">
                  <Link to={`/projects/${job.projectId}`} className="text-sm font-semibold hover:text-violet-300">
                    Open project →
                  </Link>
                  <span className="text-xs text-ink-4">started {timeAgo(job.createdAt)}</span>
                </div>
                <JobProgress job={job} compact />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-ink-2">Recent projects</h2>
          <Link to="/projects" className="text-xs font-medium text-violet-400 hover:text-violet-300">
            All projects →
          </Link>
        </div>
        {projects.loading && !projects.data ? (
          <Loading />
        ) : projects.data && projects.data.projects.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {projects.data.projects.slice(0, 8).map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<Sparkles className="size-6" />}
            title="Your first video is one sentence away"
            action={
              <Link to="/create">
                <Button variant="primary" icon={<Plus className="size-4" />}>
                  New Video
                </Button>
              </Link>
            }
          >
            Describe an idea and Kivo will model, animate and render it.
          </EmptyState>
        )}
      </section>

      {videos.data && videos.data.videos.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-ink-2">
            <Film className="size-4 text-ink-4" /> Completed videos
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {videos.data.videos.slice(0, 8).map((v) => (
              <Link key={v.id} to={`/projects/${v.projectId}`} className="group panel block overflow-hidden transition-colors hover:border-line-2">
                <div className="aspect-video overflow-hidden bg-night-850">
                  {v.thumbnailUrl ? <img src={v.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover" /> : <div className="flex size-full items-center justify-center text-ink-4"><Clapperboard className="size-7" /></div>}
                </div>
                <div className="p-3.5">
                  <div className="truncate text-sm font-medium">{v.projectTitle}</div>
                  <div className="mt-0.5 text-xs text-ink-3">
                    {v.height}p · {v.duration.toFixed(1)}s · {timeAgo(v.createdAt)}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
