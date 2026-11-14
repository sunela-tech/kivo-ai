"""Both networks: shapes, masks, caching, and that they actually learn."""
import numpy as np
import torch

from inkos.data import synth_charts, synth_notes
from inkos.models.inkos1 import Inkos1, Inkos1Config
from inkos.models.inkos1_pro import Inkos1Pro, ProConfig, downsample2
from inkos.vector import lang


def _batch(n=8, seed=0):
    rng = np.random.default_rng(seed)
    items = []
    while len(items) < n:
        d = (synth_notes.gen_todo if len(items) % 2 else synth_charts.gen_bar)(rng)
        if d is not None and len(d.prompt) < 100:
            items.append((d.prompt, lang.encode(d.ops)))
    P = max(len(p) for p, _ in items)
    T = max(len(t) for _, t in items) + 1
    prompt = torch.zeros(n, P, dtype=torch.long)
    mask = torch.zeros(n, P, dtype=torch.bool)
    tokens = torch.zeros(n, T, dtype=torch.long)
    targets = torch.full((n, T), -100)
    for b, (p, t) in enumerate(items):
        prompt[b, : len(p)] = torch.tensor(lang.prompt_tokens(p))
        mask[b, : len(p)] = True
        tokens[b, 0] = lang.BOS
        tokens[b, 1: len(t) + 1] = torch.tensor(t)
        targets[b, : len(t)] = torch.tensor(t)
        targets[b, len(t)] = lang.EOS
    return {"prompt": prompt, "prompt_mask": mask, "tokens": tokens, "targets": targets}, items


def _tiny1():
    torch.manual_seed(0)
    return Inkos1(Inkos1Config(d_model=64, n_layers=2, n_heads=4, d_ff=128))


def test_inkos1_shapes_and_pointer_mask():
    model = _tiny1()
    batch, _ = _batch()
    logits = model(batch["prompt"], batch["prompt_mask"], batch["tokens"])
    B, T = batch["tokens"].shape
    P = batch["prompt"].shape[1]
    assert logits.shape == (B, T, lang.VOCAB + P)
    ptr = logits[:, :, lang.VOCAB:]
    assert torch.isinf(ptr[~batch["prompt_mask"].unsqueeze(1).expand(-1, T, -1)]).all()   # no pointing at padding
    assert torch.isfinite(ptr[batch["prompt_mask"].unsqueeze(1).expand(-1, T, -1)]).all()


def test_inkos1_is_causal_and_ignores_prompt_padding():
    model = _tiny1().eval()
    batch, items = _batch()
    with torch.no_grad():
        full = model(batch["prompt"], batch["prompt_mask"], batch["tokens"])
        changed = batch["tokens"].clone()
        changed[:, 20:] = lang.TOK["CIRC"]                       # the future must not leak backwards
        cut = model(batch["prompt"], batch["prompt_mask"], changed)
        assert torch.allclose(full[:, :20, : lang.VOCAB], cut[:, :20, : lang.VOCAB], atol=1e-5)
        p, t = items[0]                                           # same sample alone, without padding
        solo = model(torch.tensor([lang.prompt_tokens(p)]), torch.ones(1, len(p), dtype=torch.bool),
                     torch.tensor([[lang.BOS] + t]))
        n = len(t) + 1
        assert torch.allclose(solo[0, :, : lang.VOCAB], full[0, :n, : lang.VOCAB], atol=1e-4)
        assert torch.allclose(solo[0, :, lang.VOCAB:], full[0, :n, lang.VOCAB: lang.VOCAB + len(p)], atol=1e-4)


def test_inkos1_cached_generation_matches_training_forward():
    """Greedy decoding with the key/value cache must follow the teacher-forced network exactly."""
    model = _tiny1().eval()
    prompt = "todo: [x] Pay rent; Call Anna"
    out = model.generate(prompt, temperature=0.0, max_tokens=40, constrain=True)
    toks = out["tokens"]
    assert toks
    with torch.no_grad():
        logits = model(torch.tensor([lang.prompt_tokens(prompt)]), torch.ones(1, len(prompt), dtype=torch.bool),
                       torch.tensor([[lang.BOS] + toks]))[0]
    g = lang.Grammar(len(prompt))
    for i, t in enumerate(toks[:36]):                            # the last 4 steps may be forced to close the program
        allowed = torch.from_numpy(g.allowed())
        assert int(logits[i].masked_fill(~allowed, float("-inf")).argmax()) == t
        g.feed(t)


