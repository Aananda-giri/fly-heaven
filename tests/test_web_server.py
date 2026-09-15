"""The app server's public-demo settings: base path, allowed hosts, private files, unwatched flies."""
import http.client
import json
import subprocess
import sys
import threading
import time

import pytest

from web.server.app import FlySwarm, make_server


class FakeSwarm:
    max_flies = 1

    def snapshot(self):
        return {}

    def spawn(self):
        return "f1"


@pytest.fixture
def public_server():
    server = make_server(0, FakeSwarm(), "token", base_path="/fly-heaven",
                         public_hosts=["backend.example"], public_origins=["https://demo.example"])
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield server
    server.shutdown()
    server.server_close()


def request(server, method, path, host="backend.example", **headers):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    connection.request(method, path, headers={"Host": host, **headers})
    response = connection.getresponse()
    body = response.read()
    connection.close()
    return response, body


def test_the_page_and_api_live_under_the_base_path(public_server):
    response, _ = request(public_server, "GET", "/fly-heaven")
    assert response.status == 301 and response.getheader("Location") == "/fly-heaven/"
    response, body = request(public_server, "GET", "/fly-heaven/")
    assert response.status == 200 and b"<title>Fly Haven</title>" in body
    response, body = request(public_server, "GET", "/fly-heaven/api/session")
    assert response.status == 200 and json.loads(body) == {"token": "token", "max_flies": 1}
    for outside in ("/", "/api/session", "/fly-heavenly/index.html"):
        assert request(public_server, "GET", outside)[0].status == 404


def test_only_listed_hosts_and_origins_reach_the_api(public_server):
    token = {"X-Fly-Token": "token"}
    assert request(public_server, "GET", "/fly-heaven/api/flies", host="elsewhere.example")[0].status == 403
    assert request(public_server, "POST", "/fly-heaven/api/flies", Origin="https://elsewhere.example", **token)[0].status == 403
    assert request(public_server, "POST", "/fly-heaven/api/flies", Origin="https://demo.example")[0].status == 403
    for origin in ("https://demo.example", "https://backend.example"):
        response, body = request(public_server, "POST", "/fly-heaven/api/flies", Origin=origin, **token)
        assert response.status == 201 and json.loads(body) == {"id": "f1"}


@pytest.mark.parametrize("path", [
    "/fly-heaven/server/app.py",
    "/fly-heaven/%73erver/app.py",
    "/fly-heaven/vendor/../server/food_world.py",
    "/fly-heaven/tools/export_brain_atlas.py",
    "/fly-heaven/assets/blenderkit-housefly/source.blend",
    "/fly-heaven/vendor/",
])
def test_server_code_source_assets_and_listings_are_not_served(public_server, path):
    assert request(public_server, "GET", path)[0].status == 404


def test_page_files_are_served(public_server):
    for path in ("/fly-heaven/main.js", "/fly-heaven/vendor/OrbitControls.js", "/fly-heaven/tools/pose-preview.html"):
        assert request(public_server, "GET", path)[0].status == 200


def test_flies_stop_once_no_page_polls_for_them(tmp_path):
    swarm = FlySwarm(tmp_path, max_flies=1, idle_stop_s=60)
    process = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    try:
        swarm.flies["f1"] = {"process": process, "out_dir": tmp_path / "f1", "seed": 0, "spawned_at": time.time()}
        with pytest.raises(RuntimeError):
            swarm.spawn()
        swarm.snapshot()
        assert not swarm.stop_if_unwatched() and process.poll() is None
        swarm.last_seen -= 61
        assert swarm.stop_if_unwatched()
        assert process.wait(timeout=5) is not None and swarm.flies == {}
    finally:
        process.kill()
