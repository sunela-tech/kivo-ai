import { RESOLUTIONS, clampRenderToPlan, resolutionRank, type PlanLimits, type Resolution } from "@kivo/shared";
import { Lock, Play } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { JobProgress } from "../components/JobProgress";
import { Button, Notice, cx } from "../components/ui";
import { ApiError, api, type Job } from "../lib/api";
import { useJob, useSession } from "../lib/session";
import { Section } from "./Panels";
import { useEditor } from "./store";

/**
 * Rendering settings. The scene itself is never limited by plan — only the
 * export is. This panel shows exactly what the server will render for the
 * user's plan (the server applies the same limits regardless of what is sent).
 */
export function RenderPanel() {
  const spec = useEditor((s) => s.spec)!;
  const project = useEditor((s) => s.project);
  const projectId = useEditor((s) => s.projectId)!;
  const { me, refresh, activeJobs } = useSession();
  const [resolution, setResolution] = useState<Resolution>((project?.resolution as Resolution) ?? "480p");
  const [jobId, setJobId] = useState<string | null>(activeJobs.find((j) => j.projectId === projectId && j.kind === "render")?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const { job, queue } = useJob(jobId, () => void refresh());
  if (!me) return null;

  const plan = me.plan as unknown as PlanLimits;
  const chosen = resolutionRank(resolution) > resolutionRank(plan.maxResolution) ? plan.maxResolution : resolution;
  const out = clampRenderToPlan({ duration: spec.output.duration, fps: spec.output.fps, aspect: spec.output.aspect, resolution: chosen }, plan);
  const working = !!job && (job.status === "queued" || job.status === "running");
  const prepaid = (project?.prepaidRenders ?? 0) > 0;
  const blocked = !prepaid && me.usage.remaining <= 0;

  const render = async () => {
    setBusy(true);
    setError(null);
    try {
      await useEditor.getState().save();
      const started = await api<{ job: Job }>(`/projects/${projectId}/render`, { body: { resolution: chosen } });
      setJobId(started.job.id);
      await refresh();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Section title="Export">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {RESOLUTIONS.map((r) => {
            const locked = resolutionRank(r) > resolutionRank(plan.maxResolution);
            return (
              <button
                key={r}
                disabled={locked}
                onClick={() => setResolution(r)}
                aria-pressed={chosen === r}
                title={locked ? `Exports above ${plan.maxResolution} need a higher plan` : undefined}
                className={cx(
                  "inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-[11px] font-medium",
                  chosen === r ? "border-violet-500 bg-violet-600/15 text-ink" : "border-line bg-night-850 text-ink-3 hover:text-ink",
                  locked && "opacity-45 hover:text-ink-3",
                )}
              >
                {locked && <Lock className="size-2.5" />}
                {r === "4k" ? "4K" : r}
              </button>
            );
          })}
        </div>
        <dl className="space-y-1.5 text-[11px]">
          {[
            ["Size", `${out.width} × ${out.height}`],
            ["Frame rate", `${out.fps} fps`],
            ["Length", `${out.duration} s · ${Math.round(out.duration * out.fps)} frames`],
            ["Format", "H.264 MP4"],
            ["Watermark", out.watermark ? "Kivo watermark" : "None"],
            ["Priority", me.plan.renderPriorityLabel],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-3">
              <dt className="text-ink-4">{k}</dt>
              <dd className="text-right text-ink-2 tabular-nums">{v}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <div className="space-y-3 p-3">
        {out.adjustments.length > 0 && (
          <Notice tone="info" title={`${me.plan.name} plan export limits`}>
            <ul className="space-y-0.5 text-[11px]">
              {out.adjustments.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[11px]">
              Your scene keeps everything you made. <Link to="/subscription" className="font-medium text-violet-300 underline">Upgrade</Link> to export all of it.
            </p>
          </Notice>
        )}
        {error && (
          <Notice tone="bad" title={error.code === "quota_exceeded" ? "Monthly videos used up" : "Couldn't start the render"}>
            {error.message}
          </Notice>
        )}
        {blocked && !working && !error && (
          <Notice tone="warn" title="No videos left this month">
            You can keep editing. Rendering resumes when your month resets or you <Link to="/subscription" className="underline">upgrade</Link>.
          </Notice>
        )}

        {job ? (
          <div className="rounded-xl border border-line bg-night-850 p-3">
            <JobProgress job={job} queue={queue} compact />
            {job.status === "succeeded" && (
              <Link to={`/projects/${projectId}`} className="mt-3 block">
                <Button variant="primary" className="w-full">
                  Watch the video
                </Button>
              </Link>
            )}
          </div>
        ) : null}

        {!working && (
          <Button variant="primary" className="w-full" onClick={render} loading={busy} disabled={blocked} icon={<Play className="size-4" />}>
            {job?.status === "succeeded" ? "Render again" : "Render video"}
          </Button>
        )}
        <p className="text-center text-[10px] text-ink-4">{prepaid ? "This project's first render is already included." : `Uses 1 of your ${me.usage.remaining} remaining videos. Failed renders are never charged.`}</p>
      </div>
    </div>
  );
}
