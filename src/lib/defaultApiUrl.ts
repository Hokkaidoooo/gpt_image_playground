import type { ApiMode, ApiProfile, ImageApiDialect, ReasoningEffort } from '../types'
import { DEFAULT_STREAM_PARTIAL_IMAGES, REASONING_EFFORT_VALUES } from '../types'

import { normalizeBaseUrl } from './devProxy'
import { normalizeImageProviderBaseUrl } from './imageProviderUrl'

export function normalizeImageApiDialect(value: unknown): ImageApiDialect {
  if (value === undefined || value === '' || value === 'auto') return 'auto'
  if (value === 'openai' || value === 'xai' || value === 'gemini' || value === 'gemini-interactions' || value === 'imagen') return value
  throw new Error('图片接口协议无效，请重新选择。')
}

export function normalizeStreamPartialImages(value: unknown, fallback: number | undefined = DEFAULT_STREAM_PARTIAL_IMAGES): number {
  const fallbackValue = fallback ?? DEFAULT_STREAM_PARTIAL_IMAGES
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallbackValue
  return Math.min(3, Math.max(0, Math.trunc(numeric)))
}

export function normalizeReasoningEffort(value: unknown, fallback?: ReasoningEffort): ReasoningEffort | undefined {
  return typeof value === 'string' && REASONING_EFFORT_VALUES.includes(value as ReasoningEffort)
    ? value as ReasoningEffort
    : fallback
}

export interface DefaultApiUrlPatch {
  baseUrl: string
  apiKey?: string
  apiMode?: ApiMode
  model?: string
  imageGenerationModel?: string
  imageApiDialect?: ImageApiDialect
  imageAspectRatio?: string
  imageResolution?: string
  reasoningEffort?: ReasoningEffort
  name?: string
  codexCli?: boolean
  streamImages?: boolean
  streamPartialImages?: number
  transparentBackgroundMethod?: ApiProfile['transparentBackgroundMethod']
}

export function parseDefaultApiUrl(rawUrl: string): DefaultApiUrlPatch {
  const url = rawUrl.trim()
  if (!url) return { baseUrl: '' }

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { baseUrl: normalizeBaseUrl(url) }
  }

  const queryIndex = url.search(/[?#]/)
  const baseUrl = queryIndex >= 0 ? url.slice(0, queryIndex) : url
  const apiUrlParam = parsed.searchParams.get('apiUrl')
  const apiKeyParam = parsed.searchParams.get('apiKey')
  const apiModeParam = parsed.searchParams.get('apiMode')
  const modelParam = parsed.searchParams.get('model')
  const imageGenerationModelParam = parsed.searchParams.get('imageGenerationModel')
  const imageApiDialectParam = parsed.searchParams.get('imageApiDialect')
  const imageAspectRatioParam = parsed.searchParams.get('imageAspectRatio')
  const imageResolutionParam = parsed.searchParams.get('imageResolution')
  const reasoningEffortParam = parsed.searchParams.get('reasoningEffort')
  const profileNameParam = parsed.searchParams.get('profileName')
  const codexCliParam = parsed.searchParams.get('codexCli')
  const streamImagesParam = parsed.searchParams.get('streamImages')
  const streamPartialImagesParam = parsed.searchParams.get('streamPartialImages')
  const transparentBackgroundMethodParam = parsed.searchParams.get('transparentBackgroundMethod')
  const imageApiDialect = imageApiDialectParam === null ? undefined : normalizeImageApiDialect(imageApiDialectParam)
  const requestedBaseUrl = apiUrlParam === null ? baseUrl : apiUrlParam.trim()
  const patch: DefaultApiUrlPatch = {
    baseUrl: normalizeImageProviderBaseUrl(requestedBaseUrl, imageApiDialect),
  }

  if (imageApiDialect !== undefined) patch.imageApiDialect = imageApiDialect
  if (imageAspectRatioParam !== null) patch.imageAspectRatio = imageAspectRatioParam.trim()
  if (imageResolutionParam !== null) patch.imageResolution = imageResolutionParam.trim()
  if (apiKeyParam !== null) patch.apiKey = apiKeyParam.trim()
  if (apiModeParam === 'images' || apiModeParam === 'responses') patch.apiMode = apiModeParam
  if (modelParam !== null && modelParam.trim()) patch.model = modelParam.trim()
  if (imageGenerationModelParam !== null) patch.imageGenerationModel = imageGenerationModelParam.trim()
  if (reasoningEffortParam !== null) patch.reasoningEffort = normalizeReasoningEffort(reasoningEffortParam)
  if (profileNameParam?.trim()) patch.name = profileNameParam.trim()
  if (codexCliParam !== null) patch.codexCli = codexCliParam.trim().toLowerCase() === 'true'
  if (streamImagesParam !== null) patch.streamImages = streamImagesParam.trim().toLowerCase() === 'true'
  if (streamPartialImagesParam !== null) patch.streamPartialImages = normalizeStreamPartialImages(streamPartialImagesParam)
  if (transparentBackgroundMethodParam === 'api' || transparentBackgroundMethodParam === 'local') {
    patch.transparentBackgroundMethod = transparentBackgroundMethodParam
  }

  return patch
}
