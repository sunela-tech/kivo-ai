"""End to end on tiny models: prepare -> train -> stop -> resume -> export -> generate -> serve."""
import json
import threading
import time
import urllib.error
import urllib.request

import pytest

from inkos import bitmap, paths
from inkos.config import load_config


def _train(model_id, **fit):
    from inkos.training.tasks import get_task
    from inkos.training.trainer import Trainer
    cfg = load_config(model_id)
    tr = Trainer(cfg, get_task(cfg), device="cpu")
    resumed = tr.resume()
    return tr, resumed, tr.fit(**fit)


def _state(model_id):
    return json.loads((paths.run_dir(model_id) / "state.json").read_text())


def test_inkos1_train_resume_export_generate(home):
    from inkos import evaluate, export
    from inkos.data import prepare
    from inkos.engine import Engine, model_status
    cfg = load_config("inkos1")
    meta = prepare.prepare(cfg, workers=1, download=False)       # offline: procedural data only
    assert meta["train_count"] == 320 and "icon" not in meta["by_kind"]["train"]

    assert model_status("inkos1")["training"]["status"] == "not started"
    assert model_status("inkos1")["weights"] is None
    with pytest.raises(RuntimeError, match="no trained weights"):
        Engine("cpu").generate("inkos1", "house icon")           # never pretends to be trained

    tr, resumed, status = _train("inkos1", max_steps=7)
    assert not resumed and status == "paused"
    st = _state("inkos1")
    assert (st["epochs_completed"], st["step_in_epoch"], st["global_step"]) == (0, 7, 7)
    assert st["samples_seen"] == 7 * 16 and 0 < st["epoch_progress"] < 1
    assert st["target_epochs"] == 10000                           # the target is never reported as done

    tr2, resumed, status = _train("inkos1", until_epoch=1)
    assert resumed and status == "paused"
    st = _state("inkos1")
    assert (st["epochs_completed"], st["step_in_epoch"]) == (1, 0)
    assert st["global_step"] == tr2.steps_per_epoch == 20 and st["samples_seen"] == 320
    assert st["val"]["loss"] > 0 and len(st["previews"]) == 2
    ck = paths.run_dir("inkos1") / "checkpoints"
    assert (ck / "last.pt").exists() and (ck / "epoch-000001.pt").exists() and (ck / "best.pt").exists()
    assert json.loads((ck / "last.json").read_text())["epochs_completed"] == 1

    info = model_status("inkos1")["weights"]
    assert info["source"] == "checkpoint" and info["epochs_completed"] == 1
    man = export.export(cfg)
    assert man["training"]["epochs_completed"] == 1 and man["training"]["samples_seen"] == 320
    assert model_status("inkos1")["weights"]["source"] == "installed"

    eng = Engine("cpu")
    seen = []
    res = eng.generate("inkos1", "note: milk\neggs", size=512, seed=5, progress=seen.append)
    assert res["image"].size == (512, 512) and bitmap.is_pure_bw(res["image"])
    assert res["meta"]["prompt"] == "note: milk; eggs" and res["meta"]["weights"]["epochs_completed"] == 1
    assert seen and seen[-1]["fraction"] == 1.0
    again = eng.generate("inkos1", "note: milk\neggs", size=512, seed=5)
    assert again["image"].tobytes() == res["image"].tobytes()                    # same seed, same picture
    big = eng.generate("inkos1", "note: milk\neggs", size=1024, seed=5)
    assert big["image"].size == (1024, 1024) and big["meta"]["tokens"] == res["meta"]["tokens"]

    report = evaluate.run(cfg, n=6, device="cpu")
    assert report["weights"]["epochs_completed"] == 1 and 0 <= report["generated"]["complete"] <= 1
    assert (paths.run_dir("inkos1") / "eval" / "samples.png").exists()


