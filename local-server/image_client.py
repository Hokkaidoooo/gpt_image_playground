"""图片接口、配置、凭据与文件保存的唯一实现。"""

from __future__ import annotations

import base64
import binascii
import ctypes
from ctypes import wintypes
from dataclasses import asdict, dataclass
from datetime import datetime
from http import client as http_client
import json
from pathlib import Path
import re
import sys
from typing import Callable
from urllib import error, parse, request
from uuid import uuid4

from image_validation import ImageValidationError, image_extension

from image_errors import ROOT, atomic_write, redact


DEFAULT_OUTPUT = ROOT.joinpath("data")
SETTINGS_PATH = DEFAULT_OUTPUT.joinpath("settings.json")
KEY_ENTROPY = b"local-image-tool-v1"
DPAPI_UI_FORBIDDEN = 1
ERROR_BODY_LIMIT = 4096
HTTP_SUCCESS_MIN = 200
HTTP_SUCCESS_MAX = 300
QUALITY_OPTIONS = ("low", "medium", "high", "xhigh", "max")
SIZE_OPTIONS = ("1024x1024", "1536x1024", "1024x1536", "1536x864", "864x1536")


class ImageToolError(Exception):
    """需要明确呈现给用户的失败。"""


class ImageSaveError(ImageToolError):
    """图片已校验，但落盘失败；保留响应供网页下载并明确呈现保存失败。"""

    def __init__(self, message: str, response: dict):
        super().__init__(message)
        self.response = response


@dataclass(frozen=True)
class Settings:
    api_base_url: str
    model: str
    size: str
    quality: str
    timeout_seconds: int
    remember_api_key: bool
    allow_same_origin_redirects: bool


@dataclass(frozen=True)
class GenerationResult:
    images: tuple[Path, ...]
    record: Path


