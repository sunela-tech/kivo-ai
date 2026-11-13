"""Blender scene assembly from a validated SceneSpec.

Everything here is a fixed template driven by data: import the Meshy GLBs,
normalise their size, place instances, pose skeletons from Meshy's clips, aim
cameras and lights. Nothing from the scene is executed.

Coordinates: the spec is Y-up (glTF / three.js); Blender is Z-up. A spec point
(x, y, z) is Blender (x, -z, y), and a glTF model's +Z "forward" becomes
Blender -Y on import, so headings carry over unchanged.
"""

from __future__ import annotations

import math
import os
import re
from dataclasses import dataclass, field
from typing import Any

import bpy  # type: ignore
import numpy as np
from bpy_extras import anim_utils  # type: ignore
from mathutils import Matrix, Quaternion, Vector  # type: ignore

from .sampling import SceneSampler, active_clip, hex_to_rgb

BASIS = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))
BASIS_T = BASIS.transposed()

QUALITY_SAMPLES = {"draft": 12, "standard": 32, "high": 96}


def slug(value: str) -> str:
    s = re.sub(r"[^a-z0-9_]+", "_", (value or "").lower())
    s = re.sub(r"_+", "_", s).strip("_")
    return s


def to_blender(v) -> Vector:
    return Vector((v[0], -v[2], v[1]))


def rotation_to_blender(deg) -> Quaternion:
    """three.js Euler XYZ (degrees) -> Blender quaternion."""
    rx, ry, rz = (math.radians(a) for a in deg)
    r = Matrix.Rotation(rx, 3, "X") @ Matrix.Rotation(ry, 3, "Y") @ Matrix.Rotation(rz, 3, "Z")
    return (BASIS @ r @ BASIS_T).to_quaternion()


def look_at_quat(position: Vector, target: Vector) -> Quaternion:
    direction = target - position
    if direction.length < 1e-6:
        direction = Vector((0, 1, 0))
    return direction.to_track_quat("-Z", "Y")


def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def linear_rgb(hex_color: str) -> tuple[float, float, float]:
    r, g, b = hex_to_rgb(hex_color)
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b))


# ───────────────────────── import ─────────────────────────


def import_glb(path: str) -> tuple[list, list]:
    """Import a GLB. Returns (new objects, new actions)."""
    before_objects = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    kwargs: dict[str, Any] = {"filepath": path}
    props = bpy.ops.import_scene.gltf.get_rna_type().properties
    if "disable_bone_shape" in props:
        kwargs["disable_bone_shape"] = True
    result = bpy.ops.import_scene.gltf(**kwargs)
    if "FINISHED" not in result:
        raise RuntimeError(f"Blender could not import {os.path.basename(path)}")
    objects = [o for o in bpy.data.objects if o not in before_objects]
    actions = [a for a in bpy.data.actions if a not in before_actions]
    # Older importers add helper meshes for bone display; they are not part of the model.
    helpers = [o for o in objects if o.type == "MESH" and o.parent is None and o.name.startswith("Icosphere")]
    if helpers and any(o.type == "ARMATURE" for o in objects):
        for o in helpers:
            objects.remove(o)
            bpy.data.objects.remove(o, do_unlink=True)
    if not any(o.type == "MESH" for o in objects):
        raise RuntimeError(f"{os.path.basename(path)} contains no mesh")
    return objects, actions


def remove_objects(objects: list) -> None:
    meshes = {o.data for o in objects if o.type == "MESH"}
    armatures = {o.data for o in objects if o.type == "ARMATURE"}
    for o in objects:
        bpy.data.objects.remove(o, do_unlink=True)
    for m in meshes:
        if m.users == 0:
            bpy.data.meshes.remove(m)
    for a in armatures:
        if a.users == 0:
            bpy.data.armatures.remove(a)