def test_inkos1_constrained_sampling_always_renders():
    from inkos import bitmap
    from inkos.vector.render import render
    model = _tiny1().eval()                                       # untrained: worst case for the grammar mask
    for seed in range(5):
        prompt = "note: milk; eggs"
        res = model.generate(prompt, temperature=1.0, top_p=1.0, max_tokens=60, generator=torch.Generator().manual_seed(seed))
        ops, ok = lang.decode(res["tokens"] + [lang.EOS], len(prompt))
        assert ops == res["ops"] and len(res["tokens"]) <= 60
        assert bitmap.is_pure_bw(render(res["ops"], prompt, 256))


def test_inkos1_learns():
    model = _tiny1()
    batch, _ = _batch(8)
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    first = None
    for _ in range(80):
        loss, metrics = model.loss(batch)
        first = first or loss.item()
        opt.zero_grad()
        loss.backward()
        opt.step()
    assert loss.item() < 0.35 * first and metrics["token_acc"] > 0.6


def _tiny_pro():
    torch.manual_seed(0)
    return Inkos1Pro(ProConfig(base_resolution=32, channels=[16, 32], attn_levels=[1], heads=2, text_dim=32,
                               text_layers=1, text_heads=2, refiner_channels=8, refiner_blocks=1))


def _pro_batch():
    img = torch.zeros(4, 1, 64, 64)
    img[0, :, 10:54, 30:34] = 1                                   # vertical bar
    img[1, :, 30:34, 10:54] = 1                                   # horizontal bar
    img[2, :, 16:48, 16:48] = 1                                   # filled square
    img[3, :, 8:12, 8:56] = 1
    img[3, :, 52:56, 8:56] = 1                                    # two lines
    return {"image": img, "caption": ["vertical bar", "horizontal bar", "square", "two lines"]}


def test_pro_shapes_and_binary_outputs():
    model = _tiny_pro().eval()
    ink = model.sample(["square", "bar"], steps=3, guidance=2.0, generator=torch.Generator().manual_seed(0))
    assert ink.shape == (2, 1, 32, 32) and ink.dtype == torch.bool
    up = model.upscale(ink)
    assert up.shape == (2, 1, 64, 64) and up.dtype == torch.bool
    # an untrained refiner is exact pixel doubling
    assert (up == ink.repeat_interleave(2, 2).repeat_interleave(2, 3)).all()
    text, mask, pooled = model.text(["", "abc"])
    assert mask.tolist() == [[True, False, False, False], [True, True, True, True]] and torch.isfinite(text).all()


def test_downsample_rule_keeps_thin_lines():
    hr = torch.zeros(1, 1, 8, 8)
    hr[0, 0, :, 3] = 1                                            # one pixel wide
    assert downsample2(hr)[0, 0, :, 1].all() and downsample2(hr).sum() == 4
    assert downsample2(torch.zeros(1, 1, 4, 4)).sum() == 0


def test_pro_learns():
    model = _tiny_pro()
    batch = _pro_batch()
    opt = torch.optim.AdamW(model.parameters(), lr=3e-3)
    g = torch.Generator().manual_seed(1)
    start = model.loss(batch, refiner_crop=32, generator=torch.Generator().manual_seed(7))[1]
    for _ in range(150):
        loss, _ = model.loss(batch, refiner_crop=32, generator=g)
        opt.zero_grad()
        loss.backward()
        opt.step()
    end = model.loss(batch, refiner_crop=32, generator=torch.Generator().manual_seed(7))[1]
    assert end["base_bce"] < 0.6 * start["base_bce"]
    assert end["refiner_bit_acc"] > 0.97


def test_tiled_refiner_matches_single_pass_away_from_seams():
    from inkos.engine import upscale_tiled
    model = _tiny_pro().eval()
    ink = torch.rand(1, 1, 96, 96, generator=torch.Generator().manual_seed(0)) < 0.3
    assert (upscale_tiled(model, ink, tile=32, overlap=8) == model.upscale(ink)).all()
