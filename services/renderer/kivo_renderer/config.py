"""Render worker configuration, read from the environment."""

from __future__ import annotations

import os
import socket
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    api_url: str
    token: str
    worker_id: str
    work_dir: str
    poll_seconds: float
    max_pixels: int
    keep_work: bool

    @staticmethod
    def from_env() -> "Config":
        api_url = os.environ.get("KIVO_API_URL", "").rstrip("/")
        token = os.environ.get("KIVO_RENDER_TOKEN", "")
        if not api_url:
            raise SystemExit("KIVO_API_URL is not set (the URL of the Kivo Worker, e.g. https://kivo.example.workers.dev)")
        if not token:
            raise SystemExit("KIVO_RENDER_TOKEN is not set (must match the Worker's RENDER_SERVICE_TOKEN secret)")
        return Config(
            api_url=api_url,
            token=token,
            worker_id=os.environ.get("KIVO_WORKER_ID") or f"{socket.gethostname()}-{os.getpid()}",
            work_dir=os.path.abspath(os.environ.get("KIVO_WORK_DIR", "./work")),
            poll_seconds=float(os.environ.get("KIVO_POLL_SECONDS", "5")),
            max_pixels=int(os.environ.get("KIVO_MAX_PIXELS", str(3840 * 2160))),
            keep_work=os.environ.get("KIVO_KEEP_WORK", "") == "1",
        )
