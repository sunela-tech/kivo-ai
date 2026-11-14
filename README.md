# INKOS

Two local image models that draw **pure black-and-white PNGs** for E-Ink
screens. Both are trained from scratch with PyTorch, run fully offline, and
are driven from the command line or a black-and-white HTML interface.

| | INKOS 1 | INKOS 1 Pro |
| --- | --- | --- |
| Made for | notes, journals, logs, to-do lists, tables, icons, symbols, sketches, diagrams, charts | manga characters, comic panels and pages, line art, environments |
| How it draws | a transformer writes a short vector drawing program; a rasteriser renders it | a diffusion U-Net denoises a 1-bit bitmap; a learned refiner upscales it |
| Parameters | 6.66 million | 57.55 million |
| Output sizes | 256, 512, 1024 (resolution independent) | 256 native, 512 and 1024 through the refiner |
| Training target | 10,000 epochs | 20,000 epochs |
| Trains on | a CPU or any GPU | a GPU (8 GB or more) |
| Config | `configs/inkos1.yaml` | `configs/inkos1_pro.yaml` |

Every output pixel is exactly `#000000` or `#FFFFFF`. Files are written as
1-bit PNGs.

## What is trained and what is not

<!-- STATE:BEGIN -->
<!-- STATE:END -->

The epoch counts above are **targets**. The trainer records what was really
completed in `runs/<model>/state.json`; the interface, `python -m inkos status`
and every exported weight file report that number and nothing else. An
untrained model refuses to generate instead of returning a placeholder.

## Quick start

```bash
pip install -r requirements.txt        # torch, numpy, pillow, pyyaml
```

```bash
python -m inkos doctor                 # hardware check for both models
```

```bash
python -m inkos serve                  # http://localhost:8765
```

INKOS 1 ships with a small trained weight file in `models/inkos1/`, so the
interface can generate straight away. INKOS 1 Pro has to be trained first.

Generate from the command line:

```bash
python -m inkos generate --model inkos1 --prompt "bar chart: 3, 7, 5, 9" --size 512 --out chart.png
```

## Training

Training and inference are separate programs that only share files:

```
data/      prepared training sets            written by: data prepare / data import
runs/      checkpoints, metrics, state.json  written by: train
models/    installed inference weights       written by: export
projects/  your generated images             written by: generate / serve
```

### 1. Prepare data

```bash
python -m inkos data prepare --model inkos1
```

```bash
python -m inkos data prepare --model inkos1_pro
```

INKOS 1 gets 330,000 drawings: procedural notes, charts, diagrams and symbols,
about 9,300 open-licensed stroke icons (MIT / ISC) and about 110,000
Quick, Draw! sketches (CC BY 4.0). The icon sets and sketches are downloaded
once; add `--offline` to use procedural data only. INKOS 1 Pro gets 60,000
procedurally drawn manga images at 512 px. Use `--count` for more or less.
Sources and licenses are listed in [DATA_LICENSES.md](DATA_LICENSES.md).

Add your own licensed artwork to INKOS 1 Pro (captions come from `.txt` files
next to the images):

```bash
python -m inkos data import --model inkos1_pro --dir ~/my_art --license "own work"
```

Look at what a dataset contains:

```bash
python -m inkos data preview --model inkos1_pro --out sheet.png
```

### 2. Train

```bash
python -m inkos train --model inkos1
```

```bash
python -m inkos train --model inkos1_pro
```

* An **epoch** is one full pass over the prepared training set. Only complete
  passes are counted.
* A checkpoint is written at the end of every epoch, every 10 minutes inside
  an epoch, and when you stop the run (Ctrl-C, `python -m inkos stop --model
  ...`, or the Stop button). Running the same command again **resumes** from
  the exact batch it stopped at.
* If there is no checkpoint but `models/<model>/` holds installed weights (the
  situation right after cloning this repository), training **continues from
  those weights** and from their recorded epoch count. An export carries no
  optimiser state, so the optimiser starts cold with a fresh warm-up.
