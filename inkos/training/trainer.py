"""The training loop used by both models.

What it guarantees
  * An epoch is one full pass over the prepared training split. Only complete
    passes count towards `epochs_completed`; partial progress is reported
    separately as `epoch_progress`.
  * Checkpoints are written atomically at the end of every epoch, every few
    minutes inside an epoch, and when the run is stopped (Ctrl-C / SIGTERM /
    time budget). A later run resumes from the exact batch it stopped at.
  * runs/<model>/state.json always holds the true current status. The HTML
    dashboard and `python -m inkos status` read nothing else.
"""
from __future__ import annotations

import copy
import json
import math
import os
import signal
import time
from pathlib import Path

import torch

from .. import paths
from ..config import Config, model_fingerprint

CKPT_FORMAT = 1


def atomic_write_json(path: Path, obj) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2))
    os.replace(tmp, path)


def read_state(model_id: str) -> dict | None:
    f = paths.run_dir(model_id) / "state.json"
    try:
        return json.loads(f.read_text())
    except (OSError, ValueError):
        return None


def checkpoint_summary(ck: dict, steps_per_epoch: int | None = None, target_epochs: int | None = None) -> dict:
    """The honest training record of a checkpoint: what was actually completed."""
    spe = steps_per_epoch or max(1, -(-int(ck.get("dataset_size", 1)) // int(ck.get("batch_size", 1))))
    return {
        "model_id": ck.get("model_id"), "fingerprint": ck.get("fingerprint"),
        "epochs_completed": int(ck.get("epoch", 0)),
        "epoch_progress": round(int(ck.get("step_in_epoch", 0)) / max(1, spe), 4),
        "global_step": int(ck.get("global_step", 0)), "samples_seen": int(ck.get("samples_seen", 0)),
        "dataset_size": int(ck.get("dataset_size", 0)),
        "target_epochs": int(target_epochs if target_epochs is not None else ck.get("config", {}).get("target_epochs", 0)),
        "train_seconds": round(float(ck.get("train_seconds", 0.0)), 1), "val": ck.get("val") or {},
        "saved_at": ck.get("saved_at"),
    }


def pid_alive(pid) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def pick_device(name: str | None = None) -> torch.device:
    if name and name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


class Trainer:
    def __init__(self, cfg: Config, task, device: str | None = None, threads: int | None = None):
        self.cfg, self.task = cfg, task
        self.t = cfg.train
        self.device = pick_device(device)
        if threads:
            torch.set_num_threads(int(threads))
        self.run = paths.run_dir(cfg.id)
        self.ckpt_dir = self.run / "checkpoints"
        self.ckpt_dir.mkdir(parents=True, exist_ok=True)
        self.fingerprint = model_fingerprint(cfg)

        torch.manual_seed(int(self.t.seed))
        self.model = task.build_model().to(self.device)
        self.ema = copy.deepcopy(self.model).eval().requires_grad_(False)
        self.params = sum(p.numel() for p in self.model.parameters())
        decay = [p for p in self.model.parameters() if p.ndim >= 2]
        no_decay = [p for p in self.model.parameters() if p.ndim < 2]
        self.opt = torch.optim.AdamW(
            [{"params": decay, "weight_decay": float(self.t.weight_decay)},
             {"params": no_decay, "weight_decay": 0.0}],
            lr=float(self.t.lr), betas=tuple(self.t.betas))
        self.amp_dtype = None
        if self.device.type == "cuda":
            self.amp_dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
        self.scaler = torch.amp.GradScaler("cuda") if self.amp_dtype == torch.float16 else None

        self.dataset_size = task.dataset_size
        self.batch_size = int(self.t.batch_size)
        self.steps_per_epoch = task.steps_per_epoch
        self.target_epochs = int(cfg.target_epochs)

        self.epoch = 0                # completed epochs
        self.step_in_epoch = 0
        self.global_step = 0
        self.samples_seen = 0
        self.train_seconds = 0.0      # accumulated across resumes
        self.best_val = None
        self.last_val: dict = {}
        self.previews: list[str] = []
        self.loss_ema = None
        self.metrics_ema: dict = {}
        self.speed = None
        self.started_at = time.strftime("%Y-%m-%dT%H:%M:%S")
        self._stop = None
        self._log_file = None
        self._warm_from = 0           # step at which the optimiser last started cold

    # -- logging --------------------------------------------------------------
    def log(self, msg: str):
        line = f"[{time.strftime('%H:%M:%S')}] [{self.cfg.id}] {msg}"
        print(line, flush=True)
        if self._log_file is None:
            self._log_file = open(self.run / "train.log", "a")
        self._log_file.write(line + "\n")
        self._log_file.flush()

    def _metric(self, rec: dict):
        with open(self.run / "metrics.jsonl", "a") as f:
            f.write(json.dumps(rec) + "\n")

    # -- schedule ---------------------------------------------------------------
    def lr_now(self) -> float:
        horizon = int(self.t.get("schedule_epochs") or self.target_epochs) * max(1, self.dataset_size)
        prog = min(1.0, self.samples_seen / horizon)
        lr = float(self.t.min_lr) + 0.5 * (float(self.t.lr) - float(self.t.min_lr)) * (1 + math.cos(math.pi * prog))
        warm = int(self.t.warmup_steps)
        return lr * min(1.0, (self.global_step - self._warm_from + 1) / warm) if warm > 0 else lr

    @torch.no_grad()
    def _ema_update(self):
        d = min(float(self.t.ema_decay), (1 + self.global_step) / (10 + self.global_step))
        for e, p in zip(self.ema.parameters(), self.model.parameters()):
            e.lerp_(p.detach(), 1 - d)

    # -- checkpoints ------------------------------------------------------------
    def save(self, name: str = "last.pt") -> Path:
        ckpt = {
            "format": CKPT_FORMAT, "model_id": self.cfg.id, "fingerprint": self.fingerprint,
            "config": self.cfg.plain(), "model": self.model.state_dict(), "ema": self.ema.state_dict(),
            "optimizer": self.opt.state_dict(), "scaler": self.scaler.state_dict() if self.scaler else None,
            "epoch": self.epoch, "step_in_epoch": self.step_in_epoch, "global_step": self.global_step,
            "samples_seen": self.samples_seen, "train_seconds": self.train_seconds,
            "dataset_size": self.dataset_size, "batch_size": self.batch_size,
            "best_val": self.best_val, "val": self.last_val, "torch_rng": torch.get_rng_state(),
            "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        }
        path = self.ckpt_dir / name
        tmp = path.with_suffix(".tmp")
        torch.save(ckpt, tmp)
        os.replace(tmp, path)
        # small sidecar so tools can describe a checkpoint without loading it
        atomic_write_json(path.with_suffix(".json"), checkpoint_summary(ckpt, self.steps_per_epoch, self.target_epochs))
        return path

    def _save_epoch(self):
        last = self.save("last.pt")
        ep = self.ckpt_dir / f"epoch-{self.epoch:06d}.pt"
        try:
            if ep.exists():
                ep.unlink()
            os.link(last, ep)
            ep.with_suffix(".json").write_text(last.with_suffix(".json").read_text())
        except OSError:
            self.save(ep.name)
        keep = int(self.t.keep_checkpoints)
        for old in sorted(self.ckpt_dir.glob("epoch-*.pt"))[:-keep]:
            old.unlink()
            old.with_suffix(".json").unlink(missing_ok=True)

    def resume(self) -> bool:
        path = self.ckpt_dir / "last.pt"
        if not path.exists():
            return False
        ck = torch.load(path, map_location=self.device, weights_only=False)
        if ck.get("fingerprint") != self.fingerprint:
            raise RuntimeError(
                f"{path} was trained with a different model configuration "
                f"({ck.get('fingerprint')} vs {self.fingerprint}). Use --fresh to start over, "
                f"or restore the matching configs/{self.cfg.id}.yaml.")
        self.model.load_state_dict(ck["model"])
        self.ema.load_state_dict(ck["ema"])
        self.opt.load_state_dict(ck["optimizer"])
        if self.scaler and ck.get("scaler"):
            self.scaler.load_state_dict(ck["scaler"])
        self.epoch, self.step_in_epoch = ck["epoch"], ck["step_in_epoch"]
        self.global_step, self.samples_seen = ck["global_step"], ck["samples_seen"]
        self.train_seconds = ck.get("train_seconds", 0.0)
        self.best_val, self.last_val = ck.get("best_val"), ck.get("val") or {}
        if ck.get("torch_rng") is not None:
            torch.set_rng_state(ck["torch_rng"])
        if (ck.get("dataset_size"), ck.get("batch_size")) != (self.dataset_size, self.batch_size) and self.step_in_epoch:
            self.log("dataset or batch size changed since the checkpoint: restarting the unfinished epoch")
            self.step_in_epoch = 0
        self.log(f"resumed from {path.name}: {self.epoch} epochs completed, step {self.step_in_epoch}/"
                 f"{self.steps_per_epoch} of the next, {self.samples_seen} samples seen")
        return True

    def warm_start(self) -> bool:
        """Continue from installed weights (models/<id>/) when there is no checkpoint.

        An export holds the averaged weights and their training record but no
        optimiser state, so the optimiser starts cold with a fresh warm-up.
        Epoch and sample counters carry on from the record in the manifest.
        """
        d = paths.model_dir(self.cfg.id)
        try:
            man = json.loads((d / "manifest.json").read_text())
            sd = torch.load(d / man["file"], map_location="cpu", weights_only=True)
        except (OSError, ValueError, KeyError):
            return False
        if man.get("fingerprint") != self.fingerprint:
            self.log("installed weights do not match this configuration: starting from random weights")
            return False
        sd = {k: (v.float() if v.is_floating_point() else v) for k, v in sd.items()}
        self.model.load_state_dict(sd)
        self.ema.load_state_dict(sd)
        rec = man.get("training", {})
        self.epoch = int(rec.get("epochs_completed", 0))
        self.global_step = int(rec.get("global_step", 0))
        self.train_seconds = float(rec.get("train_seconds", 0.0))
        self.last_val = rec.get("val") or {}
        partial = self.global_step - self.epoch * self.steps_per_epoch
        if int(rec.get("dataset_size", -1)) == self.dataset_size and 0 <= partial < self.steps_per_epoch:
            self.step_in_epoch = partial            # same data: carry on inside the epoch
            self.samples_seen = int(rec.get("samples_seen", 0))
        else:
            self.step_in_epoch = 0                  # different data: only whole epochs count
            self.samples_seen = self.epoch * self.dataset_size
        self._warm_from = self.global_step
        self.log(f"no checkpoint here: continuing from installed weights ({self.epoch} epochs completed, "
                 f"{self.samples_seen} samples seen). The optimiser starts cold.")
        return True

    # -- status -----------------------------------------------------------------
    def write_state(self, status: str, message: str = ""):
        remaining = max(0, self.target_epochs * self.dataset_size - self.samples_seen)
        eta = remaining / self.speed if self.speed else None
        atomic_write_json(self.run / "state.json", {
            "model": self.cfg.id, "name": self.cfg.name, "status": status, "message": message,
            "target_epochs": self.target_epochs, "epochs_completed": self.epoch,
            "epoch_progress": round(self.step_in_epoch / max(1, self.steps_per_epoch), 4),
            "step_in_epoch": self.step_in_epoch, "steps_per_epoch": self.steps_per_epoch,
            "global_step": self.global_step, "samples_seen": self.samples_seen,
            "dataset_size": self.dataset_size, "batch_size": self.batch_size,
            "loss": self.loss_ema, "train_metrics": self.metrics_ema, "val": self.last_val,
            "best_val_loss": self.best_val, "lr": self.lr_now(),
            "samples_per_sec": round(self.speed, 2) if self.speed else None,
            "eta_seconds_to_target": eta, "train_seconds": round(self.train_seconds, 1),
            "device": str(self.device), "params": self.params, "fingerprint": self.fingerprint,
            "pid": os.getpid(), "started_at": self.started_at,
            "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"), "previews": self.previews,
        })

    # -- evaluation inside training -----------------------------------------------
    def validate(self) -> dict:
        t0 = time.time()
        val = self.task.validate(self.ema, self.device, int(self.t.val_batches))
        val["at_step"] = self.global_step
        val["at_epoch"] = round(self.epoch + self.step_in_epoch / max(1, self.steps_per_epoch), 4)
        self.last_val = val
        if self.best_val is None or val["loss"] < self.best_val:
            self.best_val = val["loss"]
            self.save("best.pt")
        try:
            tag = f"step-{self.global_step:08d}"
            self.previews = self.task.preview(self.ema, self.device, self.run / "samples" / tag)
        except Exception as e:  # previews must never kill a training run
            self.log(f"preview failed: {e!r}")
        self._metric({"type": "val", "step": self.global_step, "epoch": val["at_epoch"],
                      **{k: v for k, v in val.items() if isinstance(v, (int, float))}})
        shown = "  ".join(f"{k} {v:.4f}" for k, v in val.items() if isinstance(v, float) and k != "at_epoch")
        self.log(f"validation: {shown}  ({time.time() - t0:.0f} s)")
        return val

    # -- main loop ------------------------------------------------------------------
    def fit(self, max_hours: float | None = None, max_steps: int | None = None,
            until_epoch: int | None = None) -> str:
        """Train until the target, a budget, or a stop signal. Returns the final status."""
        def on_signal(signum, _frame):
            self._stop = "interrupted"
        old = {s: signal.signal(s, on_signal) for s in (signal.SIGINT, signal.SIGTERM)}
        stop_file = self.run / "STOP"
        stop_file.unlink(missing_ok=True)
        (self.run / "train.pid").write_text(str(os.getpid()))
        goal = min(self.target_epochs, until_epoch) if until_epoch else self.target_epochs
        t_start = time.time()
        steps_this_run = 0
        last_ckpt = last_state = time.time()
        self.log(f"training {self.cfg.name} on {self.device}: {self.params / 1e6:.2f} M parameters, "
                 f"{self.dataset_size} training samples, {self.steps_per_epoch} steps per epoch, "
                 f"target {self.target_epochs} epochs")
        self.write_state("training")
        status = "completed"
        try:
            while self.epoch < goal and not self._stop:
                self.model.train()
                for batch in self.task.train_batches(self.epoch, self.step_in_epoch):
                    t0 = time.time()
                    batch = self.task.to_device(batch, self.device)
                    lr = self.lr_now()
                    for g in self.opt.param_groups:
                        g["lr"] = lr
                    with torch.autocast(self.device.type, dtype=self.amp_dtype, enabled=self.amp_dtype is not None):
                        loss, metrics = self.task.loss(self.model, batch)
                    if not torch.isfinite(loss):
                        raise FloatingPointError(f"loss became {loss.item()} at step {self.global_step}")
                    self.opt.zero_grad(set_to_none=True)
                    if self.scaler:
                        self.scaler.scale(loss).backward()
                        self.scaler.unscale_(self.opt)
                        torch.nn.utils.clip_grad_norm_(self.model.parameters(), float(self.t.grad_clip))
                        self.scaler.step(self.opt)
                        self.scaler.update()
                    else:
                        loss.backward()
                        torch.nn.utils.clip_grad_norm_(self.model.parameters(), float(self.t.grad_clip))
                        self.opt.step()
                    self._ema_update()

                    n = self.task.batch_len(batch)
                    self.global_step += 1
                    self.step_in_epoch += 1
                    self.samples_seen += n
                    steps_this_run += 1
                    dt = time.time() - t0
                    self.train_seconds += dt
                    lv = loss.item()
                    self.loss_ema = lv if self.loss_ema is None else 0.98 * self.loss_ema + 0.02 * lv
                    for k, v in metrics.items():
                        self.metrics_ema[k] = v if k not in self.metrics_ema else 0.98 * self.metrics_ema[k] + 0.02 * v
                    self.speed = n / dt if self.speed is None else 0.97 * self.speed + 0.03 * n / dt

                    now = time.time()
                    if self.global_step % int(self.t.log_every) == 0:
                        frac = self.step_in_epoch / self.steps_per_epoch
                        self._metric({"type": "train", "step": self.global_step, "epoch": round(self.epoch + frac, 5),
                                      "loss": round(self.loss_ema, 5), "lr": lr, "speed": round(self.speed, 2),
                                      **{k: round(v, 5) for k, v in self.metrics_ema.items()}})
                    if self.global_step % (int(self.t.log_every) * 5) == 0:
                        frac = self.step_in_epoch / self.steps_per_epoch
                        extra = "  ".join(f"{k} {v:.3f}" for k, v in self.metrics_ema.items())
                        self.log(f"epoch {self.epoch} ({100 * frac:.1f}%)  step {self.global_step}  "
                                 f"loss {self.loss_ema:.4f}  {extra}  lr {lr:.2e}  {self.speed:.1f} samples/s")
                    if now - last_state > 5:
                        self.write_state("training")
                        last_state = now
                    mid_epoch = self.step_in_epoch < self.steps_per_epoch
                    if mid_epoch and self.global_step % int(self.t.val_every_steps) == 0:
                        self.validate()
                        self.model.train()
                    if mid_epoch and now - last_ckpt > float(self.t.checkpoint_minutes) * 60:
                        self.save("last.pt")
                        last_ckpt = time.time()
                    if stop_file.exists():
                        self._stop = "paused"
                    if max_hours and (now - t_start) > max_hours * 3600:
                        self._stop = "paused"
                    if max_steps and steps_this_run >= max_steps:
                        self._stop = "paused"
                    if self._stop:
                        break
                if self.step_in_epoch >= self.steps_per_epoch:
                    self.epoch += 1
                    self.step_in_epoch = 0
                    self.validate()
                    self._save_epoch()
                    last_ckpt = time.time()
                    self._metric({"type": "epoch", "epoch": self.epoch, "step": self.global_step,
                                  "samples_seen": self.samples_seen})
                    self.log(f"epoch {self.epoch} of {self.target_epochs} completed")
                    self.write_state("training")
            if self._stop:
                status = self._stop
            elif self.epoch < self.target_epochs:
                status = "paused"
            self.save("last.pt")
        except BaseException as e:
            status = "failed"
            self.log(f"training failed: {e!r}")
            self.write_state("failed", repr(e))
            raise
        finally:
            for s, h in old.items():
                signal.signal(s, h)
            (self.run / "train.pid").unlink(missing_ok=True)
            stop_file.unlink(missing_ok=True)
        msg = {"completed": "target reached", "paused": "stopped by budget or request; resume with the same command",
               "interrupted": "stopped by signal; resume with the same command"}[status]
        self.write_state(status, msg)
        self.log(f"{status}: {self.epoch} of {self.target_epochs} epochs completed "
                 f"(+{100 * self.step_in_epoch / self.steps_per_epoch:.1f}% of the next), "
                 f"{self.samples_seen} samples seen. Checkpoint: {self.ckpt_dir / 'last.pt'}")
        return status
