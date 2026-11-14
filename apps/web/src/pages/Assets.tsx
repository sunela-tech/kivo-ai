import { Bone, Shapes, Trash2 } from "lucide-react";
import { useState } from "react";
import { Badge, EmptyState, Loading, Notice, PageHeader, Segmented } from "../components/ui";
import { api, formatBytes, timeAgo, type Asset } from "../lib/api";
import { useAsync, useSession } from "../lib/session";

type Filter = "all" | "characters" | "world" | "props";
const WORLD = ["building", "terrain", "vegetation"];

export function rigLabel(asset: Asset): { text: string; tone: "good" | "warn" | "neutral" } {
  if (asset.rigStatus === "rigged") return { text: "Rigged", tone: "good" };
  if (asset.rigStatus === "unsupported" || asset.rigStatus === "failed") return { text: "Rig not possible", tone: "warn" };
  if (asset.rigStatus === "pending") return { text: "Rigging", tone: "neutral" };
  return { text: "Rigid body", tone: "neutral" };
}

export function AssetsPage() {
  const { activeJobs } = useSession();
  const { data, loading, error, reload } = useAsync(() => api<{ assets: Asset[] }>("/assets"), [activeJobs.length]);
  const [filter, setFilter] = useState<Filter>("all");
  const [message, setMessage] = useState<string | null>(null);

  const shown = (data?.assets ?? []).filter((a) => {
    if (filter === "characters") return a.kind === "character" || a.kind === "creature";
    if (filter === "world") return WORLD.includes(a.kind);
    if (filter === "props") return !WORLD.includes(a.kind) && a.kind !== "character" && a.kind !== "creature";
    return true;
  });

  const remove = async (asset: Asset) => {
    setMessage(null);
    try {
      await api(`/assets/${asset.id}`, { method: "DELETE" });
      reload();
    } catch (e) {
      setMessage((e as Error).message);
    }
  };

  return (
    <>
      <PageHeader title="Assets" subtitle="Every 3D model Meshy has generated for you. Kivo reuses a model whenever a new scene asks for the same thing, so it isn't generated twice." />
      {error && <Notice tone="bad">{error}</Notice>}
      {message && (
        <div className="mb-4">
          <Notice tone="warn">{message}</Notice>
        </div>
      )}
      {loading && !data ? (
        <Loading />
      ) : (data?.assets.length ?? 0) === 0 ? (
        <EmptyState icon={<Shapes className="size-6" />} title="No models yet">
          Models appear here as soon as your first scene is generated.
        </EmptyState>
      ) : (
        <>
          <div className="mb-6">
            <Segmented<Filter>
              size="sm"
              label="Filter models"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All (${data!.assets.length})` },
                { value: "characters", label: "Characters" },
                { value: "world", label: "World" },
                { value: "props", label: "Props" },
              ]}
            />
          </div>
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {shown.map((a) => {
              const rig = rigLabel(a);
              return (
                <li key={a.id} className="panel overflow-hidden">
                  <div className="relative aspect-square bg-night-850">
                    {a.thumbnailUrl ? (
                      <img src={a.thumbnailUrl} alt={a.name} loading="lazy" className="size-full object-contain p-3" />
                    ) : (
                      <div className="flex size-full items-center justify-center text-ink-4">
                        <Shapes className="size-8" />
                      </div>
                    )}
                    <div className="absolute top-2.5 left-2.5 flex gap-1.5">
                      <Badge tone={a.status === "ready" ? "good" : a.status === "failed" ? "bad" : "violet"}>{a.statusLabel}</Badge>
                    </div>
                  </div>
                  <div className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{a.name}</div>
                        <div className="mt-0.5 text-xs text-ink-3 capitalize">
                          {a.kind} · {a.meshyModel.replace("meshy-", "Meshy ")}
                        </div>
                      </div>
                      {(a.projectCount ?? 0) === 0 && (
                        <button onClick={() => remove(a)} aria-label={`Delete ${a.name}`} className="rounded-lg p-1.5 text-ink-4 hover:bg-panel-3 hover:text-bad">
                          <Trash2 className="size-3.5" />
                        </button>
                      )}
                    </div>
                    <p className="mt-2 line-clamp-2 text-xs text-ink-3" title={a.prompt}>
                      {a.prompt}
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {a.fromImage && <Badge tone="violet">From your image</Badge>}
                      {(a.rigRequested || a.rigStatus !== "none") && (
                        <Badge tone={rig.tone}>
                          <Bone className="size-3" /> {rig.text}
                        </Badge>
                      )}
                      {a.clipNames.length > 0 && <Badge>{a.clipNames.length} clips</Badge>}
                      {a.bytes > 0 && <Badge>{formatBytes(a.bytes)}</Badge>}
                    </div>
                    {a.rigNote && <p className="mt-2 text-[11px] leading-snug text-warn/90">{a.rigNote}</p>}
                    {a.note && a.status !== "ready" && <p className="mt-2 text-[11px] leading-snug text-bad">{a.note}</p>}
                    <div className="mt-3 text-[11px] text-ink-4">
                      Used in {a.projectCount ?? 0} project{a.projectCount === 1 ? "" : "s"} · {timeAgo(a.lastUsedAt)}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
