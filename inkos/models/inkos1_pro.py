"""INKOS 1 Pro: text-conditioned diffusion over 1-bit pixels, plus a refiner.

Three networks, trained together and stored in one checkpoint:

  TextEncoder  character-level transformer; no pretrained weights.
  UNet         the generator. Works at the base resolution (256 x 256). Each
               pixel is one bit, mapped to -1 (paper) / +1 (ink) and diffused
               as a real number ("analog bits"). The network predicts, for
               every pixel, the probability that it is ink; that makes the
               loss a plain binary cross-entropy and the denoised estimate
               E[x0 | xt] = 2p - 1 exact for binary data. Self-conditioning
               feeds the previous estimate back in. Pixels are folded 4 x 4
               into channels so the U-Net runs on a 64 x 64 grid.
  Refiner      a small convolutional network that doubles resolution
               (256 -> 512, applied twice for 1024). It is trained on real
               pairs: each 512 px training image and its 2x reduction.

Noise schedule: rectified flow, x_t = (1 - t) x0 + t * noise, t in (0, 1].
Sampling: deterministic Euler steps with classifier-free guidance applied to
the logits, then a hard threshold, so the result is exactly two values.

INKOS 1.1 Pro is the same model with `colors: 6`. A pixel is then one of the
six E-Ink palette colours: it is diffused as a one-hot vector (six channels in
-1 / +1), the network predicts a distribution over the six colours per pixel
(cross-entropy loss), the denoised estimate is 2 * softmax - 1, and the final
picture is the arg-max colour of every pixel, so it can only contain palette
colours. With two colours this reduces to the black-and-white formulation.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field

import torch
import torch.nn as nn
import torch.nn.functional as F

from .. import palette
from ..prompts import FIRST_CHAR, N_CHARS

PAD_ID, BOS_ID = 0, N_CHARS + 1
TEXT_VOCAB = N_CHARS + 2


@dataclass
class ProConfig:
    base_resolution: int = 256
    patch: int = 4
    channels: list = field(default_factory=lambda: [96, 192, 320, 448])
    blocks_per_level: int = 2
    attn_levels: list = field(default_factory=lambda: [2, 3])
    heads: int = 8
    text_dim: int = 320
    text_layers: int = 4
    text_heads: int = 8
    max_prompt: int = 192
    self_cond: bool = True
    refiner_channels: int = 64
    refiner_blocks: int = 8
    dropout: float = 0.0
    colors: int = 1                # 1 = black-and-white; 6 = the E-Ink palette (INKOS 1.1 Pro)

    @property
    def planes(self) -> int:
        """Channels per pixel: one bit, or one channel per palette colour."""
        return self.colors if self.colors > 1 else 1

    @classmethod
    def from_dict(cls, d: dict) -> "ProConfig":
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------
# text
# --------------------------------------------------------------------------

class _Attention(nn.Module):
    def __init__(self, dim: int, heads: int, ctx_dim: int | None = None):
        super().__init__()
        self.h = heads
        self.q = nn.Linear(dim, dim, bias=False)
        self.kv = nn.Linear(ctx_dim or dim, 2 * dim, bias=False)
        self.out = nn.Linear(dim, dim)

    def forward(self, x, ctx=None, mask=None):
        B, T, D = x.shape
        ctx = x if ctx is None else ctx
        S = ctx.shape[1]
        q = self.q(x).view(B, T, self.h, D // self.h).transpose(1, 2)
        k, v = self.kv(ctx).view(B, S, 2, self.h, D // self.h).permute(2, 0, 3, 1, 4)
        if mask is not None:
            mask = mask[:, None, None, :]
        a = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        return self.out(a.transpose(1, 2).reshape(B, T, D))


class _TextBlock(nn.Module):
    def __init__(self, dim, heads):
        super().__init__()
        self.n1, self.attn = nn.LayerNorm(dim), _Attention(dim, heads)
        self.n2 = nn.LayerNorm(dim)
        self.ff = nn.Sequential(nn.Linear(dim, 4 * dim), nn.GELU(), nn.Linear(4 * dim, dim))

    def forward(self, x, mask):
        x = x + self.attn(self.n1(x), mask=mask)
        return x + self.ff(self.n2(x))


class TextEncoder(nn.Module):
    def __init__(self, cfg: ProConfig):
        super().__init__()
        self.max_len = cfg.max_prompt + 1
        self.tok = nn.Embedding(TEXT_VOCAB, cfg.text_dim, padding_idx=PAD_ID)
        self.pos = nn.Embedding(self.max_len, cfg.text_dim)
        self.blocks = nn.ModuleList(_TextBlock(cfg.text_dim, cfg.text_heads) for _ in range(cfg.text_layers))
        self.norm = nn.LayerNorm(cfg.text_dim)

    def tokenize(self, prompts: list[str], device) -> tuple[torch.Tensor, torch.Tensor]:
        """Every prompt starts with <bos>, so the empty (unconditional) prompt is one token."""
        rows = [[BOS_ID] + [min(N_CHARS, max(1, ord(c) - FIRST_CHAR + 1)) for c in p[: self.max_len - 1]] for p in prompts]
        L = max(len(r) for r in rows)
        ids = torch.zeros(len(rows), L, dtype=torch.long)
        for i, r in enumerate(rows):
            ids[i, : len(r)] = torch.tensor(r)
        ids = ids.to(device)
        return ids, ids != PAD_ID

    def forward(self, prompts: list[str]):
        ids, mask = self.tokenize(prompts, self.tok.weight.device)
        x = self.tok(ids) + self.pos(torch.arange(ids.shape[1], device=ids.device))
        for b in self.blocks:
            x = b(x, mask)
        x = self.norm(x)
        pooled = (x * mask.unsqueeze(-1)).sum(1) / mask.sum(1, keepdim=True)
        return x, mask, pooled


# --------------------------------------------------------------------------
# U-Net
# --------------------------------------------------------------------------

def _groups(c: int) -> int:
    g = 32
    while c % g:
        g //= 2
    return g


class ResBlock(nn.Module):
    def __init__(self, cin, cout, emb_dim, dropout):
        super().__init__()
        self.n1, self.c1 = nn.GroupNorm(_groups(cin), cin), nn.Conv2d(cin, cout, 3, padding=1)
        self.emb = nn.Linear(emb_dim, cout)
        self.n2, self.c2 = nn.GroupNorm(_groups(cout), cout), nn.Conv2d(cout, cout, 3, padding=1)
        self.drop = nn.Dropout(dropout)
        self.skip = nn.Conv2d(cin, cout, 1) if cin != cout else nn.Identity()
        nn.init.zeros_(self.c2.weight)
        nn.init.zeros_(self.c2.bias)

    def forward(self, x, emb):
        h = self.c1(F.silu(self.n1(x)))
        h = h + self.emb(emb)[:, :, None, None]
        h = self.c2(self.drop(F.silu(self.n2(h))))
        return self.skip(x) + h


class AttnBlock(nn.Module):
    """Self-attention over positions, cross-attention to the prompt, feed-forward."""

    def __init__(self, c, heads, text_dim):
        super().__init__()
        self.norm = nn.GroupNorm(_groups(c), c)
        self.n1, self.self_attn = nn.LayerNorm(c), _Attention(c, heads)
        self.n2, self.cross = nn.LayerNorm(c), _Attention(c, heads, text_dim)
        self.n3 = nn.LayerNorm(c)
        self.ff = nn.Sequential(nn.Linear(c, 2 * c), nn.GELU(), nn.Linear(2 * c, c))
        nn.init.zeros_(self.ff[-1].weight)
        nn.init.zeros_(self.ff[-1].bias)

    def forward(self, x, text, text_mask):
        B, C, H, W = x.shape
        t = self.norm(x).flatten(2).transpose(1, 2)
        t = t + self.self_attn(self.n1(t))
        t = t + self.cross(self.n2(t), text, text_mask)
        t = t + self.ff(self.n3(t))
        return x + t.transpose(1, 2).reshape(B, C, H, W)


class UNet(nn.Module):
    def __init__(self, cfg: ProConfig):
        super().__init__()
        self.cfg = cfg
        ch = list(cfg.channels)
        p2 = cfg.patch * cfg.patch
        emb = ch[0] * 4
        self.time = nn.Sequential(nn.Linear(ch[0], emb), nn.SiLU(), nn.Linear(emb, emb))
        self.text_pool = nn.Linear(cfg.text_dim, emb)
        self.conv_in = nn.Conv2d((2 if cfg.self_cond else 1) * cfg.planes * p2, ch[0], 3, padding=1)

        self.down = nn.ModuleList()
        skips = [ch[0]]
        c = ch[0]
        for lvl, co in enumerate(ch):
            for _ in range(cfg.blocks_per_level):
                self.down.append(nn.ModuleList([ResBlock(c, co, emb, cfg.dropout),
                                                AttnBlock(co, cfg.heads, cfg.text_dim) if lvl in cfg.attn_levels else None]))
                c = co
                skips.append(c)
            if lvl < len(ch) - 1:
                self.down.append(nn.Conv2d(c, c, 3, stride=2, padding=1))
                skips.append(c)
        self.mid1 = ResBlock(c, c, emb, cfg.dropout)
        self.mid_attn = AttnBlock(c, cfg.heads, cfg.text_dim)
        self.mid2 = ResBlock(c, c, emb, cfg.dropout)
        self.up = nn.ModuleList()
        for lvl in reversed(range(len(ch))):
            co = ch[lvl]
            for i in range(cfg.blocks_per_level + 1):
                self.up.append(nn.ModuleList([ResBlock(c + skips.pop(), co, emb, cfg.dropout),
                                              AttnBlock(co, cfg.heads, cfg.text_dim) if lvl in cfg.attn_levels else None,
                                              nn.Conv2d(co, co, 3, padding=1) if (i == cfg.blocks_per_level and lvl > 0) else None]))
                c = co
        self.norm_out = nn.GroupNorm(_groups(c), c)
        self.conv_out = nn.Conv2d(c, cfg.planes * p2, 3, padding=1)

    def forward(self, x_t, t, text, text_mask, pooled, self_cond=None):
        """x_t [B,C,H,W] real, t [B] in (0,1]  ->  logits [B,C,H,W] (C = 1 ink plane, or one per colour)."""
        cfg = self.cfg
        if cfg.self_cond:
            x_t = torch.cat([x_t, torch.zeros_like(x_t) if self_cond is None else self_cond], dim=1)
        h = self.conv_in(F.pixel_unshuffle(x_t, cfg.patch))
        half = cfg.channels[0] // 2
        freqs = torch.exp(-math.log(10000.0) * torch.arange(half, device=t.device) / half)
        ang = t[:, None] * 1000.0 * freqs[None]
        emb = self.time(torch.cat([ang.sin(), ang.cos()], dim=1).to(h.dtype)) + self.text_pool(pooled)
        hs = [h]
        for m in self.down:
            if isinstance(m, nn.ModuleList):
                h = m[0](h, emb)
                if m[1] is not None:
                    h = m[1](h, text, text_mask)
            else:
                h = m(h)
            hs.append(h)
        h = self.mid2(self.mid_attn(self.mid1(h, emb), text, text_mask), emb)
        for res, attn, up in self.up:
            h = res(torch.cat([h, hs.pop()], dim=1), emb)
            if attn is not None:
                h = attn(h, text, text_mask)
            if up is not None:
                h = up(F.interpolate(h, scale_factor=2.0, mode="nearest"))
        return F.pixel_shuffle(self.conv_out(F.silu(self.norm_out(h))), cfg.patch)


# --------------------------------------------------------------------------
# refiner (2x, 1-bit in, 1-bit out)
# --------------------------------------------------------------------------

class Refiner(nn.Module):
    def __init__(self, cfg: ProConfig):
        super().__init__()
        c = cfg.refiner_channels
        self.inp = nn.Conv2d(cfg.planes, c, 3, padding=1)
        self.body = nn.ModuleList(nn.Sequential(nn.Conv2d(c, c, 3, padding=1), nn.SiLU(), nn.Conv2d(c, c, 3, padding=1))
                                  for _ in range(cfg.refiner_blocks))
        self.up = nn.Conv2d(c, 4 * c, 3, padding=1)
        self.out = nn.Conv2d(c, cfg.planes, 3, padding=1)
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)

    def forward(self, x):
        """x [B,C,h,w] in {-1,+1}  ->  logits [B,C,2h,2w].

        Starts out as plain pixel doubling (the residual branch is zero at
        initialisation) and learns the corrections on top of it.
        """
        h = self.inp(x)
        for b in self.body:
            h = h + b(h)
        h = F.silu(F.pixel_shuffle(self.up(h), 2))
        return self.out(h) + 4.0 * F.interpolate(x, scale_factor=2.0, mode="nearest")


def downsample2(ink: torch.Tensor) -> torch.Tensor:
    """{0,1} [B,1,H,W] -> [B,1,H/2,W/2]; ink where at least 2 of the 4 source pixels are ink."""
    return (F.avg_pool2d(ink, 2) >= 0.5).to(ink.dtype)


def downsample2_idx(idx: torch.Tensor) -> torch.Tensor:
    """Palette indices [B,H,W] -> [B,H/2,W/2] without blending.

    Paper only where at least 3 of the 4 source pixels are paper; otherwise the
    most common ink, black first on ties. Same rule as downsample2 for two colours.
    """
    counts = F.avg_pool2d(F.one_hot(idx, palette.N).permute(0, 3, 1, 2).float(), 2) * 4
    paper = counts[:, palette.WHITE] > 2
    counts[:, palette.WHITE] = -1
    counts[:, palette.BLACK] += 0.25
    out = counts.argmax(1)
    out[paper] = palette.WHITE
    return out


def one_hot_pm(idx: torch.Tensor) -> torch.Tensor:
    """Palette indices [B,H,W] -> [B,6,H,W] with +1 on the pixel's colour and -1 elsewhere."""
    return F.one_hot(idx, palette.N).permute(0, 3, 1, 2).float() * 2 - 1


