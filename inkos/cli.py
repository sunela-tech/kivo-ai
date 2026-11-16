"""Command line for INKOS.

  python -m inkos doctor                         hardware and install check
  python -m inkos data prepare --model inkos1    build a training set
  python -m inkos train --model inkos1           train (resumes automatically)
  python -m inkos status                         real training status of both models
  python -m inkos eval --model inkos1            evaluate the latest checkpoint
  python -m inkos export --model inkos1          install weights for inference
  python -m inkos generate --model inkos1 --prompt "house icon" --out house.png
  python -m inkos serve                          local server + HTML interface
  python -m inkos plan                           the three plans and the active one

Training and inference are separate: `train` writes checkpoints under runs/,
`export` copies the averaged weights to models/, and `generate` / `serve` only
ever read weights.
"""
from __future__ import annotations

import argparse
import json
import sys
import time

from . import __version__, paths
from .config import load_config, model_ids


def _fmt_duration(sec) -> str:
    if sec is None:
        return "unknown"
    sec = float(sec)
    for unit, n in (("years", 365 * 86400), ("days", 86400), ("hours", 3600), ("minutes", 60)):
        if sec >= n:
            return f"{sec / n:.1f} {unit}"
    return f"{sec:.0f} seconds"


def _epochs(n) -> str:
    return f"{n} epoch" + ("" if n == 1 else "s")


def cmd_data(a):
    cfg = load_config(a.model, a.set)
    if a.action == "prepare":
        from .data import prepare
        prepare.prepare(cfg, count=a.count, workers=a.workers, download=not a.offline)
    elif a.action == "import":
        from .data import raster_import
        raster_import.import_folder(cfg, a.dir, license=a.license, source=a.source, caption=a.caption)
    elif a.action == "preview":
        from .data import preview
        out = preview.contact_sheet(cfg, a.n, a.out)
        print(f"wrote {out}")
    elif a.action == "info":
        from .data import store
        info = store.dataset_info(paths.data_dir(cfg.id))
        if info and "shards" in info:
            info = {**info, "shards": {k: len(v) for k, v in info["shards"].items()}}
        print(json.dumps(info, indent=2) if info else f"no prepared dataset for {cfg.id}")


def cmd_train(a):
    import shutil
    from .training.tasks import get_task
    from .training.trainer import Trainer, pid_alive, read_state
    cfg = load_config(a.model, a.set)
    st = read_state(cfg.id)
    if st and st.get("status") == "training" and pid_alive(st.get("pid")):
        sys.exit(f"{cfg.name} is already training (pid {st['pid']}). Stop it first:  python -m inkos stop --model {cfg.id}")
    run = paths.run_dir(cfg.id)
    if a.fresh and run.exists():
        shutil.rmtree(run)
    trainer = Trainer(cfg, get_task(cfg), device=a.device, threads=a.threads)
    if not trainer.resume() and not a.fresh:
        # a fresh clone that ships installed weights continues from them; otherwise a
        # model may declare a starting point (INKOS 1.1 starts from INKOS 1)
        if not trainer.warm_start() and cfg.train.get("init_from"):
            trainer.init_from(cfg.train.init_from)
    status = trainer.fit(max_hours=a.max_hours, max_steps=a.max_steps, until_epoch=a.until_epoch)
    sys.exit(0 if status in ("completed", "paused", "interrupted") else 1)


def cmd_stop(a):
    import os
    import signal
    from .training.trainer import pid_alive, read_state
    st = read_state(a.model)
    if not st or st.get("status") != "training" or not pid_alive(st.get("pid")):
        print(f"{a.model} is not training")
        return
    os.kill(int(st["pid"]), signal.SIGTERM)
    print(f"asked pid {st['pid']} to stop; it saves a checkpoint first")


