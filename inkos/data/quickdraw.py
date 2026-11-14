"""Quick, Draw! sketches as INKOS 1 training data.

The Quick, Draw! Dataset (Google, CC BY 4.0) holds millions of hand sketches
in 345 categories, already stored as pen strokes. fetch() streams only the
first part of each category file, so a few hundred megabytes cover all
categories instead of the full 37 GB.

  https://github.com/googlecreativelab/quickdraw-dataset
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from ..vector import lang
from .doc import Doc
from .words import pick

BASE = "https://storage.googleapis.com/quickdraw_dataset/full/simplified/"
USER_AGENT = "inkos-dataset-tools"

CATEGORIES = """aircraft carrier|airplane|alarm clock|ambulance|angel|animal migration|ant|anvil|apple|arm|asparagus|axe|backpack|banana|bandage|barn|baseball|baseball bat|basket|basketball|bat|bathtub|beach|bear|beard|bed|bee|belt|bench|bicycle|binoculars|bird|birthday cake|blackberry|blueberry|book|boomerang|bottlecap|bowtie|bracelet|brain|bread|bridge|broccoli|broom|bucket|bulldozer|bus|bush|butterfly|cactus|cake|calculator|calendar|camel|camera|camouflage|campfire|candle|cannon|canoe|car|carrot|castle|cat|ceiling fan|cello|cell phone|chair|chandelier|church|circle|clarinet|clock|cloud|coffee cup|compass|computer|cookie|cooler|couch|cow|crab|crayon|crocodile|crown|cruise ship|cup|diamond|dishwasher|diving board|dog|dolphin|donut|door|dragon|dresser|drill|drums|duck|dumbbell|ear|elbow|elephant|envelope|eraser|eye|eyeglasses|face|fan|feather|fence|finger|fire hydrant|fireplace|firetruck|fish|flamingo|flashlight|flip flops|floor lamp|flower|flying saucer|foot|fork|frog|frying pan|garden|garden hose|giraffe|goatee|golf club|grapes|grass|guitar|hamburger|hammer|hand|harp|hat|headphones|hedgehog|helicopter|helmet|hexagon|hockey puck|hockey stick|horse|hospital|hot air balloon|hot dog|hot tub|hourglass|house|house plant|hurricane|ice cream|jacket|jail|kangaroo|key|keyboard|knee|knife|ladder|lantern|laptop|leaf|leg|light bulb|lighter|lighthouse|lightning|line|lion|lipstick|lobster|lollipop|mailbox|map|marker|matches|megaphone|mermaid|microphone|microwave|monkey|moon|mosquito|motorbike|mountain|mouse|moustache|mouth|mug|mushroom|nail|necklace|nose|ocean|octagon|octopus|onion|oven|owl|paintbrush|paint can|palm tree|panda|pants|paper clip|parachute|parrot|passport|peanut|pear|peas|pencil|penguin|piano|pickup truck|picture frame|pig|pillow|pineapple|pizza|pliers|police car|pond|pool|popsicle|postcard|potato|power outlet|purse|rabbit|raccoon|radio|rain|rainbow|rake|remote control|rhinoceros|rifle|river|roller coaster|rollerskates|sailboat|sandwich|saw|saxophone|school bus|scissors|scorpion|screwdriver|sea turtle|see saw|shark|sheep|shoe|shorts|shovel|sink|skateboard|skull|skyscraper|sleeping bag|smiley face|snail|snake|snorkel|snowflake|snowman|soccer ball|sock|speedboat|spider|spoon|spreadsheet|square|squiggle|squirrel|stairs|star|steak|stereo|stethoscope|stitches|stop sign|stove|strawberry|streetlight|string bean|submarine|suitcase|sun|swan|sweater|swing set|sword|syringe|table|teapot|teddy-bear|telephone|television|tennis racquet|tent|The Eiffel Tower|The Great Wall of China|The Mona Lisa|tiger|toaster|toe|toilet|tooth|toothbrush|toothpaste|tornado|tractor|traffic light|train|tree|triangle|trombone|truck|trumpet|t-shirt|umbrella|underwear|van|vase|violin|washing machine|watermelon|waterslide|whale|wheel|windmill|wine bottle|wine glass|wristwatch|yoga|zebra|zigzag""".split("|")


def fetch(dest: Path, per_class: int, categories=None, log=print) -> int:
    """Download the first `per_class` recognised sketches of every category.

    Each category becomes dest/<name>.ndjson holding one stroke list per line.
    Categories already on disk with enough lines are kept as they are.
    """
    dest.mkdir(parents=True, exist_ok=True)
    cats = categories or CATEGORIES
    total = 0
    for k, cat in enumerate(cats):
        out = dest / f"{cat}.ndjson"
        if out.exists():
            n = sum(1 for _ in out.open())
            if n >= per_class:
                total += n
                continue
        rows = []
        req = urllib.request.Request(BASE + urllib.parse.quote(cat) + ".ndjson", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                for raw in r:
                    try:
                        rec = json.loads(raw)
                    except ValueError:
                        continue
                    if rec.get("recognized") and rec.get("drawing"):
                        rows.append(json.dumps(rec["drawing"], separators=(",", ":")))
                        if len(rows) >= per_class:
                            break
        except OSError as e:
            log(f"  {cat}: download failed ({e})")
            continue
        out.write_text("\n".join(rows) + "\n")
        total += len(rows)
        if (k + 1) % 25 == 0 or k + 1 == len(cats):
            log(f"  quickdraw: {k + 1}/{len(cats)} categories, {total} sketches")
    (dest / "SOURCE.json").write_text(json.dumps({
        "dataset": "Quick, Draw! Dataset", "license": "CC BY 4.0", "attribution": "Google Creative Lab",
        "url": "https://github.com/googlecreativelab/quickdraw-dataset", "per_class": per_class}, indent=2))
    return total


def load(src: Path) -> list[tuple[str, str]]:
    """[(category, json line)] for every downloaded sketch."""
    out = []
    for f in sorted(src.glob("*.ndjson")):
        cat = f.stem.replace("-", " ").lower()
        if cat.startswith("the "):
            cat = cat[4:]
        for line in f.open():
            line = line.strip()
            if line:
                out.append((cat, line))
    return out


def _rdp(p: np.ndarray, eps: float) -> np.ndarray:
    """Ramer-Douglas-Peucker simplification."""
    if len(p) < 3:
        return p
    a, b = p[0], p[-1]
    ab = b - a
    n = np.hypot(*ab)
    d = np.abs(ab[0] * (p[:, 1] - a[1]) - ab[1] * (p[:, 0] - a[0])) / n if n > 1e-9 else np.hypot(*(p - a).T)
    i = int(np.argmax(d))
    if d[i] <= eps:
        return np.stack([a, b])
    return np.vstack([_rdp(p[: i + 1], eps)[:-1], _rdp(p[i:], eps)])


def sketch_ops(drawing, size: float, cx: float, cy: float, max_tokens: int) -> list[tuple] | None:
    """Quick, Draw! stroke list ([[xs], [ys]], ...) on 0..255 -> CURVE ops."""
    strokes = [np.array(s[:2], dtype=float).T for s in drawing if len(s) >= 2 and len(s[0]) >= 1]
    if not strokes:
        return None
    allp = np.vstack(strokes)
    lo, hi = allp.min(0), allp.max(0)
    span = max(float((hi - lo).max()), 1.0)
    k = size / span
    off = np.array([cx, cy]) - (lo + hi) / 2 * k
    for eps in (0.8, 1.3, 2.0, 3.0, 4.5):
        ops = []
        for s in strokes:
            g = _rdp(s * k + off, eps)
            pts = [(lang.q(x), lang.q(y)) for x, y in g]
            pts = [p for i, p in enumerate(pts) if i == 0 or p != pts[i - 1]]
            if len(pts) == 1:
                ops.append(("DISC", pts[0][0], pts[0][1], 1))
            elif len(pts) == 2:
                ops.append(("LINE", pts))
            else:
                ops.append(("CURVE", pts[: lang.MAX_PATH_POINTS]))
        if ops and len(lang.encode(ops)) <= max_tokens:
            return ops
    return None


def make_sample(rng: np.random.Generator, category: str, line: str, max_tokens: int) -> Doc | None:
    d = Doc("sketch")
    weight = int(pick(rng, (1, 2, 2, 2, 3)))
    d.add("CLEAN")
    d.add("W", weight)
    size = float(rng.uniform(78, 116))
    slack = (122 - size) / 2
    ops = sketch_ops(json.loads(line), size, 63.5 + float(rng.uniform(-slack, slack)),
                     63.5 + float(rng.uniform(-slack, slack)), max_tokens - 2)
    if not ops:
        return None
    d.ops.extend(ops)
    adj = {1: pick(rng, ("thin ", "fine ", "")), 3: pick(rng, ("bold ", "thick ", ""))}.get(weight, "")
    r = rng.random()
    if r < 0.4:
        d.say(f"{adj}sketch of a {category}")
    elif r < 0.6:
        d.say(f"{adj}doodle: {category}")
    elif r < 0.8:
        d.say(f"{adj}{category} sketch")
    elif r < 0.9:
        d.say(f"{adj}{category} doodle")
    else:
        d.say(f"quick {adj}drawing of a {category}")
    return d
