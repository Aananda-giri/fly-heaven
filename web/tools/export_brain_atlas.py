"""Export real MaleCNS soma anatomy in the live kernel's exact neuron order."""
import argparse
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pyarrow.feather as feather

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from heaven.brain import P1_BODY_IDS

REGIONS = [
    {"name": "Visual system", "color": "#55c8f5", "classes": ["ol_intrinsic", "ol_sensory", "visual_projection", "visual_projection_tbc", "visual_centrifugal"]},
    {"name": "Central brain", "color": "#a78bfa", "classes": ["cb_intrinsic", "cb_endocrine", "cb_efferent"]},
    {"name": "Sensory neurons", "color": "#6ee7b7", "classes": ["cb_sensory", "cb_sensory_tbc", "vnc_sensory", "vnc_sensory_tbc", "sensory_ascending", "sensory_ascending_tbc", "sensory_descending"]},
    {"name": "Descending neurons", "color": "#ff8eaf", "classes": ["descending_neuron", "descending_neuron_tbc"]},
    {"name": "Nerve cord", "color": "#f6c977", "classes": ["vnc_intrinsic", "vnc_tbc", "ascending_neuron", "vnc_endocrine"]},
    {"name": "Motor neurons", "color": "#e0e8ff", "classes": ["vnc_motor", "cb_motor"]},
    {"name": "Other neurons", "color": "#8eafa7", "classes": ["vnc_efferent", "efferent_ascending", "efferent_descending", "ENS"]},
]


def export_atlas(data, out):
    ids = np.load(data / "graph.npz")["ids"]
    annotations = feather.read_table(data / "annotations.feather").to_pandas().set_index("bodyId").loc[ids]
    types = annotations.type.fillna("")
    side = annotations.somaSide.fillna("")
    classes = annotations.superclass.fillna("")
    regions = np.full(len(ids), len(REGIONS) - 1, dtype=np.uint8)
    for i, region in enumerate(REGIONS):
        regions[classes.isin(region["classes"]).to_numpy()] = i
    points = np.full((len(ids), 3), np.nan, dtype='<f4')
    for i, location in enumerate(annotations.somaLocation):
        if location is not None and len(location) == 3:
            points[i] = location
    visible = np.flatnonzero(np.isfinite(points).all(axis=1)).astype('<u4')
    positions = points[visible]
    # The brain and cord are spatially separated in the source volume.
    # Preserve the specimen's coordinates; use the empty neck gap to crop.
    brain_cutoff = 55000
    masks = {
        "PAM11": types.eq("PAM11"), "P1": np.isin(ids, P1_BODY_IDS),
        "MN9": types.eq("MN9"), "DNg12": types.str.startswith("DNg12"),
        "GF": types.eq("DNp01"), "pIP10": types.eq("pIP10"),
        "vPR6": types.eq("vPR6"), "MDN": types.eq("MDN"),
        "DNa02_L": types.eq("DNa02") & side.eq("L"),
        "DNa02_R": types.eq("DNa02") & side.eq("R"),
        "motor": classes.eq("vnc_motor"),
    }
    out.mkdir(parents=True, exist_ok=True)
    positions.tofile(out / "positions.f32")
    visible.tofile(out / "indices.u32")
    regions.tofile(out / "regions.u8")
    manifest = {
        "dataset": "MaleCNS v1.0", "neurons": int(len(ids)), "visible": int(len(visible)),
        "brainVisible": int((positions[:, 2] < brain_cutoff).sum()),
        "missing": int(len(ids) - len(visible)), "brainCutoff": brain_cutoff,
        "idOrderSha256": hashlib.sha256(ids.astype('<u8').tobytes()).hexdigest(),
        "source": "https://male-cns.janelia.org/download/", "license": "CC-BY",
        "regions": [{**r, "count": int((regions == i).sum())} for i, r in enumerate(REGIONS)],
        "circuits": {k: np.flatnonzero(np.asarray(mask)).tolist() for k, mask in masks.items()},
        "description": "Real annotated soma positions. Region colors group source superclasses; they are not neuropil segmentations. Activity is simulated spike counts, not functional imaging.",
    }
    (out / "atlas.json").write_text(json.dumps(manifest, separators=(',', ':')))
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, default=ROOT / 'data/fly-wirehead')
    parser.add_argument('--out', type=Path, default=ROOT / 'web/assets/brain-atlas')
    args = parser.parse_args()
    atlas = export_atlas(args.data, args.out)
    print(f"Exported {atlas['visible']:,}/{atlas['neurons']:,} real soma positions")
