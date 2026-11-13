"""Frames -> H.264 MP4, thumbnail, and verification that the result is playable."""

from __future__ import annotations

import json
import os
import shutil
import subprocess

WATERMARK = os.path.join(os.path.dirname(__file__), "assets", "watermark.png")


class EncodeError(RuntimeError):
    pass


def _tool(name: str) -> str:
    path = shutil.which(name)
    if not path:
        raise EncodeError(f"{name} is not installed on the render worker")
    return path


def _run(cmd: list[str], timeout: int) -> str:
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise EncodeError(f"{os.path.basename(cmd[0])} timed out") from error
    if proc.returncode != 0:
        raise EncodeError(f"{os.path.basename(cmd[0])} failed: {proc.stderr.strip()[-400:]}")
    return proc.stdout


def encode_mp4(frames_dir: str, out_path: str, *, fps: int, width: int, height: int, frames: int, watermark: bool) -> None:
    """Encode frame_00001.png… into a faststart yuv420p H.264 MP4 (plays everywhere, streams from R2)."""
    first = os.path.join(frames_dir, "frame_00001.png")
    last = os.path.join(frames_dir, f"frame_{frames:05d}.png")
    if not os.path.isfile(first) or not os.path.isfile(last):
        raise EncodeError("rendered frames are missing")
    cmd = [_tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-framerate", str(fps), "-start_number", "1",
           "-i", os.path.join(frames_dir, "frame_%05d.png")]
    base = f"scale={width}:{height}:out_color_matrix=bt709:out_range=tv:flags=lanczos"
    if watermark:
        if not os.path.isfile(WATERMARK):
            # Never deliver an unwatermarked video on a plan that requires one.
            raise EncodeError("watermark asset is missing on the render worker")
        mark_w = max(64, int(round(width * 0.13 / 2)) * 2)
        margin = max(8, int(round(height * 0.035)))
        cmd += ["-i", WATERMARK, "-filter_complex",
                f"[1:v]scale={mark_w}:-1:flags=lanczos[wm];[0:v][wm]overlay=W-w-{margin}:H-h-{margin}:format=auto,{base},format=yuv420p[v]",
                "-map", "[v]"]
    else:
        cmd += ["-vf", f"{base},format=yuv420p"]
    crf = "17" if width * height >= 1920 * 1080 else "18"
    cmd += ["-frames:v", str(frames), "-c:v", "libx264", "-preset", "medium", "-crf", crf, "-profile:v", "high",
            "-pix_fmt", "yuv420p", "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-r", str(fps), "-movflags", "+faststart", "-an", out_path]
    _run(cmd, timeout=max(600, frames * 4))


def make_thumbnail(frames_dir: str, frames: int, out_path: str, max_width: int = 640) -> None:
    index = max(1, min(frames, int(frames * 0.4) + 1))
    src = os.path.join(frames_dir, f"frame_{index:05d}.png")
    _run([_tool("ffmpeg"), "-hide_banner", "-loglevel", "error", "-y", "-i", src,
          "-vf", f"scale='min({max_width},iw)':-2:flags=lanczos", "-frames:v", "1", "-q:v", "3", out_path], timeout=120)


def probe(path: str) -> dict:
    out = _run([_tool("ffprobe"), "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries",
                "stream=codec_name,pix_fmt,width,height,nb_read_frames,avg_frame_rate:format=duration,format_name",
                "-of", "json", path], timeout=600)
    data = json.loads(out)
    streams = data.get("streams") or []
    if not streams:
        raise EncodeError("the encoded file has no video stream")
    s = streams[0]
    num, _, den = (s.get("avg_frame_rate") or "0/1").partition("/")
    return {
        "codec": s.get("codec_name"),
        "pix_fmt": s.get("pix_fmt"),
        "width": int(s.get("width") or 0),
        "height": int(s.get("height") or 0),
        "frames": int(s.get("nb_read_frames") or 0),
        "fps": (float(num) / float(den or 1)) if float(den or 1) else 0.0,
        "duration": float((data.get("format") or {}).get("duration") or 0),
        "bytes": os.path.getsize(path),
    }


def verify_mp4(path: str, *, width: int, height: int, frames: int, fps: int) -> dict:
    """Decode-check the file. A job is only reported complete if this passes."""
    info = probe(path)
    problems = []
    if info["codec"] != "h264":
        problems.append(f"codec is {info['codec']}")
    if info["pix_fmt"] != "yuv420p":
        problems.append(f"pixel format is {info['pix_fmt']}")
    if (info["width"], info["height"]) != (width, height):
        problems.append(f"size is {info['width']}x{info['height']}")
    if info["frames"] != frames:
        problems.append(f"{info['frames']} frames decoded, expected {frames}")
    if abs(info["fps"] - fps) > 0.01:
        problems.append(f"frame rate is {info['fps']:.3f}")
    if info["bytes"] < 1024:
        problems.append("file is too small")
    if problems:
        raise EncodeError("encoded video failed verification: " + "; ".join(problems))
    return info
