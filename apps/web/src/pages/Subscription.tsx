import { PricingTable } from "@clerk/react";
import { Check, Minus } from "lucide-react";
import { clerkAppearance } from "../main";
import { Badge, Loading, PageHeader, cx } from "../components/ui";
import { api, type Plan, type Usage } from "../lib/api";
import { useAsync, useSession } from "../lib/session";

interface UsageEvent {
  id: string;
  kind: "reserve" | "refund";
  reason: string | null;
  created_at: number;
  job_kind: string | null;
  project_title: string | null;
}

const yes = <Check className="mx-auto size-4 text-good" aria-label="Included" />;

function Comparison({ plans, current }: { plans: Plan[]; current: string }) {
  const rows: { label: string; get: (p: Plan) => React.ReactNode }[] = [
    { label: "Monthly price", get: (p) => (p.priceCents === 0 ? "$0" : `$${p.priceCents / 100}`) },
    { label: "Videos / month", get: (p) => p.videosPerMonth },
    { label: "Maximum duration", get: (p) => `${p.maxDurationSec} sec` },
    { label: "Maximum resolution", get: (p) => (p.maxResolution === "4k" ? "4K" : p.maxResolution) },
    { label: "Frame rate", get: (p) => `${p.maxFps} fps` },
    { label: "Concurrent jobs", get: (p) => p.concurrentJobs },
    { label: "3D model quality", get: (p) => p.meshyModel.replace("meshy-", "Meshy ").replace("-lite", " Lite") },
    { label: "Simple Mode", get: () => yes },
    { label: "Advanced Mode", get: () => yes },
    { label: "Full 3D editor", get: () => yes },
    { label: "Animation editor", get: () => yes },
    { label: "Camera editor", get: () => yes },
    { label: "AI Director", get: () => yes },
    { label: "Watermark", get: (p) => (p.watermark ? "Yes" : <Minus className="mx-auto size-4 text-ink-4" aria-label="No watermark" />) },
    { label: "Render priority", get: (p) => p.renderPriorityLabel },
  ];
  return (
    <div className="panel overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="border-b border-line">
            <th className="px-5 py-4 text-left text-xs font-medium text-ink-3">Feature</th>
            {plans.map((p) => (
              <th key={p.id} className={cx("px-4 py-4 text-center font-semibold", p.id === current && "bg-violet-600/10")}>
                {p.name}
                {p.id === current && (
                  <div className="mt-1">
                    <Badge tone="violet">Your plan</Badge>
                  </div>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-line/50 last:border-0">
              <td className="px-5 py-3 text-ink-2">{row.label}</td>
              {plans.map((p) => (
                <td key={p.id} className={cx("px-4 py-3 text-center text-ink-2 tabular-nums", p.id === current && "bg-violet-600/5 text-ink")}>
                  {row.get(p)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SubscriptionPage() {
  const { me, config } = useSession();
  const usage = useAsync(() => api<{ summary: Usage; events: UsageEvent[] }>("/usage"), [me?.usage.used]);
  if (!me) return <Loading />;
  const reset = new Date(me.usage.resetsAt).toLocaleDateString(undefined, { month: "long", day: "numeric" });

  return (
    <>
      <PageHeader title="Subscription" subtitle="Every plan includes the whole studio. Plans change how much you can generate and how big you can export — never which tools you can use." />

      <div className="mb-8 grid gap-4 sm:grid-cols-3">
        <div className="panel p-5">
          <div className="eyebrow">Current plan</div>
          <div className="mt-2 text-2xl font-semibold">{me.plan.name}</div>
          <div className="mt-1 text-xs text-ink-3">{me.plan.priceCents === 0 ? "Free" : `$${me.plan.priceCents / 100} / month`}</div>
        </div>
        <div className="panel p-5">
          <div className="eyebrow">Videos this month</div>
          <div className="mt-2 text-2xl font-semibold tabular-nums">
            {me.usage.used} <span className="text-base font-normal text-ink-3">of {me.usage.limit} used</span>
          </div>
          <div className="mt-1 text-xs text-ink-3">Resets {reset}. Failed and canceled jobs are never counted.</div>
        </div>
        <div className="panel p-5">
          <div className="eyebrow">Exports</div>
          <div className="mt-2 text-2xl font-semibold">
            {me.plan.maxResolution === "4k" ? "4K" : me.plan.maxResolution} · {me.plan.maxFps} fps
          </div>
          <div className="mt-1 text-xs text-ink-3">
            Up to {me.plan.maxDurationSec} seconds{me.plan.watermark ? " · Kivo watermark" : " · no watermark"}
          </div>
        </div>
      </div>

      <section className="mb-10">
        <h2 className="mb-1 text-sm font-semibold text-ink-2">Change plan</h2>
        <p className="mb-4 text-xs text-ink-3">Checkout, upgrades, downgrades and cancellation are handled securely by Clerk Billing. Manage payment methods and invoices under Settings → Account → Billing.</p>
        <PricingTable appearance={clerkAppearance} checkoutProps={{ appearance: clerkAppearance }} fallback={<Loading label="Loading plans" />} newSubscriptionRedirectUrl="/subscription" />
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-sm font-semibold text-ink-2">Compare plans</h2>
        <Comparison plans={config.plans} current={me.plan.id} />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink-2">Usage history</h2>
        {usage.loading && !usage.data ? (
          <Loading />
        ) : (usage.data?.events.length ?? 0) === 0 ? (
          <p className="text-sm text-ink-3">Nothing used yet.</p>
        ) : (
          <ul className="panel divide-y divide-line/60 text-sm">
            {usage.data!.events.slice(0, 30).map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <span className="font-medium">{e.project_title ?? "Deleted project"}</span>
                  <span className="ml-2 text-xs text-ink-4">{new Date(e.created_at).toLocaleString()}</span>
                </div>
                {e.kind === "reserve" ? <Badge>−1 video</Badge> : <Badge tone="good">+1 refunded{e.reason ? ` (${e.reason.replace(/_/g, " ")})` : ""}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
