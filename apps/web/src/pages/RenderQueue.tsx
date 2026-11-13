import { ListVideo } from "lucide-react";
import { Link } from "react-router";
import { JobProgress } from "../components/JobProgress";
import { Badge, EmptyState, Loading, Notice, PageHeader } from "../components/ui";
import { api, timeAgo, type Job, type RenderEntry } from "../lib/api";
import { useAsync, useSession } from "../lib/session";

const STATUS: Record<string, { label: string; tone: "neutral" | "violet" | "good" | "warn" | "bad" }> = {
  queued: { label: "Waiting for a worker", tone: "neutral" },
  claimed: { label: "Loading scene", tone: "violet" },
  rendering: { label: "Rendering", tone: "violet" },
  encoding: { label: "Encoding", tone: "violet" },
  uploading: { label: "Saving", tone: "violet" },
  succeeded: { label: "Done", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
  canceled: { label: "Canceled", tone: "warn" },
};

function took(r: RenderEntry): string {
  if (!r.startedAt || !r.finishedAt) return "";
  const s = Math.round((r.finishedAt - r.startedAt) / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`;
}

export function RenderQueuePage() {
  const { me, activeJobs } = useSession();
  // Re-read while anything is running so frame counts stay current.
  const tick = activeJobs.map((j) => `${j.id}:${j.stage}:${j.progress}`).join("|");
  const renders = useAsync(() => api<{ renders: RenderEntry[] }>("/render-queue"), [tick]);
  const jobs = useAsync(() => api<{ jobs: (Job & { projectTitle: string })[] }>("/jobs"), [tick]);

  const history = (jobs.data?.jobs ?? []).filter((j) => j.status !== "queued" && j.status !== "running");

  return (
    <>
      <PageHeader title="Render Queue" subtitle={me ? `${me.plan.renderPriorityLabel} priority · up to ${me.plan.concurrentJobs} job${me.plan.concurrentJobs === 1 ? "" : "s"} at once on the ${me.plan.name} plan` : undefined} />
      {renders.error && <Notice tone="bad">{renders.error}</Notice>}

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-ink-2">Running now</h2>
        {activeJobs.length === 0 ? (
          <EmptyState icon={<ListVideo className="size-6" />} title="Nothing is running">
            Generations and renders show up here with their live stage.
          </EmptyState>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {activeJobs.map((job) => (
              <div key={job.id} className="panel p-5">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <Link to={`/projects/${job.projectId}`} className="truncate text-sm font-semibold hover:text-violet-300">
                    {jobs.data?.jobs.find((j) => j.id === job.id)?.projectTitle ?? "Project"}
                  </Link>
                  <Badge tone="violet">{job.kind === "render" ? "Render" : job.kind === "director" ? "AI Director" : "Generation"}</Badge>
                </div>
                <JobProgress job={job} compact />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold text-ink-2">Renders</h2>
        {renders.loading && !renders.data ? (
          <Loading />
        ) : (renders.data?.renders.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-3">No renders yet.</p>
        ) : (
          <div className="panel overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="px-4 py-3 font-medium">Project</th>
                  <th className="px-4 py-3 font-medium">Output</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Frames</th>
                  <th className="px-4 py-3 font-medium">Started</th>
                </tr>
              </thead>
              <tbody>
                {renders.data!.renders.map((r) => {
                  const s = STATUS[r.status] ?? { label: r.status, tone: "neutral" as const };
                  return (
                    <tr key={r.id} className="border-b border-line/60 last:border-0">
                      <td className="max-w-[220px] truncate px-4 py-3">
                        <Link to={`/projects/${r.projectId}`} className="hover:text-violet-300">
                          {r.projectTitle}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-ink-3 tabular-nums">
                        {r.width}×{r.height} · {r.fps} fps · {r.duration}s{r.watermark ? " · watermark" : ""}
                      </td>
                      <td className="px-4 py-3">
                        <Badge tone={s.tone}>{s.label}</Badge>
                        {r.error && <div className="mt-1 max-w-[260px] text-[11px] text-bad">{r.error.message}</div>}
                      </td>
                      <td className="px-4 py-3 text-ink-3 tabular-nums">
                        {r.framesDone} / {r.framesTotal}
                        {took(r) && <span className="ml-2 text-ink-4">{took(r)}</span>}
                      </td>
                      <td className="px-4 py-3 text-ink-3">{timeAgo(r.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-semibold text-ink-2">Job history</h2>
          <ul className="panel divide-y divide-line/60">
            {history.slice(0, 20).map((j) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <Link to={`/projects/${j.projectId}`} className="font-medium hover:text-violet-300">
                    {j.projectTitle}
                  </Link>
                  <span className="ml-2 text-xs text-ink-4">
                    {j.kind === "render" ? "Render" : j.kind === "director" ? "AI Director" : j.willRender ? "Generate video" : "Generate scene"} · {timeAgo(j.createdAt)}
                  </span>
                  {j.error && <div className="mt-0.5 text-xs text-ink-3">{j.error.message}</div>}
                </div>
                <Badge tone={j.status === "succeeded" ? "good" : j.status === "failed" ? "bad" : "warn"}>{j.status === "succeeded" ? "Completed" : j.status === "failed" ? "Failed · not charged" : "Canceled · not charged"}</Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
