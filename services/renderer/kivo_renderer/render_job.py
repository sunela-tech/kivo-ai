"""Render one job's frames with Blender.

Runs as a subprocess of the worker so a Blender crash, hang or out-of-memory
kill never takes the worker down. Progress is reported as JSON lines on stdout.

    python -m kivo_renderer.render_job --job job.json --assets ./assets --frames ./frames
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback


def emit(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"event": event, **fields}) + "\n")
    sys.stdout.flush()


def frame_path(frames_dir: str, index: int) -> str:
    return os.path.join(frames_dir, f"frame_{index:05d}.png")


def run(job_path: str, assets_dir: str, frames_dir: str, first: int = 1, last: int | None = None) -> None:
    from .manifest import validate_job

    with open(job_path, "r", encoding="utf-8") as fh:
        job = validate_job(json.load(fh))

    # Imported late: bpy is heavy, and manifest errors should not need it.
    from .scene_builder import SceneBuilder, blend_frames, fade_frame

    os.makedirs(frames_dir, exist_ok=True)
    emit("stage", stage="loading")
    builder = SceneBuilder(job, assets_dir)
    builder.build()
    total = job["settings"]["frames"]
    fps = job["settings"]["fps"]
    last = min(total, last or total)
    exposure = builder.meter_exposure(os.path.dirname(os.path.abspath(frames_dir)))
    print(f"auto exposure: {exposure:+.2f} stops", file=sys.stderr)
    emit("ready", engine=builder.engine, frames=total, notes=builder.notes)

    sampler = builder.sampler
    for index in range(first, last + 1):
        t = (index - 1) / fps
        builder.scene.frame_set(index)
        builder.apply(t)
        out = frame_path(frames_dir, index)
        transition = sampler.transition_at(t)
        if transition["kind"] == "dissolve":
            a = out + ".a.png"
            b = out + ".b.png"
            builder.set_camera(transition["fromCameraId"])
            builder.render_still(a)
            builder.set_camera(transition["toCameraId"])
            builder.render_still(b)
            blend_frames(a, b, float(transition["mix"]), out)
            os.remove(a)
            os.remove(b)
        else:
            shot = sampler.shot_at(t)
            builder.set_camera(shot["cameraId"])
            builder.render_still(out)
            if transition["kind"] == "fade" and transition["level"] < 0.999:
                fade_frame(out, float(transition["level"]))
        emit("frame", done=index, total=total)
    emit("done", frames=last - first + 1)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True)
    parser.add_argument("--assets", required=True)
    parser.add_argument("--frames", required=True)
    parser.add_argument("--first", type=int, default=1)
    parser.add_argument("--last", type=int, default=None)
    args = parser.parse_args(argv)
    try:
        run(args.job, args.assets, args.frames, args.first, args.last)
        return 0
    except Exception as error:  # reported to the worker, which reports to the API
        from .manifest import ManifestError

        code = "invalid_scene" if isinstance(error, ManifestError) else "render_failed"
        emit("error", code=code, message=str(error)[:500])
        traceback.print_exc(file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
