import { Clapperboard } from "lucide-react";
import { Link } from "react-router";
import { timeAgo, type Project } from "../lib/api";
import { Badge } from "./ui";

const STATUS: Record<Project["status"], { label: string; tone: "neutral" | "violet" | "good" | "warn" | "bad" }> = {
  draft: { label: "Draft", tone: "neutral" },
  generating: { label: "Generating", tone: "violet" },
  scene_ready: { label: "Scene ready", tone: "violet" },
  rendering: { label: "Rendering", tone: "violet" },
  ready: { label: "Video ready", tone: "good" },
  failed: { label: "Failed", tone: "bad" },
};

export function ProjectCard({ project }: { project: Project }) {
  const status = STATUS[project.status];
  return (
    <Link to={`/projects/${project.id}`} className="group panel block overflow-hidden transition-colors hover:border-line-2">
      <div className="relative aspect-video overflow-hidden bg-night-850">
        {project.thumbnailUrl ? (
          <img src={project.thumbnailUrl} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        ) : (
          <div className="flex size-full items-center justify-center text-ink-4">
            <Clapperboard className="size-8" />
          </div>
        )}
        <div className="absolute top-2.5 left-2.5">
          <Badge tone={status.tone}>{status.label}</Badge>
        </div>
      </div>
      <div className="p-4">
        <div className="truncate text-sm font-semibold">{project.title}</div>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-3">
          <span>{timeAgo(project.updatedAt)}</span>
          <span aria-hidden>·</span>
          <span>
            {project.duration}s · {project.aspect}
          </span>
        </div>
      </div>
    </Link>
  );
}
