"""Loopback-bound app server for the live connectome-driven fly scene.

Serves web/ as static files and a small JSON API that spawns/reaps one OS
process per fly (see fly_worker.py for why processes, not threads/asyncio
tasks). Modeled on experiments/fly-wirehead/flywirehead/server.py's
stdlib-only, local-origin-checked HTTP server — no extra dependencies.

It only ever listens on 127.0.0.1. The public demo reaches it through a
Cloudflare Tunnel, under --base-path, from the hostnames and origins named
with --public-host/--public-origin (see deploy/).
"""

import argparse
import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
WEB_DIR = ROOT / "web"
WORKER = Path(__file__).resolve().parent / "fly_worker.py"
MAX_FLIES = 4
STALE_AFTER_S = 8.0  # a worker that hasn't written latest.json in this long is presumed dead
# Also under web/, but not the page's to serve: server code, tests, and the
# BlenderKit source .blend (Royalty Free, kept local per THIRD_PARTY.md).
PRIVATE_DIRS = (Path("server"), Path("tests"), Path("assets/blenderkit-housefly"))
PRIVATE_SUFFIXES = {".py", ".pyc", ".sh", ".blend"}

# Parallelism here is across fly processes (one brain each), not within one.
# Without this, numpy's BLAS backend defaults to spawning a thread per core
# in EVERY process — measured 35 threads/process on this 16-core machine, so
# 4 flies meant 140 threads fighting over 16 cores and each tick got ~4x
# slower than running one fly alone, not faster. One thread per process lets
# the OS scheduler actually run flies in parallel instead of thrashing.
SINGLE_THREAD_ENV = {
    "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1",
    "NUMEXPR_NUM_THREADS": "1", "VECLIB_MAXIMUM_THREADS": "1",
}


