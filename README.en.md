# GPT Image Playground · Windows local edition

[简体中文](README.md) · English · [Español](README.es.md) · [日本語](README.ja.md)

The `local-image-gui` branch of this fork extends [CookSleep’s GPT Image Playground](https://github.com/CookSleep/gpt_image_playground) with a Windows bridge and per-provider API profiles. Generate from a prompt, edit with reference images or masks, and review results in the gallery. Choose the protocol your provider supports, such as OpenAI Images, xAI, or Gemini. Models, parameters, and output formats vary by endpoint.

## Start on Windows

Use Windows 10 or 11, Node.js 22.13 or later in the 22.x series, and Python 3.10+. Run these commands in PowerShell:

```powershell
git clone --branch local-image-gui https://github.com/Hokkaidoooo/gpt_image_playground.git
cd gpt_image_playground
npm ci
$env:VITE_DEFAULT_API_URL='__LOCAL_IMAGE_PRESET__'
npm run build
python -m pip install -r .\local-server\requirements.txt
.\local-server\start.ps1
```

1. Wait for the local service to start.
2. Open `http://127.0.0.1:17865` if the browser does not open automatically. In **Settings → API configuration** (`设置 → API 配置`), enter your provider URL, API key, and model. Use the image API compatibility settings when the provider accepts only certain parameters.
3. Enter a prompt and generate. The gallery shows the result; the bridge also saves validated images to `local-server\data` by default. Press `Ctrl+C` to stop it.

## Data and limits

- The interface and bridge run locally, while generation runs on the selected provider. No local GPU is needed. Prompts and reference images are sent as needed; the provider’s prices and data policies apply.
- The bridge listens only on `127.0.0.1`. Keys entered in the UI stay in the browser’s site storage. Do not share configuration exports that contain keys.
- Compatibility mode can optimize an upload copy without overwriting the original. After a partial batch failure, you can request just the missing images. The bridge does not automatically repeat paid generation requests.

[Local service guide (Chinese)](local-server/README.md) for ports, output paths, and troubleshooting · [Preserved upstream README](README.upstream.md) · [MIT license](LICENSE), copyright CookSleep.
