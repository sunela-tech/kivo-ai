"""Dataset generators, importers and stores."""
import numpy as np
import pytest

from inkos import bitmap
from inkos.data import manga_scenes, quickdraw, store, svg_icons, synth_charts, synth_diagrams, synth_notes, synth_symbols
from inkos.vector import lang
from inkos.vector.render import render

FAMILIES = {**synth_notes.GENERATORS, **synth_charts.GENERATORS, **synth_diagrams.GENERATORS, **synth_symbols.GENERATORS}


@pytest.mark.parametrize("name", sorted(FAMILIES))
def test_generator_writes_valid_programs(name):
    rng = np.random.default_rng(7)
    made = 0
    for _ in range(40):
        d = FAMILIES[name][0](rng)
        if d is None:
            continue
        made += 1
        toks = lang.encode(d.ops)
        ops, ok = lang.decode(toks + [lang.EOS], len(d.prompt))
        assert ok and d.prompt and all(32 <= ord(c) <= 126 for c in d.prompt)
        for op in ops:                                              # every span points inside the prompt
            if op[0] == "TEXT":
                assert all(isinstance(i, str) or 0 <= i[0] <= i[1] < len(d.prompt) for i in op[5])
    assert made >= 20
    assert bitmap.is_pure_bw(render(ops, d.prompt, 256))


def test_bar_heights_follow_the_numbers():
    rng = np.random.default_rng(1)
    checked = 0
    for _ in range(40):
        d = synth_charts.gen_bar(rng)
        body = d.prompt.split(":", 1)[1]
        values = [int(part.split()[-1]) for part in body.split(",")]
        bars = sorted(op[1:] for op in d.ops if op[0] in ("RECT", "BOX"))
        shown = [v for v in values if v > 0]
        if len(bars) != len(shown):
            continue                                        # a bar under one grid unit is not drawn
        heights = [b[3] - b[1] for b in bars]
        scale = 10 if max(values) <= 10 else 100
        unit = heights[int(np.argmax(shown))] / max(shown)
        assert all(abs(h - v * unit) < 1e-6 for h, v in zip(heights, shown))
        assert max(heights) <= 128 * max(shown) / scale
        checked += 1
    assert checked >= 20


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor">
<path stroke="none" d="M0 0h24v24H0z" fill="none"/>
<path d="M5 12l-2 0l9 -9l9 9l-2 0"/><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>
<path d="M12 12h.01"/><circle cx="12" cy="12" r="4"/><rect x="4" y="4" width="16" height="16"/>
<line x1="2" y1="2" x2="22" y2="22"/><polyline points="1,1 5,5 9,1"/></svg>"""


def test_svg_icon_import():
    ops = svg_icons.icon_program(SVG, size=96, cx=64, cy=64)
    kinds = [op[0] for op in ops]
    assert kinds == ["LINE", "CIRC", "DISC", "CIRC", "RECT", "LINE", "LINE"]      # bounding box skipped
    assert ops[1][1:] == pytest.approx((64, 64, 36))                               # two arcs -> one circle
    assert len(ops[0][1]) == 5
    lang.encode(ops)


def test_svg_arc_flags_without_separators():
    subs = svg_icons.parse_path("M2 2a2 2 0 012 2", 4.0)
    assert len(subs) == 1 and subs[0]["segs"][0][0] == "C"
    assert subs[0]["segs"][0][1][-1] == pytest.approx([4, 4])


def test_brand_icons_are_skipped():
    assert svg_icons.icon_name("brand-github") is None
    assert svg_icons.icon_name("twitter") is None
    assert svg_icons.icon_name("arrow-up-right") == "arrow up right"


def test_quickdraw_sketch_conversion():
    drawing = [[[0, 50, 120, 255], [10, 80, 40, 200]], [[30, 30], [5, 250]], [[100], [100]]]
    ops = quickdraw.sketch_ops(drawing, 100, 64, 64, 300)
    assert [op[0] for op in ops] == ["CURVE", "LINE", "DISC"]
    xs = [p[0] for op in ops if op[0] != "DISC" for p in op[1]]
    assert min(xs) >= 13 and max(xs) <= 115


def test_vector_store_and_epoch_order(tmp_path):
    rng = np.random.default_rng(0)
    samples = []
    for i in range(50):
        d = synth_symbols.gen_symbol(rng)
        samples.append((d.prompt, lang.encode(d.ops), 0))
    store.write_vector_shard(tmp_path / "train-00000.npz", samples[:30])
    store.write_vector_shard(tmp_path / "train-00001.npz", samples[30:])
    (tmp_path / "meta.json").write_text('{"kinds": ["symbol"]}')
    ds = store.VectorSet(tmp_path, "train")
    assert len(ds) == 50
    for i in (0, 29, 30, 49):                                        # offsets survive the shard boundary
        prompt, toks, _ = ds.get(i)
        assert prompt == samples[i][0] and list(toks) == samples[i][1]
    a = [b.tolist() for b in ds.epoch_batches(3, 8, seed=1)]
    assert a == [b.tolist() for b in ds.epoch_batches(3, 8, seed=1)]   # reproducible -> resumable
    assert a != [b.tolist() for b in ds.epoch_batches(4, 8, seed=1)]
    assert sorted(i for b in a for i in b) == list(range(50))          # one epoch = every sample once
    batch = ds.collate(np.array([0, 1, 2]))
    assert batch["tokens"][0, 0] == lang.BOS
    n = len(samples[0][1])
    assert batch["targets"][0, n] == lang.EOS and (batch["targets"][0, n + 1:] == -100).all()


def test_raster_store_epoch_and_resume(tmp_path):
    rng = np.random.default_rng(0)
    counts = {}
    for i, n in enumerate((16, 16, 16, 9)):
        imgs = [rng.random((32, 32)) < 0.2 for _ in range(n)]
        store.write_raster_shard(tmp_path / f"train-synth-{i:05d}.npz", imgs, [f"s{i}-{k}" for k in range(n)], [0] * n)
        counts[f"train-synth-{i:05d}.npz"] = n
    import json
    (tmp_path / "meta.json").write_text(json.dumps({"kinds": ["a"], "resolution": 32, "shards": {"train": counts, "val": {}}}))
    ds = store.RasterSet(tmp_path, "train", pool=2)
    full = list(ds.batches(2, 10, seed=5))
    assert len(full) == ds.steps_per_epoch(10) == 6
    caps = [c for b in full for c in b["caption"]]
    assert len(caps) == 57 and len(set(caps)) == 57                   # every image exactly once
    assert full[0]["image"].shape == (10, 1, 32, 32) and set(full[0]["image"].unique().tolist()) <= {0.0, 1.0}
    for skip in (1, 3, 5):                                            # resuming mid-epoch replays the same batches
        rest = list(ds.batches(2, 10, seed=5, skip=skip))
        assert [b["caption"] for b in rest] == [b["caption"] for b in full[skip:]]


@pytest.mark.parametrize("kind", sorted(manga_scenes.MAKERS))
def test_manga_generator(kind):
    rng = np.random.default_rng(5)
    for _ in range(3):
        bits, caption, k = manga_scenes.MAKERS[kind][0](rng, 256)
        assert bits.shape == (256, 256) and bits.dtype == bool and k == kind
        assert 0.003 < bits.mean() < 0.99 and caption and len(caption) < 192
