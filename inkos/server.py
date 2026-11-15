"""Local inference server and model dashboard backend.

  python -m inkos serve            ->  http://127.0.0.1:8765

Standard library only. Serves the HTML interface from web/ and a small JSON
API. Generation runs in one worker thread (jobs queue up); training runs in a
separate process started with the same command you would type yourself, so
training and inference never share state except the files on disk.

The server binds to 127.0.0.1 unless told otherwise and needs no internet.
"""
from __future__ import annotations

import json
import os
import queue
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from . import __version__, bitmap, hardware, paths, plans
from .config import load_config, model_ids
from .engine import Engine, all_status, model_status
from .training.trainer import pid_alive, read_state

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$")
FILE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.png$")
MAX_BODY = 64 * 1024
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".json": "application/json",
        ".svg": "image/svg+xml", ".ico": "image/x-icon"}


class ApiError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


# --------------------------------------------------------------------------
# generation jobs
# --------------------------------------------------------------------------

class Jobs:
    def __init__(self, engine: Engine):
        self.engine = engine
        self.jobs: dict[str, dict] = {}
        self.order: list[str] = []
        self.q: queue.Queue = queue.Queue()
        self.lock = threading.Lock()
        threading.Thread(target=self._work, daemon=True, name="inkos-generate").start()

    def submit(self, req: dict) -> dict:
        job = {"id": uuid.uuid4().hex[:12], "status": "queued", "request": req, "created": time.time(),
               "progress": {"stage": "waiting", "fraction": 0.0, "detail": ""}, "result": None, "error": None}
        with self.lock:
            self.jobs[job["id"]] = job
            self.order.append(job["id"])
            for old in self.order[:-100]:
                self.jobs.pop(old, None)
            self.order = self.order[-100:]
            job["queue_position"] = self.q.qsize()
        self.q.put(job["id"])
        return job

    def get(self, job_id: str) -> dict | None:
        return self.jobs.get(job_id)

    def _work(self):
        while True:
            job = self.jobs.get(self.q.get())
            if job is None:
                continue
            job["status"] = "running"
            job["started"] = time.time()
            req = job["request"]
            try:
                res = self.engine.generate(req["model"], req["prompt"], size=req.get("size"), seed=req.get("seed"),
                                           steps=req.get("steps"), guidance=req.get("guidance"),
                                           temperature=req.get("temperature"),
                                           progress=lambda p, j=job: j.__setitem__("progress", p))
                meta = res["meta"]
                meta["project"] = req["project"]
                stem = f"{time.strftime('%Y%m%d-%H%M%S')}-{req['model']}-{meta['seed']}"
                folder = paths.PROJECTS / req["project"]
                bitmap.save_png(res["image"], folder / f"{stem}.png")
                meta["file"] = f"{stem}.png"
                meta["bytes"] = (folder / f"{stem}.png").stat().st_size
                meta["plan"] = plans.current()["id"]
                (folder / f"{stem}.json").write_text(json.dumps(meta, indent=2))
                plans.record_image()
                job["result"] = {"url": f"/files/{req['project']}/{stem}.png", "meta": meta}
                job["progress"] = {"stage": "done", "fraction": 1.0, "detail": ""}
                job["status"] = "done"
            except Exception as e:  # report, never crash the worker
                job["error"] = str(e)
                job["status"] = "error"
            job["finished"] = time.time()


# --------------------------------------------------------------------------
# training history (read incrementally; files can grow large)
# --------------------------------------------------------------------------

