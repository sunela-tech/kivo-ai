"""Package the INKOS Python app as a zip for people who do not use git.

  python tools/package_python_app.py      ->  dist/INKOS-<version>.zip

Contains the inkos package, configs, the web interface, the installed weights
of INKOS 1 and INKOS 1.1, the tests, the docs and the start-up launchers.
INKOS Cloud (cloud/) and INKOS Desktop (desktop/) are separate apps and are
left out. Only files tracked by git go in, so local data, runs and generated
images never do.
"""
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from inkos import __version__  # noqa: E402

INCLUDE = ("inkos/", "configs/", "web/", "tests/", "models/inkos1/", "models/inkos1_1/", "models/inkos_motion1/", "docs/",
           "README.md", "DATA_LICENSES.md", "requirements.txt", "pyproject.toml", "start.sh", "start.command", "start.bat")
EXECUTABLE = {"start.sh", "start.command"}


def main():
    files = subprocess.run(["git", "ls-files"], cwd=ROOT, check=True, capture_output=True, text=True).stdout.split()
    files = sorted(f for f in files if f.startswith(INCLUDE) and "__pycache__" not in f)
    top = f"INKOS-{__version__}"
    out = ROOT / "dist" / f"{top}.zip"
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in files:
            info = zipfile.ZipInfo.from_file(ROOT / f, f"{top}/{f}")
            info.external_attr = (0o100755 if f in EXECUTABLE else 0o100644) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, (ROOT / f).read_bytes())
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {len(files)} files)")


if __name__ == "__main__":
    main()
