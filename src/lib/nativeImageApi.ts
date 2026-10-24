import { DEFAULT_PARAMS, type ApiProfile, type TaskParams } from '../types'
import { base64ToBytes } from './dataUrl'
import {
  assertImageInputPayloadSize,
  createRequestTimeoutError,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  isDataUrl,
  isHttpUrl,
  normalizeBase64Image,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'
import { getImageProviderCapabilities, type ImageProviderCapabilities } from './imageProvider'
import { buildImageProviderUrl, createImageProviderHeaders, redactImageProviderError, type ResolvedImageApiDialect } from './imageProviderUrl'
import { apiFetch } from './platform'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseInlineImage(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl)
  if (!match) throw new Error('参考图必须是有效的 Base64 图片 data URL')
  const data = match[2].replace(/\s/g, '')
  if (!base64ToBytes(data).length) throw new Error('参考图没有有效的图片内容')
  return { mimeType: match[1].toLowerCase(), data }
}

function assertNativeOptions(opts: CallApiOptions, profile: ApiProfile, caps: ImageProviderCapabilities) {
  if (!caps.nativeParameters) throw new Error('当前配置未选择原生生图协议')
  if (!opts.prompt.trim()) throw new Error('请输入生图提示词')
  if (opts.maskDataUrl) throw new Error('当前原生生图协议不支持蒙版编辑，请移除蒙版后提交')
  if (opts.nativeTransparentBackground || opts.params.transparent_output) throw new Error('当前原生生图协议不支持透明背景输出，请关闭透明背景后提交')
  if (opts.params.size !== DEFAULT_PARAMS.size) throw new Error('当前原生生图协议不支持 GPT 像素尺寸，请改用宽高比和分辨率')
  if (opts.params.quality !== DEFAULT_PARAMS.quality) throw new Error('当前原生生图协议不支持 GPT 质量参数，请将质量设为自动')
  if (opts.params.moderation !== DEFAULT_PARAMS.moderation) throw new Error('当前原生生图协议不支持 GPT 审核参数，请将审核设为自动')
  if (opts.params.output_compression !== DEFAULT_PARAMS.output_compression) throw new Error('当前原生生图协议不支持 GPT 压缩参数，请清除压缩设置')
  if (opts.params.output_format !== DEFAULT_PARAMS.output_format) throw new Error('当前原生生图协议的图片格式由模型决定，请清除 GPT 输出格式选择')
  if (profile.codexCli) throw new Error('原生生图协议不能使用 Codex CLI 模式，请关闭该选项')
  if (profile.streamImages) throw new Error('当前原生生图协议暂不支持流式图片，请关闭流式传输')
  if (!Number.isInteger(opts.params.n) || opts.params.n < 1 || opts.params.n > caps.maxOutputImages) {
    throw new Error(`当前原生生图协议的输出数量必须是 1–${caps.maxOutputImages} 的整数`)
  }
  if (opts.inputImageDataUrls.length > caps.maxInputImages) throw new Error(`当前原生生图协议最多支持 ${caps.maxInputImages} 张参考图`)
  const ratio = profile.imageAspectRatio?.trim()
  const resolution = profile.imageResolution?.trim()
  if (ratio && ratio !== 'auto' && !caps.aspectRatios.includes(ratio)) throw new Error(`当前原生生图协议不支持宽高比 ${ratio}`)
  if (resolution && resolution !== 'auto' && !caps.resolutions.includes(resolution)) throw new Error(`当前模型不支持分辨率 ${resolution}，可选：${caps.resolutions.join('、')}`)
  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((total, value) => total + value.length, 0))
  opts.inputImageDataUrls.forEach(parseInlineImage)
}