class History:
    def __init__(self):
        self.state: dict[str, dict] = {}
        self.lock = threading.Lock()

    def read(self, model_id: str) -> dict:
        f = paths.run_dir(model_id) / "metrics.jsonl"
        with self.lock:
            st = self.state.setdefault(model_id, {"offset": 0, "train": [], "val": [], "stride": 1, "seen": 0, "ino": None})
            try:
                stat = f.stat()
            except OSError:
                self.state.pop(model_id, None)
                return {"train": [], "val": []}
            if stat.st_ino != st["ino"] or stat.st_size < st["offset"]:
                st.update(offset=0, train=[], val=[], stride=1, seen=0, ino=stat.st_ino)
            with open(f) as fh:
                fh.seek(st["offset"])
                for line in fh:
                    if not line.endswith("\n"):
                        break                                 # half-written last line: read it next time
                    st["offset"] += len(line.encode())
                    try:
                        r = json.loads(line)
                    except ValueError:
                        continue
                    if r.get("type") == "train":
                        st["seen"] += 1
                        if st["seen"] % st["stride"] == 0:
                            st["train"].append([r["step"], r["epoch"], r["loss"]])
                            if len(st["train"]) > 1200:       # keep the curve small: halve its resolution
                                st["train"] = st["train"][::2]
                                st["stride"] *= 2
                    elif r.get("type") == "val":
                        st["val"].append([r["step"], r["epoch"], r.get("loss")])
            return {"train": st["train"], "val": st["val"][-400:]}


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

def project_name(raw) -> str:
    name = (raw or "default").strip()
    if not NAME_RE.match(name):
        raise ApiError(400, "project names use letters, digits, space, '-' and '_' (max 40 characters)")
    return name


def list_projects() -> list[dict]:
    paths.PROJECTS.mkdir(parents=True, exist_ok=True)
    out = [{"name": d.name, "images": len(list(d.glob("*.png")))}
           for d in sorted(paths.PROJECTS.iterdir()) if d.is_dir() and NAME_RE.match(d.name)]
    if not any(p["name"] == "default" for p in out):
        out.insert(0, {"name": "default", "images": 0})
    return out


def list_gallery(project: str, limit: int = 200) -> list[dict]:
    folder = paths.PROJECTS / project
    items = []
    for png in sorted(folder.glob("*.png"), reverse=True)[:limit]:
        try:
            meta = json.loads(png.with_suffix(".json").read_text())
        except (OSError, ValueError):
            meta = {}
        items.append({"file": png.name, "url": f"/files/{project}/{png.name}", "meta": meta})
    return items


def start_training(model_id: str, max_hours: float | None) -> dict:
    st = read_state(model_id)
    if st and st.get("status") == "training" and pid_alive(st.get("pid")):
        raise ApiError(409, "this model is already training")
    from .data import store
    if not store.dataset_info(paths.data_dir(model_id)):
        raise ApiError(409, f"no training data yet. Run:  python -m inkos data prepare --model {model_id}")
    run = paths.run_dir(model_id)
    run.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "inkos", "train", "--model", model_id]
    if max_hours:
        cmd += ["--max-hours", str(float(max_hours))]
    env = dict(os.environ, INKOS_HOME=str(paths.ROOT), PYTHONPATH=str(paths.ROOT) + os.pathsep + os.environ.get("PYTHONPATH", ""))
    out = open(run / "server-train.out", "ab")
    proc = subprocess.Popen(cmd, cwd=str(paths.ROOT), env=env, stdout=out, stderr=subprocess.STDOUT,
                            start_new_session=True)
    return {"started": True, "pid": proc.pid, "command": " ".join(cmd[1:])}


def stop_training(model_id: str) -> dict:
    st = read_state(model_id)
    if not st or st.get("status") != "training" or not pid_alive(st.get("pid")):
        raise ApiError(409, "this model is not training")
    os.kill(int(st["pid"]), signal.SIGTERM)
    return {"stopping": True, "pid": st["pid"]}


def log_tail(model_id: str, lines: int = 8) -> list[str]:
    f = paths.run_dir(model_id) / "train.log"
    try:
        with open(f, "rb") as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 6000))
            return fh.read().decode("utf-8", "replace").splitlines()[-lines:]
    except OSError:
        return []


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