def cmd_status(a):
    from .engine import model_status
    for mid in ([a.model] if a.model else model_ids()):
        s = model_status(mid)
        if a.json:
            print(json.dumps(s, indent=2))
            continue
        t = s["training"]
        print(f"\n{s['name']}  ({mid})")
        print(f"  architecture     {s['architecture']}, {s['params_m']} M parameters")
        print(f"  training         {t['status']}: {t['epochs_completed']} of {t['target_epochs']} target epochs completed"
              + (f" (+{100 * t['epoch_progress']:.1f}% of the next)" if t.get('epoch_progress') else ""))
        print(f"  samples seen     {t['samples_seen']:,}   steps {t['global_step']:,}")
        if t.get("loss") is not None:
            print(f"  loss             train {t['loss']:.4f}" + (f"   val {t['val']['loss']:.4f}" if t.get('val', {}).get('loss') is not None else ""))
        if t.get("samples_per_sec"):
            print(f"  speed            {t['samples_per_sec']} samples/s on {t.get('device')}; "
                  f"time to target at this speed: {_fmt_duration(t.get('eta_seconds_to_target'))}")
        d = s["dataset"]
        print(f"  dataset          " + (f"{d['train_count']:,} training samples" if d else "not prepared"))
        w = s["weights"]
        print(f"  inference        " + (f"{w['source']} weights ({_epochs(w['epochs_completed'])}, {w['samples_seen']:,} samples)" if w else "no weights available"))


def cmd_eval(a):
    from . import evaluate
    report = evaluate.run(load_config(a.model, a.set), checkpoint=a.checkpoint, n=a.n, device=a.device)
    print(json.dumps({k: v for k, v in report.items() if k != "samples"}, indent=2))


def cmd_export(a):
    from . import export
    manifest = export.export(load_config(a.model, a.set), checkpoint=a.checkpoint, half=not a.full_precision)
    print(json.dumps(manifest, indent=2))


def cmd_plan(a):
    from . import plans
    if a.set:
        try:
            plans.set_plan(a.set)
        except plans.PlanError as e:
            sys.exit(str(e))
    s = plans.summary()
    names = {mid: load_config(mid).name for mid in model_ids()}
    for p in s["plans"]:
        mark = "  <- active" if p["id"] == s["current"] else ""
        print(f"\n{p['name']}  ({p['id']}){mark}")
        if p["tagline"]:
            print(f"  {p['tagline']}")
        if p["price"]:
            print(f"  price            {p['price']}")
        print(f"  models           {', '.join(names.get(m, m) for m in p['models'])}")
        print(f"  largest size     {p['max_size'] or 'any'} px")
        print(f"  tokens per day   {p['tokens_per_day']:,}" if p['tokens_per_day'] is not None else "  tokens per day   unlimited")
        print(f"  projects         {p['projects'] if p['projects'] is not None else 'unlimited'}")
    u = s["usage"]
    print(f"\nused today: {u['tokens']:,} tokens" + (f" of {u['limit']:,} ({u['percent']}%)" if u["limit"] is not None else " (no daily limit)"))
    print("Plans are a local setting. Change with:  python -m inkos plan --set <id>")


def cmd_generate(a):
    from . import plans
    from .engine import Engine
    cfg = load_config(a.model)
    a.size = int(a.size or cfg.inference.default_size)
    steps = a.steps or (int(cfg.sample.steps) if "steps" in cfg.sample else None)
    try:
        tokens = plans.check_generate(a.model, cfg.name, a.size, steps)
    except plans.PlanError as e:
        sys.exit(f"{e}  (python -m inkos plan --set <id>)")
    eng = Engine()
    t0 = time.time()
    try:
        res = eng.generate(a.model, a.prompt, size=a.size, seed=a.seed, steps=a.steps, guidance=a.guidance,
                           temperature=a.temperature, progress=lambda p: print(f"\r  {p['stage']} {100 * p['fraction']:.0f}%   ", end="", file=sys.stderr))
    except (RuntimeError, ValueError) as e:      # e.g. a model that has never been trained
        sys.exit(str(e))
    print(file=sys.stderr)
    from pathlib import Path

    from . import bitmap
    if res.get("video"):
        out = Path(a.out).with_suffix(".gif")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(res["video"])
    else:
        out = bitmap.save_png(res["image"], a.out)
    used = plans.record(tokens)
    print(f"wrote {out}  ({a.size}x{a.size}, seed {res['meta']['seed']}, {time.time() - t0:.1f} s, "
          f"weights: {res['meta']['weights']['source']}, {_epochs(res['meta']['weights']['epochs_completed'])} trained, "
          f"{tokens:,} tokens; {used['tokens']:,} used today)")


def cmd_serve(a):
    from . import server
    server.serve(host=a.host, port=a.port, open_browser=a.open)


def cmd_doctor(a):
    from . import hardware
    hardware.report(bench=a.bench)


