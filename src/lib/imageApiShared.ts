import { OUTPUT_FORMATS, type ApiProfile, type AppSettings, type ImageSearchGrounding, type ResponsesOutputItem, type TaskParams, type TaskRecord } from '../types'
import { blobToDataUrl } from './dataUrl'
import { DEFAULT_SVG_MODEL } from './imageModels'
import { apiFetch, isTauri } from './platform'
import { hasLocalImageBridge } from './localRuntime'

export const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  gif: 'image/gif',
}

/** GPT Image 2.6 的 complexity、SVG 和 GIF 字段；Images API 生成请求和 Responses 图像工具格式相同 */
export function applyGptImage26Params(target: Record<string, unknown>, params: TaskParams, profile: ApiProfile) {
  if (params.complexity !== 'auto') target.complexity = params.complexity
  if (params.output_format === 'svg') {
    target.svg = { model: profile.svgModel?.trim() || DEFAULT_SVG_MODEL }
  }
  if (params.output_format === 'gif') {
    target.frame_count = params.frame_count
    target.frame_duration_ms = params.frame_duration_ms
  }
}

export const MAX_MASK_EDIT_FILE_BYTES = 50 * 1024 * 1024
export const MAX_IMAGE_INPUT_PAYLOAD_BYTES = 512 * 1024 * 1024
export const PROMPT_REWRITE_GUARD_PREFIX = 'Treat everything after this line as one complete image-generation prompt, including the resolution instruction. Follow it exactly without rewriting or omitting anything:'

export interface CallApiOptions {
  settings: AppSettings
  prompt: string
  params: TaskParams
  nativeTransparentBackground?: boolean
  /** 输入图片的 data URL 列表 */
  inputImageDataUrls: string[]
  /** 与 inputImageDataUrls 按索引对齐的原链接，不是通过链接添加的为 null */
  inputImageUrls?: (string | null)[]
  maskDataUrl?: string
  /** 第一张输入图上的透明标注层，仅 Images API 编辑接口原生支持 */
  markupDataUrl?: string
  skipCodexCliSizePrompt?: boolean
  shouldContinue?: () => boolean
  onInputImagesPrepared?: (adjustments: string[]) => void | Promise<void>
  onRequestCompleted?: (result: CallApiResult, requestIndex: number) => Promise<void>
  onPromptHintsPrepared?: (hints: TaskRecord['promptHints']) => void | Promise<void>
  onFalRequestEnqueued?: (request: { requestId: string; endpoint: string }) => void
  onCustomTaskEnqueued?: (task: { taskId: string }) => void | Promise<void>
  onPartialImage?: (partial: { image: string; partialImageIndex?: number; requestIndex?: number }) => void
}

export interface CallApiResult {
  /** 已取得图片，但结果数量或保存过程需要用户处理。 */
  completionError?: string
  inputImageAdjustments?: string[]
  searchGrounding?: ImageSearchGrounding[]
  /** base64 data URL 列表 */
  images: string[]
  /** API 返回的实际生效参数 */
  actualParams?: Partial<TaskParams>
  /** 每张图片对应的实际生效参数 */
  actualParamsList?: Array<Partial<TaskParams> | undefined>
  /** 每张图片对应的 API 改写提示词 */
  revisedPrompts?: Array<string | undefined>
  /** API 返回的原始图片 HTTP URL（非 base64 时记录） */
  rawImageUrls?: string[]
  /** 按目标图片槽位记录失败或尚未发送的请求。 */
  failedRequests?: Array<{ requestIndex: number; error: string }>
}

export function isHttpUrl(value: unknown): value is string {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function isDataUrl(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('data:')
}

export function normalizeBase64Image(value: string, fallbackMime: string): string {
  if (value.startsWith('data:')) return value
  const mime = value.startsWith('/9j/') ? 'image/jpeg' : value.startsWith('iVBORw0KGgo') ? 'image/png' : value.startsWith('UklGR') ? 'image/webp' : fallbackMime
  return `data:${mime};base64,${value}`
}

export function getResponsesImageResultBase64(result: ResponsesOutputItem['result']): string | undefined {
  const b64 = typeof result === 'string'
    ? result
    : result && typeof result === 'object'
    ? typeof result.b64_json === 'string'
      ? result.b64_json
      : typeof result.base64 === 'string'
      ? result.base64
      : typeof result.image === 'string'
      ? result.image
      : typeof result.data === 'string'
      ? result.data
      : ''
    : ''

  return b64.trim() ? b64 : undefined
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
}

export function getDataUrlEncodedByteSize(dataUrl: string): number {
  return dataUrl.length
}

export function getDataUrlDecodedByteSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(',')
  if (commaIndex < 0) return dataUrl.length

  const meta = dataUrl.slice(0, commaIndex)
  const payload = dataUrl.slice(commaIndex + 1)
  if (!/;base64/i.test(meta)) return decodeURIComponent(payload).length

  const normalized = payload.replace(/\s/g, '')
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding)
}

