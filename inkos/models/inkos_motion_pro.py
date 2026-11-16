"""INKOS MOTION 1 Pro: text-conditioned video diffusion in the six-colour palette.

INKOS 1.1 Pro made to move. A clip is FRAMES frames of palette indices; each
pixel of each frame is diffused as a one-hot vector exactly as in INKOS 1.1
Pro (rectified flow, cross-entropy loss, 2 * softmax - 1 estimate, arg-max at
the end). The network is INKOS 1.1 Pro's U-Net applied to every frame, plus
layers that let the frames see each other:

  temporal mixing   after every residual block: a convolution over time
                    (kernel 3) at every position
  temporal attention at the attention levels: every position attends to
                    itself in the other frames
  frame embedding   which frame this is, added to the time embedding

All three start at zero, so at initialisation the model is INKOS 1.1 Pro
drawing each frame on its own (train.init_from copies those weights); the
temporal layers then learn the motion. The refiner (2x per frame) is INKOS
1.1 Pro's, kept frozen: the clips are stored at the base resolution only.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from .inkos1_pro import AttnBlock, ProConfig, Refiner, ResBlock, TextEncoder, UNet, _Attention, _groups, one_hot_pm


@dataclass
class MotionProConfig(ProConfig):
    frames: int = 12


class TemporalMix(nn.Module):
    """Residual convolution over frames (and optionally attention over frames) at every position."""

    def __init__(self, c: int, heads: int, attention: bool):
        super().__init__()
        self.norm = nn.GroupNorm(_groups(c), c)
        self.conv = nn.Conv1d(c, c, 3, padding=1)
        nn.init.zeros_(self.conv.weight)
        nn.init.zeros_(self.conv.bias)
        self.attn = None
        if attention:
            self.n_attn = nn.LayerNorm(c)
            self.attn = _Attention(c, heads)
            nn.init.zeros_(self.attn.out.weight)
            nn.init.zeros_(self.attn.out.bias)

    def forward(self, h: torch.Tensor, frames: int) -> torch.Tensor:
        BF, C, H, W = h.shape
        B = BF // frames
        x = self.norm(h).view(B, frames, C, H, W).permute(0, 3, 4, 2, 1).reshape(B * H * W, C, frames)
        y = self.conv(x)                                                    # [BHW, C, F]
        if self.attn is not None:
            seq = (x + y).transpose(1, 2)                                   # [BHW, F, C]
            y = y + self.attn(self.n_attn(seq)).transpose(1, 2)
        y = y.view(B, H, W, C, frames).permute(0, 4, 3, 1, 2).reshape(BF, C, H, W)
        return h + y


class VideoUNet(UNet):
    def __init__(self, cfg: MotionProConfig):
        super().__init__(cfg)
        ch = list(cfg.channels)
        emb = ch[0] * 4
        self.frame_emb = nn.Parameter(torch.zeros(cfg.frames, emb))
        tdown = []
        lvl, k = 0, 0
        for m in self.down:
            if isinstance(m, nn.ModuleList):
                c = m[0].c2.out_channels
                tdown.append(TemporalMix(c, cfg.heads, m[1] is not None))
                k += 1
            else:
                tdown.append(None)
                lvl += 1
        self.tdown = nn.ModuleList([t if t is not None else nn.Identity() for t in tdown])
        c = ch[-1]
        self.tmid = TemporalMix(c, cfg.heads, True)
        self.tup = nn.ModuleList(TemporalMix(m[0].c2.out_channels, cfg.heads, m[1] is not None) for m in self.up)

    def forward(self, x_t, t, text, text_mask, pooled, self_cond=None):
        """x_t [B,C,F,H,W] real, t [B] -> logits [B,C,F,H,W]."""
        cfg = self.cfg
        B, C, Fr, H, W = x_t.shape

        def frames_first(v):                                  # [B,C,F,H,W] -> [B*F,C,H,W]
            return v.permute(0, 2, 1, 3, 4).reshape(B * Fr, C, H, W)

        def per_frame(v):                                     # repeat a per-clip tensor for every frame
            return v.unsqueeze(1).expand(B, Fr, *v.shape[1:]).reshape(B * Fr, *v.shape[1:])

        x = frames_first(x_t)
        if cfg.self_cond:
            x = torch.cat([x, torch.zeros_like(x) if self_cond is None else frames_first(self_cond)], dim=1)
        text_f, mask_f = per_frame(text), per_frame(text_mask)
        h = self.conv_in(F.pixel_unshuffle(x, cfg.patch))
        half = cfg.channels[0] // 2
        freqs = torch.exp(-math.log(10000.0) * torch.arange(half, device=t.device) / half)
        ang = t[:, None] * 1000.0 * freqs[None]
        emb = self.time(torch.cat([ang.sin(), ang.cos()], dim=1).to(h.dtype)) + self.text_pool(pooled)   # [B, E]
        emb = (emb.unsqueeze(1) + self.frame_emb[:Fr].unsqueeze(0).to(emb.dtype)).reshape(B * Fr, -1)
        hs = [h]
        for m, tm in zip(self.down, self.tdown):
            if isinstance(m, nn.ModuleList):
                h = m[0](h, emb)
                if m[1] is not None:
                    h = m[1](h, text_f, mask_f)
                h = tm(h, Fr)
            else:
                h = m(h)
            hs.append(h)
        h = self.mid_attn(self.mid1(h, emb), text_f, mask_f)
        h = self.mid2(self.tmid(h, Fr), emb)
        for (res, attn, up), tm in zip(self.up, self.tup):
            h = res(torch.cat([h, hs.pop()], dim=1), emb)
            if attn is not None:
                h = attn(h, text_f, mask_f)
            h = tm(h, Fr)
            if up is not None:
                h = up(F.interpolate(h, scale_factor=2.0, mode="nearest"))
        out = F.pixel_shuffle(self.conv_out(F.silu(self.norm_out(h))), cfg.patch)       # [B*F, C, H, W]
        return out.view(B, Fr, C, H, W).permute(0, 2, 1, 3, 4)


class InkosMotionPro(nn.Module):
    def __init__(self, cfg: MotionProConfig):
        super().__init__()
        if cfg.colors <= 1:
            raise ValueError("INKOS MOTION 1 Pro is a colour model (colors: 6)")
        self.cfg = cfg
        self.text = TextEncoder(cfg)
        self.unet = VideoUNet(cfg)
        self.refiner = Refiner(cfg)
        for p in self.refiner.parameters():           # INKOS 1.1 Pro's refiner, kept as it is
            p.requires_grad_(False)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    def estimate(self, logits: torch.Tensor) -> torch.Tensor:
        return torch.softmax(logits.float(), dim=1) * 2 - 1

    def loss(self, batch: dict, caption_dropout: float = 0.1, self_cond_prob: float = 0.5,
             generator: torch.Generator | None = None, **_):
        """batch['clip']: long [B,F,R,R] palette indices at the base resolution; batch['caption']: list[str]."""
        clip = batch["clip"]
        dev = clip.device
        B = clip.shape[0]
        x0 = F.one_hot(clip, self.cfg.colors).permute(0, 4, 1, 2, 3).float() * 2 - 1          # [B,C,F,R,R]

        def rand(*shape):
            return torch.rand(*shape, generator=generator).to(dev)

        def randn(*shape):
            return torch.randn(*shape, generator=generator).to(dev)

        drop = rand(B) < caption_dropout
        caps = ["" if d else c for c, d in zip(batch["caption"], drop.tolist())]
        text, mask, pooled = self.text(caps)
        t = torch.sigmoid(randn(B)).clamp(1e-3, 1.0)
        tb = t.view(B, 1, 1, 1, 1)
        x_t = (1 - tb) * x0 + tb * randn(*x0.shape)
        sc = None
        if self.cfg.self_cond and float(rand(1)) < self_cond_prob:
            with torch.no_grad():
                sc = self.estimate(self.unet(x_t, t, text, mask, pooled)).detach()
        logits = self.unet(x_t, t, text, mask, pooled, sc)
        ce = F.cross_entropy(logits.float(), clip)
        with torch.no_grad():
            pred = logits.argmax(1)
            acc = (pred == clip).float().mean().item()
            # how well the frame-to-frame changes are predicted, where the clip actually changes
            moving = clip[:, 1:] != clip[:, :-1]
            hit = ((pred[:, 1:] == clip[:, 1:]) & moving).sum().item() / max(1, int(moving.sum()))
        return ce, {"base_ce": ce.item(), "base_px_acc": acc, "moving_px_acc": hit}

    @torch.no_grad()
    def sample(self, prompts: list[str], steps: int = 32, guidance: float = 3.0,
               generator: torch.Generator | None = None, progress=None) -> torch.Tensor:
        """-> long [B,F,R,R] palette indices."""
        dev = next(self.parameters()).device
        B, R, Fr, C = len(prompts), self.cfg.base_resolution, self.cfg.frames, self.cfg.colors
        text, mask, pooled = self.text(list(prompts) + [""] * B)
        x = torch.randn(B, C, Fr, R, R, generator=generator).to(dev)
        sc = torch.zeros_like(x)
        ts = torch.linspace(1.0, 0.0, steps + 1).tolist()
        logits = None
        for i in range(steps):
            t = torch.full((B,), ts[i], device=dev)
            out = self.unet(torch.cat([x, x]), torch.cat([t, t]), text, mask, pooled, torch.cat([sc, sc]))
            cond, unc = out.chunk(2)
            logits = unc + guidance * (cond - unc)
            x0 = self.estimate(logits)
            sc = x0
            x = x0 + (ts[i + 1] / ts[i]) * (x - x0)
            if progress is not None:
                progress(i + 1, steps)
        return logits.argmax(1)

    @torch.no_grad()
    def upscale(self, picture: torch.Tensor) -> torch.Tensor:
        """Palette indices [B,h,w] -> [B,2h,2w] with the refiner (one frame at a time is fine)."""
        return self.refiner(one_hot_pm(picture)).argmax(1)
