"""Structural validation of a render job.

The Worker already validates scenes with the shared zod schema. The renderer
validates again, independently, before Blender touches anything: a scene is
plain data that drives fixed templates in scene_builder.py — nothing in it is
ever evaluated, imported or executed, and anything outside these bounds is
rejected rather than interpreted.
"""

from __future__ import annotations

import math
import re
from typing import Any

ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,47}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
FILE_RE = re.compile(r"^[a-z0-9][a-z0-9_.-]{0,80}\.glb$")

EASINGS = {"linear", "ease_in", "ease_out", "ease_in_out", "hold"}
ASSET_KINDS = {"character", "creature", "vehicle", "building", "prop", "furniture", "vegetation", "terrain"}
SIZE_AXES = {"height", "longest", "width"}
LIGHT_TYPES = {"sun", "point", "spot", "area"}
ATTACH_MODES = {"world", "look_at", "follow"}
TRANSITIONS = {"cut", "fade", "dissolve"}
PROCEDURAL_KINDS = {"hover", "bob", "hop", "sway", "spin", "wobble", "shake", "pulse"}
QUALITIES = {"draft", "standard", "high"}

MAX_FRAMES = 180 * 60 + 1
MAX_PIXELS = 3840 * 2160


class ManifestError(ValueError):
    pass


def _fail(path: str, message: str) -> None:
    raise ManifestError(f"{path}: {message}")


def _num(value: Any, path: str, lo: float = -1e7, hi: float = 1e7) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        _fail(path, "must be a finite number")
    if value < lo or value > hi:
        _fail(path, f"must be between {lo} and {hi}")
    return float(value)


def _vec3(value: Any, path: str) -> list[float]:
    if not isinstance(value, list) or len(value) != 3:
        _fail(path, "must be [x, y, z]")
    return [_num(v, f"{path}[{i}]") for i, v in enumerate(value)]


def _ident(value: Any, path: str) -> str:
    if not isinstance(value, str) or not ID_RE.match(value):
        _fail(path, "must be a lowercase snake_case id")
    return value


def _color(value: Any, path: str) -> str:
    if not isinstance(value, str) or not COLOR_RE.match(value):
        _fail(path, "must be a #rrggbb colour")
    return value


def _enum(value: Any, allowed: set[str], path: str) -> str:
    if value not in allowed:
        _fail(path, f"must be one of {sorted(allowed)}")
    return value


def _list(value: Any, path: str, max_len: int) -> list:
    if not isinstance(value, list):
        _fail(path, "must be a list")
    if len(value) > max_len:
        _fail(path, f"has more than {max_len} items")
    return value


def _dict(value: Any, path: str) -> dict:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    return value


def validate_settings(settings: Any) -> dict[str, Any]:
    s = _dict(settings, "settings")
    width = int(_num(s.get("width"), "settings.width", 64, 7680))
    height = int(_num(s.get("height"), "settings.height", 64, 7680))
    if width % 2 or height % 2:
        _fail("settings", "width and height must be even")
    if width * height > MAX_PIXELS:
        _fail("settings", "resolution exceeds 4K")
    fps = int(_num(s.get("fps"), "settings.fps", 12, 120))
    duration = _num(s.get("duration"), "settings.duration", 0.5, 600)
    frames = max(1, round(duration * fps))
    if frames > MAX_FRAMES:
        _fail("settings", "too many frames")
    return {
        "width": width,
        "height": height,
        "fps": fps,
        "duration": duration,
        "frames": frames,
        "watermark": bool(s.get("watermark", False)),
        "quality": _enum(s.get("quality", "standard"), QUALITIES, "settings.quality"),
        "maxRenderSeconds": int(_num(s.get("maxRenderSeconds", 3600), "settings.maxRenderSeconds", 30, 6 * 3600 * 4)),
    }