def world_bounds(objects: list) -> tuple[np.ndarray, np.ndarray]:
    deps = bpy.context.evaluated_depsgraph_get()
    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for o in objects:
        if o.type != "MESH":
            continue
        ev = o.evaluated_get(deps)
        mesh = ev.to_mesh()
        n = len(mesh.vertices)
        if n:
            co = np.empty(n * 3, dtype=np.float32)
            mesh.vertices.foreach_get("co", co)
            m = np.array(ev.matrix_world)
            world = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
            lo = np.minimum(lo, world.min(axis=0))
            hi = np.maximum(hi, world.max(axis=0))
        ev.to_mesh_clear()
    if not np.all(np.isfinite(lo)):
        raise RuntimeError("model has no geometry")
    return lo, hi


# ───────────────────────── instances ─────────────────────────


@dataclass
class Instance:
    object_id: str
    asset_id: str
    root: Any  # animated Empty
    objects: list
    armature: Any = None
    clips: dict[str, dict] = field(default_factory=dict)  # name -> {"channels": [...], "start": f, "length": f}
    last_quat: Any = None


def _new_empty(name: str, collection) -> Any:
    e = bpy.data.objects.new(name, None)
    e.empty_display_size = 0.2
    e.rotation_mode = "QUATERNION"
    collection.objects.link(e)
    return e


def _normalise(objects: list, armature, asset: dict, norm) -> None:
    """Scale and offset the imported model so it has the asset's real-world size and stands on the origin."""
    if armature is not None:
        armature.data.pose_position = "REST"
    bpy.context.view_layer.update()
    lo, hi = world_bounds(objects)
    if armature is not None:
        armature.data.pose_position = "POSE"
    dx, dy, dz = (hi - lo).tolist()
    axis = asset["size"].get("axis", "height")
    if axis == "height":
        extent = dz
    elif axis == "width":
        extent = max(dx, dy)
    else:
        extent = max(dx, dy, dz)
    if extent < 1e-6:
        raise RuntimeError(f'model "{asset["id"]}" is degenerate')
    s = asset["size"]["meters"] / extent
    cx = (lo[0] + hi[0]) / 2
    cy = (lo[1] + hi[1]) / 2
    squash = 1.0
    if asset.get("kind") == "terrain":
        # Generated "flat" ground still has relief. Characters stand at ground level, so the slab is
        # pressed flat enough that nothing sinks into it, and its top surface is put at height 0.
        thickness = dz * s
        limit = terrain_thickness(asset["size"]["meters"])
        if thickness > limit:
            squash = limit / thickness
        base = hi[2]
    else:
        base = lo[2]
    for o in objects:
        if o.parent is None:
            o.parent = norm
    norm.scale = (s, s, s * squash)
    norm.location = (-cx * s, -cy * s, -base * s * squash)


def terrain_thickness(width_m: float) -> float:
    """Maximum relief kept on a terrain model, in metres (matches the editor preview)."""
    return max(0.12, min(0.6, width_m * 0.004))


def _compile_action(armature, action) -> dict:
    """Pre-resolve an action's curves against an armature so a pose can be set for any frame."""
    slot = action.slots[0] if getattr(action, "slots", None) and len(action.slots) else None
    bag = anim_utils.action_get_channelbag_for_slot(action, slot) if slot is not None else None
    fcurves = list(bag.fcurves) if bag is not None else list(getattr(action, "fcurves", []))
    channels = []
    for fc in fcurves:
        path = fc.data_path
        if not path.startswith("pose.bones["):
            continue
        owner_path, _, prop = path.rpartition(".")
        try:
            owner = armature.path_resolve(owner_path)
        except ValueError:
            continue  # bone not present on this skeleton
        if prop not in ("location", "rotation_quaternion", "rotation_euler", "scale"):
            continue
        channels.append((owner, prop, fc.array_index, fc))
    start, end = action.frame_range
    return {"channels": channels, "start": float(start), "length": max(1e-3, float(end - start))}


def _apply_pose(instance: Instance, clip_name: str, seconds: float, loop: bool, fps: float) -> None:
    clip = instance.clips.get(clip_name)
    if clip is None:
        return
    local = seconds * fps
    if loop:
        local = math.fmod(local, clip["length"])
    else:
        local = min(local, clip["length"])
    frame = clip["start"] + local
    for owner, prop, index, fc in clip["channels"]:
        getattr(owner, prop)[index] = fc.evaluate(frame)


