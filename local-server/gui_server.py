"""本机生图网页：按当前供应商转发请求，并校验保存最终图片。"""

from __future__ import annotations

import argparse
import base64
from collections import deque
from dataclasses import dataclass
import gzip
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import math
import os
import select
import sys
import webbrowser
from pathlib import Path
import re
import secrets
import socket
import threading
import traceback
from urllib import parse
import zlib

from image_client import (
    ImageSaveError, ImageToolError, Settings, decrypt_saved_key, image_endpoint, load_preference_metadata,
    load_preference_snapshot, open_http_response, save_image_response, url_origin, validate_key,
)
from image_errors import ROOT, atomic_write, redact


DEFAULT_DIST = ROOT.parent.joinpath("dist")
DEFAULT_OUTPUT = ROOT.joinpath("data")
GUI_SETTINGS_PATH = ROOT.joinpath("gui_settings.json")
SERVICE_NAME = "local-gpt-image-playground"
BRIDGE_VERSION = 2
MANAGED_KEY_MARKER = "local-managed-key"
DEFAULT_REQUEST_TIMEOUT = 600
MAX_REQUEST_TIMEOUT = 86400
BRIDGE_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/131.0.0.0 Safari/537.36"
)
STREAM_CHUNK_BYTES = 65536
GENERATION_QUEUE_POLL_SECONDS = 0.1
HOP_BY_HOP_HEADERS = frozenset({
    "host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade", "content-length",
})
HTTP_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})
SAVE_REQUEST_FIELDS = frozenset({
    "prompt", "model", "size", "quality", "n", "provider", "profile_name",
    "api_mode", "aspect_ratio", "resolution",
})
SENSITIVE_NAME = re.compile(r"(?:authorization|auth|api[_-]?key|key|token|secret|signature)", re.I)
HEADER_NAME = re.compile(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+")
DATA_URL = re.compile(r"data:image/(png|jpeg|webp|gif|svg\+xml);base64,([A-Za-z0-9+/]*={0,2})", re.I)


class LocalRequestError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def client_connection_is_open(connection: socket.socket) -> bool:
    try:
        readable, _, exceptional = select.select([connection], [], [connection], 0)
        if exceptional:
            return False
        return not readable or bool(connection.recv(1, socket.MSG_PEEK))
    except (OSError, ValueError):
        return False


@dataclass(frozen=True)
class GuiSettings:
    port: int = 17865
    enforce_local_origin: bool = True
    save_generated_images: bool = True
    max_upload_mb: int = 512
    serialize_image_requests: bool = True
    enforce_safe_svg: bool = True
    enforce_private_data_directory: bool = True


def load_gui_settings(path: Path | None = None, *, port: int | None = None) -> GuiSettings:
    selected = GUI_SETTINGS_PATH if path is None else path
    raw = {} if path is None and not selected.exists() else json.loads(selected.read_text(encoding="utf-8-sig"))
    if not isinstance(raw, dict):
        raise ImageToolError("gui_settings.json 必须包含配置对象。")
    if port is not None:
        raw = {**raw, "port": port}
    config = GuiSettings(**raw)
    if type(config.port) is not int or not 1024 <= config.port <= 65535:
        raise ImageToolError("本机网页端口必须是 1024 至 65535 之间的整数。")
    if type(config.max_upload_mb) is not int or not 1 <= config.max_upload_mb <= 512:
        raise ImageToolError("max_upload_mb 必须是 1 至 512 之间的整数。")
    for name in ("enforce_local_origin", "save_generated_images", "serialize_image_requests", "enforce_safe_svg", "enforce_private_data_directory"):
        if type(getattr(config, name)) is not bool:
            raise ImageToolError(f"gui_settings.json 的 {name} 必须是 true 或 false。")
    return config


def managed_base_url(settings: Settings) -> str:
    return image_endpoint(settings.api_base_url).removesuffix("/images/generations")


def credential_variants(credentials: list[str]) -> set[str]:
    variants = set()
    for credential in credentials:
        if credential:
            variants.update({
                credential, parse.quote(credential, safe=""),
                json.dumps(credential, ensure_ascii=True)[1:-1],
            })
    return variants


def redact_credentials(text: str, credentials: list[str]) -> str:
    for credential in sorted(credential_variants(credentials), key=len, reverse=True):
        text = redact(text, credential)
    return text


def redact_response_bytes(content: bytes, credentials: list[str]) -> bytes:
    for credential in sorted(credential_variants(credentials), key=len, reverse=True):
        content = content.replace(credential.encode("utf-8"), b"[credential hidden]")
    return content


def remember_credentials(url: str, headers: list[list[str]], body: bytes, credentials: list[str]) -> None:
    for name, value in headers:
        if SENSITIVE_NAME.search(name):
            credentials.append(value)
            if name.lower().endswith("authorization") and " " in value:
                credentials.append(value.split(" ", 1)[1].strip())
    for name, value in parse.parse_qsl(parse.urlsplit(url).query, keep_blank_values=True):
        if SENSITIVE_NAME.fullmatch(name):
            credentials.append(value)
    if body.lstrip().startswith((b"{", b"[")):
        try:
            value = json.loads(body)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return
        pending = [value]
        while pending:
            value = pending.pop()
            if isinstance(value, dict):
                for name, item in value.items():
                    if SENSITIVE_NAME.fullmatch(name) and isinstance(item, str):
                        credentials.append(item)
                    elif isinstance(item, (dict, list)):
                        pending.append(item)
            elif isinstance(value, list):
                pending.extend(item for item in value if isinstance(item, (dict, list)))


class ImageGuiServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self, config: GuiSettings, *, dist_dir: Path = DEFAULT_DIST,
        output_dir: Path = DEFAULT_OUTPUT,
    ):
        self.config = config
        self.dist_dir = dist_dir.expanduser().resolve()
        self.output_dir = output_dir.expanduser().resolve()
        if not self.dist_dir.joinpath("index.html").is_file():
            raise ImageToolError("网页版尚未构建，请先在仓库根目录运行 npm run build，或用 --dist-dir 指定构建目录。")
        if config.enforce_private_data_directory and (
            self.output_dir.is_relative_to(self.dist_dir) or self.dist_dir.is_relative_to(self.output_dir)
        ):
            raise ImageToolError("图片数据目录和网页资源目录不能重叠，请修改 --output-dir 或 --dist-dir。")
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.settings_path = self.output_dir.joinpath("settings.json")
        self.error_log_path = self.output_dir.joinpath("最近错误.log")
        self.token = secrets.token_urlsafe(32)
        self.generation_lock = threading.Lock()
        self.generation_queue_condition = threading.Condition()
        self.generation_waiters = deque()
        super().__init__(("127.0.0.1", config.port), ImageGuiHandler)
        self.origin = f"http://127.0.0.1:{self.server_port}"

    def acquire_generation_slot(self, connection: socket.socket) -> bool:
        ticket = object()
        with self.generation_queue_condition:
            self.generation_waiters.append(ticket)
        while True:
            if not client_connection_is_open(connection):
                with self.generation_queue_condition:
                    self.generation_waiters.remove(ticket)
                    self.generation_queue_condition.notify_all()
                return False
            with self.generation_queue_condition:
                if self.generation_waiters[0] is ticket and self.generation_lock.acquire(blocking=False):
                    self.generation_waiters.popleft()
                    self.generation_queue_condition.notify_all()
                    if not client_connection_is_open(connection):
                        self.generation_lock.release()
                        self.generation_queue_condition.notify_all()
                        return False
                    return True
                self.generation_queue_condition.wait(GENERATION_QUEUE_POLL_SECONDS)

    def release_generation_slot(self) -> None:
        self.generation_lock.release()
        with self.generation_queue_condition:
            self.generation_queue_condition.notify_all()


