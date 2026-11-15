"""Upload the model files made by build.py, and onnxruntime-web, to the WEIGHTS KV namespace.

  python upload_files.py            the deployed Worker (remote)
  python upload_files.py --local    the local `wrangler dev` store
  python upload_files.py --force    upload everything again

Keys:
  weights/<model>.json|bin       INKOS 1 and 1.1
  weights/<pro>/<file>           INKOS 1 Pro and 1.1 Pro: manifest.json and three ONNX graphs
  ort/<version>/<file>           the onnxruntime-web files the page imports

A KV value holds at most 25 MiB. A larger file is stored in 20 MiB parts:
<key> holds part 0 with metadata {"size": total, "parts": n}, and <key>#1 ...
<key>#n-1 the rest; the Worker streams them back as one body. Parts are
written before part 0, so a reader never sees a part count without its parts.
Files already uploaded with the same content (recorded in .wrangler/uploaded-*.json)
are skipped.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PUB = HERE / "public" / "weights"
ORT = HERE / "node_modules" / "onnxruntime-web"
ORT_FILES = ("ort.webgpu.bundle.min.mjs", "ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm")
LIMIT, PART = 24 * 2**20, 20 * 2**20


def files() -> list[tuple[str, Path]]:
    out = [(f"weights/{f.name}", f) for f in sorted(PUB.glob("*.json")) + sorted(PUB.glob("*.bin"))]
    for d in sorted(p for p in PUB.iterdir() if p.is_dir()):
        man = json.loads((d / "manifest.json").read_text())
        out += [(f"weights/{d.name}/{f['name']}", d / f["name"]) for f in man["files"]]
        out.append((f"weights/{d.name}/manifest.json", d / "manifest.json"))      # last: points at the new graphs
    version = json.loads((ORT / "package.json").read_text())["version"]
    out += [(f"ort/{version}/{n}", ORT / "dist" / n) for n in ORT_FILES]
    return out


def put(key: str, path: Path, meta: dict, where: str):
    cmd = ["npx", "wrangler", "kv", "key", "put", key, "--path", str(path), "--binding", "WEIGHTS",
           "--metadata", json.dumps(meta), where]
    for attempt in range(4):
        r = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True)
        if r.returncode == 0:
            return
        print(f"  retrying {key}: {r.stderr.strip()[-300:]}")
    raise SystemExit(f"could not upload {key}")


def main():
    where = "--local" if "--local" in sys.argv else "--remote"
    record_file = HERE / ".wrangler" / f"uploaded{where.replace('--', '-')}.json"
    record = {} if "--force" in sys.argv or not record_file.exists() else json.loads(record_file.read_text())
    record_file.parent.mkdir(exist_ok=True)
    for key, path in files():
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        if record.get(key) == digest:
            print(f"unchanged {key}")
            continue
        size = len(data)
        if size <= LIMIT:
            print(f"uploading {key} ({size / 1e6:.1f} MB)")
            put(key, path, {"size": size}, where)
        else:
            n = -(-size // PART)
            print(f"uploading {key} ({size / 1e6:.1f} MB in {n} parts)")
            with tempfile.TemporaryDirectory() as tmp:
                for k in list(range(1, n)) + [0]:
                    part = Path(tmp) / f"part{k}"
                    part.write_bytes(data[k * PART:(k + 1) * PART])
                    put(key if k == 0 else f"{key}#{k}", part, {"size": size, "parts": n} if k == 0 else {"part": k}, where)
        record[key] = digest
        record_file.write_text(json.dumps(record, indent=1))
    print("done")


if __name__ == "__main__":
    main()