function createNativeRequest(opts: CallApiOptions, profile: ApiProfile, dialect: ResolvedImageApiDialect): { path: string; body: Record<string, unknown> } {
  const aspectRatio = profile.imageAspectRatio && profile.imageAspectRatio !== 'auto' ? profile.imageAspectRatio : undefined
  const resolution = profile.imageResolution && profile.imageResolution !== 'auto' ? profile.imageResolution : undefined
  if (dialect === 'xai') {
    if (opts.inputImageDataUrls.length === 1 && aspectRatio) throw new Error('xAI 单张参考图编辑会沿用输入图比例，请将宽高比设为自动')
    const body: Record<string, unknown> = { model: profile.model, prompt: opts.prompt, n: opts.params.n, response_format: 'b64_json' }
    if (aspectRatio) body.aspect_ratio = aspectRatio
    if (resolution) body.resolution = resolution.toLowerCase()
    if (opts.inputImageDataUrls.length === 1) body.image = { url: opts.inputImageDataUrls[0] }
    if (opts.inputImageDataUrls.length > 1) body.images = opts.inputImageDataUrls.map((url) => ({ url }))
    return { path: opts.inputImageDataUrls.length ? 'images/edits' : 'images/generations', body }
  }

  const model = profile.model.replace(/^models\//, '')
  if (!model || /[\s,:?#]/.test(model)) throw new Error('原生 Google 生图需要一个有效的模型 ID')
  if (dialect === 'gemini-interactions') {
    const input = [
      { type: 'text', text: opts.prompt },
      ...opts.inputImageDataUrls.map((url) => {
        const image = parseInlineImage(url)
        return { type: 'image', mime_type: image.mimeType, data: image.data }
      }),
    ]
    const responseFormat: Record<string, unknown> = { type: 'image', delivery: 'inline' }
    if (aspectRatio) responseFormat.aspect_ratio = aspectRatio
    if (resolution) responseFormat.image_size = resolution
    return { path: 'interactions', body: { model, input, response_format: responseFormat } }
  }
  if (dialect === 'imagen') {
    if (profile.imageApiDialect !== 'imagen') throw new Error('Google 官方 Imagen 接口已停用；只有仍提供旧版 predict 的中转站可手动选择“Imagen 历史兼容”')
    const parameters: Record<string, unknown> = { sampleCount: opts.params.n }
    if (aspectRatio) parameters.aspectRatio = aspectRatio
    if (resolution) parameters.sampleImageSize = resolution
    return { path: `models/${encodeURIComponent(model)}:predict`, body: { instances: [{ prompt: opts.prompt }], parameters } }
  }

  const imageConfig: Record<string, unknown> = {}
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio
  if (resolution) imageConfig.imageSize = resolution
  const generationConfig: Record<string, unknown> = { responseModalities: ['TEXT', 'IMAGE'] }
  if (Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig
  return {
    path: `models/${encodeURIComponent(model)}:generateContent`,
    body: {
      contents: [{ role: 'user', parts: [{ text: opts.prompt }, ...opts.inputImageDataUrls.map((url) => ({ inlineData: parseInlineImage(url) }))] }],
      generationConfig,
    },
  }
}

function getMime(value: unknown, defaultMime?: string): string {
  if (typeof value === 'string' && /^image\/[a-zA-Z0-9.+-]+$/.test(value)) return value.toLowerCase()
  if (value == null && defaultMime) return defaultMime
  throw new Error('生图接口没有返回有效的图片 MIME 类型')
}

function getInlineResult(data: unknown, mimeType: unknown): string {
  if (typeof data !== 'string' || !data.trim()) throw new Error('生图接口返回的图片内容为空')
  const image = normalizeBase64Image(data.trim(), getMime(mimeType))
  parseInlineImage(image)
  return image
}

function collectGoogleImages(payload: Record<string, unknown>, dialect: ResolvedImageApiDialect): string[] {
  if (dialect === 'imagen') {
    if (!Array.isArray(payload.predictions)) throw new Error('Imagen 接口没有返回 predictions[] 图片结果')
    return payload.predictions.map((prediction) => {
      if (!isRecord(prediction)) throw new Error('Imagen 接口返回的图片条目格式无效')
      if (prediction.raiFilteredReason) throw new Error(`Imagen 图片被过滤：${String(prediction.raiFilteredReason)}`)
      return getInlineResult(prediction.bytesBase64Encoded, prediction.mimeType ?? prediction.mime_type)
    })
  }
  if (dialect === 'gemini-interactions') {
    if (typeof payload.status === 'string' && payload.status !== 'completed') throw new Error(`Google Interactions 未完成生图，状态：${payload.status}`)
    if (!Array.isArray(payload.steps)) throw new Error('Google Interactions 接口没有返回 steps[] 图片结果')
    const images: string[] = []
    const texts: string[] = []
    for (const step of payload.steps) {
      if (!isRecord(step)) throw new Error('Google Interactions 返回的步骤格式无效')
      if (step.type !== 'model_output') continue
      if (!Array.isArray(step.content)) throw new Error('Google Interactions 模型输出缺少 content[]')
      for (const part of step.content) {
        if (!isRecord(part)) throw new Error('Google Interactions 返回的内容条目格式无效')
        if (part.type === 'image') images.push(getInlineResult(part.data, part.mime_type))
        if (part.type === 'text' && typeof part.text === 'string') texts.push(part.text)
      }
    }
    if (!images.length) throw new Error(`Google Interactions 没有返回图片${texts.length ? `：${texts.join('\n')}` : ''}`)
    return images
  }

  const feedback = isRecord(payload.promptFeedback) ? payload.promptFeedback : isRecord(payload.prompt_feedback) ? payload.prompt_feedback : {}
  const blockReason = feedback.blockReason ?? feedback.block_reason
  if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw new Error(`Google 生图请求被阻止：${String(blockReason)}`)
  if (!Array.isArray(payload.candidates)) throw new Error('Google 生图接口没有返回 candidates[] 图片结果')
  const images: string[] = []
  const texts: string[] = []
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate)) throw new Error('Google 生图接口返回的候选结果格式无效')
    const reason = candidate.finishReason ?? candidate.finish_reason
    if (typeof reason === 'string' && reason !== 'STOP' && reason !== 'FINISH_REASON_UNSPECIFIED') throw new Error(`Google 生图未正常完成：${reason}`)
    const content = isRecord(candidate.content) ? candidate.content : {}
    if (!Array.isArray(content.parts)) throw new Error('Google 生图候选结果缺少 content.parts[]')
    for (const part of content.parts) {
      if (!isRecord(part)) throw new Error('Google 生图接口返回的内容条目格式无效')
      const inline = isRecord(part.inlineData) ? part.inlineData : isRecord(part.inline_data) ? part.inline_data : undefined
      // thought 图片不是最终交付图片，不能让仅含思考过程的响应成为成功任务。
      if (inline && part.thought !== true) images.push(getInlineResult(inline.data, inline.mimeType ?? inline.mime_type))
      if (typeof part.text === 'string' && part.thought !== true) texts.push(part.text)
    }
  }
  if (!images.length) throw new Error(`Google 生图没有返回图片${texts.length ? `：${texts.join('\n')}` : ''}`)
  return images
}

async function collectXaiImages(payload: Record<string, unknown>, signal: AbortSignal, timeoutSeconds: number): Promise<{ images: string[]; rawImageUrls: string[]; revisedPrompts: Array<string | undefined> }> {
  if (!Array.isArray(payload.data)) throw new Error('xAI 生图接口没有返回 data[] 图片结果')
  const images: string[] = []
  const rawImageUrls = payload.data.filter(isRecord).map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  try {
    for (const item of payload.data) {
      if (!isRecord(item)) throw new Error('xAI 生图接口返回的图片条目格式无效')
      if (item.respect_moderation === false) throw new Error('xAI 生成的图片被审核过滤')
      const mime = getMime(item.mime_type ?? item.mimeType, 'image/jpeg')
      if (typeof item.b64_json === 'string' && item.b64_json.trim()) {
        images.push(getInlineResult(item.b64_json, mime))
      } else if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        const image = await fetchImageUrlAsDataUrl(item.url, mime, signal, timeoutSeconds)
        parseInlineImage(image)
        images.push(image)
      } else {
        throw new Error('xAI 生图接口返回的图片条目缺少 b64_json 或图片 URL')
      }
      revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
    }
  } catch (err) {
    if (rawImageUrls.length && err instanceof Error) Object.assign(err, { rawImageUrls })
    throw err
  }
  return { images, rawImageUrls, revisedPrompts }
}

