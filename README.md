# GPT Image Playground · 本地兼容增强版

基于 [CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground) 的二次开发，面向 Windows 本地部署和多供应商图片 API。保留原项目作者与 MIT 许可；本分支的上游基础版本为 **v0.8.1**。

## 本分支的改进

| 使用场景 | 提供的能力 |
| --- | --- |
| 切换不同供应商 | 独立地址、密钥和模型配置；模型发现；显式选择 OpenAI Images、xAI、Gemini 等协议 |
| 参数支持不一致 | 自动、标准、自定义兼容规则；按供应商使用默认参数；设置与请求组装共用规则 |
| 多张生成容易超时 | 顺序分批、逐批独立超时；每张完成即保存；失败后停止后续请求 |
| 部分图片已完成 | 保留结果，只补齐缺失图片；关联补齐任务，阻止重复提交 |
| 参考图超过上传上限 | 本机校验真实格式；超限时优化上传副本；透明通道与遮罩尺寸保持一致；保留原图 |
| 本机保存与隐私 | 仅监听127.0.0.1的Python桥接、会话认证、图片完整性校验、浏览器图库与文件归档 |

生成由所选供应商的远程 API 完成。本地运行的是界面、请求桥接、参考图处理和结果保存；无需在本机安装图像模型或配置 GPU。

## Windows 本地启动

需要 Node.js 20.19+、Python 3.10+，以及所选供应商的 API Key。

```powershell
git clone --branch local-image-gui https://github.com/Hokkaidoooo/gpt_image_playground.git
cd gpt_image_playground
npm ci
$env:VITE_DEFAULT_API_URL='__LOCAL_IMAGE_PRESET__'
npm run build
python -m pip install -r .\local-server
equirements.txt
.\local-server\start.ps1
```

具体启动参数、数据目录和配置见 [本机服务说明](local-server/README.md)。在页面中添加供应商后，输入提示词即可生成；兼容规则位于「设置 → API 配置 → 图片接口兼容性」。

## 图片与密钥

- 原始参考图保留；超限时处理上传副本，调整记录显示在任务详情中。
- 自动兼容对第三方 Images 接口采用14 MB上传上限，给常见15 MB限制留出余量。可自定义上限或切换保留原图模式。
- 密钥由用户在本机填写，浏览器配置按原项目机制保存在本地；公开仓库不包含供应商密钥、个人图片、提示词和运行记录。
- 524等远端网关超时需要供应商处理。失败不会自动重新发送付费生成请求；已返回任务ID的异步接口按其契约恢复查询。

## 开发与验证

```powershell
npm test
npm run build
python -m unittest discover -s local-server/tests
```

单元测试覆盖参数契约、逐批保存、部分成功补齐、取消、输入图片处理和错误信息。服务测试使用本机HTTP端点，不调用付费供应商。

本仓库采用 React、TypeScript、Vite、Zustand 和 Python。核心模块：

- `src/lib/imageRequestCompatibility.ts`：兼容规则、配置校验与供应商能力解析。
- `src/lib/imageInputPreparation.ts`：参考图格式检查、上传副本优化与遮罩联动。
- `src/lib/openaiCompatibleImageApi.ts`：图片接口调用和分批执行。
- `src/lib/taskState.ts`、`src/store.ts`：任务持久化、中断恢复与补齐关系。
- `local-server/`：本机代理和图片归档。

## 项目来源与分支

- [上游项目](https://github.com/CookSleep/gpt_image_playground)：原始界面、图库、编辑器、Agent及其他基础能力。
- [上游说明](README.upstream.md)：保留的原项目README。
- `local-image-gui`：本仓库的本地兼容增强分支。
- `main`：上游基线，可用于跟踪更新。

[MIT License](LICENSE)
