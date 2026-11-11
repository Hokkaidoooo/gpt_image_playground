import { MAX_INPUT_IMAGES, type ApiProfile } from '../types'
import { resolveApiProfileModel } from './imageModels'
import { createRequestTimeoutError, getApiErrorMessage } from './imageApiShared'
import { buildImageProviderUrl, createImageProviderHeaders, redactImageProviderError, type ResolvedImageApiDialect } from './imageProviderUrl'
import { apiFetch } from './platform'

export { buildImageProviderUrl, normalizeGoogleImageBaseUrl } from './imageProviderUrl'
export type { ResolvedImageApiDialect } from './imageProviderUrl'

export interface ImageModelOption {
  id: string
  label: string
  imageSupport: 'confirmed' | 'likely' | 'unknown'
  source?: 'metadata' | 'name'
}

export interface ImageModelList {
  models: ImageModelOption[]
  total: number
  unclassified: number
}

export interface ImageProviderCapabilities {
  dialect: ResolvedImageApiDialect
  nativeParameters: boolean
  maxInputImages: number
  maxOutputImages: number
  supportsMask: boolean
  aspectRatios: string[]
  resolutions: string[]
}

const XAI_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9', '9:20', '20:9', '1:2', '2:1', '21:9', '5:2']
const GOOGLE_ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
const GOOGLE_WIDE_ASPECT_RATIOS = [...GOOGLE_ASPECT_RATIOS, '1:4', '4:1', '1:8', '8:1']
const IMAGEN_ASPECT_RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9']

export function resolveImageApiDialect(profile: ApiProfile, model?: string): ResolvedImageApiDialect {
  if (profile.imageApiDialect && profile.imageApiDialect !== 'auto') return profile.imageApiDialect
  const id = (model ?? resolveApiProfileModel(profile).model).trim().toLowerCase()
  if (/grok.*(?:image|imagine)/.test(id)) return 'xai'
  if (/imagen(?:[-_/]|$)/.test(id)) return 'imagen'
  if (/gemini.*nano[-_ ]?banana/.test(id)) return 'gemini-interactions'
  if (/gemini.*image|(?:nano[-_ ]?)?banana/.test(id)) return 'gemini'
  return 'openai'
}

export function getImageProviderCapabilities(profile: ApiProfile, model?: string): ImageProviderCapabilities {
  const dialect = resolveImageApiDialect(profile, model)
  const nativeParameters = profile.provider === 'openai' && profile.apiMode === 'images' && dialect !== 'openai'
  if (!nativeParameters) {
    return {
      dialect,
      nativeParameters: false,
      maxInputImages: MAX_INPUT_IMAGES,
      maxOutputImages: profile.provider === 'fal' ? 4 : 10,
      supportsMask: profile.provider !== 'fal',
      aspectRatios: [],
      resolutions: [],
    }
  }
  if (dialect === 'xai') {
    return { dialect, nativeParameters, maxInputImages: 5, maxOutputImages: 10, supportsMask: false, aspectRatios: [...XAI_ASPECT_RATIOS], resolutions: ['1K', '1.5K', '2K'] }
  }
  if (dialect === 'imagen') {
    return { dialect, nativeParameters, maxInputImages: 0, maxOutputImages: 4, supportsMask: false, aspectRatios: [...IMAGEN_ASPECT_RATIOS], resolutions: ['1K', '2K'] }
  }

  const id = (model ?? resolveApiProfileModel(profile).model).toLowerCase()
  const isFlash25 = /gemini-2\.5-flash-image/.test(id)
  const isFlashLite = /gemini.*flash-lite-image/.test(id)
  const isNanoBanana = /gemini.*nano[-_ ]?banana/.test(id)
  const isPro3 = /gemini-3(?:\.0)?-pro-image/.test(id)
  const resolutions = isFlash25 || isFlashLite ? ['1K'] : isNanoBanana || isPro3 ? ['1K', '2K', '4K'] : ['512', '1K', '2K', '4K']
  return {
    dialect,
    nativeParameters,
    // 这是本工具单次参考图数量上限，较多参考图的保真度仍取决于实际模型。
    maxInputImages: 14,
    maxOutputImages: 1,
    supportsMask: false,
    aspectRatios: [...(isFlash25 || isPro3 ? GOOGLE_ASPECT_RATIOS : GOOGLE_WIDE_ASPECT_RATIOS)],
    resolutions,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value.toLowerCase()]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.toLowerCase()) : []
}

function hasImageOutputMetadata(record: Record<string, unknown>): boolean {
  const architecture = isRecord(record.architecture) ? record.architecture : {}
  const capabilities = isRecord(record.capabilities) ? record.capabilities : {}
  const outputModalities = [record.output_modalities, record.outputModalities, record.supportedOutputModalities, architecture.output_modalities, capabilities.output_modalities, capabilities.outputModalities]
  if (outputModalities.some((value) => stringList(value).some((item) => item === 'image' || item === 'images'))) return true
  const methods = [...stringList(record.supportedGenerationMethods), ...stringList(record.supported_actions), ...stringList(record.capabilities)]
  if (methods.some((item) => /^(?:generateimages?|image_generation|image-generation|text-to-image|image-output)$/.test(item))) return true
  return [record.image_generation, record.imageGeneration, record.supports_image_generation, capabilities.image_generation, capabilities.imageGeneration, capabilities.textToImage, capabilities.text_to_image].some((value) => value === true)
    || (typeof record.image_price === 'number' && record.image_price > 0)
}

