"""End-to-end Blender test: build GLB fixtures, render frames through the real job entry point."""

import json
import os
import subprocess
import sys

import pytest

bpy = pytest.importorskip("bpy", reason="Blender (bpy) is not installed")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MAKE_FIXTURES = r"""
import bpy, sys
out = sys.argv[-1]
def export(name, build):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    build()
    mat = bpy.data.materials.new(name)
    for o in bpy.context.scene.objects:
        if o.type == "MESH":
            o.data.materials.append(mat)
    bpy.ops.export_scene.gltf(filepath=f"{out}/{name}.glb", export_format="GLB")
export("figure", lambda: bpy.ops.mesh.primitive_monkey_add(size=3, location=(5, 5, 9)))
export("slab", lambda: bpy.ops.mesh.primitive_cube_add(size=2, scale=(4, 4, 0.2)))
"""


@pytest.fixture(scope="module")
def glbs(tmp_path_factory):
    out = tmp_path_factory.mktemp("glb")
    script = out / "make.py"
    script.write_text(MAKE_FIXTURES)
    subprocess.run([sys.executable, str(script), str(out)], check=True, capture_output=True)
    return out


def job_for(glbs, tmp_path, **settings):
    assets = tmp_path / "assets"
    for asset_id, src in (("figure", "figure.glb"), ("ground", "slab.glb")):
        (assets / asset_id).mkdir(parents=True)
        (assets / asset_id / "model.glb").write_bytes((glbs / src).read_bytes())
    scene = {
        "version": 1, "title": "t", "logline": "", "style": "cinematic",
        "output": {"duration": 0.5, "fps": 12, "aspect": "16:9"},
        "world": {"skyTop": "#4477cc", "skyHorizon": "#ddeeff", "groundColor": "#444444", "ambient": 1, "exposure": 0},
        "assets": [
            {"id": "figure", "name": "Figure", "kind": "prop", "prompt": "x", "rig": "none", "size": {"meters": 2, "axis": "height"}, "actions": [], "motions": []},
            {"id": "ground", "name": "Ground", "kind": "terrain", "prompt": "x", "rig": "none", "size": {"meters": 20, "axis": "width"}, "actions": [], "motions": []},
        ],
        "objects": [
            {"id": "a", "assetId": "figure", "name": "A", "position": [0, 0, 0], "rotation": [0, 180, 0], "scale": 1, "visible": True},
            {"id": "b", "assetId": "figure", "name": "B", "position": [3, 0, 2], "rotation": [0, 0, 0], "scale": 0.5, "visible": True,
             "material": {"tint": "#ff0000", "tintStrength": 1, "roughness": 0.2, "emissive": "#110000", "emissiveStrength": 1}},
            {"id": "floor", "assetId": "ground", "name": "Floor", "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1, "visible": True},
        ],
        "lights": [{"id": "sun", "name": "Sun", "type": "sun", "color": "#ffffff", "intensity": 4, "position": [4, 8, -4], "target": [0, 0, 0], "spotAngle": 45, "castShadow": True}],
        "cameras": [
            {"id": "c1", "name": "C1", "attach": {"mode": "world", "objectId": None}, "smooth": False,
             "keyframes": [{"t": 0, "position": [0, 1.5, -7], "target": [0, 1, 0], "fov": 40, "easing": "linear"}]},
            {"id": "c2", "name": "C2", "attach": {"mode": "look_at", "objectId": "a"}, "smooth": False,
             "keyframes": [{"t": 0, "position": [5, 3, -5], "target": [0, 1, 0], "fov": 35, "easing": "linear"}]},
        ],
        "shots": [
            {"id": "s1", "name": "", "cameraId": "c1", "start": 0, "end": 0.25, "transition": "fade", "transitionDuration": 0.1},
            {"id": "s2", "name": "", "cameraId": "c2", "start": 0.25, "end": 0.5, "transition": "dissolve", "transitionDuration": 0.2},
        ],
        "tracks": [
            {"id": "a_move", "type": "transform", "objectId": "a", "smooth": False, "orientToPath": False,
             "keyframes": [{"t": 0, "position": [-1, 0, 0], "easing": "linear"}, {"t": 0.5, "position": [1, 0, 0], "easing": "linear"}]},
            {"id": "b_motion", "type": "procedural", "objectId": "b", "motions": [{"start": 0, "end": 0.5, "kind": "hop", "amplitude": 0.5, "frequency": 2}]},
        ],
    }
    job = {
        "settings": {"width": 192, "height": 108, "fps": 12, "duration": 0.5, "watermark": False, "quality": "draft", "maxRenderSeconds": 300, **settings},
        "scene": scene,
        "assets": {"figure": {"model": "model.glb", "rigged": None, "clips": {}}, "ground": {"model": "model.glb", "rigged": None, "clips": {}}},
    }
    path = tmp_path / "job.json"
    path.write_text(json.dumps(job))
    return path, assets


def run_job(path, assets, frames):
    env = dict(os.environ, KIVO_RENDER_SAMPLES="4", KIVO_RENDER_DEVICE="cpu")
    return subprocess.run(
        [sys.executable, "-m", "kivo_renderer.render_job", "--job", str(path), "--assets", str(assets), "--frames", str(frames)],
        cwd=ROOT, env=env, capture_output=True, text=True, timeout=600,
    )


def events(proc):
    return [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]


def test_renders_every_frame(glbs, tmp_path):
    path, assets = job_for(glbs, tmp_path)
    frames = tmp_path / "frames"
    proc = run_job(path, assets, frames)
    assert proc.returncode == 0, proc.stderr[-2000:]
    evs = events(proc)
    assert evs[-1] == {"event": "done", "frames": 6}
    assert [e["done"] for e in evs if e["event"] == "frame"] == [1, 2, 3, 4, 5, 6]
    files = sorted(os.listdir(frames))
    assert files == [f"frame_{i:05d}.png" for i in range(1, 7)], files

    import numpy as np

    def pixels(index):
        img = bpy.data.images.load(str(frames / f"frame_{index:05d}.png"))
        px = np.array(img.pixels[:]).reshape(-1, img.channels)[:, :3]
        bpy.data.images.remove(img)
        return px

    first, mid, last = pixels(1), pixels(3), pixels(6)
    assert first.max() < 0.02, "the first frame of a fade-in starts black"
    assert last.mean() > 0.05, "later frames show the lit scene"
    assert np.abs(mid - last).mean() > 0.01, "the two cameras and the motion produce different images"


def test_missing_model_fails_instead_of_substituting(glbs, tmp_path):
    path, assets = job_for(glbs, tmp_path)
    os.remove(assets / "figure" / "model.glb")
    proc = run_job(path, assets, tmp_path / "frames")
    assert proc.returncode != 0
    err = [e for e in events(proc) if e["event"] == "error"]
    assert err and "missing" in err[0]["message"]
    assert not os.path.exists(tmp_path / "frames" / "frame_00001.png")


def test_invalid_scene_is_rejected_before_blender(glbs, tmp_path):
    path, assets = job_for(glbs, tmp_path)
    job = json.loads(path.read_text())
    job["scene"]["tracks"].append({"id": "evil", "type": "python", "objectId": "a", "source": "import os"})
    path.write_text(json.dumps(job))
    proc = run_job(path, assets, tmp_path / "frames")
    assert proc.returncode != 0
    err = [e for e in events(proc) if e["event"] == "error"]
    assert err[0]["code"] == "invalid_scene"
