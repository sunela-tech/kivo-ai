"""Import open-licensed stroke icon sets as INKOS 1 training data.

Sets (all outline / stroke based, 24 x 24 view box):

  tabler     @tabler/icons    MIT   icons/outline
  lucide     lucide-static    ISC   icons
  feather    feather-icons    MIT   dist/icons
  iconoir    iconoir          MIT   icons/regular
  heroicons  heroicons        MIT   24/outline

fetch() downloads the release tarballs straight from the npm registry (no npm
needed) and keeps only the SVG files and each LICENSE. Brand and logo icons
are skipped: they are trademarks, not general drawings.

icon_program() converts one SVG into an InkScript program: straight runs
become LINE, curves and arcs become CURVE through a few sampled points, full
circles become CIRC.
"""
from __future__ import annotations

import io
import json
import math
import re
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

from ..vector import lang
from .doc import Doc
from .words import pick

SETS = {
    "tabler": {"package": "@tabler/icons", "prefix": "package/icons/outline/", "license": "MIT"},
    "lucide": {"package": "lucide-static", "prefix": "package/icons/", "license": "ISC"},
    "feather": {"package": "feather-icons", "prefix": "package/dist/icons/", "license": "MIT"},
    "iconoir": {"package": "iconoir", "prefix": "package/icons/regular/", "license": "MIT"},
    "heroicons": {"package": "heroicons", "prefix": "package/24/outline/", "license": "MIT"},
}

BRANDS = set("""facebook twitter github gitlab instagram linkedin youtube twitch slack figma framer codepen
codesandbox dribbble chrome trello pocket apple google microsoft windows android amazon aws azure paypal visa
mastercard spotify tiktok telegram whatsapp discord reddit pinterest snapchat tumblr behance dropbox firefox
safari vimeo skype xbox playstation nintendo tesla uber airbnb netflix adobe wikipedia yahoo bing baidu wechat
weibo kakao messenger npm react vue angular svelte docker kubernetes python html5 css3 linux ubuntu debian
bitbucket stackoverflow mastodon bluesky viber patreon kickstarter ebay shopify stripe tailwind bootstrap
wordpress drupal joomla salesforce oracle ibm intel amd nvidia samsung huawei xiaomi sony dell lenovo asus bmw
mercedes toyota honda ford volkswagen audi lego disney nike adidas puma mcdonalds starbucks gmail outlook
onedrive icloud itunes imac iphone ipad macbook airpods airtag finder xcode swift kotlin flutter github-inverted
openai meta threads tiktok-solid youtube-solid deno nodejs typescript javascript php laravel django rails
golang rust-lang webflow notion zoom-logo trekking-brand periscope medium mailchimp hackernews product-hunt
glassdoor upwork fiverr etsy alibaba aliexpress taobao booking tripadvisor yelp foursquare grab lyft doordash
""".split())

USER_AGENT = "inkos-dataset-tools"


# --------------------------------------------------------------------------
# download
# --------------------------------------------------------------------------

def fetch(dest: Path, sets=None, log=print) -> dict:
    """Download icon sets into dest/<set>/*.svg. Returns {set: count}."""
    out = {}
    for name in sets or SETS:
        spec = SETS[name]
        target = dest / name
        if (target / "SOURCE.json").exists():
            out[name] = len(list(target.glob("*.svg")))
            log(f"  {name}: already present ({out[name]} icons)")
            continue
        meta = json.loads(_get(f"https://registry.npmjs.org/{spec['package']}/latest"))
        blob = _get(meta["dist"]["tarball"])
        target.mkdir(parents=True, exist_ok=True)
        n = 0
        with tarfile.open(fileobj=io.BytesIO(blob)) as tf:
            for m in tf.getmembers():
                if not m.isfile():
                    continue
                base = m.name.rsplit("/", 1)[-1]
                if m.name == "package/LICENSE":
                    (target / "LICENSE").write_bytes(tf.extractfile(m).read())
                elif m.name.startswith(spec["prefix"]) and m.name.endswith(".svg") and "/" not in m.name[len(spec["prefix"]):]:
                    if re.fullmatch(r"[A-Za-z0-9._-]+", base):
                        (target / base).write_bytes(tf.extractfile(m).read())
                        n += 1
        (target / "SOURCE.json").write_text(json.dumps({
            "package": spec["package"], "version": meta.get("version"), "license": spec["license"],
            "tarball": meta["dist"]["tarball"], "icons": n}, indent=2))
        out[name] = n
        log(f"  {name}: {n} icons ({spec['package']} {meta.get('version')}, {spec['license']})")
    return out