function resultParams(images: string[]): { actualParams: Partial<TaskParams>; actualParamsList: Array<Partial<TaskParams>> } {
  const actualParamsList = images.map<Partial<TaskParams>>((image) => {
    const mime = parseInlineImage(image).mimeType
    const output_format = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpeg' : mime === 'image/webp' ? 'webp' : undefined
    return output_format ? { output_format } : {}
  })
  return { actualParams: { ...actualParamsList[0], n: images.length }, actualParamsList }
}

export async function callNativeImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const caps = getImageProviderCapabilities(profile)
  assertNativeOptions(opts, profile, caps)
  const request = createNativeRequest(opts, profile, caps.dialect)
  const headers = { ...createImageProviderHeaders(profile, caps.dialect), 'Content-Type': 'application/json' }
  const url = buildImageProviderUrl(profile, request.path, caps.dialect)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    const response = await apiFetch(url, { method: 'POST', headers, body: JSON.stringify(request.body), cache: 'no-store', signal: controller.signal, timeoutSeconds: profile.timeout })
    if (!response.ok) throw new Error(`生图失败：${await getApiErrorMessage(response)}`)
    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new Error('原生生图接口返回的 JSON 格式无效')
    if (payload.error) throw new Error(`生图失败：${typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)}`)
    if (caps.dialect !== 'xai') {
      const images = collectGoogleImages(payload, caps.dialect)
      if (!images.length) throw new Error('原生生图接口没有返回图片')
      return { images, ...resultParams(images) }
    }
    const result = await collectXaiImages(payload, controller.signal, profile.timeout)
    if (!result.images.length) throw new Error('xAI 生图接口没有返回图片')
    return { ...result, ...resultParams(result.images) }
  } catch (err) {
    if (err instanceof Error) {
      const message = redactImageProviderError(err.message, profile.apiKey)
      if (message !== err.message) {
        const redacted = new Error(message)
        redacted.name = err.name
        if ('rawImageUrls' in err) Object.assign(redacted, { rawImageUrls: err.rawImageUrls })
        throw redacted
      }
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