# --------------------------------------------------------------------------
# the model
# --------------------------------------------------------------------------

class Inkos1Pro(nn.Module):
    def __init__(self, cfg: ProConfig):
        super().__init__()
        self.cfg = cfg
        self.text = TextEncoder(cfg)
        self.unet = UNet(cfg)
        self.refiner = Refiner(cfg)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    # -- training -----------------------------------------------------------
    def loss(self, batch: dict, caption_dropout: float = 0.1, self_cond_prob: float = 0.5,
             refiner_crop: int = 128, refiner_crops: int = 2, generator: torch.Generator | None = None):
        """batch['image'] at twice the base resolution: float [B,1,2R,2R] in {0,1} for
        black-and-white, long [B,2R,2R] of palette indices for colour. batch['caption']: list[str]."""
        color = self.cfg.colors > 1
        hr = batch["image"]
        dev = hr.device
        B = hr.shape[0]
        R = self.cfg.base_resolution
        if color:
            if hr.shape[-1] != 2 * R:
                hr = F.interpolate(hr[:, None].float(), size=(2 * R, 2 * R), mode="nearest")[:, 0].long()
            lr = downsample2_idx(hr)                 # [B,R,R] indices
            x0 = one_hot_pm(lr)
        else:
            if hr.shape[-1] != 2 * R:
                hr = (F.interpolate(hr, size=(2 * R, 2 * R), mode="area") >= 0.5).to(hr.dtype)
            lr = downsample2(hr)
            x0 = lr * 2 - 1

        def rand(*shape):
            return torch.rand(*shape, generator=generator).to(dev)

        def randn(*shape):
            return torch.randn(*shape, generator=generator).to(dev)

        def fit(logits, target):
            if color:
                return F.cross_entropy(logits.float(), target), (logits.argmax(1) == target).float().mean().item()
            return (F.binary_cross_entropy_with_logits(logits.float(), target),
                    ((logits > 0) == (target > 0.5)).float().mean().item())

        # base model
        drop = rand(B) < caption_dropout
        caps = ["" if d else c for c, d in zip(batch["caption"], drop.tolist())]
        text, mask, pooled = self.text(caps)
        t = torch.sigmoid(randn(B)).clamp(1e-3, 1.0)
        tb = t.view(B, 1, 1, 1)
        x_t = (1 - tb) * x0 + tb * randn(*x0.shape)
        sc = None
        if self.cfg.self_cond and float(rand(1)) < self_cond_prob:
            with torch.no_grad():
                sc = self.estimate(self.unet(x_t, t, text, mask, pooled)).detach()
        base, base_acc = fit(self.unet(x_t, t, text, mask, pooled, sc), lr)

        # refiner, on aligned crops
        c = refiner_crop
        lrs, hrs = [], []
        for _ in range(refiner_crops):
            ys = torch.randint(0, R - c // 2 + 1, (B,), generator=generator)
            xs = torch.randint(0, R - c // 2 + 1, (B,), generator=generator)
            for b in range(B):
                y, x = int(ys[b]), int(xs[b])
                lrs.append(lr[b, ..., y: y + c // 2, x: x + c // 2])
                hrs.append(hr[b, ..., 2 * y: 2 * y + c, 2 * x: 2 * x + c])
        lr_c, hr_c = torch.stack(lrs), torch.stack(hrs)
        # generated inputs are not perfect: train on lightly corrupted ones too
        flip = rand(*lr_c.shape) < rand(lr_c.shape[0], *([1] * (lr_c.ndim - 1))) * 0.03
        if color:
            noisy = torch.where(flip, torch.randint(0, palette.N, lr_c.shape, generator=generator).to(dev), lr_c)
            ref, ref_acc = fit(self.refiner(one_hot_pm(noisy)), hr_c)
            names = ("base_ce", "refiner_ce", "base_px_acc", "refiner_px_acc")
        else:
            ref, ref_acc = fit(self.refiner(torch.where(flip, 1 - lr_c, lr_c) * 2 - 1), hr_c)
            names = ("base_bce", "refiner_bce", "base_bit_acc", "refiner_bit_acc")
        metrics = dict(zip(names, (base.item(), ref.item(), base_acc, ref_acc)))
        return base + ref, metrics

    def estimate(self, logits: torch.Tensor) -> torch.Tensor:
        """E[x0 | x_t] from the network's logits, in the -1 / +1 pixel space."""
        if self.cfg.colors > 1:
            return torch.softmax(logits.float(), dim=1) * 2 - 1
        return torch.tanh(logits.float() / 2)

    # -- inference ----------------------------------------------------------
    @torch.no_grad()
    def sample(self, prompts: list[str], steps: int = 32, guidance: float = 3.0,
               generator: torch.Generator | None = None, progress=None) -> torch.Tensor:
        """-> bool [B,1,R,R] (True = ink), or for a colour model long [B,R,R] of palette indices.
        progress(step, steps) is called after every denoising step."""
        dev = next(self.parameters()).device
        B, R = len(prompts), self.cfg.base_resolution
        use_cfg = guidance != 1.0
        text, mask, pooled = self.text(list(prompts) + [""] * B if use_cfg else list(prompts))
        x = torch.randn(B, self.cfg.planes, R, R, generator=generator).to(dev)
        sc = torch.zeros_like(x)
        ts = torch.linspace(1.0, 0.0, steps + 1).tolist()
        logits = None
        for i in range(steps):
            t = torch.full((B,), ts[i], device=dev)
            if use_cfg:
                out = self.unet(torch.cat([x, x]), torch.cat([t, t]), text, mask, pooled, torch.cat([sc, sc]))
                cond, unc = out.chunk(2)
                logits = unc + guidance * (cond - unc)
            else:
                logits = self.unet(x, t, text, mask, pooled, sc)
            x0 = self.estimate(logits)
            sc = x0
            x = x0 + (ts[i + 1] / ts[i]) * (x - x0)
            if progress is not None:
                progress(i + 1, steps)
        return logits.argmax(1) if self.cfg.colors > 1 else logits > 0

    @torch.no_grad()
    def upscale(self, picture: torch.Tensor) -> torch.Tensor:
        """Double the resolution with the learned refiner.
        bool [B,1,h,w] -> bool [B,1,2h,2w], or palette indices [B,h,w] -> [B,2h,2w]."""
        if self.cfg.colors > 1:
            return self.refiner(one_hot_pm(picture)).argmax(1)
        return self.refiner(picture.float() * 2 - 1) > 0