class FlySwarm:
    """Owns the spawn/despawn lifecycle of every live fly-worker process."""

    def __init__(self, run_dir, max_flies=MAX_FLIES, idle_stop_s=None):
        self.run_dir = run_dir
        self.run_dir.mkdir(parents=True, exist_ok=True)
        self.max_flies = max_flies
        self.idle_stop_s = idle_stop_s
        self.lock = threading.Lock()
        self.flies = {}  # id -> {"process": Popen, "out_dir": Path, "seed": int, "spawned_at": float}
        self._next_seed = 0
        self.last_seen = time.time()  # when a page last spawned or polled flies

    def spawn(self):
        with self.lock:
            self._reap_locked()
            if len(self.flies) >= self.max_flies:
                raise RuntimeError(f"At most {self.max_flies} flies at once")
            fly_id = secrets.token_hex(4)
            out_dir = self.run_dir / fly_id
            seed = self._next_seed
            self._next_seed += 1
            process = subprocess.Popen(
                [sys.executable, str(WORKER), "--id", fly_id, "--out", str(out_dir), "--seed", str(seed)],
                cwd=str(ROOT), stdout=None, stderr=None, env={**os.environ, **SINGLE_THREAD_ENV},
            )
            self.flies[fly_id] = {"process": process, "out_dir": out_dir, "seed": seed, "spawned_at": time.time()}
            self.last_seen = time.time()
            return fly_id

    def despawn(self, fly_id):
        with self.lock:
            entry = self.flies.pop(fly_id, None)
        if entry is None:
            raise KeyError(fly_id)
        entry["process"].terminate()
        try:
            entry["process"].wait(timeout=3)
        except subprocess.TimeoutExpired:
            entry["process"].kill()

    def _reap_locked(self):
        """Drop entries whose process died without us despawning it."""
        dead = [fid for fid, e in self.flies.items() if e["process"].poll() is not None]
        for fid in dead:
            del self.flies[fid]

    def snapshot(self):
        with self.lock:
            self._reap_locked()
            self.last_seen = time.time()
            entries = dict(self.flies)
        out = {}
        for fly_id, entry in entries.items():
            latest = entry["out_dir"] / "latest.json"
            try:
                data = json.loads(latest.read_text())
            except (FileNotFoundError, json.JSONDecodeError):
                data = {"id": fly_id, "status": "loading", "message": "waking the connectome…"}
            data["seed"] = entry["seed"]
            data["age_s"] = round(time.time() - entry["spawned_at"], 1)
            out[fly_id] = data
        return out

    def activity(self, fly_id):
        with self.lock:
            entry = self.flies.get(fly_id)
            if entry is None:
                raise KeyError(fly_id)
            path = entry["out_dir"] / "activity.bin"
        return path.read_bytes()

    def stop_if_unwatched(self):
        """Stop every fly once no page has polled for idle_stop_s. On a public
        server, a closed tab would otherwise leave its brains running for good."""
        with self.lock:
            unwatched = (self.idle_stop_s is not None and bool(self.flies)
                         and time.time() - self.last_seen > self.idle_stop_s)
        if unwatched:
            self.shutdown()
        return unwatched

    def shutdown(self):
        with self.lock:
            entries = list(self.flies.values())
            self.flies.clear()
        for entry in entries:
            entry["process"].terminate()
        for entry in entries:
            try:
                entry["process"].wait(timeout=3)
            except subprocess.TimeoutExpired:
                entry["process"].kill()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, swarm, token, base_path="", public_hosts=(), public_origins=(), **kwargs):
        self.swarm, self.token, self.base_path = swarm, token, base_path
        self.public_hosts, self.public_origins = set(public_hosts), set(public_origins)
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        super().end_headers()

    def allowed_request(self):
        port = self.server.server_port
        local = {f"127.0.0.1:{port}", f"localhost:{port}"}
        origins = {f"http://{h}" for h in local} | {f"https://{h}" for h in self.public_hosts} | self.public_origins
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in (local | self.public_hosts) and (origin is None or origin in origins) and self.headers.get("Sec-Fetch-Site") != "cross-site"

    def app_path(self):
        """The request path below base_path, or None when it's outside it."""
        path = urlsplit(self.path).path
        if not self.base_path:
            return path
        if path == self.base_path or path.startswith(self.base_path + "/"):
            return path[len(self.base_path):]
        return None

    def translate_path(self, path):
        # Only called for paths app_path() has already placed under base_path.
        return super().translate_path(urlsplit(path).path.removeprefix(self.base_path))

    def private_file(self):
        relative = Path(self.translate_path(self.path)).relative_to(WEB_DIR)
        return relative.suffix in PRIVATE_SUFFIXES or any(relative.is_relative_to(d) for d in PRIVATE_DIRS)

    def list_directory(self, path):
        self.send_error(404)  # the page names every file it needs; don't enumerate web/
        return None

    def respond(self, code, data):
        body = json.dumps(data, allow_nan=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.allowed_request():
            return self.respond(403, {"error": "Request origin not allowed"})
        path = self.app_path()
        if path is None:
            return self.respond(404, {"error": "Not found"})
        if path == "":
            self.send_response(301)
            self.send_header("Location", self.base_path + "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/api/session":
            return self.respond(200, {"token": self.token, "max_flies": self.swarm.max_flies})
        if path == "/api/flies":
            return self.respond(200, {"flies": self.swarm.snapshot(), "max_flies": self.swarm.max_flies})
        if path.startswith("/api/flies/") and path.endswith("/activity"):
            fly_id = path.removeprefix("/api/flies/").removesuffix("/activity")
            try:
                body = self.swarm.activity(fly_id)
            except (KeyError, FileNotFoundError):
                return self.respond(404, {"error": "Activity not available"})
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path.startswith("/api/"):
            return self.respond(404, {"error": "Unknown API endpoint"})
        if self.private_file():
            return self.respond(404, {"error": "Not found"})
        return super().do_GET()

    def do_HEAD(self):
        self.send_error(405)

    def _authorized(self):
        return self.allowed_request() and secrets.compare_digest(self.headers.get("X-Fly-Token", ""), self.token)

    def do_POST(self):
        if not self._authorized():
            return self.respond(403, {"error": "Valid session required"})
        path = self.app_path()
        if path == "/api/flies":
            try:
                fly_id = self.swarm.spawn()
            except RuntimeError as error:
                return self.respond(409, {"error": str(error)})
            return self.respond(201, {"id": fly_id})
        return self.respond(404, {"error": "Unknown API endpoint"})

    def do_DELETE(self):
        if not self._authorized():
            return self.respond(403, {"error": "Valid session required"})
        path = self.app_path() or ""
        if path.startswith("/api/flies/"):
            fly_id = path.removeprefix("/api/flies/")
            try:
                self.swarm.despawn(fly_id)
            except KeyError:
                return self.respond(404, {"error": "No such fly"})
            return self.respond(200, {"ok": True})
        return self.respond(404, {"error": "Unknown API endpoint"})


def make_server(port, swarm, token, base_path="", public_hosts=(), public_origins=()):
    handler = partial(Handler, swarm=swarm, token=token, base_path=base_path,
                      public_hosts=public_hosts, public_origins=public_origins)
    return ThreadingHTTPServer(("127.0.0.1", port), handler)


def serve(args):
    run_dir = (ROOT / "runs" / "fly-haven-web").resolve()
    atlas_dir = WEB_DIR / "assets/brain-atlas"
    if not (atlas_dir / "atlas.json").exists():
        subprocess.run([sys.executable, str(WEB_DIR / "tools/export_brain_atlas.py")], cwd=str(ROOT), check=True)
    swarm = FlySwarm(run_dir, max_flies=args.max_flies, idle_stop_s=args.idle_stop)
    token = secrets.token_urlsafe(24)
    server = make_server(args.port, swarm, token, args.base_path, args.public_host, args.public_origin)
    url = f"http://127.0.0.1:{server.server_port}{args.base_path}/"
    print(f"Fly Haven: {url}\nCtrl-C stops every fly and exits.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)

    if args.idle_stop is not None:
        def stop_unwatched():
            while True:
                time.sleep(5)
                if swarm.stop_if_unwatched():
                    print(f"No page polled for {args.idle_stop:g}s: stopped every fly.", flush=True)

        threading.Thread(target=stop_unwatched, daemon=True).start()

    def _stop(*_):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, _stop)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("Stopping every fly…", flush=True)
    finally:
        server.server_close()
        swarm.shutdown()


def base_path(value):
    value = value.strip("/")
    return f"/{value}" if value else ""


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--port", type=int, default=8934)
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--max-flies", type=int, default=MAX_FLIES, help="brain processes at once; each takes a core and ~0.35 GB (~0.9 GB while loading)")
    p.add_argument("--base-path", type=base_path, default="", help="serve under this URL path, e.g. /fly-heaven")
    p.add_argument("--public-host", action="append", default=[], help="also accept this Host header (repeatable)")
    p.add_argument("--public-origin", action="append", default=[], help="also accept this Origin (repeatable)")
    p.add_argument("--idle-stop", type=float, metavar="SECONDS", help="stop every fly once no page has polled for this long")
    serve(p.parse_args())
