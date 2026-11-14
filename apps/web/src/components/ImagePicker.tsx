import { ImagePlus, X } from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { IMAGE_ACCEPT } from "../lib/images";
import { Spinner, cx } from "./ui";

/** An image attached to the idea: already uploaded, or waiting to be uploaded with the project. */
export interface AttachedImage {
  key: string;
  name: string;
  preview: string;
  /** Set once the image is stored with the project. */
  id?: string;
  blob?: Blob;
  busy?: boolean;
}

/**
 * Lets the user add pictures of the things they want in their video. Each usable picture
 * becomes one 3D model, so the limit follows the plan's models-per-scene limit.
 */
export function ImagePicker({
  images,
  max,
  disabled,
  onAdd,
  onRemove,
}: {
  images: AttachedImage[];
  max: number;
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (image: AttachedImage) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const full = images.length >= max;

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (disabled || full) return;
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"));
    if (files.length) onAdd(files);
  };

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <span className="label">
          Images <span className="font-normal text-ink-4">(optional)</span>
        </span>
        <span className="text-xs tabular-nums text-ink-4">
          {images.length} of {max}
        </span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled && !full) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        className={cx("rounded-xl border border-dashed p-3 transition-colors", over ? "border-violet-500 bg-violet-600/10" : "border-line bg-night-850/60")}
      >
        <ul className="flex flex-wrap gap-3">
          {images.map((image) => (
            <li key={image.key} className="relative size-24 overflow-hidden rounded-lg border border-line bg-night-900">
              <img src={image.preview} alt={image.name || "Uploaded image"} className="size-full object-contain" />
              {image.busy ? (
                <div className="absolute inset-0 grid place-items-center bg-night-950/70">
                  <Spinner className="size-5" />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => onRemove(image)}
                  disabled={disabled}
                  aria-label={`Remove ${image.name || "image"}`}
                  className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-night-950/85 text-ink-2 transition-colors hover:bg-bad hover:text-night-950 disabled:opacity-40"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          ))}
          {!full && (
            <li>
              <button
                type="button"
                onClick={() => input.current?.click()}
                disabled={disabled}
                className="flex size-24 flex-col items-center justify-center gap-1.5 rounded-lg border border-line bg-night-850 text-xs text-ink-3 transition-colors hover:border-line-2 hover:text-ink disabled:opacity-50"
              >
                <ImagePlus className="size-5" />
                Add image
              </button>
            </li>
          )}
        </ul>
        <p className="mt-3 text-xs leading-relaxed text-ink-3">
          Kivo turns each image into a 3D model and puts it in your scene. Use a picture of one object or character, ideally on a plain background. JPG, PNG or WebP; drop files here or use the button.
        </p>
      </div>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) onAdd(files);
        }}
      />
    </div>
  );
}
