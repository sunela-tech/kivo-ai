import pytest

from kivo_renderer.manifest import ManifestError, validate_job

SETTINGS = {"width": 854, "height": 480, "fps": 24, "duration": 5, "watermark": True, "quality": "standard", "maxRenderSeconds": 1200}


def assets_for(scene):
    return {a["id"]: {"model": "model.glb", "rigged": None, "clips": {}} for a in scene["assets"]}


def test_accepts_valid_job(scene):
    job = validate_job({"settings": SETTINGS, "scene": scene, "assets": assets_for(scene)})
    assert job["settings"]["frames"] == 120
    assert job["settings"]["watermark"] is True


@pytest.mark.parametrize(
    "mutate, message",
    [
        (lambda j: j["settings"].update(width=853), "even"),
        (lambda j: j["settings"].update(width=7680, height=4320), "4K"),
        (lambda j: j["settings"].update(fps=500), "between"),
        (lambda j: j["settings"].update(quality="ultra"), "one of"),
        (lambda j: j["scene"]["objects"][0].update(assetId="nope"), "unknown asset"),
        (lambda j: j["scene"]["objects"][0].update(position=[0, "__import__('os')", 0]), "finite number"),
        (lambda j: j["scene"]["objects"][0].update(id="Bad Id; rm -rf"), "snake_case"),
        (lambda j: j["scene"]["world"].update(skyTop="red"), "colour"),
        (lambda j: j["scene"]["cameras"].clear(), "at least one camera"),
        (lambda j: j["scene"]["shots"][0].update(cameraId="ghost"), "unknown camera"),
        (lambda j: j["scene"]["tracks"].append({"id": "x", "type": "script", "objectId": "hero", "code": "import os"}), "unknown track type"),
        (lambda j: j["scene"]["tracks"][0]["keyframes"][0].update(easing="exec"), "one of"),
        (lambda j: j["assets"]["robot"].update(model="../../etc/passwd"), "missing model file"),
        (lambda j: j["assets"]["robot"].update(clips={"walk": {"file": "/tmp/x.glb"}}), "invalid file name"),
        (lambda j: j["assets"].pop("tower"), "must be an object"),
    ],
)
def test_rejects_invalid_jobs(scene, mutate, message):
    job = {"settings": dict(SETTINGS), "scene": scene, "assets": assets_for(scene)}
    mutate(job)
    with pytest.raises(ManifestError) as error:
        validate_job(job)
    assert message in str(error.value)


def test_hidden_objects_do_not_need_model_files(scene):
    for obj in scene["objects"]:
        if obj["assetId"] == "tower":
            obj["visible"] = False
    assets = assets_for(scene)
    del assets["tower"]
    validate_job({"settings": SETTINGS, "scene": scene, "assets": assets})
