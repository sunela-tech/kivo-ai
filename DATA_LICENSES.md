# Training data and licenses

INKOS uses no pretrained weights. Both models start from random
initialisation and learn only from the data listed here. The exact sources
used for a prepared dataset are also recorded in `data/<model>/meta.json`.

## INKOS 1

| Source | What it provides | License |
| --- | --- | --- |
| INKOS procedural generators (`inkos/data/synth_*.py`) | notes, to-do lists, journals, logs, tables, signs, charts, diagrams, symbols | this repository |
| [Tabler Icons](https://github.com/tabler/tabler-icons) (`@tabler/icons`, outline set) | about 5,000 stroke icons | MIT |
| [Lucide](https://github.com/lucide-icons/lucide) (`lucide-static`) | about 2,350 stroke icons | ISC |
| [Iconoir](https://github.com/iconoir-icons/iconoir) (`iconoir`, regular set) | about 1,300 stroke icons | MIT |
| [Heroicons](https://github.com/tailwindlabs/heroicons) (`heroicons`, 24 px outline) | 324 stroke icons | MIT |
| [Feather](https://github.com/feathericons/feather) (`feather-icons`) | about 270 stroke icons | MIT |
| [Quick, Draw! Dataset](https://github.com/googlecreativelab/quickdraw-dataset), Google Creative Lab | hand sketches in 345 categories | CC BY 4.0 |

Icon packages are downloaded from the npm registry by
`python -m inkos data prepare --model inkos1`; each package's `LICENSE` file is
kept next to its icons under `data/sources/icons/<set>/`. Brand and logo icons
are excluded by the importer (`inkos/data/svg_icons.py`), because they are
trademarks rather than general drawings.

Quick, Draw! is used under CC BY 4.0, which requires attribution: *the Quick,
Draw! Dataset is made available by Google, Inc. under the Creative Commons
Attribution 4.0 International license.* Weights trained on it should carry
this notice when redistributed.

The stroke font used for all lettering (`inkos/vector/font.py`) was drawn for
this project.

## INKOS 1.1

The same sources as INKOS 1. Colour is added by code
(`inkos/data/colorize.py`), which recolours the drawing programs and puts
the matching colour words at the start of the prompt. INKOS 1.1 is also
initialised from INKOS 1's weights, so the Quick, Draw! attribution above
applies to it as well.

## INKOS 1 Pro

| Source | What it provides | License |
| --- | --- | --- |
| INKOS procedural manga generator (`inkos/data/manga_*.py`) | characters, chibi figures, eight kinds of background, props, panel pages with speech bubbles, screentone | this repository |
| Your own imports (`python -m inkos data import`) | whatever artwork you add | you state it; it is recorded in `meta.json` |

No existing manga, anime or illustration was used, traced or scraped. The
procedural set is simple, original artwork drawn by code. To reach
professional quality the model needs real artwork that you created or are
licensed to train on; `data import` refuses to run without a license
statement for that reason.

## INKOS 1.1 Pro

| Source | What it provides | License |
| --- | --- | --- |
| INKOS procedural manga generator, colour mode (`inkos/data/manga_*.py`) | the INKOS 1 Pro subjects drawn in the six-colour palette, with colour words in the captions | this repository |
| Your own imports (`python -m inkos data import`) | artwork you add, snapped to the six palette colours | you state it; it is recorded in `meta.json` |

## Offline use

Run with `--offline` to prepare INKOS 1 without downloads; the icon and sketch
shares are then filled with procedural drawings.