class ImageGuiHandler(SimpleHTTPRequestHandler):
    server: ImageGuiServer
    protocol_version = "HTTP/1.1"

    def __init__(self, request, client_address, server: ImageGuiServer):
        super().__init__(request, client_address, server, directory=str(server.dist_dir))

    def log_message(self, format: str, *args) -> None:
        # 访问日志不记录提示词、图片地址或凭据；失败独立保存脱敏后的明确证据。
        return

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        super().end_headers()

    def _write(self, status: int, content: bytes, content_type: str, *, content_encoding: str = "") -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        if content_encoding:
            self.send_header("Content-Encoding", content_encoding)
        self.end_headers()
        self._response_started = True
        self.wfile.write(content)

    def _json(self, status: int, value: dict) -> None:
        self._write(status, json.dumps(value, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _check_origin(self, *, require_origin: bool = False) -> None:
        if not self.server.config.enforce_local_origin:
            return
        authority = parse.urlsplit(self.server.origin).netloc
        if self.headers.get("Host") != authority:
            raise LocalRequestError("请通过本机启动入口打开网页。", 403)
        origin = self.headers.get("Origin")
        if (require_origin and origin != self.server.origin) or (origin and origin != self.server.origin):
            raise LocalRequestError("拒绝来自其他网页的请求。", 403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise LocalRequestError("拒绝来自其他网页的连接请求。", 403)

    def _authenticate(self) -> None:
        self._check_origin(require_origin=True)
        provided_token = self.headers.get("Authorization", "").encode("utf-8")
        expected_token = ("Bearer " + self.server.token).encode("ascii")
        if not secrets.compare_digest(provided_token, expected_token):
            raise LocalRequestError("本机连接凭据已失效，请刷新网页后再提交。", 403)

    def _bootstrap(self) -> None:
        profiles = []
        base_url = ""
        configuration_error = ""
        if self.server.settings_path.exists():
            try:
                settings, has_key = load_preference_metadata(self.server.settings_path)
                base_url = managed_base_url(settings)
                profiles.append({
                    "id": "local-managed", "name": "本机加密配置", "provider": "openai",
                    "baseUrl": base_url, "apiKey": MANAGED_KEY_MARKER if has_key else "",
                    "model": settings.model, "apiMode": "images", "imageApiDialect": "openai", "isDefault": True,
                    "timeout": settings.timeout_seconds, "apiProxy": False,
                    "codexCli": False, "streamImages": False, "responseFormatB64Json": False,
                })
                if not has_key:
                    configuration_error = "本机加密配置未保存 API Key，请在供应商设置中填写密钥后再使用。"
            except (ImageToolError, OSError, ValueError, TypeError) as exc:
                configuration_error = f"本机加密配置无法读取：{exc}。请在供应商设置中新建或修改连接。"
        preset = {"profiles": profiles, "agent": {"apiConfigMode": "off"}}
        encoded = base64.b64encode(json.dumps(preset, ensure_ascii=False).encode("utf-8")).decode("ascii")
        value = {
            "preset": "embedded-config:" + encoded,
            "token": self.server.token,
            "managedBaseUrl": base_url,
            "managedKeyMarker": MANAGED_KEY_MARKER,
            "saveGeneratedImages": self.server.config.save_generated_images,
            "bridgeVersion": BRIDGE_VERSION,
        }
        if configuration_error:
            value["configurationError"] = configuration_error
        script = "window.__LOCAL_IMAGE_BOOTSTRAP__ = " + json.dumps(value, ensure_ascii=False) + ";\n"
        self._write(200, script.encode("utf-8"), "text/javascript; charset=utf-8")

    def _serve_static(self, *, head: bool = False) -> None:
        path = parse.urlsplit(self.path)
        resolved = Path(self.translate_path(path.path)).resolve()
        if not resolved.is_relative_to(self.server.dist_dir) or not resolved.is_file():
            raise LocalRequestError("本机页面资源不存在。", 404)
        if head:
            super().do_HEAD()
        else:
            super().do_GET()

    def do_GET(self) -> None:
        self._response_started = False
        try:
            self._check_origin()
            path = parse.urlsplit(self.path).path
            if path == "/local-config.js":
                self._bootstrap()
                return
            if path == "/health":
                self._json(200, {"service": SERVICE_NAME, "version": BRIDGE_VERSION})
                return
            if path == "/":
                self.path = "/index.html"
            self._serve_static()
        except LocalRequestError as exc:
            self._json(exc.status, {"error": {"message": str(exc)}})
        except (ImageToolError, OSError, ValueError, TypeError) as exc:
            self._record_error(exc, [self.server.token])

    def do_HEAD(self) -> None:
        try:
            self._check_origin()
            if parse.urlsplit(self.path).path == "/":
                self.path = "/index.html"
            self._serve_static(head=True)
        except LocalRequestError as exc:
            self.send_error(exc.status, "Local resource unavailable")

    def do_OPTIONS(self) -> None:
        self._json(403, {"error": {"message": "请求仅接受本机网页的同源调用。"}})

    def _read_body(self, *, allow_empty: bool = False) -> bytes:
        lengths = self.headers.get_all("Content-Length", [])
        length = lengths[0] if lengths else "0"
        if len(lengths) > 1 or not length.isdecimal() or self.headers.get("Transfer-Encoding"):
            raise LocalRequestError("请求必须包含有效的 Content-Length，不能使用分块上传。")
        count = int(length)
        if count > self.server.config.max_upload_mb * 1024 * 1024:
            raise LocalRequestError("请求超过本机上传大小限制。", 413)
        if not count and not allow_empty:
            raise LocalRequestError("保存请求不能为空。")
        self.connection.settimeout(120)
        body = self.rfile.read(count)
        if len(body) != count:
            raise LocalRequestError("请求体传输不完整。")
        return body

    def _request_metadata(self) -> dict:
        encoded = self.headers.get("X-Local-Request", "")
        if not encoded or re.search(r"%(?![0-9a-fA-F]{2})", encoded):
            raise LocalRequestError("缺少有效的 X-Local-Request 请求描述。")
        try:
            metadata = json.loads(parse.unquote_to_bytes(encoded))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise LocalRequestError("X-Local-Request 不是有效的请求描述。") from exc
        if not isinstance(metadata, dict) or set(metadata) - {"url", "method", "headers", "timeoutSeconds"}:
            raise LocalRequestError("请求描述字段无效。")
        if not isinstance(metadata.get("url"), str) or not isinstance(metadata.get("method"), str):
            raise LocalRequestError("请求描述必须包含完整 URL 和 HTTP method。")
        headers = metadata.get("headers")
        if not isinstance(headers, list) or any(
            not isinstance(pair, list) or len(pair) != 2 or not all(isinstance(value, str) for value in pair)
            for pair in headers
        ):
            raise LocalRequestError("请求 headers 必须是名称和值组成的数组。")
        for name, value in headers:
            if not HEADER_NAME.fullmatch(name) or re.search(r"[\x00-\x08\x0a-\x1f\x7f]", value):
                raise LocalRequestError("请求头名称或值包含无效字符。")
            try:
                value.encode("latin-1")
            except UnicodeEncodeError as exc:
                raise LocalRequestError("请求头值不能包含无法传输的字符。") from exc
        timeout = metadata.get("timeoutSeconds", DEFAULT_REQUEST_TIMEOUT)
        if type(timeout) not in (int, float) or not math.isfinite(timeout) or not 0 < timeout <= MAX_REQUEST_TIMEOUT:
            raise LocalRequestError("请求 timeoutSeconds 必须是 0 至 86400 之间的有效秒数。")
        if metadata["method"] not in HTTP_METHODS:
            raise LocalRequestError("不支持此 HTTP method。")
        metadata["timeoutSeconds"] = timeout
        return metadata

    def _validate_url(self, url: str, *, saving: bool = False) -> None:
        try:
            parts = parse.urlsplit(url)
            port = parts.port if parts.port is not None else (443 if parts.scheme == "https" else 80)
        except ValueError as exc:
            raise LocalRequestError("供应商 URL 格式或端口无效。") from exc
        if parts.scheme not in ("http", "https") or not parts.hostname or not 1 <= port <= 65535:
            raise LocalRequestError("供应商 URL 必须是完整的 http:// 或 https:// 地址。")
        if parts.username or parts.password or parts.fragment or re.search(r"[\x00-\x20\x7f]", url):
            raise LocalRequestError("供应商 URL 不能包含账号密码、片段或空白字符。")
        if saving and parts.query:
            raise LocalRequestError("保存用的供应商基础地址不能包含查询参数，避免把密钥写入记录。")
        if MANAGED_KEY_MARKER in parse.unquote(url):
            raise LocalRequestError("本机密钥占位符只能用于认证请求头，不能用于 URL 或自定义模板。")
        if saving or port != self.server.server_port:
            return
        host = parts.hostname.rstrip(".").lower()
        try:
            address = ipaddress.ip_address(host)
            loopback = address.is_loopback or (address.version == 6 and address.ipv4_mapped and address.ipv4_mapped.is_loopback)
        except ValueError:
            loopback = host in ("localhost", "localhost.localdomain")
            if not loopback:
                try:
                    loopback = any(ipaddress.ip_address(info[4][0]).is_loopback for info in socket.getaddrinfo(host, port))
                except OSError as exc:
                    raise LocalRequestError("供应商主机名无法解析。") from exc
        if loopback:
            raise LocalRequestError("供应商地址不能指回本机生图服务，请填写真实 API 地址。")

    def _forward_headers(self, metadata: dict, body: bytes, credentials: list[str]) -> dict[str, str]:
        url = metadata["url"]
        pairs = metadata["headers"]
        remember_credentials(url, pairs, body, credentials)
        self._validate_url(url)
        if MANAGED_KEY_MARKER.encode("ascii") in body:
            raise LocalRequestError("本机密钥占位符不能用于请求体或自定义模板，请填写该供应商的真实 API Key。")
        connection_fields = {
            value.strip().lower()
            for name, values in pairs if name.lower() == "connection"
            for value in values.split(",")
        }
        ignored = HOP_BY_HOP_HEADERS | connection_fields | {"x-local-request"}
        headers = {}
        names = set()
        managed_names = []
        for name, value in pairs:
            lowered = name.lower()
            if lowered in names:
                raise LocalRequestError("请求包含重复的请求头。")
            names.add(lowered)
            if lowered in ignored:
                continue
            if MANAGED_KEY_MARKER in value:
                if lowered == "authorization" and re.fullmatch(r"(?:Bearer|Key)\s+local-managed-key", value, re.I):
                    managed_names.append(name)
                elif lowered == "x-goog-api-key" and value == MANAGED_KEY_MARKER:
                    managed_names.append(name)
                else:
                    raise LocalRequestError("本机密钥占位符只能用于 Bearer、Key 或 x-goog-api-key 认证。")
            headers[name] = value
        # 浏览器 fetch 禁止携带 User-Agent，桥接需以浏览器签名转发，否则供应商的 Cloudflare 校验返回 403/1010。
        if "user-agent" not in names:
            headers["User-Agent"] = BRIDGE_USER_AGENT
        if not managed_names:
            return headers
        settings, encrypted = load_preference_snapshot(self.server.settings_path)
        if url_origin(url) != url_origin(managed_base_url(settings)):
            raise LocalRequestError("该密钥属于原供应商，不能发送到其他站点；请在当前供应商设置中填写新的 API Key。", 403)
        key = decrypt_saved_key(encrypted)
        credentials.append(key)
        validate_key(key)
        for name in managed_names:
            value = headers[name]
            headers[name] = key if name.lower() == "x-goog-api-key" else value.removesuffix(MANAGED_KEY_MARKER) + key
        return headers

    def _record_error(self, exc: Exception, credentials: list[str], *, status: int = 502, value: dict | None = None) -> None:
        detail = redact_credentials(traceback.format_exc(), credentials)
        summary = redact_credentials(str(exc), credentials)
        try:
            atomic_write(self.server.error_log_path, detail.encode("utf-8"))
        except OSError as log_error:
            summary += redact_credentials(f"；错误日志保存失败：{log_error}", credentials)
        if self._response_started or isinstance(exc, (BrokenPipeError, ConnectionResetError)):
            self.close_connection = True
            return
        if value is None:
            value = {"error": {"message": summary}}
        else:
            value = {**value, "error": {**value["error"], "message": summary}}
        self._json(status, value)

    def _log_upstream_failure(self, status: int, content: bytes, credentials: list[str]) -> None:
        detail = redact_credentials(f"供应商返回 HTTP {status}：\n" + content.decode("utf-8", errors="replace"), credentials)
        atomic_write(self.server.error_log_path, detail.encode("utf-8"))

    def _stream_response(self, response, status: int, content_type: str, credentials: list[str]) -> None:
        if response.headers.get("Content-Encoding", "identity").lower() != "identity":
            raise ImageToolError("供应商返回了压缩的事件流，无法安全转发；请关闭该供应商的流式压缩。")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        self._response_started = True
        pending = b""
        while chunk := response.read1(STREAM_CHUNK_BYTES):
            pending += chunk
            while match := re.search(rb"\r\n\r\n|\n\n|\r\r", pending):
                event, pending = pending[:match.end()], pending[match.end():]
                if status >= 400 or b'"error"' in event or b"event: error" in event:
                    event = redact_response_bytes(event, credentials)
                    self._log_upstream_failure(status, event, credentials)
                self._write_stream_chunk(event)
        if getattr(response, "length", None) not in (None, 0):
            raise ImageToolError("供应商事件流提前中断，未取得完整响应；本次不会自动重试。")
        if pending:
            raise ImageToolError("供应商事件流包含未完成的事件，不能确认响应完整；本次不会自动重试。")
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def _write_stream_chunk(self, chunk: bytes) -> None:
        self.wfile.write(f"{len(chunk):x}\r\n".encode("ascii") + chunk + b"\r\n")
        self.wfile.flush()

    def _proxy(self, credentials: list[str]) -> None:
        body = self._read_body(allow_empty=True)
        metadata = self._request_metadata()
        acquired = False
        try:
            if self.server.config.serialize_image_requests:
                acquired = self.server.acquire_generation_slot(self.connection)
                if not acquired:
                    return
            headers = self._forward_headers(metadata, body, credentials)
            with open_http_response(
                metadata["url"], metadata["method"], headers, body,
                timeout=metadata["timeoutSeconds"], return_http_errors=True,
            ) as response:
                status = response.status
                content_type = response.headers.get("Content-Type", "application/octet-stream")
                if content_type.split(";", 1)[0].strip().lower() == "text/event-stream":
                    self._stream_response(response, status, content_type, credentials)
                    return
                content = response.read()
                encoding = response.headers.get("Content-Encoding", "")
                decoded = content
                if encoding.lower() == "gzip":
                    decoded = gzip.decompress(content)
                elif encoding.lower() == "deflate":
                    decoded = zlib.decompress(content)
                is_error = status >= 400 or b'"error"' in decoded
                if is_error:
                    if encoding.lower() not in ("", "identity", "gzip", "deflate"):
                        raise ImageToolError("供应商错误响应使用了不支持的压缩格式，无法安全呈现错误。")
                    content = redact_response_bytes(decoded, credentials)
                    encoding = ""
                    self._log_upstream_failure(status, content, credentials)
                self._write(status, content, content_type, content_encoding=encoding)
        finally:
            if acquired:
                self.server.release_generation_slot()

    def _save_images(self) -> None:
        try:
            payload = json.loads(self._read_body())
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise LocalRequestError("图片保存请求不是有效 JSON。") from exc
        if not isinstance(payload, dict) or set(payload) - {"images", "endpoint", "request", "taskId"}:
            raise LocalRequestError("图片保存请求字段无效。")
        endpoint = payload.get("endpoint")
        if not isinstance(endpoint, str):
            raise LocalRequestError("图片保存请求缺少供应商基础地址。")
        self._validate_url(endpoint, saving=True)
        request_metadata = payload.get("request")
        if not isinstance(request_metadata, dict) or set(request_metadata) - SAVE_REQUEST_FIELDS:
            raise LocalRequestError("图片记录只能包含提示词、模型和生图参数，不能包含密钥或额外字段。")
        for name in ("prompt", "model"):
            if not isinstance(request_metadata.get(name), str) or not request_metadata[name].strip():
                raise LocalRequestError(f"图片记录 {name} 不能为空。")
        for name, value in request_metadata.items():
            if name == "n":
                if type(value) is not int or value <= 0:
                    raise LocalRequestError("图片记录 n 必须是正整数。")
            elif not isinstance(value, str):
                raise LocalRequestError(f"图片记录 {name} 必须是字符串。")
            elif MANAGED_KEY_MARKER in value:
                raise LocalRequestError("图片记录不能包含本机密钥占位符。")
        task_id = payload.get("taskId")
        if task_id is not None and (not isinstance(task_id, str) or not task_id.strip()):
            raise LocalRequestError("图片记录 taskId 必须是非空字符串。")
        images = payload.get("images")
        if not isinstance(images, list) or not images:
            raise LocalRequestError("图片保存请求必须包含完整的图片 data URL。")
        items = []
        for data_url in images:
            match = DATA_URL.fullmatch(data_url) if isinstance(data_url, str) else None
            if not match or not match[2]:
                raise LocalRequestError("保存内容必须是 PNG、JPEG、WebP、GIF 或 SVG 的完整 Base64 图片 data URL。")
            items.append({"b64_json": match[2]})
        record_request = {**request_metadata, **({"task_id": task_id} if task_id is not None else {})}
        settings = Settings(endpoint, request_metadata["model"], "", "", DEFAULT_REQUEST_TIMEOUT, False, False)
        try:
            saved, result = save_image_response(
                {"data": items}, record_request, settings, lambda _: None,
                save_files=self.server.config.save_generated_images, endpoint=endpoint,
                enforce_safe_svg=self.server.config.enforce_safe_svg,
                output_dir=self.server.output_dir,
            )
        except ImageSaveError as exc:
            self._record_error(exc, [self.server.token], status=507, value={
                "error": {"code": "local_save_failed", "message": str(exc)},
                "images": exc.response["data"],
            })
            return
        except ImageToolError as exc:
            self._record_error(exc, [self.server.token], value={
                "error": {"code": "invalid_image", "message": str(exc)},
            })
            return
        value = {"saved": saved is not None, "images": result["data"]}
        if saved is not None:
            value["record"] = saved.record.name
            for item, path in zip(value["images"], saved.images):
                item["fileName"] = path.name
        self._json(200, value)

    def do_POST(self) -> None:
        self._response_started = False
        self.close_connection = True
        credentials = [self.server.token]
        try:
            self._authenticate()
            path = parse.urlsplit(self.path)
            if path.query or path.fragment:
                raise LocalRequestError("本机接口不能包含查询参数或片段。", 404)
            if path.path == "/local/proxy":
                self._proxy(credentials)
                return
            if path.path == "/local/save-images":
                self._save_images()
                return
            raise LocalRequestError("本机接口不存在。", 404)
        except LocalRequestError as exc:
            self._json(exc.status, {"error": {"message": redact_credentials(str(exc), credentials)}})
        except (BrokenPipeError, ConnectionResetError) as exc:
            self._record_error(exc, credentials)
        except Exception as exc:
            # 网络、凭据和保存失败都明确呈现；流已开始时关闭连接，让读取失败可见。
            self._record_error(exc, credentials)


def main() -> None:
    parser = argparse.ArgumentParser(description="Windows 本机多供应商生图工具")
    parser.add_argument("--serve", action="store_true", help="启动本机服务")
    parser.add_argument("--dist-dir", type=Path, default=Path(os.environ.get("IMAGE_GUI_DIST_DIR", str(DEFAULT_DIST))), help="前端构建目录，默认仓库根目录的 dist")
    parser.add_argument("--output-dir", type=Path, default=Path(os.environ.get("IMAGE_GUI_OUTPUT_DIR", str(DEFAULT_OUTPUT))), help="图片与日志目录，默认 local-server/data")
    parser.add_argument("--config", type=Path, help="可选的服务配置 JSON")
    parser.add_argument("--port", type=int, help="监听端口，默认 17865")
    parser.add_argument("--open", action="store_true", help="启动后打开默认浏览器")
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("本机启动附件目前支持 Windows 10/11；加密配置使用 Windows DPAPI。")
    config = load_gui_settings(args.config, port=args.port)
    with ImageGuiServer(config, dist_dir=args.dist_dir, output_dir=args.output_dir) as server:
        print(f"生图工作台：{server.origin}", flush=True)
        print(f"图片与日志：{server.output_dir}", flush=True)
        print("按 Ctrl+C 停止服务。", flush=True)
        if args.open:
            webbrowser.open(server.origin)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("本机服务已停止。", flush=True)


if __name__ == "__main__":
    main()