class App:
    def __init__(self, device: str | None = None):
        self.engine = Engine(device)
        self.jobs = Jobs(self.engine)
        self.history = History()
        self.started = time.strftime("%Y-%m-%dT%H:%M:%S")
        self.hw = hardware.probe()

    def status(self) -> dict:
        self.hw = hardware.probe()
        models = all_status()
        plan = plans.summary()
        allowed = set(next(p for p in plan["plans"] if p["id"] == plan["current"])["models"])
        for m in models:
            m["checks"] = hardware.checks(self.hw, m)
            m["bench"] = hardware.read_bench().get(m["id"])
            m["in_plan"] = m["id"] in allowed
        return {"server": {"version": __version__, "started": self.started, "device": str(self.engine.device),
                           "home": str(paths.ROOT)},
                "hardware": self.hw, "models": models, "plan": plan}


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"inkos/{__version__}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):       # quiet: only failures
            if args and str(args[1]).startswith(("4", "5")):
                sys.stderr.write("[inkos] %s %s\n" % (self.address_string(), fmt % args))

        # -- plumbing -------------------------------------------------------
        def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None):
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def _json(self, obj, status: int = 200):
            self._send(status, json.dumps(obj).encode(), "application/json")

        def _file(self, path: Path, root: Path, download: bool = False):
            try:
                path = path.resolve()
                path.relative_to(root.resolve())
            except (ValueError, OSError):
                raise ApiError(404, "not found")
            if not path.is_file():
                raise ApiError(404, "not found")
            extra = {"Content-Disposition": f'attachment; filename="{path.name}"'} if download else None
            self._send(200, path.read_bytes(), MIME.get(path.suffix.lower(), "application/octet-stream"), extra)

        def _body(self) -> dict:
            if self.headers.get("X-Inkos") != "1":
                raise ApiError(403, "requests that change state must come from the INKOS interface")
            n = int(self.headers.get("Content-Length") or 0)
            if n > MAX_BODY:
                raise ApiError(413, "request too large")
            try:
                data = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                raise ApiError(400, "body must be JSON")
            if not isinstance(data, dict):
                raise ApiError(400, "body must be a JSON object")
            return data

        def _model(self, raw) -> str:
            if raw not in model_ids():
                raise ApiError(400, f"unknown model; choose one of {model_ids()}")
            return raw

        def _dispatch(self, fn):
            try:
                fn()
            except ApiError as e:
                self._json({"error": str(e)}, e.status)
            except plans.PlanError as e:
                self._json({"error": str(e), "plan": plans.current()["id"]}, 403)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as e:
                self._json({"error": f"{type(e).__name__}: {e}"}, 500)

        # -- GET ---------------------------------------------------------------
        def do_GET(self):
            self._dispatch(self._get)

        do_HEAD = do_GET

        def _get(self):
            url = urlparse(self.path)
            path, qs = unquote(url.path), parse_qs(url.query)
            parts = [p for p in path.split("/") if p]
            if path == "/api/status":
                return self._json(app.status())
            if path == "/api/projects":
                return self._json({"projects": list_projects()})
            if path == "/api/plans":
                return self._json(plans.summary())
            if path == "/api/gallery":
                project = project_name(qs.get("project", ["default"])[0])
                return self._json({"project": project, "images": list_gallery(project)})
            if len(parts) == 3 and parts[:2] == ["api", "jobs"]:
                job = app.jobs.get(parts[2])
                if not job:
                    raise ApiError(404, "no such job")
                return self._json(job)
            if path == "/api/training":
                mid = self._model(qs.get("model", [""])[0])
                st = model_status(mid)
                return self._json({"model": mid, "training": st["training"], "dataset": st["dataset"],
                                   "history": app.history.read(mid), "log": log_tail(mid),
                                   "previews": ["/" + p for p in st["training"].get("previews", [])]})
            if len(parts) == 3 and parts[0] == "files":
                project = project_name(parts[1])
                if not FILE_RE.match(parts[2]):
                    raise ApiError(404, "not found")
                return self._file(paths.PROJECTS / project / parts[2], paths.PROJECTS, "download" in qs)
            if parts[:1] == ["runs"] and path.endswith(".png") and len(parts) >= 4 and parts[2] in ("samples", "eval"):
                return self._file(paths.ROOT / path.lstrip("/"), paths.RUNS)
            if path in ("/", "/index.html"):
                return self._file(paths.WEB / "index.html", paths.WEB)
            if len(parts) == 1 and Path(parts[0]).suffix in MIME:
                return self._file(paths.WEB / parts[0], paths.WEB)
            raise ApiError(404, "not found")

        # -- POST / DELETE -------------------------------------------------------
        def do_POST(self):
            self._dispatch(self._post)

        def do_DELETE(self):
            self._dispatch(self._delete)

        def _post(self):
            path = urlparse(self.path).path
            data = self._body()
            if path == "/api/generate":
                mid = self._model(data.get("model"))
                prompt = str(data.get("prompt") or "").strip()
                if not prompt:
                    raise ApiError(400, "write a prompt first")
                cfg = load_config(mid)
                size = int(data.get("size") or cfg.inference.default_size)
                if size not in cfg.inference.sizes:
                    raise ApiError(400, f"size must be one of {list(cfg.inference.sizes)}")
                plans.check_generate(mid, cfg.name, size)
                if model_status(mid)["weights"] is None:
                    raise ApiError(409, f"{cfg.name} has no trained weights yet. Train it first (see the Training tab).")
                req = {"model": mid, "prompt": prompt[:2000], "size": size, "project": project_name(data.get("project"))}
                for key, lo, hi, cast in (("seed", 0, 2 ** 31 - 1, int), ("steps", 1, 200, int),
                                          ("guidance", 0.0, 20.0, float), ("temperature", 0.0, 2.0, float)):
                    if data.get(key) not in (None, ""):
                        try:
                            v = cast(data[key])
                        except (TypeError, ValueError):
                            raise ApiError(400, f"{key} must be a number")
                        req[key] = min(hi, max(lo, v))
                return self._json(app.jobs.submit(req), 202)
            if path == "/api/projects":
                name = project_name(data.get("name"))
                if not (paths.PROJECTS / name).is_dir():
                    plans.check_new_project(len(list_projects()))
                (paths.PROJECTS / name).mkdir(parents=True, exist_ok=True)
                return self._json({"projects": list_projects(), "created": name})
            if path == "/api/plan":
                plans.set_plan(str(data.get("plan") or ""))
                return self._json(plans.summary())
            if path == "/api/training/start":
                mh = data.get("max_hours")
                return self._json(start_training(self._model(data.get("model")), float(mh) if mh else None))
            if path == "/api/training/stop":
                return self._json(stop_training(self._model(data.get("model"))))
            if path == "/api/export":
                from . import export
                mid = self._model(data.get("model"))
                try:
                    man = export.export(load_config(mid))
                except SystemExit as e:
                    raise ApiError(409, str(e))
                app.engine.unload(mid)
                return self._json({"exported": man})
            raise ApiError(404, "not found")

        def _delete(self):
            if self.headers.get("X-Inkos") != "1":
                raise ApiError(403, "requests that change state must come from the INKOS interface")
            parts = [p for p in unquote(urlparse(self.path).path).split("/") if p]
            if len(parts) == 4 and parts[:2] == ["api", "gallery"]:
                project = project_name(parts[2])
                if not FILE_RE.match(parts[3]):
                    raise ApiError(404, "not found")
                png = paths.PROJECTS / project / parts[3]
                if not png.is_file():
                    raise ApiError(404, "not found")
                png.unlink()
                png.with_suffix(".json").unlink(missing_ok=True)
                return self._json({"deleted": parts[3]})
            raise ApiError(404, "not found")

    return Handler


def make_server(host: str = "127.0.0.1", port: int = 8765, device: str | None = None) -> ThreadingHTTPServer:
    paths.PROJECTS.mkdir(parents=True, exist_ok=True)
    srv = ThreadingHTTPServer((host, port), make_handler(App(device)))
    srv.daemon_threads = True
    return srv


def serve(host: str = "127.0.0.1", port: int = 8765, device: str | None = None):
    srv = make_server(host, port, device)
    shown = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    print(f"INKOS {__version__} local server: http://{shown}:{port}/   (Ctrl-C to stop)")
    if host == "0.0.0.0":
        print("listening on all interfaces: other devices on your network can reach this server")
    for mid in model_ids():
        s = model_status(mid)
        w = s["weights"]
        print(f"  {s['name']}: " + (f"{w['source']} weights, {w['epochs_completed']} of {s['training']['target_epochs']} epochs trained"
                                    if w else "no trained weights yet"))
    print(f"  plan: {plans.current()['name']}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")
    finally:
        srv.server_close()
