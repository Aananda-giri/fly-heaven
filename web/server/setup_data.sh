#!/usr/bin/env bash
# Links the prepared MaleCNS graph and calibration this server needs, from
# wherever they've already been prepared on this machine, instead of
# redownloading/recalibrating (~1.1GB, checksum-verified either way — see
# the top-level README's "Both use the same three MaleCNS source files").
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."   # -> repo root

if [ -e data/fly-wirehead/graph.npz ]; then
    echo "data/fly-wirehead already prepared."
else
    match=$(find "$HOME" -maxdepth 4 -path "*/data/fly-wirehead/graph.npz" 2>/dev/null | head -1 || true)
    if [ -n "$match" ]; then
        mkdir -p data
        ln -sf "$(dirname "$match")" data/fly-wirehead
        echo "Linked data/fly-wirehead -> $(dirname "$match")"
    else
        echo "No prepared MaleCNS graph found on this machine." >&2
        echo "Run fly-heaven.ipynb sections 0 and 2.1 first (see the top-level README)." >&2
        exit 1
    fi
fi

if [ -e runs/fly-heaven/calibration.json ]; then
    echo "runs/fly-heaven/calibration.json already present."
else
    match=$(find "$HOME" -maxdepth 4 -path "*/runs/fly-heaven/calibration.json" 2>/dev/null | head -1 || true)
    if [ -n "$match" ]; then
        mkdir -p runs/fly-heaven
        cp "$match" runs/fly-heaven/calibration.json
        echo "Copied calibration.json from $match"
    else
        echo "No calibration.json found; running heaven.calibrate (takes a few minutes)…"
        uv run python -m heaven.calibrate
    fi
fi