def test_training_continues_from_installed_weights(home):
    """A clone that ships models/<id>/ but no runs/ carries on from the recorded epoch."""
    import shutil

    from inkos import export
    from inkos.data import prepare
    from inkos.engine import model_status
    from inkos.training.tasks import get_task
    from inkos.training.trainer import Trainer
    cfg = load_config("inkos1")
    prepare.prepare(cfg, workers=1, download=False)
    _train("inkos1", until_epoch=1)
    export.export(cfg)
    shutil.rmtree(paths.run_dir("inkos1"))

    st = model_status("inkos1")
    assert st["training"]["status"] == "not running" and st["training"]["epochs_completed"] == 1
    assert st["training"]["samples_seen"] == 320 and st["weights"]["source"] == "installed"

    tr = Trainer(cfg, get_task(cfg), device="cpu")
    assert not tr.resume() and tr.warm_start()
    assert (tr.epoch, tr.step_in_epoch, tr.global_step, tr.samples_seen) == (1, 0, 20, 320)
    before = tr.task.validate(tr.ema, tr.device, 2)["loss"]
    assert abs(before - st["weights"]["val"]["loss"]) < 0.05        # same weights (float16 rounding only)
    assert tr.lr_now() < 0.6 * float(cfg.train.lr)                 # fresh warm-up
    assert tr.fit(until_epoch=2) == "paused"
    assert _state("inkos1")["epochs_completed"] == 2 and _state("inkos1")["samples_seen"] == 640


def test_changed_architecture_refuses_old_checkpoint(home):
    from inkos.data import prepare
    from inkos.training.tasks import get_task
    from inkos.training.trainer import Trainer
    prepare.prepare(load_config("inkos1"), workers=1, download=False)
    _train("inkos1", max_steps=2)
    wider = load_config("inkos1", ["model.d_model=96"])
    with pytest.raises(RuntimeError, match="different model configuration"):
        Trainer(wider, get_task(wider), device="cpu").resume()


def test_pro_train_resume_export_generate(home):
    from inkos import evaluate, export
    from inkos.data import prepare, raster_import
    from inkos.engine import Engine, model_status
    cfg = load_config("inkos1_pro")
    meta = prepare.prepare(cfg, workers=1)
    assert meta["train_count"] == 48 and meta["val_count"] == 16

    art = home / "art"
    art.mkdir()
    from PIL import Image, ImageDraw
    for i in range(3):
        im = Image.new("RGB", (200, 260), (245, 240, 230))
        ImageDraw.Draw(im).line([10, 10 + 60 * i, 190, 250 - 60 * i], fill=(30, 30, 30), width=6)
        im.save(art / f"page{i}.jpg")
    (art / "page0.txt").write_text("my own sketch, diagonal line")
    with pytest.raises(SystemExit, match="license"):
        raster_import.import_folder(cfg, str(art), license=None)
    meta = raster_import.import_folder(cfg, str(art), license="own work")
    assert meta["train_count"] == 51 and meta["sources"][-1]["license"] == "own work"
    assert prepare.prepare(cfg, workers=1)["train_count"] == 51          # rebuilding keeps the imported art

    tr, _, status = _train("inkos1_pro", max_steps=3)
    assert status == "paused" and _state("inkos1_pro")["samples_seen"] == 24
    tr, resumed, status = _train("inkos1_pro", until_epoch=1)
    st = _state("inkos1_pro")
    assert resumed and st["epochs_completed"] == 1 and st["samples_seen"] == 51 and st["target_epochs"] == 20000
    assert st["global_step"] == 7

    export.export(cfg)
    assert model_status("inkos1_pro")["weights"]["source"] == "installed"
    eng = Engine("cpu")
    stages = []
    for size in (64, 128, 256):
        res = eng.generate("inkos1_pro", "manga portrait, girl", size=size, seed=3, steps=2, progress=lambda p: stages.append(p["stage"]))
        assert res["image"].size == (size, size) and res["image"].mode == "1" and bitmap.is_pure_bw(res["image"])
        assert res["meta"]["refiner_passes"] == {64: 0, 128: 1, 256: 2}[size]
    assert "denoising" in stages and "refining to 256 px" in stages
    report = evaluate.run(cfg, n=4, device="cpu")
    assert 0 <= report["refiner_iou"] <= 1 and report["generated_images"]["n"] == 4


