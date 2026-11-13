"""Kivo render worker.

Pulls render jobs from the Kivo Worker API (highest plan priority first),
renders them with Blender in a subprocess, encodes H.264 MP4 with ffmpeg,
verifies the file decodes, uploads it, and only then reports completion.

    KIVO_API_URL=https://… KIVO_RENDER_TOKEN=… python -m kivo_renderer.worker
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Any

from .client import ApiError, Client
from .config import Config
from .encode import EncodeError, encode_mp4, make_thumbnail, verify_mp4
from .manifest import ManifestError, validate_job

log = logging.getLogger("kivo.renderer")


def _span(seconds: float) -> str:
    seconds = max(0.0, seconds)
    if seconds >= 5400:
        return f"{seconds / 3600:.0f} hours"
    if seconds >= 90:
        return f"{seconds / 60:.0f} minutes"
    return f"{seconds:.0f} seconds"


def projected_overrun(first: tuple[float, int], now: float, done: int, total: int, deadline: float,
                      *, min_frames: int = 2, min_seconds: float = 15.0, margin: float = 1.5) -> str | None:
    """Can the remaining frames still finish before the deadline at the pace measured so far?

    `first` is (time, frames done) when the first frame finished, so start-up cost is not counted.
    Returns None while the job can still make it (or it is too early to tell); otherwise a sentence
    saying why it cannot. A job is only given up on when it would overrun by more than `margin`,
    because later shots can be lighter than the first ones.
    """
    started, base = first
    measured = done - base
    if measured < min_frames or now - started < min_seconds or done >= total:
        return None
    per_frame = (now - started) / measured
    remaining = per_frame * (total - done)
    left = max(0.0, deadline - now)
    if remaining <= left * margin:
        return None
    return (f"at about {per_frame:.0f} s per frame on this render worker, the remaining {total - done} of {total} frames "
            f"would take about {_span(remaining)}, but only {_span(left)} of the time limit is left")


class Canceled(Exception):
    pass


class JobFailed(Exception):
    def __init__(self, code: str, message: str, retryable: bool):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class Heartbeat:
    """Keeps the job's lease alive during phases that have no per-frame progress."""

    def __init__(self, client: Client, job_id: str, phase: str, interval: float = 20.0):
        self.client, self.job_id, self.phase, self.interval = client, job_id, phase, interval
        self.cancel = False
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)

    def _run(self) -> None:
        while not self._stop.wait(self.interval):
            try:
                if self.client.progress(self.job_id, phase=self.phase).get("cancel"):
                    self.cancel = True
            except ApiError as error:
                log.warning("heartbeat failed: %s", error)

    def __enter__(self) -> "Heartbeat":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        self._thread.join(timeout=5)


