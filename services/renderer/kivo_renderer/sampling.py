"""Deterministic scene sampling.

A line-for-line port of packages/shared/src/interp.ts. The browser preview runs
the TypeScript version; Blender renders from this one. tests/test_sampling.py
asserts both against the same fixture (packages/shared/test/fixtures/sampling.json),
so what the user previews is what gets rendered.
"""

from __future__ import annotations

import math
from typing import Any

PROCEDURAL_FADE = 0.25
HEADING_WINDOW = 0.15

Vec3 = list[float]
Key = tuple[float, Any, str]  # (t, value, easing)


def ease(easing: str, u: float) -> float:
    x = min(1.0, max(0.0, u))
    if easing == "linear":
        return x
    if easing == "ease_in":
        return x * x
    if easing == "ease_out":
        return 1 - (1 - x) * (1 - x)
    if easing == "ease_in_out":
        return 2 * x * x if x < 0.5 else 1 - ((-2 * x + 2) * (-2 * x + 2)) / 2
    if easing == "hold":
        return 0.0
    return x


def lerp(a: float, b: float, u: float) -> float:
    return a + (b - a) * u


def lerp3(a: Vec3, b: Vec3, u: float) -> Vec3:
    return [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)]


def _catmull(p0: float, p1: float, p2: float, p3: float, u: float) -> float:
    u2 = u * u
    u3 = u2 * u
    return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3)


def hex_to_rgb(value: str) -> Vec3:
    n = int(value[1:], 16)
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]


def _locate(keys: list[Key], time: float) -> tuple[int, int, float]:
    n = len(keys)
    if n == 1 or time <= keys[0][0]:
        return 0, 0, 0.0
    if time >= keys[n - 1][0]:
        return n - 1, n - 1, 0.0
    i = 0
    while i < n - 2 and keys[i + 1][0] <= time:
        i += 1
    k0 = keys[i]
    k1 = keys[i + 1]
    span = k1[0] - k0[0]
    raw = 1.0 if span <= 1e-9 else (time - k0[0]) / span
    return i, i + 1, ease(k1[2], raw)


def _sample_scalar(keys: list[Key], time: float, fallback: float) -> float:
    if not keys:
        return fallback
    i0, i1, u = _locate(keys, time)
    return lerp(keys[i0][1], keys[i1][1], u)


def _sample_vec(keys: list[Key], time: float, fallback: Vec3, smooth: bool) -> Vec3:
    if not keys:
        return fallback
    i0, i1, u = _locate(keys, time)
    a = keys[i0][1]
    b = keys[i1][1]
    if not smooth or i0 == i1:
        return lerp3(a, b, u)
    if a[0] == b[0] and a[1] == b[1] and a[2] == b[2]:
        return a
    p0 = keys[max(0, i0 - 1)][1]
    p3 = keys[min(len(keys) - 1, i1 + 1)][1]
    return [
        _catmull(p0[0], a[0], b[0], p3[0], u),
        _catmull(p0[1], a[1], b[1], p3[1], u),
        _catmull(p0[2], a[2], b[2], p3[2], u),
    ]


def _sorted(keys: list[Key]) -> list[Key]:
    return sorted(keys, key=lambda k: k[0])