def _call(base, method, path, body=None, header=True):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    if header:
        req.add_header("X-Inkos", "1")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
        return r.status, (json.loads(raw) if r.headers["Content-Type"].startswith("application/json") else raw), r.headers


def test_server_api(home):
    from inkos import export, server
    from inkos.data import prepare
    cfg = load_config("inkos1")
    prepare.prepare(cfg, workers=1, download=False)
    _train("inkos1", max_steps=4)
    export.export(cfg)

    srv = server.make_server("127.0.0.1", 0, "cpu")
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        _, page, _ = _call(base, "GET", "/")
        assert b"<title>INKOS</title>" in page
        assert b"http://" not in page and b"https://" not in page          # nothing loaded from the network
        _, st, _ = _call(base, "GET", "/api/status")
        by_id = {m["id"]: m for m in st["models"]}
        assert by_id["inkos1"]["weights"]["epochs_completed"] == 0 and by_id["inkos1"]["weights"]["samples_seen"] == 64
        assert by_id["inkos1"]["training"]["target_epochs"] == 10000
        assert by_id["inkos1_pro"]["weights"] is None and by_id["inkos1_pro"]["training"]["status"] == "not started"
        assert set(by_id["inkos1"]["memory"]["inference_mb"]) == {"256", "512", "1024"}

        with pytest.raises(urllib.error.HTTPError) as e:                   # untrained model: refused, not faked
            _call(base, "POST", "/api/generate", {"model": "inkos1_pro", "prompt": "manga portrait"})
        assert e.value.code == 409
        with pytest.raises(urllib.error.HTTPError) as e:                   # state changes need the UI header
            _call(base, "POST", "/api/generate", {"model": "inkos1", "prompt": "x"}, header=False)
        assert e.value.code == 403
        with pytest.raises(urllib.error.HTTPError) as e:
            _call(base, "GET", "/files/default/..%2F..%2Fconfigs%2Finkos1.yaml")
        assert e.value.code in (400, 404)

        code, job, _ = _call(base, "POST", "/api/generate", {"model": "inkos1", "prompt": "bar chart: 3, 7", "size": 256, "seed": 9, "project": "tests"})
        assert code == 202
        for _ in range(200):
            _, job, _ = _call(base, "GET", f"/api/jobs/{job['id']}")
            if job["status"] in ("done", "error"):
                break
            time.sleep(0.1)
        assert job["status"] == "done", job
        meta = job["result"]["meta"]
        assert meta["seed"] == 9 and meta["size"] == 256 and meta["project"] == "tests"
        _, png, headers = _call(base, "GET", job["result"]["url"] + "?download=1")
        assert png[:8] == b"\x89PNG\r\n\x1a\n" and "attachment" in headers["Content-Disposition"]
        import io
        from PIL import Image
        img = Image.open(io.BytesIO(png))
        assert img.size == (256, 256) and bitmap.is_pure_bw(img)

        _, gal, _ = _call(base, "GET", "/api/gallery?project=tests")
        assert len(gal["images"]) == 1 and gal["images"][0]["meta"]["prompt"] == "bar chart: 3, 7"
        _, tr, _ = _call(base, "GET", "/api/training?model=inkos1")
        assert tr["training"]["global_step"] == 4 and len(tr["history"]["train"]) == 2
        _call(base, "DELETE", f"/api/gallery/tests/{meta['file']}")
        assert _call(base, "GET", "/api/gallery?project=tests")[1]["images"] == []
    finally:
        srv.shutdown()
        srv.server_close()