class Worker:
    def __init__(self, config: Config):
        self.config = config
        self.client = Client(config)
        self.stopping = False
        self.child: subprocess.Popen | None = None

    # ---- lifecycle ----

    def stop(self, *_args) -> None:
        log.info("shutdown requested; finishing up")
        self.stopping = True
        if self.child and self.child.poll() is None:
            self.child.terminate()

    def run_forever(self) -> None:
        signal.signal(signal.SIGTERM, self.stop)
        signal.signal(signal.SIGINT, self.stop)
        log.info("render worker %s polling %s", self.config.worker_id, self.config.api_url)
        while not self.stopping:
            try:
                job = self.client.claim()
            except ApiError as error:
                log.warning("claim failed: %s", error)
                job = None
            if job is None:
                time.sleep(self.config.poll_seconds)
                continue
            self.run_job(job)

    def run_once(self) -> bool:
        job = self.client.claim()
        if job is None:
            return False
        self.run_job(job)
        return True

    # ---- one job ----

    def run_job(self, job: dict[str, Any]) -> None:
        job_id = job["renderJobId"]
        work = os.path.join(self.config.work_dir, job_id)
        log.info("job %s claimed", job_id)
        try:
            shutil.rmtree(work, ignore_errors=True)
            os.makedirs(work, exist_ok=True)
            result = self._render(job, work)
            self.client.complete(job_id, result)
            log.info("job %s complete: %s", job_id, result)
        except Canceled:
            log.info("job %s canceled", job_id)
        except JobFailed as error:
            log.error("job %s failed (%s): %s", job_id, error.code, error)
            self.client.fail(job_id, error.code, str(error), error.retryable)
        except ApiError as error:
            log.error("job %s: API error: %s", job_id, error)
            self.client.fail(job_id, "storage_error" if error.status in (0, 413, 507) else "render_failed", str(error), True)
        except Exception as error:  # noqa: BLE001 — report anything rather than leaving a job hanging
            log.exception("job %s crashed", job_id)
            self.client.fail(job_id, "render_failed", f"{type(error).__name__}: {error}", True)
        finally:
            if not self.config.keep_work:
                shutil.rmtree(work, ignore_errors=True)

    def _render(self, job: dict[str, Any], work: str) -> dict[str, Any]:
        job_id = job["renderJobId"]
        try:
            valid = validate_job(job)
        except ManifestError as error:
            raise JobFailed("invalid_scene", str(error), False) from error
        settings = valid["settings"]
        deadline = time.time() + settings["maxRenderSeconds"]

        # 1. Models
        self._report(job_id, phase="preparing")
        assets_dir = os.path.join(work, "assets")
        for asset_id, entry in job["assets"].items():
            for file_name, meta in (entry.get("files") or {}).items():
                size = self.client.download(meta["url"], os.path.join(assets_dir, asset_id, os.path.basename(file_name)))
                if size == 0:
                    raise JobFailed("storage_error", f'model file for "{asset_id}" is empty', True)

        local_job = {"settings": job["settings"], "scene": job["scene"],
                     "assets": {k: {"model": v.get("model"), "rigged": v.get("rigged"), "clips": v.get("clips") or {}} for k, v in job["assets"].items()}}
        job_path = os.path.join(work, "job.json")
        with open(job_path, "w", encoding="utf-8") as fh:
            json.dump(local_job, fh)

        # 2. Frames (Blender subprocess)
        frames_dir = os.path.join(work, "frames")
        total = settings["frames"]
        notes, engine = self._render_frames(job_id, job_path, assets_dir, frames_dir, total, deadline)

        # 3. Encode + verify
        video = os.path.join(work, "video.mp4")
        thumb = os.path.join(work, "thumbnail.jpg")
        with Heartbeat(self.client, job_id, "encoding") as beat:
            self._report(job_id, phase="encoding", framesDone=total, framesTotal=total)
            try:
                encode_mp4(frames_dir, video, fps=settings["fps"], width=settings["width"], height=settings["height"],
                           frames=total, watermark=settings["watermark"])
                info = verify_mp4(video, width=settings["width"], height=settings["height"], frames=total, fps=settings["fps"])
                make_thumbnail(frames_dir, total, thumb)
            except EncodeError as error:
                raise JobFailed("render_failed", str(error), True) from error
            if beat.cancel:
                raise Canceled()

        # 4. Upload
        with Heartbeat(self.client, job_id, "uploading") as beat:
            self._report(job_id, phase="uploading")
            self.client.upload(job_id, "thumbnail", thumb, "image/jpeg")
            self.client.upload(job_id, "video", video, "video/mp4")
            if beat.cancel:
                raise Canceled()

        return {"width": info["width"], "height": info["height"], "fps": settings["fps"], "frames": info["frames"],
                "durationSeconds": round(info["duration"], 3), "bytes": info["bytes"], "codec": info["codec"],
                "watermark": settings["watermark"], "engine": engine, "notes": notes}

    def _report(self, job_id: str, **fields) -> None:
        if self.client.progress(job_id, **fields).get("cancel"):
            raise Canceled()

    def _render_frames(self, job_id: str, job_path: str, assets_dir: str, frames_dir: str, total: int, deadline: float) -> tuple[list[str], str]:
        cmd = [sys.executable, "-m", "kivo_renderer.render_job", "--job", job_path, "--assets", assets_dir, "--frames", frames_dir]
        log_path = os.path.join(os.path.dirname(job_path), "blender.log")
        notes: list[str] = []
        engine = "unknown"
        error: dict[str, Any] | None = None
        last_report = 0.0
        done = 0
        pace: tuple[float, int] | None = None
        too_slow: str | None = None
        with open(log_path, "w", encoding="utf-8") as log_file:
            self.child = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=log_file, text=True, bufsize=1,
                                          cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
            child = self.child
            watchdog = threading.Timer(max(1.0, deadline - time.time()), child.kill)
            watchdog.daemon = True
            watchdog.start()
            try:
                assert child.stdout is not None
                for line in child.stdout:
                    line = line.strip()
                    if not line.startswith("{"):
                        continue
                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    kind = event.get("event")
                    if kind == "ready":
                        notes = list(event.get("notes") or [])
                        engine = event.get("engine", engine)
                        self._report(job_id, phase="rendering", framesDone=0, framesTotal=total, engine=engine)
                    elif kind == "frame":
                        done = int(event["done"])
                        now = time.time()
                        # Give up early on a job that cannot finish in time, instead of rendering for
                        # hours and failing at the deadline: the user gets the answer in minutes.
                        if pace is None:
                            pace = (now, done)
                        else:
                            too_slow = projected_overrun(pace, now, done, total, deadline)
                            if too_slow:
                                child.kill()
                                break
                        if now - last_report >= 2.0 or done == total:
                            last_report = now
                            self._report(job_id, phase="rendering", framesDone=done, framesTotal=total)
                    elif kind == "error":
                        error = event
                code = child.wait()
            except Canceled:
                child.kill()
                child.wait()
                raise
            finally:
                watchdog.cancel()
                self.child = None
        if self.stopping:
            raise JobFailed("interrupted", "the render worker was shut down mid-job", True)
        if too_slow:
            raise JobFailed("render_timeout", f"stopped after {done} frames: {too_slow}", False)
        if time.time() >= deadline and code != 0:
            raise JobFailed("render_timeout", f"rendering exceeded the time limit after {done} of {total} frames", False)
        if code != 0:
            if error is not None:
                raise JobFailed(error.get("code", "render_failed"), error.get("message", "Blender failed"), error.get("code") != "invalid_scene")
            tail = ""
            try:
                with open(log_path, "r", encoding="utf-8", errors="replace") as fh:
                    tail = fh.read()[-400:]
            except OSError:
                pass
            raise JobFailed("render_failed", f"Blender exited with code {code} after {done} of {total} frames. {tail}".strip(), True)
        if done != total:
            raise JobFailed("render_failed", f"Blender rendered {done} of {total} frames", True)
        return notes, engine


def main() -> None:
    logging.basicConfig(level=os.environ.get("KIVO_LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    worker = Worker(Config.from_env())
    if "--once" in sys.argv:
        sys.exit(0 if worker.run_once() else 3)
    worker.run_forever()


if __name__ == "__main__":
    main()
