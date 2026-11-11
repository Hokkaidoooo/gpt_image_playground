"""GIF/SVG 校验候选的纯函数测试；不访问供应商或项目配置。"""
from io import BytesIO
from pathlib import Path
import sys
import unittest
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image_validation import ImageValidationError, image_extension

SAFE_SVG = b'''<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 120 80"><defs><linearGradient id="paint"><stop stop-color="rgb(0, 20, 255)"/></linearGradient><path id="shape" d="M0 0L10 10"/></defs><style>.outline {fill: url(#paint); transform: translate(1px,2px)}</style><use xlink:href="#shape" class="outline"/><text x="5" y="20">Vector</text></svg>'''


def animated_gif():
    frames = [Image.new("RGB", (6, 4), color) for color in ("red", "blue")]
    stream = BytesIO()
    frames[0].save(stream, format="GIF", save_all=True, append_images=frames[1:], duration=[80, 160], loop=0)
    return stream.getvalue()


class ImageValidationTests(unittest.TestCase):
    def test_existing_raster_formats(self):
        for format_name, extension in (("PNG", ".png"), ("JPEG", ".jpg"), ("WEBP", ".webp")):
            with self.subTest(format=format_name):
                stream = BytesIO()
                Image.new("RGB", (5, 3), "green").save(stream, format=format_name)
                data = stream.getvalue()
                self.assertEqual(image_extension(data), extension)

    def test_gif_decodes_every_frame_and_preserves_original_bytes(self):
        data = animated_gif()
        original = bytes(data)
        self.assertEqual(image_extension(data), ".gif")
        self.assertEqual(data, original)
        with Image.open(BytesIO(data)) as image:
            self.assertEqual(image.n_frames, 2)
            self.assertEqual(image.info["loop"], 0)
            durations = []
            colors = []
            for index in range(image.n_frames):
                image.seek(index)
                durations.append(image.info["duration"])
                colors.append(image.convert("RGB").getpixel((0, 0)))
            self.assertEqual(durations, [80, 160])
            self.assertEqual(colors, [(255, 0, 0), (0, 0, 255)])

    def test_gif_missing_trailer_and_truncated_later_frame(self):
        data = animated_gif()
        for broken in (data[:-1], data[:-8], data[:-24] + b";"):
            with self.subTest(length=len(broken)):
                with self.assertRaises(ImageValidationError):
                    image_extension(broken)

    def test_safe_svg_preserves_bytes_and_local_references(self):
        original = bytes(SAFE_SVG)
        self.assertEqual(image_extension(SAFE_SVG), ".svg")
        self.assertEqual(SAFE_SVG, original)
        self.assertEqual(image_extension(b"\xef\xbb\xbf" + SAFE_SVG), ".svg")

    def test_active_elements_are_rejected(self):
        for element in ("script", "foreignObject", "iframe", "animate", "set", "animateTransform", "feImage"):
            with self.subTest(element=element):
                with self.assertRaises(ImageValidationError):
                    image_extension(f'<svg xmlns="http://www.w3.org/2000/svg"><{element}/></svg>'.encode())

    def test_active_attributes_and_external_references_are_rejected(self):
        attributes = [
            'onload="alert(1)"', 'ONCLICK="alert(1)"', 'href="https://outside.example/image"',
            'href="//outside.example/image"', 'href="data:image/png;base64,aA=="',
            'href="javascript:alert(1)"', 'href="javas&#99;ript:alert(1)"',
            'xml:base="https://outside.example"', 'src="https://outside.example"',
            'xlink:href="file:///C:/private.svg"',
        ]
        for attrs in attributes:
            with self.subTest(attrs=attrs):
                with self.assertRaises(ImageValidationError):
                    image_extension(f'<svg xmlns:xlink="http://www.w3.org/1999/xlink"><image {attrs}/></svg>'.encode())

    def test_css_external_fetch_and_obfuscation_are_rejected(self):
        styles = [
            'fill:url(https://outside.example/p.svg#x)', 'fill:u\\72l(https://outside.example)',
            '@import "https://outside.example/style.css";', 'fill:u/**/rl(https://outside.example)',
            'fill:image-set("https://outside.example/a.png" 1x)',
            'fill:-webkit-image-set("https://outside.example/a.png" 1x)',
            'fill:src("https://outside.example/a.png")', 'fill:expression(alert(1))',
            'behavior:https://outside.example', '-moz-binding:https://outside.example',
        ]
        for style in styles:
            with self.subTest(style=style):
                with self.assertRaises(ImageValidationError):
                    image_extension(f'<svg><style>{style}</style></svg>'.encode())
        with self.assertRaises(ImageValidationError):
            image_extension(b'<svg><style>rect{fill:u<![CDATA[rl]]>(https://outside.example)}</style></svg>')

    def test_xml_hard_boundaries_even_when_static_filter_is_off(self):
        documents = [
            b'<!DOCTYPE svg><svg/>', b'<!DOCTYPE svg [<!ENTITY x "text">]><svg>&x;</svg>',
            b'<!DOCTYPE svg SYSTEM "https://outside.example/a.dtd"><svg/>',
            b'<?xml-stylesheet href="https://outside.example/a.css"?><svg/>',
            b'<svg>', b'<html/>', b'<svg xmlns="https://outside.example"/>',
        ]
        for enabled in (True, False):
            for data in documents:
                with self.subTest(enabled=enabled, data=data[:35]):
                    with self.assertRaises(ImageValidationError):
                        image_extension(data, enforce_safe_svg=enabled)

    def test_explicit_switch_disables_static_content_filter(self):
        content = b'<svg><script>text only in test</script></svg>'
        with self.assertRaises(ImageValidationError):
            image_extension(content)
        self.assertEqual(image_extension(content, enforce_safe_svg=False), ".svg")

    def test_unknown_raster_and_non_utf8_svg_are_rejected(self):
        stream = BytesIO()
        Image.new("RGB", (4, 3)).save(stream, format="BMP")
        for data in (stream.getvalue(), b'<svg>\xff</svg>', b'not an image'):
            with self.subTest(data=data[:10]):
                with self.assertRaises(ImageValidationError):
                    image_extension(data)


if __name__ == "__main__":
    unittest.main()
