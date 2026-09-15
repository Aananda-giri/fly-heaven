#!/usr/bin/env bash
# Deploy the web app (web/server/app.py) to lucy, the demo's always-on fallback box, over SSH.
#
#   scripts/deploy_home_server.sh [ssh-host]      # default: ssh.himalayansiliconvalley.com
#
# Ships only what a live brain and the page need to ~/fly-heaven: the heaven and
# flywirehead code, the page with its built assets, calibration.json, and the
# prepared connectome files a brain reads (~270 MB, sent only when they differ).
# Installs numpy/pandas/pyarrow with uv, compiles the kernel on that CPU, and
# (re)starts a systemd user service serving http://127.0.0.1:8934/fly-heaven/
# on that machine. Re-runnable.
set -euo pipefail

HOST="${1:-ssh.himalayansiliconvalley.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="$ROOT/data/fly-wirehead"
DATA_FILES=(graph.npz annotations.feather normalized/neurons.feather manifest.json)
PACKAGES=(numpy==2.5.3 pandas==3.0.5 pyarrow==25.0.1)  # as locked in uv.lock

for built in web/assets/housefly.glb web/assets/food-pack.glb web/assets/food-pack.json \
             web/assets/brain-atlas/atlas.json runs/fly-heaven/calibration.json; do
  [ -e "$ROOT/$built" ] || { echo "Missing $built: build it first (see web/README.md)." >&2; exit 1; }
done

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE"/{heaven,experiments/fly-wirehead,web/server,web/assets,runs/fly-heaven}
cp "$ROOT"/heaven/{__init__,behaviour,brain,world}.py "$STAGE/heaven/"
cp -R "$ROOT"/experiments/fly-wirehead/{flywirehead,licenses,THIRD_PARTY.md} "$STAGE/experiments/fly-wirehead/"
cp "$ROOT"/web/{index.html,*.js,food-layout.json,THIRD_PARTY.md} "$STAGE/web/"
cp -R "$ROOT/web/vendor" "$STAGE/web/"
cp "$ROOT"/web/server/{app.py,fly_worker.py,food_world.py} "$STAGE/web/server/"
cp -R "$ROOT"/web/assets/{housefly.glb,food-pack.glb,food-pack.json,brain-atlas} "$STAGE/web/assets/"
cp "$ROOT/runs/fly-heaven/calibration.json" "$STAGE/runs/fly-heaven/"
cp "$ROOT/deploy/fly-heaven.service" "$STAGE/"
find "$STAGE" -name __pycache__ -prune -exec rm -rf {} +

echo "Uploading code and page to $HOST:~/fly-heaven ..."
# Code and page are replaced wholesale so files deleted here don't linger there.
tar -C "$STAGE" -czf - . | ssh "$HOST" 'mkdir -p ~/fly-heaven && cd ~/fly-heaven && rm -rf heaven experiments web && tar -xzf -'

if (cd "$DATA_DIR" && sha256sum "${DATA_FILES[@]}") | ssh "$HOST" 'cd ~/fly-heaven/data/fly-wirehead && sha256sum --quiet -c -' >/dev/null 2>&1; then
  echo "Connectome data already up to date."
else
  echo "Uploading connectome data (~270 MB) ..."
  # -h: data/fly-wirehead and its files are often links into another checkout's prepared copy.
  tar -C "$DATA_DIR/" -chf - "${DATA_FILES[@]}" \
    | ssh "$HOST" "mkdir -p ~/fly-heaven/data/fly-wirehead && cd ~/fly-heaven/data/fly-wirehead && rm -f ${DATA_FILES[*]} && tar -xf -"
fi

ssh "$HOST" bash -s -- "${PACKAGES[@]}" <<'REMOTE'
set -euo pipefail
cd ~/fly-heaven
UV="$HOME/.local/bin/uv"
[ -x .venv/bin/python ] || "$UV" venv --python 3.12 .venv
"$UV" pip install --python .venv/bin/python "$@"
# Compile the connectome kernel for this CPU now, not inside the first visitor's fly.
.venv/bin/python -c 'from heaven.brain import _load_wirehead; _load_wirehead()'
install -Dm644 fly-heaven.service ~/.config/systemd/user/fly-heaven.service
systemctl --user daemon-reload
systemctl --user enable fly-heaven.service
systemctl --user restart fly-heaven.service
echo "Service restarted; follow startup with: journalctl --user -u fly-heaven -f"
REMOTE