* `--max-hours 8`, `--max-steps N` and `--until-epoch N` stop cleanly at a
  budget. `--fresh` discards the run and starts from random weights.
  `--device cuda:1` picks a device; on CUDA mixed precision is used
  automatically.
* `--set key=value` overrides any config value for one run, for example
  `--set train.batch_size=64`. Changing `model.*` changes the weight shapes,
  and the trainer refuses to resume a checkpoint that no longer fits.

Watch progress with `python -m inkos status`, the Training tab of the
interface, or `runs/<model>/train.log`. Each validation also writes sample
images to `runs/<model>/samples/`.

### 3. Install weights for inference

```bash
python -m inkos export --model inkos1
```

This copies the averaged (EMA) weights of the newest checkpoint to
`models/<model>/weights.pt` as float16 and writes a `manifest.json` that
records how much training they received. If nothing is installed, inference
falls back to the newest checkpoint and says so.

### How long will the targets take?

`python -m inkos doctor --bench` runs real optimisation steps and prints
measured throughput and the projected time to the target. For orientation,
on the 4-core CPU this project was built on:

<!-- BENCH:BEGIN -->
<!-- BENCH:END -->

The targets are sized for a GPU. Lower `target_epochs` or `data.count` in the
config if you want a run that finishes sooner; the cosine learning-rate
schedule follows whatever target you set.

## Evaluation

```bash
python -m inkos eval --model inkos1
```

```bash
python -m inkos eval --model inkos1_pro --n 16
```

Writes `runs/<model>/eval/report.json` and a comparison sheet
(`samples.png`, generated image next to a reference).

INKOS 1 is scored on the held-out split with teacher forcing (loss,
perplexity, token and pointer accuracy per data family) and on free
generation: how often its programs are valid *without* the grammar mask, how
much of the requested text ends up on the page, whether bar charts have the
right number of bars at the right heights, and ink overlap with the
reference drawing.

INKOS 1 Pro is scored on denoising loss at four noise levels with fixed
noise, on how well the refiner restores reduced real images, and on how the
statistics of generated images (ink coverage, edge density, speckle) compare
with real ones.

## The interface

`python -m inkos serve` starts a local server (standard library only) and the
HTML interface in `web/`:

* **Generate**: model selector with each model's real training state, prompt
  box with example prompts, size selector, optional seed and sampling
  settings, a progress bar driven by the actual sampler, preview, PNG
  download, regenerate, repeat with the same seed.
* **Gallery**: every image is stored with its settings under
  `projects/<name>/`; browse, reuse a prompt, download or delete.
* **Models**: parameters, memory needs per size, hardware verdicts for this
  machine, the weights in use and their training record, data sources and
  licenses, and a button to install the newest checkpoint.
* **Training**: epochs completed against the target, samples seen, losses,
  measured speed and time to target, loss curve, latest validation samples,
  the trainer log, and Start / Resume / Stop.

The page uses two colours, no gradients, no shadows and no animation, has
48 px touch targets, and only redraws what changed. It loads nothing from
the network. By default the server listens on `127.0.0.1`; to use it from an
E-Ink tablet on the same network:

```bash
python -m inkos serve --host 0.0.0.0
```

## How the models work

### INKOS 1: a transformer that writes drawings

INKOS 1 never paints pixels. It writes **InkScript**, a small drawing
language on a 128 x 128 grid: polylines, smooth curves, outlines, filled
shapes, circles, rectangles, ellipses, text, plus pen state (stroke weight,
black or white ink, dashed, ruler-straight or hand-wobbled). A deterministic
rasteriser (`inkos/vector/render.py`) turns a program into a bitmap, which is
why one program gives the same picture at 256, 512 and 1024 pixels.

The network (`inkos/models/inkos1.py`) is an 8-layer, 256-wide prefix-LM
transformer. The prompt is read character by character with bidirectional
attention; the program is generated left to right with attention to the
prompt and to what has been written so far. Its output at every step is one
distribution over drawing tokens **and** over positions in the prompt (a
pointer head). A pair of pointers means "write this span of the prompt
here", so the words you type are copied onto the page exactly rather than
re-spelled by the network. Sampling runs with key/value caching and a grammar
mask, so every sampled program is well formed and renders.