def validate_scene(scene: Any) -> dict[str, Any]:
    sc = _dict(scene, "scene")
    out = _dict(sc.get("output"), "scene.output")
    _num(out.get("duration"), "scene.output.duration", 0.5, 600)
    _num(out.get("fps"), "scene.output.fps", 12, 120)

    world = _dict(sc.get("world"), "scene.world")
    for key in ("skyTop", "skyHorizon", "groundColor"):
        _color(world.get(key), f"scene.world.{key}")
    _num(world.get("ambient", 1), "scene.world.ambient", 0, 5)
    _num(world.get("exposure", 0), "scene.world.exposure", -4, 4)

    asset_ids: set[str] = set()
    for i, a in enumerate(_list(sc.get("assets"), "scene.assets", 40)):
        p = f"scene.assets[{i}]"
        asset_ids.add(_ident(_dict(a, p).get("id"), f"{p}.id"))
        _enum(a.get("kind"), ASSET_KINDS, f"{p}.kind")
        size = _dict(a.get("size"), f"{p}.size")
        _num(size.get("meters"), f"{p}.size.meters", 0.02, 2000)
        _enum(size.get("axis", "height"), SIZE_AXES, f"{p}.size.axis")

    object_ids: set[str] = set()
    for i, o in enumerate(_list(sc.get("objects"), "scene.objects", 300)):
        p = f"scene.objects[{i}]"
        oid = _ident(_dict(o, p).get("id"), f"{p}.id")
        if oid in object_ids:
            _fail(p, "duplicate object id")
        object_ids.add(oid)
        if _ident(o.get("assetId"), f"{p}.assetId") not in asset_ids:
            _fail(p, "references an unknown asset")
        _vec3(o.get("position"), f"{p}.position")
        _vec3(o.get("rotation", [0, 0, 0]), f"{p}.rotation")
        _num(o.get("scale", 1), f"{p}.scale", 0.01, 100)
        mat = o.get("material")
        if mat is not None:
            m = _dict(mat, f"{p}.material")
            for key in ("tint", "emissive"):
                if m.get(key) is not None:
                    _color(m[key], f"{p}.material.{key}")
            for key, hi in (("tintStrength", 1), ("roughness", 1), ("metallic", 1), ("emissiveStrength", 50)):
                if m.get(key) is not None:
                    _num(m[key], f"{p}.material.{key}", 0, hi)

    light_ids: set[str] = set()
    for i, light in enumerate(_list(sc.get("lights"), "scene.lights", 24)):
        p = f"scene.lights[{i}]"
        light_ids.add(_ident(_dict(light, p).get("id"), f"{p}.id"))
        _enum(light.get("type"), LIGHT_TYPES, f"{p}.type")
        _color(light.get("color", "#ffffff"), f"{p}.color")
        _num(light.get("intensity"), f"{p}.intensity", 0, 1e6)
        _vec3(light.get("position"), f"{p}.position")
        _vec3(light.get("target", [0, 0, 0]), f"{p}.target")
        _num(light.get("spotAngle", 45), f"{p}.spotAngle", 1, 179)

    camera_ids: set[str] = set()
    cameras = _list(sc.get("cameras"), "scene.cameras", 24)
    if not cameras:
        _fail("scene.cameras", "at least one camera is required")
    for i, cam in enumerate(cameras):
        p = f"scene.cameras[{i}]"
        camera_ids.add(_ident(_dict(cam, p).get("id"), f"{p}.id"))
        attach = _dict(cam.get("attach") or {"mode": "world", "objectId": None}, f"{p}.attach")
        mode = _enum(attach.get("mode"), ATTACH_MODES, f"{p}.attach.mode")
        if mode != "world" and attach.get("objectId") not in object_ids:
            _fail(f"{p}.attach", "references an unknown object")
        keys = _list(cam.get("keyframes"), f"{p}.keyframes", 200)
        if not keys:
            _fail(f"{p}.keyframes", "at least one keyframe is required")
        for j, k in enumerate(keys):
            kp = f"{p}.keyframes[{j}]"
            _num(_dict(k, kp).get("t"), f"{kp}.t", 0, 600)
            _vec3(k.get("position"), f"{kp}.position")
            _vec3(k.get("target"), f"{kp}.target")
            _num(k.get("fov", 40), f"{kp}.fov", 8, 120)
            _enum(k.get("easing", "ease_in_out"), EASINGS, f"{kp}.easing")

    shots = _list(sc.get("shots"), "scene.shots", 80)
    if not shots:
        _fail("scene.shots", "at least one shot is required")
    for i, s in enumerate(shots):
        p = f"scene.shots[{i}]"
        if _dict(s, p).get("cameraId") not in camera_ids:
            _fail(p, "references an unknown camera")
        _num(s.get("start"), f"{p}.start", 0, 600)
        _num(s.get("end"), f"{p}.end", 0, 600)
        _enum(s.get("transition", "cut"), TRANSITIONS, f"{p}.transition")
        _num(s.get("transitionDuration", 0), f"{p}.transitionDuration", 0, 3)

    for i, track in enumerate(_list(sc.get("tracks"), "scene.tracks", 600)):
        p = f"scene.tracks[{i}]"
        kind = _dict(track, p).get("type")
        if kind == "light":
            if track.get("lightId") not in light_ids:
                _fail(p, "references an unknown light")
            for j, k in enumerate(_list(track.get("keyframes"), f"{p}.keyframes", 200)):
                kp = f"{p}.keyframes[{j}]"
                _num(k.get("t"), f"{kp}.t", 0, 600)
                if k.get("intensity") is not None:
                    _num(k["intensity"], f"{kp}.intensity", 0, 1e6)
                if k.get("color") is not None:
                    _color(k["color"], f"{kp}.color")
                _enum(k.get("easing", "linear"), EASINGS, f"{kp}.easing")
            continue
        if track.get("objectId") not in object_ids:
            _fail(p, "references an unknown object")
        if kind == "transform":
            for j, k in enumerate(_list(track.get("keyframes"), f"{p}.keyframes", 400)):
                kp = f"{p}.keyframes[{j}]"
                _num(k.get("t"), f"{kp}.t", 0, 600)
                if k.get("position") is not None:
                    _vec3(k["position"], f"{kp}.position")
                if k.get("rotation") is not None:
                    _vec3(k["rotation"], f"{kp}.rotation")
                if k.get("scale") is not None:
                    _num(k["scale"], f"{kp}.scale", 0.01, 100)
                _enum(k.get("easing", "linear"), EASINGS, f"{kp}.easing")
        elif kind == "action":
            for j, c in enumerate(_list(track.get("clips"), f"{p}.clips", 60)):
                cp = f"{p}.clips[{j}]"
                _num(c.get("start"), f"{cp}.start", 0, 600)
                _num(c.get("end"), f"{cp}.end", 0, 600)
                _ident(c.get("action"), f"{cp}.action")
                _num(c.get("speed", 1), f"{cp}.speed", 0.1, 4)
        elif kind == "procedural":
            for j, m in enumerate(_list(track.get("motions"), f"{p}.motions", 40)):
                mp = f"{p}.motions[{j}]"
                _num(m.get("start"), f"{mp}.start", 0, 600)
                _num(m.get("end"), f"{mp}.end", 0, 600)
                _enum(m.get("kind"), PROCEDURAL_KINDS, f"{mp}.kind")
                _num(m.get("amplitude"), f"{mp}.amplitude", 0, 1000)
                _num(m.get("frequency"), f"{mp}.frequency", 0, 30)
        else:
            _fail(p, "unknown track type")
    return sc


