#!/usr/bin/env bash
# Builds web/assets/housefly.glb from the BlenderKit "Housefly-Exotic Rigged"
# asset (Joachim Bornemann, BlenderKit base ID 1fd6b0b2-d5e4-457e-ad87-62f5002eef40).
#
# The source .blend is not committed (BlenderKit Royalty Free license — keep
# it as local production material, not project-owned). This script looks for
# it in web/assets/blenderkit-housefly/source.blend, falling back to a copy
# from the local BlenderKit cache if one hasn't been placed there yet.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # -> web/

SRC_DIR="assets/blenderkit-housefly"
SRC="$SRC_DIR/source.blend"
RAW="assets/housefly.raw.glb"
OUT="assets/housefly.glb"

mkdir -p "$SRC_DIR"

if [ ! -f "$SRC" ]; then
    echo "No $SRC yet; looking in the local BlenderKit cache..."
    CACHE_MATCH=$(find "$HOME/.local/share/blenderkit_data/models" \
        -iname "housefly-exotic-rigged_*.blend" 2>/dev/null | head -1 || true)
    if [ -n "$CACHE_MATCH" ]; then
        cp "$CACHE_MATCH" "$SRC"
        echo "Copied from BlenderKit cache: $CACHE_MATCH"
    else
        echo "Could not find the asset. In Blender, download 'Housefly-Exotic" >&2
        echo "Rigged' via the BlenderKit add-on, then copy the cached .blend to" >&2
        echo "$SRC and rerun this script." >&2
        exit 1
    fi
fi

echo "Exporting from Blender..."
PYTHONHOME=/usr PATH=/usr/bin:/bin blender --factory-startup -b \
    --python tools/export_housefly.py -- "$SRC" "$RAW"

echo "Optimizing (resize/compress textures, Draco-compress geometry)..."
# --flatten/--join/--instance/--palette disabled: the scene graph must keep
# its named bone nodes (Wing.L, Leg.Front.L.001, ...) so the browser side
# can drive them individually — collapsing the hierarchy would remove them.
npx --yes @gltf-transform/cli optimize "$RAW" "$OUT" \
    --texture-size 1024 --texture-compress webp --compress draco \
    --flatten false --join false --instance false --palette false \
    --simplify true --simplify-error 0.0005

rm -f "$RAW"
echo "Wrote $OUT"
