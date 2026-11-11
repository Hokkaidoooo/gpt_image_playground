"""本机HTTP验证：测试数据留在独立临时目录，供应商只监听回环地址。"""

from __future__ import annotations

import base64
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib import parse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from PIL import Image
import gui_server as gui
import image_client as client

TEST_KEY = "test-only-public-test-key"


def png_bytes() -> bytes:
    stream = BytesIO()
    Image.new("RGB", (4, 3), "navy").save(stream, format="PNG")
    return stream.getvalue()


def http(server, path="/", *, method="GET", body=None, headers=None):
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()


@contextmanager
def running(server):
    thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
    thread.start()
    try:
        yield server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
        if thread.is_alive():
            raise AssertionError("测试服务未停止")


class UpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        return

    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.server.requests.append((self.path, dict(self.headers), body))
        if self.path == "/failure":
            response = json.dumps({"error": {"message": "invalid: " + TEST_KEY}}).encode()
            status = 400
        else:
            response = json.dumps({"data": [{"b64_json": base64.b64encode(png_bytes()).decode()}]}).encode()
            status = 200
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)


class LocalServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".test-tmp-", dir=ROOT)
        self.addCleanup(self.temporary.cleanup)
        self.temp = Path(self.temporary.name)
        self.dist = self.temp / "dist"
        self.dist.mkdir()
        (self.dist / "index.html").write_text('<!doctype html><title>Local image test</title><script src="/local-config.js"></script>', encoding="utf-8")
        self.output = self.temp / "data"
        self.server = gui.ImageGuiServer(gui.GuiSettings(port=0), dist_dir=self.dist, output_dir=self.output)
        self.context = running(self.server)
        self.context.__enter__()
        self.addCleanup(self.context.__exit__, None, None, None)

    def auth_headers(self):
        return {"Origin": self.server.origin, "Authorization": f"Bearer {self.server.token}", "Content-Type": "application/json"}

    def test_fresh_start_page_health_and_empty_bootstrap(self):
        self.assertEqual(http(self.server)[0], 200)
        status, _, raw = http(self.server, "/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw), {"service": gui.SERVICE_NAME, "version": 2})
        status, _, raw = http(self.server, "/local-config.js")
        bootstrap = json.loads(raw.decode().removeprefix("window.__LOCAL_IMAGE_BOOTSTRAP__ = ").strip().removesuffix(";"))
        preset = json.loads(base64.b64decode(bootstrap["preset"].removeprefix("embedded-config:")))
        self.assertEqual(status, 200)
        self.assertEqual(preset["profiles"], [])
        self.assertNotIn("configurationError", bootstrap)
        self.assertEqual(bootstrap["managedBaseUrl"], "")
        self.assertFalse((self.output / "settings.json").exists())

    def test_missing_default_config_uses_defaults_and_explicit_missing_file_fails(self):
        with patch.object(gui, "GUI_SETTINGS_PATH", self.temp / "missing.json"):
            self.assertEqual(gui.load_gui_settings(), gui.GuiSettings())
            with self.assertRaises(FileNotFoundError):
                gui.load_gui_settings(self.temp / "explicit-missing.json")
        config = self.temp / "custom.json"
        config.write_text('{"port": 17866, "save_generated_images": false}', encoding="utf-8")
        self.assertEqual(gui.load_gui_settings(config, port=17867).port, 17867)
        self.assertFalse(gui.load_gui_settings(config).save_generated_images)

    def test_authentication_and_origin_gate(self):
        for headers in [{}, {**self.auth_headers(), "Origin": "https://untrusted.example.test"}, {**self.auth_headers(), "Authorization": "Bearer wrong"}]:
            with self.subTest(headers=list(headers)):
                self.assertEqual(http(self.server, "/local/save-images", method="POST", body=b"{}", headers=headers)[0], 403)

    def test_proxy_real_loopback_roundtrip_and_error_redaction(self):
        upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        upstream.requests = []
        original = gui.open_http_response

        def local_only(url, *args, **kwargs):
            if parse.urlsplit(url).hostname != "127.0.0.1":
                raise AssertionError("测试禁止外部供应商请求")
            return original(url, *args, **kwargs)

        with running(upstream), patch.object(gui, "open_http_response", side_effect=local_only):
            for path, expected_status in [("/v1/images/generations", 200), ("/failure", 400)]:
                metadata = {"url": f"http://127.0.0.1:{upstream.server_port}{path}", "method": "POST", "headers": [["Authorization", f"Bearer {TEST_KEY}"], ["Content-Type", "application/json"]], "timeoutSeconds": 5}
                headers = {**self.auth_headers(), "X-Local-Request": parse.quote(json.dumps(metadata), safe="")}
                status, _, body = http(self.server, "/local/proxy", method="POST", body=b'{"prompt":"public test","model":"test-image","n":1}', headers=headers)
                self.assertEqual(status, expected_status)
                self.assertNotIn(TEST_KEY.encode(), body)
            self.assertEqual(len(upstream.requests), 2)
            self.assertEqual(upstream.requests[0][1]["Authorization"], f"Bearer {TEST_KEY}")
            self.assertEqual(upstream.requests[0][1]["User-Agent"], gui.BRIDGE_USER_AGENT)
            self.assertNotIn(TEST_KEY, self.server.error_log_path.read_text(encoding="utf-8"))

    def test_verified_image_saved_only_to_output_directory(self):
        encoded = base64.b64encode(png_bytes()).decode()
        payload = {"images": [f"data:image/png;base64,{encoded}"], "endpoint": "https://supplier.example.test/v1", "request": {"prompt": "public test", "model": "test-image", "n": 1}, "taskId": "test-task"}
        status, _, body = http(self.server, "/local/save-images", method="POST", body=json.dumps(payload).encode(), headers=self.auth_headers())
        self.assertEqual(status, 200)
        result = json.loads(body)
        self.assertTrue(result["saved"])
        saved = self.output / result["images"][0]["fileName"]
        self.assertEqual(saved.read_bytes(), png_bytes())
        record = json.loads((self.output / result["record"]).read_text(encoding="utf-8"))
        self.assertEqual(record["request"]["task_id"], "test-task")
        self.assertEqual(http(self.server, "/data/" + saved.name)[0], 404)
        self.assertEqual(http(self.server, "/../data/" + saved.name)[0], 404)

    def test_gif_and_svg_http_save_preserves_animation_and_vector_bytes(self):
        stream = BytesIO()
        frames = [Image.new("RGB", (6, 4), color) for color in ("red", "blue")]
        frames[0].save(stream, format="GIF", save_all=True, append_images=frames[1:], duration=[80, 160], loop=0)
        gif = stream.getvalue()
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 6 4"><rect width="6" height="4" fill="red"/></svg>'
        images = ["data:image/" + kind + ";base64," + base64.b64encode(data).decode() for kind, data in (("gif", gif), ("svg+xml", svg))]
        payload = {"images": images, "endpoint": "https://supplier.example.test/v1", "request": {"prompt": "format test", "model": "test-image", "n": 2}}
        status, _, raw = http(self.server, "/local/save-images", method="POST", body=json.dumps(payload).encode(), headers=self.auth_headers())
        self.assertEqual(status, 200)
        response = json.loads(raw)
        self.assertEqual([item["output_format"] for item in response["images"]], ["gif", "svg"])
        self.assertEqual([base64.b64decode(item["b64_json"]) for item in response["images"]], [gif, svg])
        files = [self.output / item["fileName"] for item in response["images"]]
        self.assertEqual([path.read_bytes() for path in files], [gif, svg])
        with Image.open(files[0]) as animation:
            self.assertEqual(animation.n_frames, 2)
            self.assertEqual(animation.info["loop"], 0)
            animation.seek(1)
            self.assertEqual(animation.info["duration"], 160)
        self.assertEqual(http(self.server, "/data/" + files[1].name)[0], 404)

    def test_svg_active_content_is_rejected_without_saving(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><script>test</script></svg>'
        payload = {"images": ["data:image/svg+xml;base64," + base64.b64encode(svg).decode()], "endpoint": "https://supplier.example.test/v1", "request": {"prompt": "format test", "model": "test-image"}}
        status, _, raw = http(self.server, "/local/save-images", method="POST", body=json.dumps(payload).encode(), headers=self.auth_headers())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_image")
        self.assertEqual(list(self.output.glob("image_*")), [])

    def test_svg_filter_config_is_explicit_and_boolean(self):
        config = self.temp / "svg-config.json"
        config.write_text('{"enforce_safe_svg": false}', encoding="utf-8")
        self.assertFalse(gui.load_gui_settings(config).enforce_safe_svg)
        config.write_text('{"enforce_safe_svg": "false"}', encoding="utf-8")
        with self.assertRaisesRegex(client.ImageToolError, "enforce_safe_svg"):
            gui.load_gui_settings(config)

    def test_damaged_image_rejected_without_saving(self):
        payload = {"images": ["data:image/png;base64," + base64.b64encode(b"not a png").decode()], "endpoint": "https://supplier.example.test/v1", "request": {"prompt": "public test", "model": "test-image"}}
        status, _, raw = http(self.server, "/local/save-images", method="POST", body=json.dumps(payload).encode(), headers=self.auth_headers())
        self.assertEqual(status, 502)
        self.assertEqual(json.loads(raw)["error"]["code"], "invalid_image")
        self.assertEqual(list(self.output.glob("image_*")), [])

    def test_static_directory_cannot_contain_private_data(self):
        with self.assertRaisesRegex(client.ImageToolError, "不能重叠"):
            gui.ImageGuiServer(gui.GuiSettings(port=0), dist_dir=self.dist, output_dir=self.dist / "data")
        with self.assertRaisesRegex(client.ImageToolError, "不能重叠"):
            gui.ImageGuiServer(gui.GuiSettings(port=0), dist_dir=self.dist, output_dir=self.temp)

    @unittest.skipUnless(sys.platform == "win32", "启动附件仅支持Windows")
    def test_command_line_starts_from_explicit_paths(self):
        with socket.socket() as reserve:
            reserve.bind(("127.0.0.1", 0))
            port = reserve.getsockname()[1]
        process = subprocess.Popen([sys.executable, "-B", str(ROOT / "gui_server.py"), "--serve", "--dist-dir", str(self.dist), "--output-dir", str(self.temp / "cli-data"), "--port", str(port)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8", env={**os.environ, "PYTHONIOENCODING": "utf-8"}, creationflags=subprocess.CREATE_NO_WINDOW)
        try:
            deadline = time.monotonic() + 5
            while True:
                if process.poll() is not None:
                    self.fail("CLI启动失败：" + process.communicate()[1])
                connection = HTTPConnection("127.0.0.1", port, timeout=1)
                try:
                    connection.request("GET", "/health")
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.loads(response.read())["service"], gui.SERVICE_NAME)
                    break
                except (ConnectionRefusedError, TimeoutError):
                    if time.monotonic() >= deadline:
                        self.fail("CLI未在5秒内响应")
                    time.sleep(0.05)
                finally:
                    connection.close()
        finally:
            process.terminate()
            process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