def _rest_pose(instance: Instance) -> None:
    for bone in instance.armature.pose.bones:
        bone.location = (0, 0, 0)
        bone.rotation_quaternion = (1, 0, 0, 0)
        bone.scale = (1, 1, 1)


def _apply_material(objects: list, override: dict) -> None:
    for o in objects:
        if o.type != "MESH":
            continue
        o.data = o.data.copy()
        for slot in o.material_slots:
            if slot.material is None:
                continue
            mat = slot.material.copy()
            slot.material = mat
            tree = mat.node_tree
            if tree is None:
                continue
            bsdf = next((n for n in tree.nodes if n.bl_idname == "ShaderNodeBsdfPrincipled"), None)
            if bsdf is None:
                continue
            tint = override.get("tint")
            strength = float(override.get("tintStrength", 0.6 if tint else 0))
            if tint and strength > 0:
                rgb = linear_rgb(tint)
                base = bsdf.inputs["Base Color"]
                if base.is_linked:
                    source = base.links[0].from_socket
                    mix = tree.nodes.new("ShaderNodeMix")
                    mix.data_type = "RGBA"
                    mix.blend_type = "MULTIPLY"
                    sockets = {s.identifier: s for s in mix.inputs}
                    sockets["Factor_Float"].default_value = strength
                    sockets["B_Color"].default_value = (*rgb, 1)
                    tree.links.new(source, sockets["A_Color"])
                    result = next(s for s in mix.outputs if s.identifier == "Result_Color")
                    tree.links.new(result, base)
                else:
                    c = base.default_value
                    base.default_value = tuple(c[i] * (1 - strength) + c[i] * rgb[i] * strength for i in range(3)) + (1,)
            for key, socket_name in (("roughness", "Roughness"), ("metallic", "Metallic")):
                if override.get(key) is not None:
                    socket = bsdf.inputs[socket_name]
                    for link in list(socket.links):
                        tree.links.remove(link)
                    socket.default_value = float(override[key])
            if override.get("emissive"):
                color = bsdf.inputs.get("Emission Color")
                power = bsdf.inputs.get("Emission Strength")
                if color is not None and power is not None:
                    for link in list(color.links):
                        tree.links.remove(link)
                    color.default_value = (*linear_rgb(override["emissive"]), 1)
                    power.default_value = float(override.get("emissiveStrength", 2))