Lettering is drawn with a single-stroke font made for this project
(`inkos/vector/font.py`). In hand mode every glyph gets seeded slant, size
and position jitter. The network decides what is written, where, how large
and in which style; the letter shapes come from the font, not from the
network.

Prompts it is trained on (a style word such as `handwritten`, `clean`,
`bold`, `thin` may come first):

```
note Groceries: milk; eggs; bread          todo: [x] Pay rent; Call Anna
journal 2026-11-14: Woke up early ...      log: 09:00 boot ok; 09:05 sync started
schedule: 09:00 Standup; 10:30 Review      table: Item, Qty; Apples, 3; Pears, 5
sign: Back in 5 minutes                    bar chart: Mon 3, Tue 7, Wed 5
line chart: 1, 4, 2, 8, 5                  pie chart: Rent 50, Food 30, Fun 20
scatter plot: 1 2, 3 5, 6 4                progress bar: 70%
flowchart: Start -> Check -> Done          mind map: Project; Design; Build; Test
tree: Root; A; B; C                        timeline: 2020 Start; 2022 Launch
venn diagram: Cats; Dogs                   cycle: Plan; Do; Check; Act
house icon      filled star      three stars      moon above a tree
clock at 3:40   sketch of a cat  doodle: bicycle
```

A multi-line prompt is read as one item per line. It is a small model
trained on these patterns, not a general language model: free-form sentences
outside them will not be understood.

### INKOS 1 Pro: diffusion over one-bit pixels

`inkos/models/inkos1_pro.py` holds three networks trained together:

* a character-level **text encoder** (4 layers, no pretrained weights);
* a **U-Net** that generates at 256 x 256. Each pixel is a bit, mapped to
  -1 / +1 and diffused as a real number ("analog bits"), with a
  rectified-flow schedule and self-conditioning. The network predicts the
  probability that each pixel is ink, so the loss is a binary cross-entropy
  and the denoised estimate is exact for binary data. Pixels are folded
  4 x 4 into channels, so the U-Net works on a 64 x 64 grid with
  self- and cross-attention at 16 x 16 and 8 x 8;
* a small convolutional **refiner** that doubles resolution and is trained on
  real pairs (each 512 px training image and its 2x reduction). It starts as
  plain pixel doubling and learns corrections on top; 1024 px applies it
  twice, in tiles, so memory stays flat.

Sampling uses deterministic Euler steps with classifier-free guidance on the
logits and ends with a hard threshold. Prompts are comma-separated tags, for
example `manga portrait, girl, long black hair, straight bangs, smiling,
sailor uniform, speed lines`.

The bundled training set is drawn by code (`inkos/data/manga_*.py`):
characters with varied hair, eyes, expressions and outfits, chibi figures,
eight kinds of environment, props, and multi-panel pages with one recurring
character, speech bubbles, sound effects and halftone screentone. It is
simple original artwork, good for learning line, tone and layout. It is not
professional manga, and a model trained only on it will not draw like one;
for that, import artwork you made or are licensed to use.

## Project layout

```
configs/            the two model configurations
inkos/
  cli.py            command line
  config.py         config loading, model fingerprint
  vector/           InkScript language, stroke font, rasteriser
  models/           inkos1.py, inkos1_pro.py
  data/             generators, icon and sketch importers, dataset stores
  training/         trainer (checkpoints, resume, status) and per-model tasks
  evaluate.py       evaluation tools
  export.py         checkpoint -> installed weights
  engine.py         inference engine and model status
  hardware.py       hardware checks and benchmark
  server.py         local HTTP server
web/                interface (index.html, style.css, app.js)
tests/              test suite (pytest)
models/inkos1/      installed INKOS 1 weights and their manifest
```

Run the tests with:

```bash
python -m pytest
```

They build tiny versions of both models and run the full path: prepare,
train, stop, resume, export, generate at every size, evaluate, and the
server API.
