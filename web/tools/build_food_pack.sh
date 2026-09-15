#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
food_source="${1:-$HOME/Downloads/heaven/foods-and-fruits-pack-low-poly (2)/source/A Complete Food Pack -and Fruits.blend}"
if [[ ! -f "$food_source" ]]; then
  echo "Food pack not found. Pass its source .blend path as the first argument." >&2
  exit 1
fi
PYTHONHOME=/usr PATH=/usr/bin:/bin blender --factory-startup -b --python tools/export_food_pack.py -- "$food_source" "$PWD/assets/food-pack.glb"