def validate_assets(assets: Any, scene: dict[str, Any]) -> dict[str, Any]:
    """Every asset an object uses must have a real model file. No placeholders."""
    files = _dict(assets, "assets")
    used = {o["assetId"] for o in scene["objects"] if o.get("visible", True)}
    for asset_id in used:
        entry = _dict(files.get(asset_id), f"assets.{asset_id}")
        model = entry.get("model")
        if not isinstance(model, str) or not FILE_RE.match(model):
            _fail(f"assets.{asset_id}.model", "missing model file")
        rigged = entry.get("rigged")
        if rigged is not None and (not isinstance(rigged, str) or not FILE_RE.match(rigged)):
            _fail(f"assets.{asset_id}.rigged", "invalid file name")
        clips = _dict(entry.get("clips") or {}, f"assets.{asset_id}.clips")
        for name, clip in clips.items():
            _ident(name, f"assets.{asset_id}.clips key")
            c = _dict(clip, f"assets.{asset_id}.clips.{name}")
            if not isinstance(c.get("file"), str) or not FILE_RE.match(c["file"]):
                _fail(f"assets.{asset_id}.clips.{name}.file", "invalid file name")
            if c.get("animation") is not None and not isinstance(c["animation"], str):
                _fail(f"assets.{asset_id}.clips.{name}.animation", "must be a string")
    return files


def validate_job(job: Any) -> dict[str, Any]:
    j = _dict(job, "job")
    settings = validate_settings(j.get("settings"))
    scene = validate_scene(j.get("scene"))
    assets = validate_assets(j.get("assets"), scene)
    return {"settings": settings, "scene": scene, "assets": assets}
