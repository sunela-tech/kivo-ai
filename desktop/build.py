"""Build INKOS Desktop: one self-contained HTML file that runs offline.

  python desktop/build.py            ->  desktop/dist/INKOS.html

The file holds the page, the drawing engine (the same JavaScript as INKOS
Cloud, checked against PyTorch), the font, and the float16 weights of
INKOS 1 and INKOS 1.1 as base64. Open it in any current browser: no server,
no install, no network. The Pro models are not included: at about 115 MB each
they would make the file too heavy; they run in INKOS Cloud and the Python app.

Needs: Python with the project's dependencies (to export the weights) and
Node with esbuild (cd cloud && npm install).
"""
from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DESK = ROOT / "desktop"
CLOUD = ROOT / "cloud"
sys.path.insert(0, str(ROOT))

from inkos import __version__  # noqa: E402

sys.path.insert(0, str(CLOUD))
import build as cloud_build  # noqa: E402  (exports weights, font and model data)

ESBUILD = CLOUD / "node_modules" / ".bin" / "esbuild"


def bundle(entry: Path) -> str:
    if not ESBUILD.exists():
        raise SystemExit("esbuild is missing: run  cd cloud && npm install")
    out = subprocess.run([str(ESBUILD), str(entry), "--bundle", "--format=iife", "--minify", "--target=es2020",
                          "--legal-comments=none"], check=True, capture_output=True, text=True).stdout
    return safe(out)


def safe(text: str) -> str:
    """Make text safe to place inside a <script> element."""
    return text.replace("</", "<\\/")


def main():
    cloud_build.main()                                   # refresh cloud/public/{weights,data}
    pub = CLOUD / "public"
    app = json.loads((pub / "data" / "app.json").read_text())
    for m in app["models"]:                              # the Pro and MOTION models stay in the cloud and Python apps
        m["cloud"] = m["cloud"] and m["id"] in ("inkos1", "inkos1_1")
    app["plans"] = [{**p, "models": [x for x in p["models"] if x in ("inkos1", "inkos1_1")]} for p in app["plans"]]
    data = {"app": app, "font": json.loads((pub / "data" / "font.json").read_text()), "version": __version__}

    parts = [f'<script type="application/json" id="inkos-data">{safe(json.dumps(data, separators=(",", ":")))}</script>',
             f'<script type="text/plain" id="engine-worker-src">{bundle(DESK / "src" / "engine-worker.js")}</script>']
    for m in app["models"]:
        if not m["cloud"]:
            continue
        index = (pub / "weights" / f"{m['id']}.json").read_text()
        weights = base64.b64encode((pub / "weights" / f"{m['id']}.bin").read_bytes()).decode()
        parts.append(f'<script type="application/json" id="index-{m["id"]}">{safe(index)}</script>')
        parts.append(f'<script type="text/plain" id="weights-{m["id"]}">{weights}</script>')

    html = (DESK / "src" / "template.html").read_text()
    html = html.replace("/*STYLE*/", (ROOT / "web" / "style.css").read_text())
    html = html.replace("<!--DATA-->", "\n".join(parts))
    html = html.replace("/*APP*/", bundle(DESK / "src" / "app.js"))
    out = DESK / "dist" / "INKOS.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
