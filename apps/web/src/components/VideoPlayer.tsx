import { Download } from "lucide-react";
import { formatBytes, type Video } from "../lib/api";
import { Badge, Button } from "./ui";

/** Plays a finished video. Only ever rendered for a video the server has stored and verified. */
export function VideoPlayer({ video, title }: { video: Video; title: string }) {
  if (!video.url) return null;
  return (
    <div className="space-y-3">
      <div className="overflow-hidden rounded-2xl border border-line bg-black" style={{ aspectRatio: `${video.width} / ${video.height}`, maxHeight: "70dvh" }}>
        <video key={video.id} src={video.url} poster={video.thumbnailUrl ?? undefined} controls playsInline preload="metadata" className="size-full" aria-label={title} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge>
            {video.width}×{video.height}
          </Badge>
          <Badge>{video.fps} fps</Badge>
          <Badge>{video.duration.toFixed(1)} s</Badge>
          <Badge>H.264 MP4</Badge>
          <Badge>{formatBytes(video.bytes)}</Badge>
          {video.watermark && <Badge tone="warn">Watermark</Badge>}
        </div>
        {video.downloadUrl && (
          <a href={video.downloadUrl} download>
            <Button variant="secondary" size="sm" icon={<Download className="size-3.5" />}>
              Download MP4
            </Button>
          </a>
        )}
      </div>
    </div>
  );
}