class SceneSampler:
    def __init__(self, spec: dict[str, Any]):
        self.spec = spec
        self.objects: dict[str, dict] = {o["id"]: o for o in spec["objects"]}
        self.transforms: dict[str, dict] = {}
        self.procedurals: dict[str, list[dict]] = {}
        self.cameras: dict[str, dict] = {}
        self.camera_keys: dict[str, dict] = {}
        self.lights: dict[str, dict] = {light["id"]: light for light in spec["lights"]}
        self.light_keys: dict[str, dict] = {}

        for track in spec["tracks"]:
            kind = track["type"]
            if kind == "transform":
                self._compile_transform(track)
            elif kind == "procedural":
                self.procedurals.setdefault(track["objectId"], []).extend(track["motions"])
            elif kind == "light":
                self._compile_light(track)

        for cam in spec["cameras"]:
            self.cameras[cam["id"]] = cam
            keys = sorted(cam["keyframes"], key=lambda k: k["t"])
            self.camera_keys[cam["id"]] = {
                "pos": [(k["t"], k["position"], k.get("easing", "ease_in_out")) for k in keys],
                "target": [(k["t"], k["target"], k.get("easing", "ease_in_out")) for k in keys],
                "fov": [(k["t"], k.get("fov", 40), k.get("easing", "ease_in_out")) for k in keys],
            }
        self.shots: list[dict] = sorted(spec["shots"], key=lambda s: s["start"])

    def _compile_transform(self, track: dict) -> None:
        pos: list[Key] = []
        rot: list[Key] = []
        scale: list[Key] = []
        for k in track["keyframes"]:
            easing = k.get("easing", "linear")
            if k.get("position") is not None:
                pos.append((k["t"], k["position"], easing))
            if k.get("rotation") is not None:
                rot.append((k["t"], k["rotation"], easing))
            if k.get("scale") is not None:
                scale.append((k["t"], k["scale"], easing))
        self.transforms[track["objectId"]] = {
            "smooth": bool(track.get("smooth", False)),
            "orientToPath": bool(track.get("orientToPath", False)),
            "pos": _sorted(pos),
            "rot": _sorted(rot),
            "scale": _sorted(scale),
        }

    def _compile_light(self, track: dict) -> None:
        entry = self.light_keys.setdefault(track["lightId"], {"intensity": [], "color": []})
        for k in track["keyframes"]:
            easing = k.get("easing", "linear")
            if k.get("intensity") is not None:
                entry["intensity"].append((k["t"], k["intensity"], easing))
            if k.get("color"):
                entry["color"].append((k["t"], hex_to_rgb(k["color"]), easing))
        entry["intensity"] = _sorted(entry["intensity"])
        entry["color"] = _sorted(entry["color"])

    def _path_position(self, obj: dict, c: dict | None, t: float) -> Vec3:
        if not c:
            return obj["position"]
        return _sample_vec(c["pos"], t, obj["position"], c["smooth"])

    def _heading(self, obj: dict, c: dict, t: float) -> float | None:
        keys = c["pos"]
        if len(keys) < 2:
            return None
        t0 = keys[0][0]
        t1 = keys[-1][0]
        a = self._path_position(obj, c, max(t0, min(t1, t - HEADING_WINDOW)))
        b = self._path_position(obj, c, max(t0, min(t1, t + HEADING_WINDOW)))
        dx = b[0] - a[0]
        dz = b[2] - a[2]
        if dx * dx + dz * dz < 1e-8:
            i0, _, _ = _locate(keys, max(t0, min(t1, t)))
            found = False
            i = min(i0, len(keys) - 2)
            while i >= 0 and not found:
                dx = keys[i + 1][1][0] - keys[i][1][0]
                dz = keys[i + 1][1][2] - keys[i][1][2]
                found = dx * dx + dz * dz >= 1e-8
                i -= 1
            i = min(i0 + 1, len(keys) - 2)
            while i <= len(keys) - 2 and not found:
                dx = keys[i + 1][1][0] - keys[i][1][0]
                dz = keys[i + 1][1][2] - keys[i][1][2]
                found = dx * dx + dz * dz >= 1e-8
                i += 1
            if not found:
                return None
        return math.atan2(dx, dz) * 180 / math.pi

    def sample_object(self, object_id: str, t: float) -> dict[str, Any]:
        obj = self.objects.get(object_id)
        if obj is None:
            return {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": 1}
        c = self.transforms.get(object_id)
        position = list(self._path_position(obj, c, t))
        base_rot = obj.get("rotation", [0, 0, 0])
        rotation = list(_sample_vec(c["rot"], t, base_rot, False) if c else base_rot)
        base_scale = obj.get("scale", 1)
        scale = _sample_scalar(c["scale"], t, base_scale) if c else base_scale
        if c and c["orientToPath"]:
            h = self._heading(obj, c, t)
            if h is not None:
                rotation[1] = h
        for m in self.procedurals.get(object_id, []):
            if t < m["start"]:
                continue
            length = max(0.0, m["end"] - m["start"])
            tau = min(t - m["start"], length)
            w2 = 2 * math.pi * m["frequency"]
            kind = m["kind"]
            if kind == "spin":
                rotation[1] += 360 * m["frequency"] * tau
                continue
            if t > m["end"]:
                continue
            w = max(0.0, min(1.0, tau / PROCEDURAL_FADE, (m["end"] - t) / PROCEDURAL_FADE))
            amp = m["amplitude"]
            if kind == "hover":
                position[1] += amp * math.sin(w2 * tau) * w
            elif kind == "bob":
                position[1] += amp * 0.5 * (1 - math.cos(w2 * tau)) * w
            elif kind == "hop":
                position[1] += amp * abs(math.sin(math.pi * m["frequency"] * tau)) * w
            elif kind == "sway":
                rotation[2] += amp * math.sin(w2 * tau) * w
            elif kind == "wobble":
                rotation[2] += amp * math.sin(w2 * tau) * w
                rotation[0] += amp * 0.5 * math.sin(w2 * tau + math.pi / 2) * w
            elif kind == "shake":
                position[0] += amp * math.sin(w2 * tau * 1.31 + 0.7) * w
                position[2] += amp * math.sin(w2 * tau * 1.73 + 2.1) * w
                position[1] += amp * 0.5 * math.sin(w2 * tau * 2.17 + 4.2) * w
            elif kind == "pulse":
                scale *= 1 + amp * math.sin(w2 * tau) * w
        return {"position": position, "rotation": rotation, "scale": max(0.001, scale)}

    def sample_camera(self, camera_id: str, t: float) -> dict[str, Any]:
        cam = self.cameras.get(camera_id)
        keys = self.camera_keys.get(camera_id)
        if cam is None or keys is None:
            return {"position": [0, 2, 8], "target": [0, 1, 0], "fov": 40}
        position = list(_sample_vec(keys["pos"], t, [0, 2, 8], bool(cam.get("smooth", True))))
        target = list(_sample_vec(keys["target"], t, [0, 1, 0], False))
        fov = _sample_scalar(keys["fov"], t, 40)
        attach = cam.get("attach") or {"mode": "world", "objectId": None}
        if attach["mode"] != "world" and attach.get("objectId") in self.objects:
            anchor = self.sample_object(attach["objectId"], t)["position"]
            target = [target[0] + anchor[0], target[1] + anchor[1], target[2] + anchor[2]]
            if attach["mode"] == "follow":
                position = [position[0] + anchor[0], position[1] + anchor[1], position[2] + anchor[2]]
        return {"position": position, "target": target, "fov": fov}

    def sample_light(self, light_id: str, t: float) -> dict[str, Any]:
        light = self.lights.get(light_id)
        if light is None:
            return {"intensity": 0, "color": [1, 1, 1]}
        base = hex_to_rgb(light.get("color", "#ffffff"))
        keys = self.light_keys.get(light_id)
        if keys is None:
            return {"intensity": light["intensity"], "color": base}
        return {
            "intensity": _sample_scalar(keys["intensity"], t, light["intensity"]),
            "color": _sample_vec(keys["color"], t, base, False),
        }

    def shot_index_at(self, t: float) -> int:
        if not self.shots:
            return -1
        for i in range(len(self.shots) - 1, -1, -1):
            if t >= self.shots[i]["start"]:
                return i
        return 0

    def shot_at(self, t: float) -> dict | None:
        i = self.shot_index_at(t)
        return None if i < 0 else self.shots[i]

    def transition_at(self, t: float) -> dict[str, Any]:
        for i, s in enumerate(self.shots):
            d = s.get("transitionDuration", 0)
            kind = s.get("transition", "cut")
            if kind == "cut" or d <= 1e-6:
                continue
            if i == 0:
                if kind == "fade" and t < s["start"] + d:
                    return {"kind": "fade", "level": max(0.0, min(1.0, (t - s["start"]) / d))}
                continue
            half = d / 2
            if t < s["start"] - half or t >= s["start"] + half:
                continue
            prev = self.shots[i - 1]
            if kind == "fade":
                return {"kind": "fade", "level": max(0.0, min(1.0, abs(t - s["start"]) / half))}
            return {
                "kind": "dissolve",
                "fromCameraId": prev["cameraId"],
                "toCameraId": s["cameraId"],
                "mix": max(0.0, min(1.0, (t - (s["start"] - half)) / d)),
            }
        return {"kind": "none"}


def active_clip(spec: dict[str, Any], object_id: str, t: float) -> dict[str, Any] | None:
    best = None
    for track in spec["tracks"]:
        if track["type"] != "action" or track["objectId"] != object_id:
            continue
        for c in track["clips"]:
            if c["start"] <= t < c["end"] and (best is None or c["start"] >= best["start"]):
                best = c
    if best is None:
        return None
    speed = best.get("speed", 1)
    return {"action": best["action"], "time": (t - best["start"]) * speed, "loop": best.get("loop", True), "speed": speed}