def main(argv=None):
    p = argparse.ArgumentParser(prog="inkos", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--version", action="version", version=f"inkos {__version__}")
    sub = p.add_subparsers(dest="cmd", required=True)
    ids = model_ids()

    def model_arg(sp, required=True):
        sp.add_argument("--model", required=required, choices=ids)
        sp.add_argument("--set", action="append", default=[], metavar="key=value",
                        help="override a config value, e.g. --set train.batch_size=16")

    d = sub.add_parser("data", help="dataset tools")
    d.add_argument("action", choices=["prepare", "import", "preview", "info"])
    model_arg(d)
    d.add_argument("--count", type=int, help="number of training samples (default: config data.count)")
    d.add_argument("--workers", type=int)
    d.add_argument("--offline", action="store_true", help="do not download icon sets / sketches")
    d.add_argument("--dir", help="[import] folder of images with optional .txt captions")
    d.add_argument("--license", help="[import] license of the imported images (required)")
    d.add_argument("--source", help="[import] where the images come from")
    d.add_argument("--caption", help="[import] caption for images that have no .txt file")
    d.add_argument("--n", type=int, default=48, help="[preview] number of samples")
    d.add_argument("--out", help="[preview] output PNG")
    d.set_defaults(fn=cmd_data)

    t = sub.add_parser("train", help="train a model (resumes from the last checkpoint)")
    model_arg(t)
    t.add_argument("--fresh", action="store_true",
                   help="delete the existing run and start from random weights (ignores installed weights too)")
    t.add_argument("--max-hours", type=float, help="stop cleanly after this long")
    t.add_argument("--max-steps", type=int, help="stop cleanly after this many steps")
    t.add_argument("--until-epoch", type=int, help="stop when this many epochs are complete")
    t.add_argument("--device", default="auto", help="auto | cpu | cuda | cuda:1 | mps")
    t.add_argument("--threads", type=int, help="CPU threads")
    t.set_defaults(fn=cmd_train)

    s = sub.add_parser("stop", help="ask a running training job to checkpoint and stop")
    s.add_argument("--model", required=True, choices=ids)
    s.set_defaults(fn=cmd_stop)

    s = sub.add_parser("status", help="show real training status")
    s.add_argument("--model", choices=ids)
    s.add_argument("--json", action="store_true")
    s.set_defaults(fn=cmd_status)

    e = sub.add_parser("eval", help="evaluate a checkpoint")
    model_arg(e)
    e.add_argument("--checkpoint", help="checkpoint file (default: latest)")
    e.add_argument("--n", type=int, default=200, help="number of generated samples to score")
    e.add_argument("--device", default="auto")
    e.set_defaults(fn=cmd_eval)

    x = sub.add_parser("export", help="install averaged weights into models/ for inference")
    model_arg(x)
    x.add_argument("--checkpoint")
    x.add_argument("--full-precision", action="store_true", help="store float32 instead of float16")
    x.set_defaults(fn=cmd_export)

    g = sub.add_parser("generate", help="generate one PNG")
    g.add_argument("--model", required=True, choices=ids)
    g.add_argument("--prompt", required=True)
    g.add_argument("--size", type=int, default=None, choices=[256, 512, 1024], help="output size (default: the model's)")
    g.add_argument("--seed", type=int)
    g.add_argument("--steps", type=int, help="[Pro] denoising steps")
    g.add_argument("--guidance", type=float, help="[Pro] classifier-free guidance scale")
    g.add_argument("--temperature", type=float, help="[INKOS 1] sampling temperature")
    g.add_argument("--out", default="inkos.png", help="output file; the MOTION models write a .gif")
    g.set_defaults(fn=cmd_generate)

    v = sub.add_parser("serve", help="start the local server and HTML interface")
    v.add_argument("--host", default="127.0.0.1")
    v.add_argument("--port", type=int, default=8765)
    v.add_argument("--open", action="store_true", help="open the interface in the default browser")
    v.set_defaults(fn=cmd_serve)

    pl = sub.add_parser("plan", help="show the three plans, or switch the active one")
    pl.add_argument("--set", metavar="ID", help="make this plan active (basic, plus, studio)")
    pl.set_defaults(fn=cmd_plan)

    h = sub.add_parser("doctor", help="check hardware and installation")
    h.add_argument("--bench", action="store_true", help="measure real training and inference speed")
    h.set_defaults(fn=cmd_doctor)

    a = p.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
