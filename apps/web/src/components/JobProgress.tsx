import { AlertTriangle, Check, CircleDashed, XCircle } from "lucide-react";
import { useState } from "react";
import { api, type Job } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Notice, Spinner, cx } from "./ui";

/**
 * Generation progress.
 *
 * Shows the stage the job is really in. A bar appears only when the server has
 * a measured number (Meshy task progress, frames rendered) — otherwise the
 * current stage just shows that it is working. No invented percentages.
 */
export function JobProgress({ job, queue, onCanceled, compact }: { job: Job; queue?: { position: number } | null; onCanceled?: () => void; compact?: boolean }) {
  const { config, refresh } = useSession();
  const [canceling, setCanceling] = useState(false);
  const stages = config.stages.filter((s) => job.stages.includes(s.id));
  const currentIndex = stages.findIndex((s) => s.id === job.stage);
  const active = job.status === "queued" || job.status === "running";
  const finished = job.status === "succeeded";

  const cancel = async () => {
    setCanceling(true);
    try {
      await api(`/jobs/${job.id}/cancel`, { method: "POST" });
      await refresh();
      onCanceled?.();
    } finally {
      setCanceling(false);
    }
  };

  return (
    <div className="space-y-4">
      <ol className={cx("grid gap-1", compact ? "grid-cols-1" : "sm:grid-cols-2")}>
        {stages.map((stage, i) => {
          const done = finished || i < currentIndex;
          const current = active && i === currentIndex;
          const failedHere = (job.status === "failed" || job.status === "canceled") && i === currentIndex;
          return (
            <li
              key={stage.id}
              aria-current={current ? "step" : undefined}
              className={cx("flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors", current && "bg-violet-600/10 ring-1 ring-violet-500/30")}
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center">
                {done ? (
                  <Check className="size-4 text-good" />
                ) : current ? (
                  <Spinner className="size-4" />
                ) : failedHere ? (
                  <XCircle className="size-4 text-bad" />
                ) : (
                  <CircleDashed className="size-4 text-ink-4" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className={cx("text-sm font-medium", done ? "text-ink-2" : current ? "text-ink" : failedHere ? "text-bad" : "text-ink-4")}>{stage.label}</div>
                {current && (
                  <div className="mt-1 space-y-1.5">
                    <div className="text-xs text-ink-3">
                      {job.detail ?? stage.detail}
                      {queue && job.stage === "preparing_rendering" ? ` · position ${queue.position} in the render queue` : ""}
                    </div>
                    {job.progress !== null && (
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-panel-3" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(job.progress * 100)}>
                          <div className="h-full rounded-full bg-violet-500 transition-[width] duration-500" style={{ width: `${Math.round(job.progress * 100)}%` }} />
                        </div>
                        <span className="w-9 text-right text-[11px] text-ink-3 tabular-nums">{Math.round(job.progress * 100)}%</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {job.status === "failed" && job.error && (
        <Notice tone="bad" title="Generation failed">
          {job.error.message}
        </Notice>
      )}
      {job.status === "canceled" && <Notice tone="warn" title="Canceled">You canceled this job. Your quota was not charged.</Notice>}
      {job.warnings.length > 0 && (job.status === "succeeded" || active) && (
        <details className="rounded-xl border border-line bg-night-850 px-4 py-3 text-xs text-ink-3">
          <summary className="flex cursor-pointer items-center gap-2 text-ink-2">
            <AlertTriangle className="size-3.5 text-warn" /> {job.warnings.length} note{job.warnings.length === 1 ? "" : "s"} from the pipeline
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            {job.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </details>
      )}
      {active && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-ink-4">You can leave this page — the job keeps running.</span>
          <Button size="sm" variant="ghost" onClick={cancel} loading={canceling} disabled={job.cancelRequested}>
            {job.cancelRequested ? "Canceling…" : "Cancel"}
          </Button>
        </div>
      )}
    </div>
  );
}