class SceneBuilder:
    def __init__(self, job: dict, assets_dir: str):
        self.settings = job["settings"]
        self.spec = job["scene"]
        self.asset_files = job["assets"]
        self.assets_dir = assets_dir
        self.fps = float(self.settings["fps"])
        self.sampler = SceneSampler(self.spec)
        self.assets = {a["id"]: a for a in self.spec["assets"]}
        self.instances: dict[str, Instance] = {}
        self.cameras: dict[str, Any] = {}
        self.lights: dict[str, Any] = {}
        self.templates: dict[str, list] = {}
        self.notes: list[str] = []

    # ---- setup ----

    def build(self) -> None:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        self.scene = bpy.context.scene
        self.scene.render.fps = int(self.fps)
        self.scene.frame_start = 1
        self.scene.frame_end = self.settings["frames"]
        self.collection = self.scene.collection
        self._configure_render()
        self._build_world()
        for obj in self.spec["objects"]:
            if obj.get("visible", True):
                self._build_instance(obj)
        if not self.instances:
            raise RuntimeError("the scene has no visible objects to render")
        self._ground_shadows()
        self._build_lights()
        self._build_cameras()
        bpy.context.view_layer.update()

    def _configure_render(self) -> None:
        scene = self.scene
        s = self.settings
        r = scene.render
        r.resolution_x = s["width"]
        r.resolution_y = s["height"]
        r.resolution_percentage = 100
        r.image_settings.file_format = "PNG"
        r.image_settings.color_mode = "RGB"
        r.image_settings.compression = 15
        r.film_transparent = False
        r.use_persistent_data = True
        engine = os.environ.get("KIVO_RENDER_ENGINE", "cycles").lower()
        samples = int(os.environ.get("KIVO_RENDER_SAMPLES", "0")) or QUALITY_SAMPLES[s["quality"]]
        if engine == "eevee":
            r.engine = "BLENDER_EEVEE"
            try:
                scene.eevee.taa_render_samples = max(16, samples)
            except AttributeError:
                pass
            self.engine = "eevee"
        else:
            r.engine = "CYCLES"
            c = scene.cycles
            c.samples = samples
            c.use_adaptive_sampling = True
            c.adaptive_threshold = 0.03 if s["quality"] == "high" else 0.06
            c.use_denoising = True
            c.max_bounces = 6
            c.diffuse_bounces = 2
            c.glossy_bounces = 3
            c.transmission_bounces = 4
            c.transparent_max_bounces = 6
            c.caustics_reflective = False
            c.caustics_refractive = False
            c.device = "GPU" if self._enable_gpu() else "CPU"
            self.engine = f"cycles-{c.device.lower()}"
        threads = int(os.environ.get("KIVO_RENDER_THREADS", "0"))
        if threads > 0:
            r.threads_mode = "FIXED"
            r.threads = threads
        scene.view_settings.exposure = float(self.spec["world"].get("exposure", 0))

    def _enable_gpu(self) -> bool:
        if os.environ.get("KIVO_RENDER_DEVICE", "auto").lower() == "cpu":
            return False
        try:
            prefs = bpy.context.preferences.addons["cycles"].preferences
        except KeyError:
            return False
        for backend in ("OPTIX", "CUDA", "HIP", "ONEAPI", "METAL"):
            try:
                prefs.compute_device_type = backend
                prefs.get_devices()
            except Exception:  # backend not compiled in / no driver
                continue
            gpus = [d for d in prefs.devices if d.type != "CPU"]
            if gpus:
                for d in prefs.devices:
                    d.use = d.type != "CPU"
                return True
        try:
            prefs.compute_device_type = "NONE"
        except Exception:
            pass
        return False

    def _build_world(self) -> None:
        w = self.spec["world"]
        world = bpy.data.worlds.new("KivoWorld")
        self.scene.world = world
        if world.node_tree is None:
            world.use_nodes = True
        tree = world.node_tree
        tree.nodes.clear()
        coord = tree.nodes.new("ShaderNodeTexCoord")
        sep = tree.nodes.new("ShaderNodeSeparateXYZ")
        remap = tree.nodes.new("ShaderNodeMapRange")
        remap.inputs["From Min"].default_value = -1
        remap.inputs["From Max"].default_value = 1
        ramp = tree.nodes.new("ShaderNodeValToRGB")
        background = tree.nodes.new("ShaderNodeBackground")
        out = tree.nodes.new("ShaderNodeOutputWorld")
        elements = ramp.color_ramp.elements
        ground = (*linear_rgb(w["groundColor"]), 1)
        horizon = (*linear_rgb(w["skyHorizon"]), 1)
        top = (*linear_rgb(w["skyTop"]), 1)
        elements[0].position = 0.0
        elements[0].color = ground
        elements[1].position = 1.0
        elements[1].color = top
        e = elements.new(0.495)
        e.color = ground
        e = elements.new(0.505)
        e.color = horizon
        tree.links.new(coord.outputs["Generated"], sep.inputs[0])
        tree.links.new(sep.outputs["Z"], remap.inputs["Value"])
        tree.links.new(remap.outputs[0], ramp.inputs[0])
        tree.links.new(ramp.outputs["Color"], background.inputs["Color"])
        background.inputs["Strength"].default_value = float(w.get("ambient", 1))
        tree.links.new(background.outputs[0], out.inputs["Surface"])

    def _ground_shadows(self) -> None:
        """Without a terrain model, catch shadows on the (invisible) ground so objects do not float.

        This adds no visible geometry: a shadow catcher only darkens the world's ground colour.
        """
        has_terrain = any(self.assets[i.asset_id].get("kind") == "terrain" for i in self.instances.values())
        if has_terrain or not self.engine.startswith("cycles"):
            return
        mesh = bpy.data.meshes.new("kivo_shadow_catcher")
        r = 3000.0
        mesh.from_pydata([(-r, -r, 0), (r, -r, 0), (r, r, 0), (-r, r, 0)], [], [(0, 1, 2, 3)])
        plane = bpy.data.objects.new("kivo_shadow_catcher", mesh)
        self.collection.objects.link(plane)
        plane.is_shadow_catcher = True

    # ---- models ----

    def _asset_path(self, asset_id: str, file_name: str) -> str:
        path = os.path.join(self.assets_dir, asset_id, file_name)
        if not os.path.isfile(path):
            raise RuntimeError(f'model file for "{asset_id}" is missing')
        return path

    def _clips_needed(self, object_id: str) -> list[str]:
        names: list[str] = []
        for track in self.spec["tracks"]:
            if track["type"] == "action" and track["objectId"] == object_id:
                for clip in track["clips"]:
                    if clip["action"] not in names:
                        names.append(clip["action"])
        return names

    def _build_instance(self, obj: dict) -> None:
        asset = self.assets[obj["assetId"]]
        files = self.asset_files[asset["id"]]
        needed = self._clips_needed(obj["id"])
        rigged_file = files.get("rigged")
        use_rig = bool(rigged_file) and bool(needed)

        root = _new_empty(f"inst_{obj['id']}", self.collection)
        norm = _new_empty(f"norm_{obj['id']}", self.collection)
        norm.parent = root

        armature = None
        if use_rig:
            objects, actions = import_glb(self._asset_path(asset["id"], rigged_file))
            armature = next((o for o in objects if o.type == "ARMATURE"), None)
            for a in actions:
                bpy.data.actions.remove(a)
            if armature is not None and armature.animation_data is not None:
                armature.animation_data_clear()
        elif asset["id"] in self.templates and not obj.get("material"):
            objects = self._duplicate(self.templates[asset["id"]])
        else:
            objects, actions = import_glb(self._asset_path(asset["id"], files["model"]))
            for a in actions:
                bpy.data.actions.remove(a)
            for o in objects:
                if o.animation_data is not None:
                    o.animation_data_clear()
            if not obj.get("material"):
                self.templates.setdefault(asset["id"], objects)

        _normalise(objects, armature, asset, norm)
        if obj.get("material"):
            _apply_material(objects, obj["material"])

        instance = Instance(object_id=obj["id"], asset_id=asset["id"], root=root, objects=objects, armature=armature)
        if armature is not None:
            self._load_clips(instance, files.get("clips") or {}, needed)
        elif needed:
            self.notes.append(f'"{obj["id"]}" has no skeleton; its clips ({", ".join(needed)}) were not applied.')
        self.instances[obj["id"]] = instance

    def _duplicate(self, template: list) -> list:
        mapping = {}
        for o in template:
            copy = o.copy()
            self.collection.objects.link(copy)
            mapping[o] = copy
        for o, copy in mapping.items():
            copy.parent = mapping.get(o.parent)
            if o.parent is not None and copy.parent is not None:
                copy.matrix_parent_inverse = o.matrix_parent_inverse.copy()
        return list(mapping.values())

    def _load_clips(self, instance: Instance, clips: dict, needed: list[str]) -> None:
        by_file: dict[str, list[str]] = {}
        for name in needed:
            entry = clips.get(name)
            if entry is None:
                self.notes.append(f'Clip "{name}" was not generated for "{instance.object_id}"; that part plays without it.')
                continue
            by_file.setdefault(entry["file"], []).append(name)
        for file_name, names in by_file.items():
            objects, actions = import_glb(self._asset_path(instance.asset_id, file_name))
            by_slug = {slug(a.name): a for a in actions}
            for name in names:
                wanted = clips[name].get("animation")
                action = by_slug.get(slug(wanted)) if wanted else None
                if action is None and len(actions) == 1:
                    action = actions[0]
                if action is None and wanted:
                    action = next((a for key, a in by_slug.items() if slug(wanted) in key), None)
                if action is None:
                    self.notes.append(f'Clip "{name}" was not found in its file for "{instance.object_id}".')
                    continue
                action.use_fake_user = True
                instance.clips[name] = _compile_action(instance.armature, action)
            remove_objects(objects)

    # ---- lights and cameras ----

    def _build_lights(self) -> None:
        kinds = {"sun": "SUN", "point": "POINT", "spot": "SPOT", "area": "AREA"}
        for light in self.spec["lights"]:
            data = bpy.data.lights.new(light["id"], kinds[light["type"]])
            data.use_shadow = bool(light.get("castShadow", True))
            if light["type"] == "sun":
                data.angle = math.radians(1.5)
            elif light["type"] == "spot":
                data.spot_size = math.radians(float(light.get("spotAngle", 45)))
                data.spot_blend = 0.25
                data.shadow_soft_size = 0.15
            elif light["type"] == "area":
                data.size = 2.0
            else:
                data.shadow_soft_size = 0.15
            obj = bpy.data.objects.new(light["id"], data)
            obj.rotation_mode = "QUATERNION"
            self.collection.objects.link(obj)
            position = to_blender(light["position"])
            obj.location = position
            obj.rotation_quaternion = look_at_quat(position, to_blender(light.get("target", [0, 0, 0])))
            self.lights[light["id"]] = obj

    def _build_cameras(self) -> None:
        for cam in self.spec["cameras"]:
            data = bpy.data.cameras.new(cam["id"])
            data.sensor_fit = "VERTICAL"
            data.clip_start = 0.05
            data.clip_end = 20000
            obj = bpy.data.objects.new(cam["id"], data)
            obj.rotation_mode = "QUATERNION"
            self.collection.objects.link(obj)
            self.cameras[cam["id"]] = obj

    # ---- per-frame state ----

    def apply(self, t: float) -> None:
        """Put the whole scene in its state at time t (seconds)."""
        for object_id, inst in self.instances.items():
            s = self.sampler.sample_object(object_id, t)
            inst.root.location = to_blender(s["position"])
            q = rotation_to_blender(s["rotation"])
            if inst.last_quat is not None and q.dot(inst.last_quat) < 0:
                q.negate()
            inst.last_quat = q.copy()
            inst.root.rotation_quaternion = q
            inst.root.scale = (s["scale"],) * 3
            if inst.armature is not None:
                clip = active_clip(self.spec, object_id, t)
                if clip is not None and clip["action"] in inst.clips:
                    _apply_pose(inst, clip["action"], clip["time"], clip["loop"], self.fps)
                else:
                    held = self._held_clip(object_id, t)
                    if held is not None:
                        _apply_pose(inst, held[0], held[1], False, self.fps)
                    else:
                        _rest_pose(inst)
        for light_id, obj in self.lights.items():
            s = self.sampler.sample_light(light_id, t)
            obj.data.energy = float(s["intensity"])
            obj.data.color = tuple(srgb_to_linear(c) for c in s["color"])
        for camera_id, obj in self.cameras.items():
            s = self.sampler.sample_camera(camera_id, t)
            position = to_blender(s["position"])
            obj.location = position
            obj.rotation_quaternion = look_at_quat(position, to_blender(s["target"]))
            obj.data.angle_y = math.radians(float(s["fov"]))

    def _held_clip(self, object_id: str, t: float) -> tuple[str, float] | None:
        """Between clips a character holds the last pose of the clip that just ended."""
        best = None
        for track in self.spec["tracks"]:
            if track["type"] != "action" or track["objectId"] != object_id:
                continue
            for c in track["clips"]:
                if c["end"] <= t and (best is None or c["end"] > best["end"]):
                    best = c
        if best is None or best["action"] not in self.instances[object_id].clips:
            return None
        return best["action"], (best["end"] - best["start"]) * best.get("speed", 1)

    def meter_exposure(self, work_dir: str) -> float:
        """Auto-exposure, like a camera's light meter.

        Lighting written for a mood ("twilight", "night") can land far too dark or
        blown out once path-traced. A few small probe frames are rendered through the
        real shot cameras and the exposure is set so the picture reaches a sensible
        average brightness for the scene's time of day. The scene's own exposure value
        still applies on top as the user's compensation.
        """
        scene = self.scene
        r = scene.render
        saved = (r.resolution_percentage, getattr(scene.cycles, "samples", None))
        r.resolution_percentage = max(10, min(100, round(100 * 200 / max(1, r.resolution_y))))
        if self.engine.startswith("cycles"):
            scene.cycles.samples = 8
        duration = self.settings["duration"]
        times = [duration * f for f in (0.3, 0.55, 0.8)]
        user = float(self.spec["world"].get("exposure", 0))
        target = exposure_target(float(self.spec["world"].get("ambient", 1)))
        exposure = 0.0
        probe = os.path.join(work_dir, "exposure_probe.png")
        try:
            for _ in range(3):
                scene.view_settings.exposure = exposure
                levels = []
                for t in times:
                    self.apply(t)
                    shot = self.sampler.shot_at(t)
                    self.set_camera(shot["cameraId"])
                    self.render_still(probe)
                    levels.append(image_luminance(probe))
                measured = max(1e-4, sum(levels) / len(levels))
                if abs(measured - target) < 0.03:
                    break
                # Brightness is roughly gamma-encoded, so compare in linear light; damp to avoid overshooting the tone curve.
                stops = math.log2(srgb_to_linear(target) / max(1e-5, srgb_to_linear(measured)))
                exposure = max(-3.0, min(6.0, exposure + 0.8 * stops))
        finally:
            r.resolution_percentage = saved[0]
            if saved[1] is not None:
                scene.cycles.samples = saved[1]
            if os.path.exists(probe):
                os.remove(probe)
        final = max(-4.0, min(8.0, exposure + user))
        scene.view_settings.exposure = final
        return final

    def set_camera(self, camera_id: str) -> None:
        self.scene.camera = self.cameras[camera_id]

    def render_still(self, path: str) -> None:
        bpy.context.view_layer.update()
        self.scene.render.filepath = path
        bpy.ops.render.render(write_still=True)
        if not os.path.isfile(path) or os.path.getsize(path) == 0:
            raise RuntimeError("Blender did not write the frame")


