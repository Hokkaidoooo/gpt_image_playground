# Windows 本机生图服务

这个附件为 GPT Image Playground 提供本机网页入口、供应商请求转发和图片自动保存。只监听 `127.0.0.1`，支持 Windows 10/11、Python 3.10 或更新版本。

## 启动

在仓库根目录执行：

```powershell
npm ci
$env:VITE_DEFAULT_API_URL='__LOCAL_IMAGE_PRESET__'
npm run build
python -m pip install -r local-server\requirements.txt
.\local-server\start.ps1
```

也可以双击 `local-server\start.cmd`。启动器依次查找 `local-server\.venv`、Windows Python Launcher 的 `py -3`、PATH 中的 `python`，并检查 Python 版本及 Pillow。

页面默认打开 `http://127.0.0.1:17865`。在“设置 → API 配置”填写自己的供应商地址、API Key 和模型。附件不提供任何供应商密钥或预置账号。

服务运行时保留启动窗口；按 `Ctrl+C` 停止。需要指定 Python、输出目录或端口时：

```powershell
.\local-server\start.ps1 -Python 'C:\Python312\python.exe' -OutputDir 'D:\Images' -Port 17866
```

直接用 Python 启动也可以：

```powershell
python -B local-server\gui_server.py --serve --open --output-dir 'D:\Images'
```

## 文件与配置

- `dist`：网页构建目录，默认位于仓库根目录。用 `--dist-dir` 或环境变量 `IMAGE_GUI_DIST_DIR` 指定其他构建目录；PowerShell 对应 `-DistDir`。
- `local-server\data`：默认图片、提示词记录及错误日志目录。用 `--output-dir` 或环境变量 `IMAGE_GUI_OUTPUT_DIR` 指定；PowerShell 对应 `-OutputDir`。
- `最近错误.log`：保留最后一次后端错误；完整任务历史在当前浏览器的本机站点数据中。
- `gui_settings.example.json`：可复制为 `gui_settings.json` 后修改，或通过 `--config` / `-Config` 指定配置文件。没有配置文件时采用默认值。

服务配置包括：

| 配置项 | 默认值 | 作用 |
|---|---:|---|
| `port` | 17865 | 本机端口；命令行端口优先 |
| `save_generated_images` | true | 完整校验图片后自动保存；false 时仍保留浏览器中的图片 |
| `enforce_safe_svg` | true | SVG 仅允许静态元素与文档内资源；false 关闭静态内容筛选，XML 完整性和 DTD/实体/处理指令禁用始终生效 |
| `serialize_image_requests` | true | 同一时间只转发一个供应商请求；并发请求按顺序等待，取消的等待请求不会转发 |
| `max_upload_mb` | 512 | 单次上传大小上限 |
| `enforce_local_origin` | true | 校验本机网页来源；false 关闭来源校验，会话凭据仍必需 |
| `enforce_private_data_directory` | true | 禁止数据目录和网页目录重叠，避免数据作为网页资源被读取；false 关闭目录校验 |

保留最后两项为 `true`。上传或分享代码前，不要把图片、提示词、日志、API Key 或本机配置放入 `dist`。默认数据和配置文件已列入 `.gitignore`；自己指定的输出目录若位于仓库内，也应加入忽略规则。

## 密钥与隐私

通过网页填写的 API Key 保存在当前浏览器的本机站点存储中，请勿公开浏览器数据或包含密钥的配置导出文件。网页请求由本机服务发送到所选供应商；提示词和参考图按所选操作传给该供应商。

如需沿用本工具的旧版 DPAPI 加密配置，可将自己的 `settings.json` 放入当前输出目录。页面只收到密钥占位符；服务在请求时解密，并将它限制在该配置的供应商来源。DPAPI 依赖 Windows 用户环境，不能承诺换电脑或换账号后仍可解密。新用户无需此文件。

## 错误处理

- 提示“网页版尚未构建”：在仓库根目录运行 `npm run build`，或指定正确的 `--dist-dir`。
- 端口占用：关闭使用该端口的旧服务，或选择其他端口。改变端口会使用另一个浏览器站点存储。
- 提示缺少 Pillow：用启动服务的同一个 Python 安装 `requirements.txt`。
- 已生成但保存失败：浏览器保留收到的图片；先下载图片并检查输出目录，避免重复生成。
- 供应商返回错误：页面保留真实错误；服务不会自动更换供应商或重发生图请求。

## 本机验证

```powershell
python -B -m unittest discover -s local-server\tests -v
```

验证使用临时目录和独立的 `127.0.0.1` HTTP 供应商，检查启动、无密钥预置、鉴权、来源校验、转发、错误脱敏及完整图片保存，不发送外部供应商请求。

## 开源归属

本项目基于 CookSleep 的 GPT Image Playground 二次开发。本附件沿用仓库的 MIT 许可证；原作者的版权声明保留在 `LICENSE` 中。


## GIF 与 SVG

保存 PNG、JPEG、WebP、GIF 和 SVG。GIF 逐帧解码校验后原样保存，保留动画帧、时长和循环设置。SVG 保留原始 UTF-8 字节，可在图库下载和本机输出目录读取。

默认 `enforce_safe_svg: true`：允许静态图形、文字、渐变、滤镜、样式及 `#id` 文档内引用；拒绝脚本、事件属性、外部资源、嵌入资源、foreignObject、动态元素及不能明确校验的 CSS 语法。内容不符合规则时明确返回错误，不会删除或改写 SVG 内容。设置 `enforce_safe_svg: false` 并重启服务可关闭静态内容筛选；DTD、实体声明和处理指令始终拒绝，防止 XML 解析访问外部资源。
