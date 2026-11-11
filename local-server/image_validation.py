"""图片内容校验；GIF 保留动画，SVG 默认只允许静态文档内资源。"""
from __future__ import annotations
from io import BytesIO
import re
from xml.parsers import expat
from PIL import Image, UnidentifiedImageError

RASTER_EXTENSIONS = {"PNG": ".png", "JPEG": ".jpg", "WEBP": ".webp", "GIF": ".gif"}
SVG_NAMESPACE = "http://www.w3.org/2000/svg"
SVG_STATIC_ELEMENTS = frozenset({
    "svg", "g", "defs", "symbol", "use", "title", "desc", "style", "switch",
    "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
    "text", "tspan", "textPath", "a", "image", "clipPath", "mask", "pattern",
    "linearGradient", "radialGradient", "stop", "marker", "filter",
    "feBlend", "feColorMatrix", "feComponentTransfer", "feComposite",
    "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight",
    "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG", "feFuncR",
    "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset",
    "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence",
})
SVG_LOCAL_REFERENCE = re.compile(r"#[^\s\x00-\x20'\"<>]+")
SVG_CSS_URL = re.compile(r"url\(\s*(['\"]?)(#[^\s'\"()]+)\1\s*\)", re.I)
SVG_CSS_FUNCTION = re.compile(r"([-a-zA-Z_][-a-zA-Z_0-9]*)\s*\(")
SVG_CSS_FUNCTIONS = frozenset({
    "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch",
    "color", "color-mix", "calc", "min", "max", "clamp", "var",
    "matrix", "matrix3d", "translate", "translatex", "translatey", "translatez",
    "translate3d", "scale", "scalex", "scaley", "scalez", "scale3d",
    "rotate", "rotatex", "rotatey", "rotatez", "rotate3d", "skew", "skewx", "skewy",
})


class ImageValidationError(ValueError):
    """内容不满足图片完整性或 SVG 静态文档边界。"""


def _validate_svg_css(value: str) -> None:
    # 转义、注释和自定义资源函数会使浏览器解析结果超出可核验的静态子集。
    if any(token in value for token in ("\\", "/*", "@")):
        raise ImageValidationError("SVG 样式不能包含转义、注释或外部规则。")
    remaining = SVG_CSS_URL.sub("", value)
    if any(match.lower() not in SVG_CSS_FUNCTIONS for match in SVG_CSS_FUNCTION.findall(remaining)):
        raise ImageValidationError("SVG 样式包含不允许的函数或外部资源。")
    if re.search(r"(?:^|[;{])\s*(?:behavior|-moz-binding)\s*:", remaining, re.I):
        raise ImageValidationError("SVG 样式不能包含活动内容。")


def validate_svg(data: bytes, *, enforce_safe_svg: bool = True) -> None:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ImageValidationError("SVG 必须使用有效的 UTF-8 编码。") from exc
    parser = expat.ParserCreate(namespace_separator="}")
    elements: list[str] = []
    style_chunks: list[str] = []
    root_seen = False

    def reject_declaration(*_args):
        raise ImageValidationError("SVG 不允许 DTD、实体声明或处理指令。")

    def start(name: str, attributes: dict[str, str]) -> None:
        nonlocal root_seen
        namespace, _, local = name.rpartition("}")
        if not root_seen:
            if local != "svg" or namespace not in ("", SVG_NAMESPACE):
                raise ImageValidationError("返回的 XML 根元素不是 SVG。")
            root_seen = True
        if enforce_safe_svg:
            if elements and elements[-1] == "style":
                raise ImageValidationError("SVG style 只能包含样式文本。")
            if namespace not in ("", SVG_NAMESPACE) or local not in SVG_STATIC_ELEMENTS:
                raise ImageValidationError(f"SVG 包含不允许的元素：{local}。")
            for attribute, value in attributes.items():
                attribute_namespace, _, attr = attribute.rpartition("}")
                if attribute_namespace not in ("", "http://www.w3.org/1999/xlink", "http://www.w3.org/XML/1998/namespace"):
                    raise ImageValidationError("SVG 包含不允许的属性命名空间。")
                if attr.lower().startswith("on") or attr.lower() in ("src", "base"):
                    raise ImageValidationError(f"SVG 包含不允许的属性：{attr}。")
                if attr.lower() == "href" and not SVG_LOCAL_REFERENCE.fullmatch(value):
                    raise ImageValidationError("SVG 只允许文档内的 #id 引用，不能包含外链或嵌入资源。")
                _validate_svg_css(value)
        elements.append(local)

    def characters(value: str) -> None:
        if enforce_safe_svg and elements and elements[-1] == "style":
            style_chunks.append(value)

    def end(_name: str) -> None:
        if enforce_safe_svg and elements[-1] == "style":
            _validate_svg_css("".join(style_chunks))
            style_chunks.clear()
        elements.pop()

    parser.StartDoctypeDeclHandler = reject_declaration
    parser.EntityDeclHandler = reject_declaration
    parser.ExternalEntityRefHandler = reject_declaration
    parser.ProcessingInstructionHandler = reject_declaration
    parser.StartElementHandler = start
    parser.CharacterDataHandler = characters
    parser.EndElementHandler = end
    try:
        parser.Parse(text, True)
    except expat.ExpatError as exc:
        raise ImageValidationError("返回的 SVG 损坏或不完整，未保存为成功图片。") from exc


def image_extension(data: bytes, *, enforce_safe_svg: bool = True) -> str:
    if data.removeprefix(b"\xef\xbb\xbf").lstrip().startswith(b"<"):
        validate_svg(data, enforce_safe_svg=enforce_safe_svg)
        return ".svg"
    try:
        with Image.open(BytesIO(data)) as image:
            extension = RASTER_EXTENSIONS.get(image.format)
            if extension is None:
                raise ImageValidationError("返回内容不是 PNG、JPEG、WebP、GIF 或 SVG 图片。")
            image.verify()
        with Image.open(BytesIO(data)) as image:
            if image.format == "GIF" and not data.endswith(b";"):
                raise ImageValidationError("返回的 GIF 缺少结束标记，图片不完整。")
            for index in range(getattr(image, "n_frames", 1)):
                image.seek(index)
                image.load()
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, IndexError, EOFError) as exc:
        if isinstance(exc, ImageValidationError):
            raise
        raise ImageValidationError("返回的图片损坏或不完整，未保存为成功图片。") from exc
    return extension