def _get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()


# --------------------------------------------------------------------------
# SVG path data -> segments
# --------------------------------------------------------------------------

_NUM = re.compile(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")
_ARITY = {"M": 2, "L": 2, "H": 1, "V": 1, "C": 6, "S": 4, "Q": 4, "T": 2, "A": 7, "Z": 0}


def _tokenize(d: str):
    """Yield (command, args) honouring implicit repeats and glued arc flags."""
    i, n, cmd = 0, len(d), None
    while i < n:
        c = d[i]
        if c in " \t\r\n,":
            i += 1
            continue
        if c.isalpha():
            cmd = c
            i += 1
            if cmd in "Zz":
                yield cmd, []
            continue
        if cmd is None:
            raise ValueError("path data starts with a number")
        args = []
        for k in range(_ARITY[cmd.upper()]):
            while i < n and d[i] in " \t\r\n,":
                i += 1
            if cmd in "Aa" and k in (3, 4):
                if i >= n or d[i] not in "01":
                    raise ValueError("bad arc flag")
                args.append(float(d[i]))
                i += 1
            else:
                m = _NUM.match(d, i)
                if not m:
                    raise ValueError("bad number in path")
                args.append(float(m.group()))
                i = m.end()
        yield cmd, args
        if cmd == "M":
            cmd = "L"
        elif cmd == "m":
            cmd = "l"


def _cubic(p0, p1, p2, p3, n):
    t = np.linspace(0, 1, n + 1)[:, None]
    return ((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + t ** 3 * p3


def _arc_center(p0, p1, rx, ry, phi, large, sweep):
    """SVG endpoint arc -> (centre, rx, ry, theta0, dtheta)."""
    cp, sp = math.cos(phi), math.sin(phi)
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1, y1 = cp * dx + sp * dy, -sp * dx + cp * dy
    rx, ry = abs(rx), abs(ry)
    lam = (x1 / rx) ** 2 + (y1 / ry) ** 2
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    den = rx * rx * y1 * y1 + ry * ry * x1 * x1
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp, cyp = co * rx * y1 / ry, -co * ry * x1 / rx
    cx = cp * cxp - sp * cyp + (p0[0] + p1[0]) / 2
    cy = sp * cxp + cp * cyp + (p0[1] + p1[1]) / 2
    t0 = math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx)
    t1 = math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx)
    dt = t1 - t0
    if sweep and dt < 0:
        dt += 2 * math.pi
    elif not sweep and dt > 0:
        dt -= 2 * math.pi
    return (cx, cy), rx, ry, t0, dt


def parse_path(d: str, scale: float) -> list[dict]:
    """Path data -> subpaths. Each subpath: {'segs': [...], 'closed': bool}.

    A segment is ('L', pts) for a straight piece or ('C', pts, arc_info) for a
    curved one, pts being an (n, 2) array in SVG units. scale (grid units per
    SVG unit) only decides how densely curves are sampled.
    """
    subs: list[dict] = []
    cur = np.zeros(2)
    start = np.zeros(2)
    last_ctrl = None
    last_cmd = ""
    segs: list = []

    def flush(closed=False):
        nonlocal segs
        if segs:
            subs.append({"segs": segs, "closed": closed})
        segs = []

    for cmd, a in _tokenize(d):
        up = cmd.upper()
        rel = cmd.islower()
        base = cur if rel else np.zeros(2)
        if up == "M":
            flush()
            cur = base + a
            start = cur.copy()
        elif up == "Z":
            if np.hypot(*(cur - start)) > 1e-6:
                segs.append(("L", np.stack([cur, start])))
            cur = start.copy()
            flush(closed=True)
        elif up in "LHV":
            if up == "L":
                nxt = base + a
            elif up == "H":
                nxt = np.array([(cur[0] if rel else 0) + a[0], cur[1]])
            else:
                nxt = np.array([cur[0], (cur[1] if rel else 0) + a[0]])
            segs.append(("L", np.stack([cur, nxt])))
            cur = nxt
        elif up in "CSQT":
            if up == "C":
                c1, c2, nxt = base + a[0:2], base + a[2:4], base + a[4:6]
            elif up == "S":
                c1 = 2 * cur - last_ctrl if last_cmd in "CS" and last_ctrl is not None else cur
                c2, nxt = base + a[0:2], base + a[2:4]
            else:
                if up == "Q":
                    qc, nxt = base + a[0:2], base + a[2:4]
                else:
                    qc = 2 * cur - last_ctrl if last_cmd in "QT" and last_ctrl is not None else cur
                    nxt = base + a[0:2]
                c1, c2 = cur + 2 / 3 * (qc - cur), nxt + 2 / 3 * (qc - nxt)
            length = (np.hypot(*(c1 - cur)) + np.hypot(*(c2 - c1)) + np.hypot(*(nxt - c2))) * scale
            n = int(min(6, max(2, round(length / 7))))
            segs.append(("C", _cubic(cur, c1, c2, nxt, n), None))
            last_ctrl = c2 if up in "CS" else qc
            cur = nxt
        elif up == "A":
            rx, ry, rot, large, sweep = a[0], a[1], math.radians(a[2]), bool(a[3]), bool(a[4])
            nxt = base + a[5:7]
            if rx == 0 or ry == 0 or np.hypot(*(nxt - cur)) < 1e-9:
                if np.hypot(*(nxt - cur)) > 1e-9:
                    segs.append(("L", np.stack([cur, nxt])))
            else:
                c, rx, ry, t0, dt = _arc_center(cur, nxt, rx, ry, rot, large, sweep)
                n = int(min(8, max(2, math.ceil(abs(dt) / math.radians(50)))))
                t = t0 + dt * np.linspace(0, 1, n + 1)
                x, y = rx * np.cos(t), ry * np.sin(t)
                pts = np.stack([c[0] + x * math.cos(rot) - y * math.sin(rot),
                                c[1] + x * math.sin(rot) + y * math.cos(rot)], axis=1)
                pts[0], pts[-1] = cur, nxt
                segs.append(("C", pts, (c, rx, ry, dt)))
            cur = nxt
        last_cmd = up
    flush()
    return subs


# --------------------------------------------------------------------------
# SVG document -> InkScript
# --------------------------------------------------------------------------

def _f(el, key, default=0.0) -> float:
    v = el.get(key)
    if v is None:
        return default
    m = _NUM.match(v.strip())
    return float(m.group()) if m else default


def _full_circle(sub) -> tuple | None:
    arcs = [s for s in sub["segs"] if s[0] == "C" and s[2] is not None]
    if len(arcs) != len(sub["segs"]) or not arcs:
        return None
    c0, r0 = np.array(arcs[0][2][0]), arcs[0][2][1]
    total = 0.0
    for _, _, (c, rx, ry, dt) in arcs:
        if abs(rx - ry) > 0.02 * max(rx, 1e-6) or abs(rx - r0) > 0.02 * r0 or np.hypot(*(np.array(c) - c0)) > 0.02 * r0 + 1e-3:
            return None
        total += dt
    if abs(abs(total) - 2 * math.pi) > 0.05:
        return None
    return (float(c0[0]), float(c0[1]), float(r0))


def _tangent_break(a: np.ndarray, b: np.ndarray) -> bool:
    """True if curve a ends and curve b starts in clearly different directions."""
    u, v = a[-1] - a[-2], b[1] - b[0]
    nu, nv = np.hypot(*u), np.hypot(*v)
    if nu < 1e-9 or nv < 1e-9:
        return False
    return float(np.dot(u, v) / (nu * nv)) < math.cos(math.radians(28))


def _dedupe(pts):
    out = []
    for p in pts:
        if not out or p != out[-1]:
            out.append(p)
    return out


def _emit_subpath(ops: list, sub: dict, T, scale: float):
    circle = _full_circle(sub)
    if circle:
        cx, cy = T(np.array(circle[:2]))
        r = circle[2] * scale
        ops.append(("DISC", cx, cy, max(0.9, r)) if r < 1.3 else ("CIRC", cx, cy, r))
        return
    allpts = np.vstack([s[1] for s in sub["segs"]])
    if np.ptp(allpts, axis=0).max() * scale < 0.7:       # a dot such as "M12 12h.01"
        cx, cy = T(allpts.mean(axis=0))
        ops.append(("DISC", cx, cy, 0.9))
        return
    run: list = []        # current LINE run, grid points

    def flush_line():
        nonlocal run
        pts = _dedupe([(lang.q(x), lang.q(y)) for x, y in run])
        if len(pts) >= 2:
            ops.append(("LINE", pts))
        run = []

    curve: np.ndarray | None = None

    def flush_curve():
        nonlocal curve
        if curve is not None:
            pts = _dedupe([(lang.q(x), lang.q(y)) for x, y in (T(p) for p in curve)])
            if len(pts) >= 2:
                ops.append(("CURVE" if len(pts) > 2 else "LINE", pts))
        curve = None

    for seg in sub["segs"]:
        pts = seg[1]
        small = np.ptp(pts, axis=0).max() * scale < 3.2
        if seg[0] == "L" or small:
            flush_curve()
            a, b = T(pts[0]), T(pts[-1])
            if not run:
                run = [a]
            run.append(b)
        else:
            flush_line()
            if curve is not None and not _tangent_break(curve, pts):
                curve = np.vstack([curve, pts[1:]])
            else:
                flush_curve()
                curve = pts
    flush_line()
    flush_curve()


def icon_program(svg_text: str, size: float = 108.0, cx: float = 63.5, cy: float = 63.5) -> list[tuple] | None:
    """SVG source -> drawing ops scaled to `size` grid units, centred on (cx, cy).

    Returns None for icons that use features the importer does not handle
    (transforms, non-square view boxes) so they are skipped, not mangled.
    """
    try:
        root = ET.fromstring(svg_text)
    except ET.ParseError:
        return None
    vb = [float(v) for v in re.split(r"[ ,]+", (root.get("viewBox") or "0 0 24 24").strip())]
    if len(vb) != 4 or vb[2] <= 0 or abs(vb[2] - vb[3]) > 1e-6:
        return None
    scale = size / vb[2]
    ox, oy = cx - size / 2 - vb[0] * scale, cy - size / 2 - vb[1] * scale

    def T(p):
        return (ox + float(p[0]) * scale, oy + float(p[1]) * scale)

    ops: list[tuple] = []
    for el in root.iter():
        tag = el.tag.rsplit("}", 1)[-1]
        if el.get("transform"):
            return None
        if el.get("stroke") == "none" and el.get("fill") in (None, "none"):
            continue            # invisible bounding boxes
        try:
            if tag == "path":
                for sub in parse_path(el.get("d") or "", scale):
                    _emit_subpath(ops, sub, T, scale)
            elif tag == "circle":
                x, y = T((_f(el, "cx"), _f(el, "cy")))
                r = _f(el, "r") * scale
                ops.append(("DISC", x, y, max(0.9, r)) if r < 1.3 else ("CIRC", x, y, r))
            elif tag == "ellipse":
                x, y = T((_f(el, "cx"), _f(el, "cy")))
                ops.append(("ELLI", x, y, _f(el, "rx") * scale, _f(el, "ry") * scale))
            elif tag == "rect":
                x, y, w, h = _f(el, "x"), _f(el, "y"), _f(el, "width"), _f(el, "height")
                r = min(_f(el, "rx", _f(el, "ry")), w / 2, h / 2)
                if r * scale < 2.6:
                    (x0, y0), (x1, y1) = T((x, y)), T((x + w, y + h))
                    ops.append(("RECT", x0, y0, x1, y1))
                else:
                    d = (f"M{x + r} {y}h{w - 2 * r}a{r} {r} 0 0 1 {r} {r}v{h - 2 * r}a{r} {r} 0 0 1 {-r} {r}"
                         f"h{-(w - 2 * r)}a{r} {r} 0 0 1 {-r} {-r}v{-(h - 2 * r)}a{r} {r} 0 0 1 {r} {-r}z")
                    for sub in parse_path(d, scale):
                        _emit_subpath(ops, sub, T, scale)
            elif tag == "line":
                a, b = T((_f(el, "x1"), _f(el, "y1"))), T((_f(el, "x2"), _f(el, "y2")))
                if (lang.q(a[0]), lang.q(a[1])) == (lang.q(b[0]), lang.q(b[1])):
                    ops.append(("DISC", a[0], a[1], 0.9))
                else:
                    ops.append(("LINE", [a, b]))
            elif tag in ("polyline", "polygon"):
                nums = [float(m.group()) for m in _NUM.finditer(el.get("points") or "")]
                pts = _dedupe([(lang.q(px), lang.q(py)) for px, py in (T(p) for p in zip(nums[0::2], nums[1::2]))])
                if tag == "polygon" and len(pts) >= 3:
                    ops.append(("POLY", pts))
                elif len(pts) >= 2:
                    ops.append(("LINE", pts))
        except (ValueError, ZeroDivisionError, IndexError):
            return None
    return ops or None


def icon_name(stem: str) -> str | None:
    """File stem -> caption, or None for brand / logo icons."""
    name = stem.lower()
    if name.startswith("brand-") or name.endswith("-logo") or "logo" in name.split("-"):
        return None
    parts = [p for p in re.split(r"[-_]+", name) if p]
    if any(p in BRANDS for p in parts) or name in BRANDS:
        return None
    return " ".join(parts)


def load_sets(src: Path, sets=None) -> list[tuple[str, str, str]]:
    """[(set, caption, svg text)] for every usable icon under src."""
    out = []
    for s in sets or SETS:
        for f in sorted((src / s).glob("*.svg")):
            cap = icon_name(f.stem)
            if cap:
                out.append((s, cap, f.read_text(encoding="utf-8", errors="replace")))
    return out


def make_sample(rng: np.random.Generator, caption: str, svg: str, canonical: bool, max_tokens: int) -> Doc | None:
    """One training sample from an icon, with random size, position and pen."""
    d = Doc("icon")
    adj = d.style(rng, hand_p=0.3, adj_p=0.35)
    if canonical:
        size, cx, cy = 108.0, 63.5, 63.5
    else:
        size = float(rng.uniform(64, 116))
        slack = (124 - size) / 2
        cx, cy = 63.5 + float(rng.uniform(-slack, slack)), 63.5 + float(rng.uniform(-slack, slack))
    ops = icon_program(svg, size, cx, cy)
    if not ops:
        return None
    d.ops.extend(ops)
    if len(lang.encode(d.ops)) > max_tokens:
        return None
    r = rng.random()
    if r < 0.4:
        d.say(f"{adj}{caption} icon")
    elif r < 0.65:
        d.say(f"icon: {adj}{caption}")
    elif r < 0.85:
        d.say(f"{adj}{caption}")
    elif r < 0.93:
        d.say(f"{adj}{caption} symbol")
    else:
        d.say(f"{pick(rng, ('simple', 'line', 'outline'))} {adj}{caption} icon")
    return d
