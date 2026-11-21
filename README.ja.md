# GPT Image Playground · Windows ローカル版

[简体中文](README.md) · [English](README.en.md) · [Español](README.es.md) · 日本語

このフォークの `local-image-gui` ブランチでは、[CookSleep の GPT Image Playground](https://github.com/CookSleep/gpt_image_playground) に Windows 用の中継サービスとプロバイダー別の設定を追加しています。テキストから画像を生成し、参照画像やマスクで編集して、ギャラリーで結果を確認できます。OpenAI Images、xAI、Gemini など、接続先に対応した方式を選んでください。使えるモデル、設定項目、出力形式は接続先によって異なります。

## Windows で起動する

Windows 10 または 11、Node.js 22.13 以降の 22.x、Python 3.10 以降を用意し、PowerShell で次のコマンドを順に実行します。

```powershell
git clone --branch local-image-gui https://github.com/Hokkaidoooo/gpt_image_playground.git
cd gpt_image_playground
npm ci
$env:VITE_DEFAULT_API_URL='__LOCAL_IMAGE_PRESET__'
npm run build
python -m pip install -r .\local-server\requirements.txt
.\local-server\start.ps1
```

1. ローカルサービスが起動するまで待ちます。
2. ブラウザーが自動で開かない場合は `http://127.0.0.1:17865` を開きます。**設定 → API 設定**（画面表示は `设置 → API 配置`）で、接続先 URL、API キー、モデルを入力します。接続先が一部の項目にしか対応しない場合は、画像 API の互換性設定を調整します。
3. プロンプトを入力して画像を生成し、ギャラリーで確認します。既定では、検証済みの画像は `local-server\data` にも保存されます。終了するには `Ctrl+C` を押します。

## データの扱いと制限

- 画面と中継サービスは手元の端末で動作し、画像生成はプロバイダー側で行われます。ローカル GPU は不要です。操作に応じてプロンプトや参照画像が送信され、料金やデータの扱いは接続先の規定に従います。
- 中継サービスは `127.0.0.1` のみで待ち受けます。入力したキーはブラウザーのサイトデータに保存されるため、キーを含む設定のエクスポートは共有しないでください。
- 互換モードでは元画像を上書きせず、アップロード用のコピーを最適化できます。複数枚の生成が途中で失敗した場合は、不足分だけを追加でリクエストできます。有料の生成リクエストは自動で再送されません。

[ローカルサービスの説明（中国語）](local-server/README.md)：ポート、保存先、エラー対処 · [上流の README](README.upstream.md) · [MIT ライセンス](LICENSE)、著作権者 CookSleep。