def image_luminance(path: str) -> float:
    """Mean display luminance (0..1) of a rendered image."""
    img = bpy.data.images.load(path)
    try:
        n = img.size[0] * img.size[1] * img.channels
        px = np.empty(n, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(-1, img.channels)
        return float((0.2126 * px[:, 0] + 0.7152 * px[:, 1] + 0.0722 * px[:, 2]).mean())
    finally:
        bpy.data.images.remove(img)


def exposure_target(ambient: float) -> float:
    """How bright the picture should be on average, by time of day (the scene's sky light)."""
    if ambient < 0.2:
        return 0.20  # night: dark, but readable
    if ambient < 0.7:
        return 0.30  # dusk / interiors
    return 0.38  # daylight


def blend_frames(path_a: str, path_b: str, mix: float, out_path: str) -> None:
    """Cross-dissolve two rendered frames."""
    a = bpy.data.images.load(path_a)
    b = bpy.data.images.load(path_b)
    try:
        n = a.size[0] * a.size[1] * a.channels
        pa = np.empty(n, dtype=np.float32)
        pb = np.empty(n, dtype=np.float32)
        a.pixels.foreach_get(pa)
        b.pixels.foreach_get(pb)
        a.pixels.foreach_set(pa * (1 - mix) + pb * mix)
        a.filepath_raw = out_path
        a.file_format = "PNG"
        a.save()
    finally:
        bpy.data.images.remove(a)
        bpy.data.images.remove(b)


def fade_frame(path: str, level: float) -> None:
    """Dip a rendered frame toward black (level 1 = untouched, 0 = black)."""
    img = bpy.data.images.load(path)
    try:
        n = img.size[0] * img.size[1] * img.channels
        px = np.empty(n, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape(-1, img.channels)
        px[:, :3] *= level
        img.pixels.foreach_set(px.ravel())
        img.filepath_raw = path
        img.file_format = "PNG"
        img.save()
    finally:
        bpy.data.images.remove(img)