def image_endpoint(base_url: str, operation: str = "generations") -> str:
    if operation not in ("generations", "edits"):
        raise ImageToolError("只支持图片生成或图片编辑接口。")
    parsed = parse.urlsplit(base_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ImageToolError("API 地址必须是完整的 http:// 或 https:// 地址。")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ImageToolError("API 地址不能包含账号密码、查询参数或片段。")
    path = parsed.path.rstrip("/")
    if not path:
        path = "/v1/images/generations"
    elif path.endswith("/v1"):
        path += "/images/generations"
    elif not path.endswith("/images/generations"):
        raise ImageToolError("请输入站点根地址、以 /v1 结尾的地址，或完整图片生成接口地址。")
    path = path.removesuffix("generations") + operation
    return parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def validate_settings(settings: Settings) -> None:
    for field in ("api_base_url", "model", "size", "quality"):
        if not isinstance(getattr(settings, field), str):
            raise ImageToolError(f"settings.json 的 {field} 必须是字符串。")
    image_endpoint(settings.api_base_url)
    if not settings.model.strip():
        raise ImageToolError("模型名不能为空。")
    if settings.size and not re.fullmatch(r"[1-9]\d*x[1-9]\d*", settings.size):
        raise ImageToolError("尺寸应为 宽x高，例如 1536x864；也可以选择由模型决定。")
    if settings.quality and settings.quality not in QUALITY_OPTIONS:
        raise ImageToolError("质量参数无效，请选择下拉框中的值。")
    if type(settings.timeout_seconds) is not int or settings.timeout_seconds <= 0:
        raise ImageToolError("等待超时必须是正整数秒。")
    for field in ("remember_api_key", "allow_same_origin_redirects"):
        if type(getattr(settings, field)) is not bool:
            raise ImageToolError(f"settings.json 的 {field} 必须是 true 或 false。")


def load_preference_snapshot(path: Path = SETTINGS_PATH) -> tuple[Settings, bytes]:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(raw, dict):
        raise ImageToolError("settings.json 必须包含一个配置对象。")
    if "api_key_dpapi" not in raw or not isinstance(raw["api_key_dpapi"], str):
        raise ImageToolError("settings.json 缺少字符串字段 api_key_dpapi。")
    encrypted_key = raw.pop("api_key_dpapi")
    try:
        settings = Settings(**raw)
    except TypeError as exc:
        raise ImageToolError(f"settings.json 字段不完整或存在未知字段：{exc}") from exc
    validate_settings(settings)
    if not settings.remember_api_key and encrypted_key:
        raise ImageToolError("配置中仍有加密密钥，但 remember_api_key 为 false；请检查配置。")
    if not encrypted_key:
        return settings, b""
    try:
        encrypted = base64.b64decode(encrypted_key, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise ImageToolError("settings.json 的加密密钥编码无效。") from exc
    return settings, encrypted


def load_preference_metadata(path: Path = SETTINGS_PATH) -> tuple[Settings, bool]:
    """网页预置只读取配置和密钥是否存在，不在页面加载时解密密钥。"""
    settings, encrypted = load_preference_snapshot(path)
    return settings, bool(encrypted)


def decrypt_saved_key(encrypted: bytes) -> str:
    if not encrypted:
        return ""
    key = _crypt_key(encrypted, decrypt=True).decode("utf-8")
    validate_key(key)
    return key


def load_preferences(path: Path = SETTINGS_PATH) -> tuple[Settings, str]:
    settings, encrypted = load_preference_snapshot(path)
    return settings, decrypt_saved_key(encrypted)


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _crypt_key(data: bytes, *, decrypt: bool) -> bytes:
    if sys.platform != "win32":
        raise ImageToolError("加密配置需要 Windows DPAPI，不能在其他系统解密。")
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    function = getattr(crypt32, "CryptUnprotectData" if decrypt else "CryptProtectData")
    function.argtypes = [
        ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.POINTER(_DataBlob),
        ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob),
    ]
    function.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    buffer = ctypes.create_string_buffer(data)
    entropy_buffer = ctypes.create_string_buffer(KEY_ENTROPY)
    incoming = _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)))
    entropy = _DataBlob(len(KEY_ENTROPY), ctypes.cast(entropy_buffer, ctypes.POINTER(ctypes.c_ubyte)))
    outgoing = _DataBlob()
    if not function(
        ctypes.byref(incoming), None, ctypes.byref(entropy), None, None,
        DPAPI_UI_FORBIDDEN, ctypes.byref(outgoing),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(outgoing.pbData, outgoing.cbData)
    finally:
        kernel32.LocalFree(outgoing.pbData)


def validate_key(key: str) -> None:
    if not key.strip():
        raise ImageToolError("请填写中转站 API-Key。")
    if "\r" in key or "\n" in key:
        raise ImageToolError("API-Key 不能包含换行。")


def save_preferences(settings: Settings, key: str, path: Path = SETTINGS_PATH) -> None:
    validate_settings(settings)
    encrypted_key = ""
    if settings.remember_api_key:
        validate_key(key)
        encrypted = _crypt_key(key.strip().encode("utf-8"), decrypt=False)
        encrypted_key = base64.b64encode(encrypted).decode("ascii")
    values = {**asdict(settings), "api_key_dpapi": encrypted_key}
    data = json.dumps(values, ensure_ascii=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write(path, data.encode("utf-8"))


def url_origin(url: str) -> tuple[str, str | None, int | None]:
    parts = parse.urlsplit(url)
    port = parts.port or (443 if parts.scheme == "https" else 80)
    return parts.scheme, parts.hostname, port


class _ApiRedirectHandler(request.HTTPRedirectHandler):
    def __init__(self, allow_same_origin: bool | None):
        super().__init__()
        self.allow_same_origin = allow_same_origin

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if self.allow_same_origin is None:
            return None
        if not self.allow_same_origin:
            raise ImageToolError(f"图片接口返回 HTTP {code} 重定向。请核对 API 地址；本次没有追随重定向。")
        if url_origin(req.full_url) != url_origin(newurl) or code not in (307, 308):
            raise ImageToolError("接口重定向改变了站点或提交方式，无法继续携带密钥提交。请填写最终接口地址。")
        return request.Request(newurl, data=req.data, headers=dict(req.headers), method=req.get_method())


def open_http_response(
    url: str, method: str, headers: dict[str, str], body: bytes | None,
    *, timeout: float, allow_same_origin_redirects: bool | None = None,
    return_http_errors: bool = False,
):
    """共用请求传输；网页按原状态返回 HTTP 错误，原窗口沿用显式异常。"""
    req = request.Request(url, data=body or None, headers=headers, method=method)
    opener = request.build_opener(_ApiRedirectHandler(allow_same_origin_redirects))
    try:
        return opener.open(req, timeout=timeout)
    except error.HTTPError as exc:
        if return_http_errors:
            return exc
        raise


def _http_failure(exc: error.HTTPError, key: str) -> ImageToolError:
    key_bytes = key.encode("utf-8")
    with exc:
        raw = exc.read(ERROR_BODY_LIMIT + len(key_bytes))
    cutoff = ERROR_BODY_LIMIT
    boundary_match = raw.find(key_bytes, max(0, cutoff - len(key_bytes) + 1))
    if 0 <= boundary_match < cutoff:
        cutoff = boundary_match
    body = redact(raw[:cutoff].decode("utf-8", errors="replace"), key)
    detail = body
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        detail = json.dumps(parsed.get("error", parsed), ensure_ascii=False)
    safe_detail = redact(detail or str(exc.reason), key)
    return ImageToolError(f"HTTP {exc.code}：{safe_detail[:1200]}")


def post_image_request(
    settings: Settings, key: str, body: bytes, content_type: str,
    *, operation: str = "generations",
) -> dict:
    endpoint = image_endpoint(settings.api_base_url, operation)
    try:
        with open_http_response(
            endpoint, "POST",
            {"Authorization": f"Bearer {key}", "Content-Type": content_type, "Accept": "application/json"},
            body, timeout=settings.timeout_seconds,
            allow_same_origin_redirects=settings.allow_same_origin_redirects,
        ) as response:
            if not HTTP_SUCCESS_MIN <= response.status < HTTP_SUCCESS_MAX:
                raise ImageToolError(f"图片接口返回 HTTP {response.status}，未取得成功响应。")
            raw = response.read()
    except error.HTTPError as exc:
        raise _http_failure(exc, key) from exc
    except (error.URLError, OSError, http_client.HTTPException) as exc:
        raise ImageToolError(
            redact(f"图片请求未取得完整响应：{exc}。工具不会自动重试；请先查看中转站的请求记录，再决定是否重发。", key)
        ) from exc
    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ImageToolError("图片接口没有返回有效 JSON；请确认中转站支持 /v1/images/generations。") from exc
    if not isinstance(result, dict):
        raise ImageToolError("图片接口返回的 JSON 不是对象。")
    if "error" in result:
        detail = json.dumps(result["error"], ensure_ascii=False)
        raise ImageToolError(redact(f"中转站报告失败：{detail}", key))
    return result


def _image_bytes(item: dict, timeout: int, progress: Callable[[str], None]) -> bytes:
    encoded = item.get("b64_json")
    if encoded is not None:
        if not isinstance(encoded, str) or not encoded:
            raise ImageToolError("响应中的 b64_json 为空或类型错误。")
        progress("已收到图片，正在解码。")
        try:
            return base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise ImageToolError("响应中的图片 Base64 无效，未保存为成功图片。") from exc
    url = item.get("url")
    if not isinstance(url, str) or parse.urlsplit(url).scheme not in ("http", "https"):
        raise ImageToolError("响应缺少有效的 b64_json 或图片下载地址。")
    progress("中转站返回了图片下载地址，正在取回图片。")
    try:
        with request.urlopen(url, timeout=timeout) as response:
            return response.read()
    except (error.URLError, OSError, http_client.HTTPException) as exc:
        raise ImageToolError(f"已收到下载地址，但图片下载失败：{exc}。没有重新发起生图请求。") from exc


def _image_extension(data: bytes, *, enforce_safe_svg: bool = True) -> str:
    try:
        return image_extension(data, enforce_safe_svg=enforce_safe_svg)
    except ImageValidationError as exc:
        raise ImageToolError(str(exc)) from exc


def save_image_response(
    result: dict, payload: dict, settings: Settings, progress: Callable[[str], None],
    *, operation: str = "generations", save_files: bool = True, endpoint: str | None = None,
    enforce_safe_svg: bool = True,
    output_dir: Path = DEFAULT_OUTPUT,
) -> tuple[GenerationResult | None, dict]:
    items = result.get("data")
    if not isinstance(items, list) or not items:
        raise ImageToolError("接口没有返回图片 data，不能确认生图成功。")
    images = []
    for item in items:
        if not isinstance(item, dict):
            raise ImageToolError("图片 data 中存在无效记录。")
        content = _image_bytes(item, settings.timeout_seconds, progress)
        images.append((content, _image_extension(content, enforce_safe_svg=enforce_safe_svg)))
    # 网页与窗口共用同一份已校验图片，浏览器无需再次访问远端图片链接。
    response = {
        **result,
        "data": [
            {
                **{name: value for name, value in item.items() if name not in ("url", "b64_json")},
                "b64_json": base64.b64encode(content).decode("ascii"),
                "output_format": "jpeg" if extension == ".jpg" else extension.removeprefix("."),
            }
            for item, (content, extension) in zip(items, images)
        ],
    }
    if not save_files:
        return None, response
    timestamp = datetime.now().astimezone()
    prefix = f"image_{timestamp:%Y%m%d_%H%M%S}_{uuid4().hex[:8]}"
    paths = tuple(output_dir.joinpath(f"{prefix}_{index:02d}{ext}") for index, (_, ext) in enumerate(images, 1))
    record_path = output_dir.joinpath(f"{prefix}_记录.json")
    record = {
        "completed_at": timestamp.isoformat(),
        "endpoint": image_endpoint(settings.api_base_url, operation) if endpoint is None else endpoint,
        "request": payload,
        "images": [path.name for path in paths],
        "usage": result.get("usage"),
        "server_created": result.get("created"),
        "revised_prompts": [item.get("revised_prompt") for item in items],
    }
    progress("正在保存图片与提示词记录。")
    try:
        output_dir.mkdir(parents=True, exist_ok=True)
        for path, (content, _) in zip(paths, images):
            with path.open("xb") as stream:
                stream.write(content)
        with record_path.open("x", encoding="utf-8") as stream:
            json.dump(record, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    except OSError as exc:
        saved = [str(path) for path in paths if path.exists()]
        raise ImageSaveError(
            f"已收到图片，但本地保存未全部完成：{exc}。已存在文件：{saved}；请勿直接重发生图请求。",
            response,
        ) from exc
    return GenerationResult(paths, record_path), response


def generate_image(prompt: str, key: str, settings: Settings, progress: Callable[[str], None]) -> GenerationResult:
    validate_settings(settings)
    validate_key(key)
    if not prompt.strip():
        raise ImageToolError("请先输入生图提示词。")
    payload = {"model": settings.model.strip(), "prompt": prompt, "n": 1}
    if settings.size:
        payload["size"] = settings.size
    if settings.quality:
        payload["quality"] = settings.quality
    progress("正在等待图片模型响应……")
    result = post_image_request(
        settings, key.strip(), json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json",
    )
    saved, _ = save_image_response(result, payload, settings, progress)
    if saved is None:
        raise ImageToolError("图片未保存，生成结果不完整。")
    return saved
