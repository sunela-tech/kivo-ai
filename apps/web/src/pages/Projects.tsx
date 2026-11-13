import { FolderOpen, Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ProjectCard } from "../components/ProjectCard";
import { Button, EmptyState, Loading, Notice, PageHeader, Segmented } from "../components/ui";
import { api, type Project } from "../lib/api";
import { useAsync, useSession } from "../lib/session";

type Filter = "all" | "videos" | "scenes" | "drafts";

export function ProjectsPage() {
  const { activeJobs } = useSession();
  const { data, loading, error } = useAsync(() => api<{ projects: Project[] }>("/projects"), [activeJobs.length]);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.projects ?? []).filter((p) => {
      if (q && !p.title.toLowerCase().includes(q) && !p.prompt.toLowerCase().includes(q)) return false;
      if (filter === "videos") return !!p.latestVideoId;
      if (filter === "scenes") return p.hasScene && !p.latestVideoId;
      if (filter === "drafts") return !p.hasScene;
      return true;
    });
  }, [data, query, filter]);

  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Every video you've started. Open one to watch, edit, re-render or duplicate it."
        actions={
          <Link to="/create">
            <Button variant="primary" icon={<Plus className="size-4" />}>
              New Video
            </Button>
          </Link>
        }
      />
      {error && <Notice tone="bad">{error}</Notice>}
      {loading && !data ? (
        <Loading />
      ) : (data?.projects.length ?? 0) === 0 ? (
        <EmptyState
          icon={<FolderOpen className="size-6" />}
          title="No projects yet"
          action={
            <Link to="/create">
              <Button variant="primary" icon={<Plus className="size-4" />}>
                New Video
              </Button>
            </Link>
          }
        >
          Projects keep your prompt, your 3D scene, and every render.
        </EmptyState>
      ) : (
        <>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
            <div className="relative w-full max-w-xs">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-4" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search projects" aria-label="Search projects" className="field pl-9" />
            </div>
            <Segmented<Filter>
              size="sm"
              label="Filter projects"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "videos", label: "With video" },
                { value: "scenes", label: "Scene only" },
                { value: "drafts", label: "Drafts" },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <p className="py-16 text-center text-sm text-ink-3">No projects match.</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {shown.map((p) => (
                <ProjectCard key={p.id} project={p} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
