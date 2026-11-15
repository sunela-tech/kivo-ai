"""INKOS 1: a prefix-LM transformer that writes InkScript.

Sequence layout
    [ prompt characters ]  [ <bos> program tokens ... <eos> ]
       bidirectional            left-to-right

Prompt positions attend to the whole prompt; program positions attend to the
prompt and to earlier program tokens. One stack of weights does both jobs.

Output distribution at each program step is a single softmax over
    VOCAB drawing tokens  +  one "copy from prompt position i" entry per
    prompt character (pointer head).
A pointer pair marks a span of the prompt to be written on the page, so text
the user typed is quoted verbatim rather than re-spelled by the network.

INKOS 1.1 is the same network with `color: true`: six more tokens select the
pen colour, and the program is rasterised in the six-colour E-Ink palette.

Generation runs with key/value caching and, by default, a grammar mask
(inkos.vector.lang.Grammar) so every sampled program can be rendered.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import torch
import torch.nn as nn
import torch.nn.functional as F

from ..vector import lang


@dataclass
class Inkos1Config:
    d_model: int = 256
    n_layers: int = 8
    n_heads: int = 8
    d_ff: int = 1024
    max_prompt: int = 256
    max_program: int = 320
    dropout: float = 0.0
    color: bool = False            # INKOS 1.1: six extra colour tokens
    vocab: int = lang.VOCAB

    @classmethod
    def from_dict(cls, d: dict) -> "Inkos1Config":
        kw = {k: v for k, v in d.items() if k in cls.__dataclass_fields__}
        if kw.get("color"):
            kw["vocab"] = lang.VOCAB_COLOR
        return cls(**kw)

    def to_dict(self) -> dict:
        return asdict(self)


class Block(nn.Module):
    def __init__(self, cfg: Inkos1Config):
        super().__init__()
        d = cfg.d_model
        self.h = cfg.n_heads
        self.n1 = nn.LayerNorm(d)
        self.qkv = nn.Linear(d, 3 * d)
        self.proj = nn.Linear(d, d)
        self.n2 = nn.LayerNorm(d)
        self.fc1 = nn.Linear(d, cfg.d_ff)
        self.fc2 = nn.Linear(cfg.d_ff, d)
        self.drop = nn.Dropout(cfg.dropout)

    def _split(self, x):
        B, T, D = x.shape
        q, k, v = self.qkv(self.n1(x)).view(B, T, 3, self.h, D // self.h).permute(2, 0, 3, 1, 4)
        return q, k, v

    def _mlp(self, x):
        return x + self.drop(self.fc2(F.gelu(self.fc1(self.n2(x)))))

    def forward(self, x, mask):
        B, T, D = x.shape
        q, k, v = self._split(x)
        a = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
        x = x + self.drop(self.proj(a.transpose(1, 2).reshape(B, T, D)))
        return self._mlp(x)

    def step(self, x, cache: dict):
        """Process new positions that may attend to everything cached so far."""
        B, T, D = x.shape
        q, k, v = self._split(x)
        if "k" in cache:
            k = torch.cat([cache["k"], k], dim=2)
            v = torch.cat([cache["v"], v], dim=2)
        cache["k"], cache["v"] = k, v
        a = F.scaled_dot_product_attention(q, k, v)
        x = x + self.proj(a.transpose(1, 2).reshape(B, T, D))
        return self._mlp(x)


class Inkos1(nn.Module):
    def __init__(self, cfg: Inkos1Config):
        super().__init__()
        self.cfg = cfg
        d = cfg.d_model
        self.tok = nn.Embedding(cfg.vocab, d)
        self.seg = nn.Embedding(2, d)
        self.pos_prompt = nn.Embedding(cfg.max_prompt, d)
        self.pos_prog = nn.Embedding(cfg.max_program + 1, d)
        self.ptr_emb = nn.Parameter(torch.zeros(d))
        self.blocks = nn.ModuleList(Block(cfg) for _ in range(cfg.n_layers))
        self.norm = nn.LayerNorm(d)
        self.head = nn.Linear(d, cfg.vocab, bias=False)
        self.head.weight = self.tok.weight           # tied
        self.ptr_q = nn.Linear(d, d)
        self.ptr_k = nn.Linear(d, d)
        self.apply(self._init)
        for b in self.blocks:
            nn.init.normal_(b.proj.weight, std=0.02 / math.sqrt(2 * cfg.n_layers))
            nn.init.normal_(b.fc2.weight, std=0.02 / math.sqrt(2 * cfg.n_layers))

    @staticmethod
    def _init(m):
        if isinstance(m, nn.Linear):
            nn.init.normal_(m.weight, std=0.02)
            if m.bias is not None:
                nn.init.zeros_(m.bias)
        elif isinstance(m, nn.Embedding):
            nn.init.normal_(m.weight, std=0.02)

    def num_params(self) -> int:
        return sum(p.numel() for p in self.parameters())

    # -- embeddings ---------------------------------------------------------
    def _embed_prompt(self, prompt):
        P = prompt.shape[1]
        pos = torch.arange(P, device=prompt.device)
        return self.tok(prompt) + self.pos_prompt(pos) + self.seg.weight[0]

    def _embed_program(self, tokens, prompt, start: int = 0):
        """tokens may contain pointer ids (>= vocab): embedded from the prompt
        character and position they point at."""
        V = self.cfg.vocab
        is_ptr = tokens >= V
        idx = (tokens - V).clamp(min=0, max=max(0, prompt.shape[1] - 1))
        plain = self.tok(tokens.masked_fill(is_ptr, 0))
        if prompt.shape[1]:
            pointed = self.tok(prompt.gather(1, idx)) + self.pos_prompt(idx) + self.ptr_emb
            x = torch.where(is_ptr.unsqueeze(-1), pointed, plain)
        else:
            x = plain
        pos = torch.arange(start, start + tokens.shape[1], device=tokens.device)
        return x + self.pos_prog(pos) + self.seg.weight[1]

    def _logits(self, h_prog, h_prompt, prompt_mask):
        vocab = self.head(h_prog)
        ptr = self.ptr_q(h_prog) @ self.ptr_k(h_prompt).transpose(1, 2) / math.sqrt(self.cfg.d_model)
        ptr = ptr.masked_fill(~prompt_mask.unsqueeze(1), float("-inf"))
        return torch.cat([vocab, ptr], dim=-1)

    # -- training -----------------------------------------------------------
    def forward(self, prompt, prompt_mask, tokens):
        """-> logits [B, T, vocab + P] for every program position."""
        B, P = prompt.shape
        T = tokens.shape[1]
        x = torch.cat([self._embed_prompt(prompt), self._embed_program(tokens, prompt)], dim=1)
        L = P + T
        base = torch.zeros(L, L, dtype=torch.bool, device=x.device)
        base[P:, P:] = torch.tril(torch.ones(T, T, dtype=torch.bool, device=x.device))
        cols = torch.cat([prompt_mask, torch.zeros(B, T, dtype=torch.bool, device=x.device)], dim=1)
        mask = (base.unsqueeze(0) | cols.unsqueeze(1)).unsqueeze(1)          # [B, 1, L, L]
        for blk in self.blocks:
            x = blk(x, mask)
        h = self.norm(x)
        return self._logits(h[:, P:], h[:, :P], prompt_mask)

    def loss(self, batch: dict):
        logits = self(batch["prompt"], batch["prompt_mask"], batch["tokens"])
        tgt = batch["targets"]
        loss = F.cross_entropy(logits.flatten(0, 1).float(), tgt.flatten(), ignore_index=-100)
        with torch.no_grad():
            valid = tgt != -100
            hit = (logits.argmax(-1) == tgt) & valid
            is_ptr = (tgt >= self.cfg.vocab) & valid
            metrics = {"token_acc": (hit.sum() / valid.sum().clamp(min=1)).item()}
            if is_ptr.any():
                metrics["pointer_acc"] = ((hit & is_ptr).sum() / is_ptr.sum()).item()
        return loss, metrics

    # -- inference ----------------------------------------------------------
    @torch.no_grad()
    def generate(self, prompt: str, temperature: float = 0.7, top_p: float = 0.95,
                 max_tokens: int | None = None, constrain: bool = True,
                 generator: torch.Generator | None = None, progress=None) -> dict:
        """Sample one program for `prompt`.

        Returns {'tokens', 'ops', 'complete'}; `complete` is False when the
        token budget ran out before <eos> (the finished part is still returned).
        progress(step, max_tokens) is called as tokens are produced.
        """
        cfg = self.cfg
        dev = self.tok.weight.device
        prompt = prompt[: cfg.max_prompt]
        P = len(prompt)
        max_tokens = min(max_tokens or cfg.max_program, cfg.max_program)
        p_ids = torch.tensor([lang.prompt_tokens(prompt)], dtype=torch.long, device=dev)
        caches = [dict() for _ in self.blocks]
        x = self._embed_prompt(p_ids)
        for blk, c in zip(self.blocks, caches):
            x = blk.step(x, c)
        keys = self.ptr_k(self.norm(x))                                  # [1, P, D]
        grammar = lang.Grammar(P, cfg.vocab)
        out: list[int] = []
        tok = lang.BOS
        for step in range(max_tokens):
            t = torch.tensor([[tok]], dtype=torch.long, device=dev)
            x = self._embed_program(t, p_ids, start=step)
            for blk, c in zip(self.blocks, caches):
                x = blk.step(x, c)
            h = self.norm(x)[:, -1]
            logits = torch.cat([self.head(h), (self.ptr_q(h).unsqueeze(1) @ keys.transpose(1, 2)).squeeze(1)
                                / math.sqrt(cfg.d_model)], dim=-1)[0].float()
            logits = logits.cpu()
            if constrain:
                allowed = torch.from_numpy(grammar.allowed())
                if step >= max_tokens - 4:
                    # out of budget: close the open path / end the program if the grammar allows it
                    closing = torch.zeros_like(allowed)
                    closing[lang.END] = closing[lang.EOS] = True
                    if (allowed & closing).any():
                        allowed = allowed & closing
                logits = logits.masked_fill(~allowed, float("-inf"))
            else:
                logits[lang.PAD] = float("-inf")
                logits[lang.BOS] = float("-inf")
            tok = _sample(logits, temperature, top_p, generator)
            if not grammar.feed(tok):
                break                      # only reachable when unconstrained
            if tok == lang.EOS:
                break
            out.append(tok)
            if progress is not None:
                progress(step + 1, max_tokens)
        return {"tokens": out, "ops": grammar.ops, "complete": grammar.done}


def _sample(logits: torch.Tensor, temperature: float, top_p: float, generator) -> int:
    if temperature <= 0:
        return int(logits.argmax())
    probs = F.softmax(logits / temperature, dim=-1)
    if top_p < 1.0:
        sp, si = probs.sort(descending=True)
        keep = sp.cumsum(0) - sp < top_p
        sp = sp * keep
        return int(si[torch.multinomial(sp / sp.sum(), 1, generator=generator)])
    return int(torch.multinomial(probs, 1, generator=generator))
