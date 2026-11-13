"""HTTP client for the Kivo Worker's render-service API."""

from __future__ import annotations

import os
import time
from typing import Any

import requests

from .config import Config


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(f"Kivo API {status}: {message}")
        self.status = status


class Client:
    def __init__(self, config: Config):
        self.config = config
        self.session = requests.Session()
        self.session.headers.update({"Authorization": f"Bearer {config.token}", "User-Agent": "kivo-renderer/0.1"})

    def _url(self, path: str) -> str:
        return path if path.startswith("http") else f"{self.config.api_url}{path}"

    def _request(self, method: str, path: str, *, retries: int = 4, **kwargs) -> requests.Response:
        delay = 1.0
        for attempt in range(retries + 1):
            try:
                response = self.session.request(method, self._url(path), timeout=kwargs.pop("timeout", 60), **kwargs)
            except requests.RequestException as error:
                if attempt == retries:
                    raise ApiError(0, str(error)) from error
            else:
                if response.status_code < 500 and response.status_code != 429:
                    return response
                if attempt == retries:
                    raise ApiError(response.status_code, response.text[:300])
            time.sleep(delay)
            delay = min(delay * 2, 20)
        raise ApiError(0, "unreachable")

    def claim(self) -> dict[str, Any] | None:
        response = self._request("POST", "/api/render/claim", json={"workerId": self.config.worker_id, "maxPixels": self.config.max_pixels}, retries=1)
        if response.status_code == 204:
            return None
        if response.status_code != 200:
            raise ApiError(response.status_code, response.text[:300])
        return response.json()

    def progress(self, job_id: str, **fields) -> dict[str, Any]:
        response = self._request("POST", f"/api/render/jobs/{job_id}/progress", json={"workerId": self.config.worker_id, **fields}, retries=2)
        if response.status_code == 409:
            return {"cancel": True}
        if response.status_code != 200:
            raise ApiError(response.status_code, response.text[:300])
        return response.json()

    def download(self, url: str, dest: str) -> int:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp = dest + ".part"
        response = self._request("GET", url, stream=True, timeout=300)
        if response.status_code != 200:
            raise ApiError(response.status_code, f"could not download {os.path.basename(dest)}")
        size = 0
        with open(tmp, "wb") as fh:
            for chunk in response.iter_content(1 << 20):
                fh.write(chunk)
                size += len(chunk)
        os.replace(tmp, dest)
        return size

    def upload(self, job_id: str, kind: str, path: str, content_type: str) -> None:
        with open(path, "rb") as fh:
            response = self._request(
                "PUT",
                f"/api/render/jobs/{job_id}/{kind}",
                data=fh.read(),
                headers={"Content-Type": content_type, "X-Kivo-Worker": self.config.worker_id},
                timeout=900,
                retries=3,
            )
        if response.status_code != 200:
            raise ApiError(response.status_code, f"upload of {kind} failed: {response.text[:200]}")

    def complete(self, job_id: str, info: dict[str, Any]) -> dict[str, Any]:
        response = self._request("POST", f"/api/render/jobs/{job_id}/complete", json={"workerId": self.config.worker_id, **info})
        if response.status_code != 200:
            raise ApiError(response.status_code, response.text[:300])
        return response.json()

    def fail(self, job_id: str, code: str, message: str, retryable: bool) -> None:
        try:
            self._request(
                "POST",
                f"/api/render/jobs/{job_id}/fail",
                json={"workerId": self.config.worker_id, "code": code, "message": message[:500], "retryable": retryable},
                retries=3,
            )
        except ApiError:
            pass  # the API's lease sweeper will recover the job
