import type { ApiProfile, ImageRequestCompatibility, ImageRequestOmittableParameter, TaskRecord } from '../types'
import { getImageProviderCapabilities } from './imageProvider'
import { normalizeBaseUrl } from './devProxy'

export const OMITTABLE_IMAGE_PARAMETERS: readonly ImageRequestOmittableParameter[] = ['moderation', 'quality', 'size', 'output_format', 'output_compression', 'response_format']
export const MAX_IMAGES_PER_REQUEST = 10

export interface ResolvedImageRequestCompatibility {
  mode: ImageRequestCompatibility['mode']
  maxImagesPerRequest: number
  omitParameters: ImageRequestOmittableParameter[]
  editImageField: 'image[]' | 'image'
  referenceImagePolicy: 'auto' | 'original'
  maxReferenceImageMB: number
}

export function normalizeImageRequestCompatibility(value: unknown): ImageRequestCompatibility | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('图片请求兼容设置必须是配置对象。')
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !['mode', 'maxImagesPerRequest', 'omitParameters', 'editImageField', 'referenceImagePolicy', 'maxReferenceImageMB'].includes(key))) {
    throw new Error('图片请求兼容设置含有无法识别的字段。')
  }
  if (record.mode !== 'auto' && record.mode !== 'standard' && record.mode !== 'custom') throw new Error('图片请求兼容模式无效，请重新选择。')
  if (record.maxImagesPerRequest !== undefined && (!Number.isInteger(record.maxImagesPerRequest) || (record.maxImagesPerRequest as number) < 1 || (record.maxImagesPerRequest as number) > MAX_IMAGES_PER_REQUEST)) {
    throw new Error(`每次请求的图片数量必须是 1 至 ${MAX_IMAGES_PER_REQUEST} 的整数。`)
  }
  if (record.omitParameters !== undefined && (!Array.isArray(record.omitParameters) || record.omitParameters.some((name) => !OMITTABLE_IMAGE_PARAMETERS.includes(name)))) {
    throw new Error('不发送的图片参数中含有无法识别的选项。')
  }
  if (record.editImageField !== undefined && record.editImageField !== 'image[]' && record.editImageField !== 'image') throw new Error('参考图字段必须为 image[] 或 image。')
  if (record.referenceImagePolicy !== undefined && record.referenceImagePolicy !== 'auto' && record.referenceImagePolicy !== 'original') throw new Error('参考图处理方式必须为自动优化或保留原图。')
  if (record.maxReferenceImageMB !== undefined && (typeof record.maxReferenceImageMB !== 'number' || !Number.isFinite(record.maxReferenceImageMB) || record.maxReferenceImageMB < 1 || record.maxReferenceImageMB > 50)) throw new Error('参考图大小上限必须为 1 至 50 MB。')
  return {
    mode: record.mode,
    ...(record.maxImagesPerRequest !== undefined ? { maxImagesPerRequest: record.maxImagesPerRequest as number } : {}),
    ...(record.omitParameters !== undefined ? { omitParameters: OMITTABLE_IMAGE_PARAMETERS.filter((name) => (record.omitParameters as unknown[]).includes(name)) } : {}),
    ...(record.editImageField !== undefined ? { editImageField: record.editImageField } : {}),
    ...(record.referenceImagePolicy !== undefined ? { referenceImagePolicy: record.referenceImagePolicy } : {}),
    ...(record.maxReferenceImageMB !== undefined ? { maxReferenceImageMB: record.maxReferenceImageMB } : {}),
  }
}

export function parseImageRequestCompatibilityParam(value: string): ImageRequestCompatibility | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error('链接中的图片请求兼容设置不是有效 JSON。')
    throw err
  }
  return normalizeImageRequestCompatibility(parsed)
}

export function resolveImageRequestCompatibility(profile: ApiProfile): ResolvedImageRequestCompatibility {
  const standard: ResolvedImageRequestCompatibility = { mode: 'standard', maxImagesPerRequest: MAX_IMAGES_PER_REQUEST, omitParameters: [], editImageField: 'image[]', referenceImagePolicy: 'original', maxReferenceImageMB: 50 }
  if (profile.provider !== 'openai' || profile.apiMode !== 'images' || getImageProviderCapabilities(profile).nativeParameters) return standard
  const compatibility = normalizeImageRequestCompatibility(profile.imageRequestCompatibility)
  const mode = compatibility?.mode ?? 'auto'
  const singleImage = profile.codexCli || profile.streamImages === true
  let hostname = ''
  try {
    hostname = new URL(normalizeBaseUrl(profile.baseUrl)).hostname
  } catch (err) {
    // 编辑地址时不应用站点规则，提交仍由接口地址校验处理。
    if (!(err instanceof TypeError)) throw err
  }  const maxReferenceImageMB = compatibility?.maxReferenceImageMB ?? (hostname === 'api.openai.com' ? 50 : 14)
  if (mode === 'standard') return { ...standard, maxImagesPerRequest: singleImage ? 1 : MAX_IMAGES_PER_REQUEST, maxReferenceImageMB }
  if (mode === 'custom') return {
    mode,
    maxImagesPerRequest: singleImage ? 1 : compatibility?.maxImagesPerRequest ?? 1,
    omitParameters: [...(compatibility?.omitParameters ?? [])],
    editImageField: compatibility?.editImageField ?? 'image[]',
    referenceImagePolicy: compatibility?.referenceImagePolicy ?? 'auto',
    maxReferenceImageMB,
  }

  return {
    mode,
    maxImagesPerRequest: !singleImage && hostname === 'api.openai.com' ? MAX_IMAGES_PER_REQUEST : 1,
    omitParameters: hostname === 'new.orbitix.site' ? ['moderation'] : [],
    editImageField: 'image[]',
    referenceImagePolicy: compatibility?.referenceImagePolicy ?? 'auto',
    maxReferenceImageMB,
  }
}

export function getImageRequestBatchCount(profile: ApiProfile, n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new Error('生成图片数量必须是正整数。')
  return Math.ceil(n / resolveImageRequestCompatibility(profile).maxImagesPerRequest)
}

export function usesSequentialImageRequests(profile: ApiProfile, n: number): boolean {
  const compatibility = resolveImageRequestCompatibility(profile)
  return compatibility.mode !== 'standard' && n > compatibility.maxImagesPerRequest
}

export function getTaskOmittedImageParameters(task: TaskRecord): ImageRequestOmittableParameter[] {
  if (!task.imageRequestCompatibility) return []
  return resolveImageRequestCompatibility({
    id: task.apiProfileId ?? '', name: task.apiProfileName ?? '',
    provider: task.apiProvider ?? 'openai', apiMode: task.apiMode ?? 'images',
    baseUrl: task.apiBaseUrl ?? '', apiKey: '', model: task.apiModel ?? '',
    imageApiDialect: task.imageApiDialect,
    imageRequestCompatibility: task.imageRequestCompatibility,
    timeout: 1, codexCli: false, apiProxy: false, transparentBackgroundMethod: 'api',
  }).omitParameters
}
