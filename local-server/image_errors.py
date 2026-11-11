"""启动与窗口共用的显式错误报告，不依赖界面或图片库。"""

from __future__ import annotations

import ctypes
from pathlib import Path
from uuid import uuid4


ROOT = Path(__file__).resolve().parent
ERROR_LOG_PATH = ROOT.joinpath("data", "最近错误.log")
MESSAGE_BOX_ERROR = 0x10


def atomic_write(path: Path, data: bytes) -> None:
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(data)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def redact(text: str, key: str) -> str:
    return text.replace(key, "[密钥已隐藏]") if key else text


def show_failure(detail: str, key: str, title: str) -> str:
    safe_detail = redact(detail, key)
    summary = safe_detail.rstrip().splitlines()[-1]
    try:
        ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(ERROR_LOG_PATH, safe_detail.encode("utf-8"))
    except OSError as exc:
        summary += f"\n错误日志保存也失败：{exc}"
    else:
        summary += "\n完整错误：" + str(ERROR_LOG_PATH)
    ctypes.windll.user32.MessageBoxW(None, summary, title, MESSAGE_BOX_ERROR)
    return summary
