"""The Python sampler must agree with the TypeScript one the browser preview uses."""

import math

from kivo_renderer.sampling import SceneSampler, active_clip, ease


def close(a, b, tol=1e-6):
    if isinstance(a, (list, tuple)):
        assert len(a) == len(b)
        for x, y in zip(a, b):
            close(x, y, tol)
    else:
        assert math.isclose(a, b, rel_tol=tol, abs_tol=tol), (a, b)


def test_matches_typescript_fixture(fixture):
    sampler = SceneSampler(fixture["spec"])
    assert len(fixture["samples"]) >= 10
    for sample in fixture["samples"]:
        t = sample["t"]
        for object_id, expected in sample["objects"].items():
            got = sampler.sample_object(object_id, t)
            close(got["position"], expected["position"])
            close(got["rotation"], expected["rotation"])
            close(got["scale"], expected["scale"])
        for camera_id, expected in sample["cameras"].items():
            got = sampler.sample_camera(camera_id, t)
            close(got["position"], expected["position"])
            close(got["target"], expected["target"])
            close(got["fov"], expected["fov"])
        for light_id, expected in sample["lights"].items():
            got = sampler.sample_light(light_id, t)
            close(got["intensity"], expected["intensity"])
            close(got["color"], expected["color"])
        shot = sampler.shot_at(t)
        assert (shot["id"] if shot else None) == sample["shot"]
        got = sampler.transition_at(t)
        assert got["kind"] == sample["transition"]["kind"]
        for key in ("level", "mix"):
            if key in sample["transition"]:
                close(got[key], sample["transition"][key])
        for key in ("fromCameraId", "toCameraId"):
            if key in sample["transition"]:
                assert got[key] == sample["transition"][key]


def test_easing():
    assert ease("linear", 0.25) == 0.25
    assert ease("ease_in", 0.5) == 0.25
    assert ease("ease_out", 0.5) == 0.75
    assert ease("hold", 0.9) == 0
    assert ease("ease_in_out", 2) == 1


def test_active_clip(fixture):
    spec = fixture["spec"]
    assert active_clip(spec, "hero", 2)["action"] == "walk"
    assert active_clip(spec, "hero", 7) == {"action": "idle", "time": 1, "loop": True, "speed": 1}
    assert active_clip(spec, "scout", 2) is None
