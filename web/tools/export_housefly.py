"""Blender headless script: export the rigged housefly to glTF.

Run via:
    blender --factory-startup -b --python export_housefly.py -- <source.blend> <out.glb>

Exports the whole scene (mesh + armature, no baked animation — the source
file only carries a pose library). Node names are preserved so the browser
side can drive individual bones (Wing.L, Leg.Front.L.001, ...) by name.
"""
import sys
import bpy

argv = sys.argv[sys.argv.index("--") + 1:]
src_path, out_path = argv[0], argv[1]

bpy.ops.wm.open_mainfile(filepath=src_path)

bpy.ops.export_scene.gltf(
    filepath=out_path,
    export_format="GLB",
    use_selection=False,
    export_yup=True,
    export_apply=False,
    export_animations=True,
    export_skins=True,
    export_materials="EXPORT",
    export_texcoords=True,
    export_normals=True,
    export_image_format="AUTO",
)
print(f"Exported {out_path}")