function assertMaxBytes(label: string, bytes: number, maxBytes: number) {
  if (bytes > maxBytes) {
    throw new Error(`${label}过大：${formatMiB(bytes)}，上限为 ${formatMiB(maxBytes)}`)
  }
}

export function assertImageInputPayloadSize(bytes: number) {
  assertMaxBytes('图像输入有效负载总大小', bytes, MAX_IMAGE_INPUT_PAYLOAD_BYTES)
}

export function assertMaskEditFileSize(label: string, bytes: number) {
  assertMaxBytes(label, bytes, MAX_MASK_EDIT_FILE_BYTES)
}

const IMAGE_TOOL_DROPPED_ERROR = /Tool choice 'required' must be specified with 'tools' parameter\./i
export const IMAGE_TOOL_DROPPED_HINT = '提示：当前使用的 API 可能未正确转发图像生成工具，请尝试更换支持该工具的接口或模型。'
export const IMAGE_FETCH_CORS_HINT = ' 可点链接按钮复制结果链接，或尝试开启「返回 Base64 图片数据」避免此问题。'
export const STREAMING_UNSUPPORTED_HINT = '提示：当前使用的 API 可能不支持流式传输，请尝试关闭「流式传输」功能。'
export const STREAMING_FORMAT_HINT = '提示：API 返回了无法解析的流式数据格式，请尝试关闭「流式传输」功能。'
export const TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT = '提示：当前使用的 API 不支持为该模型使用原生透明背景，请将「透明背景实现方式」切换为「本地后处理」。'

export function appendStreamingUnsupportedHint(message: string): string {
  return message ? `${message}\n${STREAMING_UNSUPPORTED_HINT}` : STREAMING_UNSUPPORTED_HINT
}

export function appendStreamingFormatHint(message: string): string {
  return message ? `${message}\n${STREAMING_FORMAT_HINT}` : STREAMING_FORMAT_HINT
}

export function maybeAppendTransparentBackgroundHint(message: string): string {
  if (!/transparent background is not supported for this model\.?/i.test(message)) return message
  return `${message}\n${TRANSPARENT_BACKGROUND_UNSUPPORTED_HINT}`
}

/** 部分 API 转发 Responses 请求时会丢弃 image_generation 工具，却保留 tool_choice，服务端因此报错 */
export function maybeAppendImageToolDroppedHint(message: string): string {
  if (!IMAGE_TOOL_DROPPED_ERROR.test(message)) return message
  return `${message}\n${IMAGE_TOOL_DROPPED_HINT}`
}

/** 请求超时中止时使用的原因，替代浏览器默认的英文“signal is aborted without reason”；仍为 AbortError，不改变错误分类 */
export function createRequestTimeoutError(timeoutSeconds: number) {
  return new DOMException(`请求超时：超过 ${timeoutSeconds} 秒仍未完成，请稍后重试或提高超时时间。`, 'AbortError')
}

/** 排除明确与流式无关的状态码后追加提示 */
export function maybeAppendStreamingHint(message: string, status: number, streamImages?: boolean): string {
  const transparentMessage = maybeAppendTransparentBackgroundHint(message)
  if (transparentMessage !== message) return transparentMessage
  if (IMAGE_TOOL_DROPPED_ERROR.test(message)) return message
  if (!streamImages) return message
  if (status === 401 || status === 403 || status === 404 || status === 408 || status === 429 || status >= 500) {
    return message
  }
  return appendStreamingUnsupportedHint(message)
}

async function probeNoCorsReachability(url: string, timeoutMs = 8000): Promise<'opaque' | 'reachable' | 'failed'> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      method: 'GET',
      mode: 'no-cors',
      cache: 'no-store',
      signal: controller.signal,
    })
    return response.type === 'opaque' ? 'opaque' : 'reachable'
  } catch {
    return 'failed'
  } finally {
    clearTimeout(timeoutId)
  }
}

