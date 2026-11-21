# GPT Image Playground · edición local para Windows

[简体中文](README.md) · [English](README.en.md) · Español · [日本語](README.ja.md)

La rama `local-image-gui` de este fork añade un puente para Windows y perfiles por proveedor a [GPT Image Playground de CookSleep](https://github.com/CookSleep/gpt_image_playground). Genera imágenes a partir de texto, edítalas con referencias o máscaras y consulta los resultados en la galería. Selecciona el protocolo que admita tu proveedor, como OpenAI Images, xAI o Gemini. Los modelos, parámetros y formatos dependen de la API elegida.

## Inicio en Windows

Usa Windows 10 u 11, Node.js 22.13 o posterior de la serie 22, y Python 3.10 o posterior. Ejecuta estos comandos en PowerShell:

```powershell
git clone --branch local-image-gui https://github.com/Hokkaidoooo/gpt_image_playground.git
cd gpt_image_playground
npm ci
$env:VITE_DEFAULT_API_URL='__LOCAL_IMAGE_PRESET__'
npm run build
python -m pip install -r .\local-server\requirements.txt
.\local-server\start.ps1
```

1. Espera a que se inicie el servicio local.
2. Abre `http://127.0.0.1:17865` si el navegador no se abre solo. En **Ajustes → Configuración de API** (`设置 → API 配置`), introduce la URL, la clave y el modelo del proveedor. Ajusta la compatibilidad de la API de imágenes si el proveedor solo admite ciertos parámetros.
3. Escribe una instrucción y genera una imagen. Puedes verla en la galería; por defecto, el puente guarda las imágenes validadas en `local-server\data`. Pulsa `Ctrl+C` para detenerlo.

## Datos y límites

- La interfaz y el puente se ejecutan en tu equipo; las imágenes se generan en el proveedor. No necesitas una GPU local. Las instrucciones y referencias se envían según la operación y se aplican las tarifas y políticas de datos del proveedor.
- El puente solo escucha en `127.0.0.1`. Las claves introducidas en la interfaz quedan en el almacenamiento del sitio en ese navegador. No compartas exportaciones que contengan claves.
- El modo de compatibilidad puede optimizar una copia para la carga sin sobrescribir el original. Si falla parte de un lote, puedes solicitar solo las imágenes que falten. El puente no repite automáticamente las solicitudes de generación de pago.

[Guía del servicio local (en chino)](local-server/README.md) para puertos, carpetas de salida y errores · [README original conservado](README.upstream.md) · [Licencia MIT](LICENSE), copyright CookSleep.
