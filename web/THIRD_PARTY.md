# Third-party material

**Three.js 0.180.0** (`vendor/three.module.js`, `vendor/three.core.min.js`,
`vendor/loaders/`, `vendor/utils/`, `vendor/OrbitControls.js`) — MIT, see
`vendor/THREE-LICENSE.txt`.

**Draco 1.5** decoder (`vendor/draco_*`) — Apache License 2.0, see
`vendor/DRACO-LICENSE.txt`. Used only to decompress the housefly mesh at
load time.

**Housefly-Exotic Rigged** by Joachim Bornemann (BlenderKit base ID
`1fd6b0b2-d5e4-457e-ad87-62f5002eef40`) — BlenderKit Royalty Free license.
The source `.blend` is not committed; see `assets/blenderkit-housefly/README.md`
and `tools/build_housefly.sh`. `assets/housefly.glb`, built from it, is also
not committed — run the build script to produce it locally.

**MaleCNS v1.0 soma atlas** — real soma coordinates and neuron annotations
from the FlyEM/Janelia, Cambridge/MRC LMB and Google Research collaboration,
[MaleCNS downloads](https://male-cns.janelia.org/download/), CC-BY. Exported
atlas files are generated locally from the already-prepared dataset.

**A Complete Food Pack -and Fruits** — user-supplied local Blender source,
`~/Downloads/heaven/foods-and-fruits-pack-low-poly (2)/source/A Complete Food Pack -and Fruits.blend`.
`tools/build_food_pack.sh` extracts six local production variants. The source
and generated `assets/food-pack.glb`/`.json` are not committed.

Ground, grass, rocks, twigs, leaves, sky, and all rig animation are generated
in code.
