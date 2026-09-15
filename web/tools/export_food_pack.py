"""Blender: export six food variants from the user's local low-poly pack.

blender -b --factory-startup --python web/tools/export_food_pack.py -- SOURCE.blend OUTPUT.glb
Source meshes and textures are preserved. Source layout is baked away, each
variant centered with its bottom at ground level and longest dimension 1.
"""
import json
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Matrix, Vector

args = sys.argv[sys.argv.index('--') + 1:]
source, output = args[:2]
bpy.ops.wm.open_mainfile(filepath=source)
bpy.context.view_layer.update()
variants = {
    'apple_red': ('Component#12', False),
    'apple_green': ('Component#20', False),
    'banana': ('Component#29', True),
    'orange': ('Orange#1', False),
    'melon_slice': ('Component#46', False),
    'mango': ('Component#44', True),
}
new_objects = []
metadata = {}
used_materials = set()
for name, (source_name, lay_down) in variants.items():
    src = bpy.data.objects.get(source_name)
    if src is None:
        raise ValueError(f'Missing food object: {source_name}')
    mesh = src.data.copy()
    mesh.transform(src.matrix_world)
    if lay_down:
        # Remove the individual fruit's source-layout tilt. The longest
        # principal axis lies along the floor, with its thinnest axis up.
        vertices = np.array([tuple(v.co) for v in mesh.vertices])
        _, axes = np.linalg.eigh(np.cov(vertices.T))
        rows = np.array([axes[:, 1], axes[:, 2], axes[:, 0]])
        if np.linalg.det(rows) < 0:
            rows[2] *= -1
        mesh.transform(Matrix(rows.tolist()).to_4x4())
    points = [v.co for v in mesh.vertices]
    low = Vector(tuple(min(p[i] for p in points) for i in range(3)))
    high = Vector(tuple(max(p[i] for p in points) for i in range(3)))
    center = (low + high) / 2
    center.z = low.z
    factor = 1 / max(high - low)
    for vertex in mesh.vertices:
        vertex.co = (vertex.co - center) * factor
    metadata[name] = {
        'radius': max((v.co.x * v.co.x + v.co.y * v.co.y) ** 0.5 for v in mesh.vertices),
        'height': max(v.co.z for v in mesh.vertices),
    }
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    new_objects.append(obj)
    used_materials.update(m for m in mesh.materials if m)
# Bound browser texture sizes, operating only in memory, never saving source.
used_images = {node.image for mat in used_materials if mat.use_nodes for node in mat.node_tree.nodes if node.type == 'TEX_IMAGE' and node.image}
for image in used_images:
    w, h = image.size
    if max(w, h) > 1024:
        image.scale(max(1, round(w * 1024 / max(w, h))), max(1, round(h * 1024 / max(w, h))))
bpy.ops.object.select_all(action='DESELECT')
for obj in new_objects:
    obj.select_set(True)
Path(output).parent.mkdir(parents=True, exist_ok=True)
bpy.ops.export_scene.gltf(filepath=output, export_format='GLB', use_selection=True, export_yup=True, export_animations=False, export_materials='EXPORT')
Path(output).with_suffix('.json').write_text(json.dumps(metadata, indent=2))
print('Exported food variants:', ', '.join(variants))