export async function fetchImageUrlAsDataUrl(url: string, fallbackMime: string, signal?: AbortSignal, timeoutSeconds?: number): Promise<string> {
  if (isDataUrl(url)) return url

  let response: Response
  try {
    response = await apiFetch(url, {
      cache: 'no-store',
      signal,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    })
  } catch (err) {
    if (err instanceof TypeError) {
      // 客户端由 Rust 侧发出请求，不存在跨域问题，也不需要 no-cors 探测
      if (isTauri || hasLocalImageBridge()) throw new Error('图片链接下载失败，请查看链接是否过期或网络是否中断；本次没有重新发送生图请求。')
      const probe = await probeNoCorsReachability(url)
      if (probe === 'opaque') {
        throw new Error(`图片已生成，但因服务商未允许跨域，图片链接下载失败。${IMAGE_FETCH_CORS_HINT}`)
      }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        throw new Error(`图片链接下载失败（网络不可用）。${IMAGE_FETCH_CORS_HINT}`)
      }
      throw new Error(`图片链接下载失败（可能因跨域限制、链接过期或网络异常）。${IMAGE_FETCH_CORS_HINT}`)
    }
    throw err
  }

  if (!response.ok) {
    throw new Error(`图片 URL 下载失败：HTTP ${response.status}`)
  }

  const blob = await response.blob()
  return blobToDataUrl(blob, fallbackMime)
}

const MODERATION_STAGE_LABELS: Record<string, string> = {
  input: '提示词或参考图',
  output: '生成结果',
}

/** moderation_blocked 错误可能附带拦截阶段和粗粒度类别 */
export function appendModerationDetails(message: string, details: unknown): string {
  if (!details || typeof details !== 'object') return message
  const record = details as Record<string, unknown>
  const stage = typeof record.moderation_stage === 'string' ? MODERATION_STAGE_LABELS[record.moderation_stage] : undefined
  const categories = Array.isArray(record.categories)
    ? record.categories.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : []
  const parts = [
    stage ? `拦截来源：${stage}` : '',
    categories.length ? `类别：${categories.join('、')}` : '',
  ].filter(Boolean)
  return parts.length ? `${message}\n${parts.join('；')}` : message
}

export async function getApiErrorMessage(response: Response): Promise<string> {
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    return `HTTP ${response.status}：无法读取供应商错误响应：${error instanceof Error ? error.message : String(error)}`
  }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : {}
  const candidates = [error.message, record.detail, record.error, record.message]
  const detail = candidates.find((value) => typeof value === 'string' && value.trim())
  const details = Array.isArray(record.detail)
    ? record.detail.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n')
    : undefined
  const message = appendModerationDetails(typeof detail === 'string' ? detail : details || text.trim(), error.moderation_details)
  const readable = /<(?:!doctype|html|head|body)\b/i.test(message)
    ? message.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 600)
    : message
  let hint = ''
  if (response.status === 524 || /error code:\s*524/i.test(message)) {
    hint = '供应商网关等待生成结果超时。请先查看供应商调用记录，确认本次结果后再决定是否重试；本机延长超时无法改变网关限制。'
  } else if ([502, 503, 504].includes(response.status)) {
    hint = '供应商服务或上游暂时不可用。请稍后查看供应商调用记录；本次不会自动重发。'
  } else if (response.status === 429) {
    hint = '供应商限流或额度不足。请检查余额、配额及并发限制，稍后再提交。'
  } else if (response.status === 401) {
    hint = '供应商身份验证失败。请检查当前配置的 API Key 和接口地址是否属于同一供应商。'
  } else if (response.status === 403) {
    hint = '供应商拒绝访问。请检查密钥权限、模型访问权限或站点访问限制。'
  } else if (/n must be between|number of images.*(?:limit|between)|n.*must.*(?:less|maximum)/i.test(message)) {
    hint = '供应商不支持本次生成张数。请在兼容设置中降低每次请求张数，按顺序分批生成。'
  } else if (error.code === 'unsupported_backend_parameter' || /cannot honor moderation/i.test(message)) {
    hint = '供应商后端不支持该参数。请在兼容设置中使用供应商默认参数，或选择支持该选项的接口。'
  }
  return [`HTTP ${response.status}${readable ? `：${readable}` : ''}`, hint].filter(Boolean).join('\n')
}

export function pickActualParams(source: unknown): Partial<TaskParams> {
  if (!source || typeof source !== 'object') return {}
  const record = source as Record<string, unknown>
  const actualParams: Partial<TaskParams> = {}

  if (typeof record.size === 'string') actualParams.size = record.size
  if (record.quality === 'auto' || record.quality === 'low' || record.quality === 'medium' || record.quality === 'high' || record.quality === 'xhigh' || record.quality === 'max') {
    actualParams.quality = record.quality
  }
  if (OUTPUT_FORMATS.includes(record.output_format as TaskParams['output_format'])) {
    actualParams.output_format = record.output_format as TaskParams['output_format']
  }
  if (typeof record.output_compression === 'number') actualParams.output_compression = record.output_compression
  if (record.moderation === 'auto' || record.moderation === 'low') actualParams.moderation = record.moderation
  if (typeof record.n === 'number') actualParams.n = record.n

  return actualParams
}

