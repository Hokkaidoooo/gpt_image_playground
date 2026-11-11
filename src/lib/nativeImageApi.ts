import { DEFAULT_PARAMS, type ApiProfile, type TaskParams } from '../types'
import { base64ToBytes } from './dataUrl'
import {
  assertImageInputPayloadSize,
  createRequestTimeoutError,
  getApiErrorMessage,
  normalizeBase64Image,
  runSequentialImageRequests,
  type CallApiOptions,
  type CallApiResult,
} from './imageApiShared'
import { getImageProviderCapabilities, type ImageProviderCapabilities } from './imageProvider'
import { buildImageProviderUrl, createImageProviderHeaders, redactImageProviderError, type ResolvedImageApiDialect } from './imageProviderUrl'
import { apiFetch } from './platform'
import { callGoogleImageApi } from './googleImageApi'
import { callModelImagesApi } from './openaiCompatibleImageApi'
import { supportsGrokQuality } from './imageModels'

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
  if (opts.maskDataUrl) throw new Error('当前原生生图协议不支持遮罩编辑，请移除遮罩后提交')
  if (opts.nativeTransparentBackground || opts.params.transparent_output) throw new Error('当前原生生图协议不支持透明背景输出，请关闭透明背景后提交')
  if (opts.params.size !== DEFAULT_PARAMS.size) throw new Error('当前原生生图协议不支持 GPT 像素尺寸，请改用宽高比和分辨率')
  if (opts.params.quality !== DEFAULT_PARAMS.quality && !(caps.dialect === 'xai' && supportsGrokQuality(profile.model) && ['low', 'medium'].includes(opts.params.quality))) throw new Error('当前原生生图协议不支持 GPT 质量参数，请将质量设为自动')
  if (opts.params.moderation !== DEFAULT_PARAMS.moderation) throw new Error('当前原生生图协议不支持 GPT 审核参数，请将审核设为自动')
  if (opts.params.output_compression !== DEFAULT_PARAMS.output_compression) throw new Error('当前原生生图协议不支持 GPT 压缩参数，请清除压缩设置')
  if (opts.params.output_format !== DEFAULT_PARAMS.output_format) throw new Error('当前原生生图协议的图片格式由模型决定，请清除 GPT 输出格式选择')
  if (profile.codexCli) throw new Error('原生生图协议不能使用 Codex CLI 模式，请关闭该选项')
  if (profile.streamImages) throw new Error('当前原生生图协议暂不支持流式图片，请关闭流式传输')
  if (!Number.isInteger(opts.params.n) || opts.params.n < 1 || opts.params.n > caps.maxOutputImages) {
    throw new Error(`当前原生生图协议的输出数量必须是 1–${caps.maxOutputImages} 的整数`)
  }
  if (opts.inputImageDataUrls.length > caps.maxInputImages) throw new Error(`当前原生生图协议最多支持 ${caps.maxInputImages} 张参考图`)
  const ratio = opts.params.aspect_ratio?.trim()
  const resolution = opts.params.resolution?.trim()
  if (ratio && ratio !== 'auto' && !caps.aspectRatios.includes(ratio)) throw new Error(`当前原生生图协议不支持宽高比 ${ratio}`)
  if (resolution && resolution !== 'auto' && !caps.resolutions.includes(resolution)) throw new Error(`当前模型不支持分辨率 ${resolution}，可选：${caps.resolutions.join('、')}`)
  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((total, value) => total + value.length, 0))
  opts.inputImageDataUrls.forEach(parseInlineImage)
}

function createNativeRequest(opts: CallApiOptions, profile: ApiProfile, dialect: ResolvedImageApiDialect): { path: string; body: Record<string, unknown> } {
  const aspectRatio = opts.params.aspect_ratio && opts.params.aspect_ratio !== 'auto' ? opts.params.aspect_ratio : undefined
  const resolution = opts.params.resolution && opts.params.resolution !== 'auto' ? opts.params.resolution : undefined
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

  throw new Error('未配置原生生图协议')
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

  throw new Error('未配置Google结果解析协议')
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
  if (caps.dialect === 'gemini') return callGoogleImageApi(opts, profile)
  if (caps.dialect === 'xai') {
    try {
      return await runSequentialImageRequests(opts, caps.maxOutputImages, (batch) => callModelImagesApi(batch, { ...profile, provider: 'xai' }))
    } catch (error) {
      if (!(error instanceof Error)) throw error
      const message = redactImageProviderError(error.message, profile.apiKey)
      if (message !== error.message) throw Object.assign(new Error(message), { name: error.name, ...('rawImageUrls' in error ? { rawImageUrls: error.rawImageUrls } : {}) })
      throw error
    }
  }
  return runSequentialImageRequests(opts, caps.dialect === 'gemini-interactions' ? 1 : caps.maxOutputImages, (batch) => callNativeImageApiSingle(batch, profile, caps))
}

async function callNativeImageApiSingle(opts: CallApiOptions, profile: ApiProfile, caps: ImageProviderCapabilities): Promise<CallApiResult> {
  const request = createNativeRequest(opts, profile, caps.dialect)
  const headers = { ...createImageProviderHeaders(profile, caps.dialect), 'Content-Type': 'application/json' }
  const url = buildImageProviderUrl(profile, request.path, caps.dialect)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
    const response = await apiFetch(url, { method: 'POST', headers, body: JSON.stringify(request.body), cache: 'no-store', signal: controller.signal, timeoutSeconds: profile.timeout })
    if (!response.ok) throw new Error(`生图失败：${await getApiErrorMessage(response)}`)
    const payload: unknown = await response.json()
    if (!isRecord(payload)) throw new Error('原生生图接口返回的 JSON 格式无效')
    if (payload.error) throw new Error(`生图失败：${typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)}`)
    const images = collectGoogleImages(payload, caps.dialect)
    if (!images.length) throw new Error('原生生图接口没有返回图片')
    return { images, ...resultParams(images) }
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