function hasTextOnlyOutputMetadata(record: Record<string, unknown>): boolean {
  const architecture = isRecord(record.architecture) ? record.architecture : {}
  const capabilities = isRecord(record.capabilities) ? record.capabilities : {}
  const modalities = [record.output_modalities, record.outputModalities, record.supportedOutputModalities, architecture.output_modalities, capabilities.output_modalities, capabilities.outputModalities]
  const declaredOutputs = modalities.map(stringList).filter((items) => items.length)
  const explicitFalse = [record.image_generation, record.imageGeneration, record.supports_image_generation, capabilities.image_generation, capabilities.imageGeneration, capabilities.textToImage, capabilities.text_to_image].some((value) => value === false)
  return explicitFalse || (declaredOutputs.length > 0 && declaredOutputs.every((items) => !items.some((item) => item === 'image' || item === 'images')))
}

export function classifyImageModel(record: Record<string, unknown>, googleResourceName = false): ImageModelOption {
  const rawId = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : typeof record.name === 'string' ? record.name.trim() : ''
  if (!rawId) throw new Error('模型列表中有条目缺少模型 ID')
  const id = googleResourceName ? rawId.replace(/^models\//, '') : rawId
  const label = typeof record.displayName === 'string' && record.displayName.trim()
    ? record.displayName.trim()
    : typeof record.display_name === 'string' && record.display_name.trim()
    ? record.display_name.trim()
    : id
  if (hasImageOutputMetadata(record)) return { id, label, imageSupport: 'confirmed', source: 'metadata' }
  if (hasTextOnlyOutputMetadata(record)) return { id, label, imageSupport: 'unknown', source: 'metadata' }

  // 名称只能提示可能支持生图；输入图片能力、vision 和普通 Gemini 文本模型不能证明能输出图片。
  const likely = /gpt[-_/ ]?image|dall[-_/ ]?e|grok.*(?:image|imagine)|(?:nano[-_ ]?)?banana|gemini.*(?:[-_/]image(?:[-_/]|$))|imagen(?:[-_/]|$)|(?:^|[-_/])flux(?:[.\d_/-]|$)|stable[-_ ]?diffusion|(?:^|[-_/])sd(?:xl|[.\d_/-]|$)|recraft|qwen[-_/ ]?image|hunyuan[-_/ ]?image/i.test(id)
  return likely ? { id, label, imageSupport: 'likely', source: 'name' } : { id, label, imageSupport: 'unknown' }
}

export async function listImageModels(profile: ApiProfile, signal?: AbortSignal): Promise<ImageModelList> {
  const dialect = resolveImageApiDialect(profile)
  const isGoogle = dialect === 'gemini' || dialect === 'gemini-interactions' || dialect === 'imagen'
  const headers = createImageProviderHeaders(profile, dialect)
  const url = buildImageProviderUrl(profile, 'models', dialect)
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  if (signal?.aborted) abort()
  else signal?.addEventListener('abort', abort, { once: true })
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    const models = new Map<string, ImageModelOption>()
    const tokens = new Set<string>()
    let pageToken = ''
    do {
      const pageUrl = isGoogle ? `${url}?pageSize=1000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}` : url
      const response = await apiFetch(pageUrl, { method: 'GET', headers, cache: 'no-store', signal: controller.signal, timeoutSeconds: profile.timeout })
      if (!response.ok) throw new Error(`获取模型失败：${await getApiErrorMessage(response)}`)
      const payload: unknown = await response.json()
      if (isRecord(payload) && payload.error) throw new Error(`获取模型失败：${JSON.stringify(payload.error)}`)
      const items = Array.isArray(payload) ? payload : isRecord(payload) ? payload.data ?? payload.models : undefined
      if (!Array.isArray(items)) throw new Error('供应商返回的模型列表格式无法识别，需要 data[] 或 models[]')
      for (const item of items) {
        const record = typeof item === 'string' ? { id: item } : item
        if (!isRecord(record)) throw new Error('模型列表中有格式无效的条目')
        const model = classifyImageModel(record, isGoogle)
        const previous = models.get(model.id)
        if (previous?.source === 'metadata' && model.source === 'metadata' && previous.imageSupport !== model.imageSupport) {
          throw new Error(`供应商对模型 ${model.id} 返回的生图能力相互矛盾，无法确认可用模型`)
        }
        if (!previous || (previous.source !== 'metadata' && (model.source === 'metadata' || previous.imageSupport === 'unknown'))) {
          models.set(model.id, model)
        }
      }
      const nextToken = isGoogle && isRecord(payload) ? payload.nextPageToken : undefined
      if (nextToken != null && typeof nextToken !== 'string') throw new Error('供应商返回的模型分页标记格式无效')
      pageToken = typeof nextToken === 'string' ? nextToken : ''
      if (pageToken && tokens.has(pageToken)) throw new Error('供应商重复返回相同的模型分页标记，无法完成模型获取')
      if (pageToken) tokens.add(pageToken)
    } while (pageToken)

    const result = [...models.values()].sort((a, b) => {
      const order = { confirmed: 0, likely: 1, unknown: 2 }
      return order[a.imageSupport] - order[b.imageSupport] || a.id.localeCompare(b.id)
    })
    return { models: result, total: result.length, unclassified: result.filter((model) => model.imageSupport === 'unknown').length }
  } catch (err) {
    if (err instanceof Error) {
      const message = redactImageProviderError(err.message, profile.apiKey)
      if (message !== err.message) {
        const redacted = new Error(message)
        redacted.name = err.name
        throw redacted
      }
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener('abort', abort)
  }
}