export function mergeActualParams(...sources: Array<Partial<TaskParams> | undefined>): Partial<TaskParams> | undefined {
  const merged = Object.assign({}, ...sources.filter((source) => source && Object.keys(source).length))
  return Object.keys(merged).length ? merged : undefined
}

export function mergeImageApiResults(results: PromiseSettledResult<CallApiResult>[], counts = results.map(() => 1)): CallApiResult {
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<CallApiResult> => result.status === 'fulfilled')
    .map((result) => result.value)
  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    throw firstError.reason
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((result) => result.rawImageUrls ?? [])
  const searchGrounding = successfulResults.flatMap((result) => result.searchGrounding ?? [])
  let offset = 0
  const failedRequests = results.flatMap((result, index) => {
    const start = offset
    offset += counts[index]
    return result.status === 'rejected'
      ? Array.from({ length: counts[index] }, (_, slot) => ({ requestIndex: start + slot, error: result.reason instanceof Error ? result.reason.message : String(result.reason) }))
      : (result.value.failedRequests ?? []).map((failure) => ({ ...failure, requestIndex: start + failure.requestIndex }))
  })
  const completionError = successfulResults.map((result) => result.completionError).filter(Boolean).join('\n')
  const inputImageAdjustments = [...new Set(successfulResults.flatMap((result) => result.inputImageAdjustments ?? []))]

  return {
    images,
    actualParams: mergeActualParams(successfulResults[0].actualParams ?? {}, { n: images.length }),
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(searchGrounding.length ? { searchGrounding } : {}),
    ...(failedRequests.length ? { failedRequests } : {}),
    ...(completionError ? { completionError } : {}),
    ...(inputImageAdjustments.length ? { inputImageAdjustments } : {}),
  }
}

export function isRecoverableImageTaskError(error: unknown): error is Error & { recoverableImageTask: true } {
  return error instanceof Error && 'recoverableImageTask' in error && error.recoverableImageTask === true
}

export async function runSequentialImageRequests<T extends CallApiOptions>(opts: T, batchSize: number, execute: (batch: T) => Promise<CallApiResult>): Promise<CallApiResult> {
  if (!Number.isSafeInteger(opts.params.n) || opts.params.n < 1 || !Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('生成张数与每批张数必须是正整数。')
  const results: PromiseSettledResult<CallApiResult>[] = []
  const counts: number[] = []
  const total = opts.params.n
  for (let requestIndex = 0; requestIndex < total; requestIndex += batchSize) {
    const count = Math.min(batchSize, total - requestIndex)
    if (opts.shouldContinue && !opts.shouldContinue()) {
      results.push({ status: 'rejected', reason: new Error('任务已停止，剩余图片未发送。') })
      counts.push(total - requestIndex)
      break
    }
    let result: CallApiResult
    try {
      result = await execute({
        ...opts,
        params: { ...opts.params, n: count },
        onPartialImage: opts.onPartialImage
          ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
          : undefined,
      })
    } catch (error) {
      if (isRecoverableImageTaskError(error)) throw error
      results.push({ status: 'rejected', reason: error })
      counts.push(count)
      if (requestIndex + count < total) {
        results.push({ status: 'rejected', reason: new Error('前一批请求失败，后续图片未发送。') })
        counts.push(total - requestIndex - count)
      }
      break
    }
    if (result.images.length < count) {
      result = {
        ...result,
        failedRequests: Array.from({ length: count - result.images.length }, (_, index) => ({
          requestIndex: result.images.length + index,
          error: `供应商只返回 ${result.images.length} 张图片，本批请求 ${count} 张；缺少的图片未自动补发。`,
        })),
      }
    } else if (result.images.length > count) {
      result = { ...result, completionError: `供应商返回 ${result.images.length} 张图片，超过本批请求的 ${count} 张；已保留全部结果并停止后续请求。` }
    }
    try {
      await opts.onRequestCompleted?.(result, requestIndex)
    } catch (error) {
      result = { ...result, completionError: `图片已生成，但结果保存未完成：${error instanceof Error ? error.message : String(error)}` }
    }
    results.push({ status: 'fulfilled', value: result })
    const occupiedSlots = Math.max(count, result.images.length)
    counts.push(occupiedSlots)
    if (result.failedRequests?.length || result.completionError) {
      if (requestIndex + occupiedSlots < total) {
        results.push({ status: 'rejected', reason: new Error('前一批结果未完整确认，后续图片未发送。') })
        counts.push(total - requestIndex - occupiedSlots)
      }
      break
    }
  }
  if (results.length === 1 && results[0].status === 'fulfilled') return results[0].value
  return mergeImageApiResults(results, counts)
}
