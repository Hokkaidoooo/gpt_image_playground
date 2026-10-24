import { DEFAULT_PARAMS, type AppSettings, type TaskParams } from '../types'
import { getActiveApiProfile, isOpenAICompatibleProvider } from './apiProfiles'
import { getImageGenerationModel, isGptImage25Model } from './imageModels'
import { getImageProviderCapabilities } from './imageProvider'
import { normalizeCodexCliImageSize, normalizeImageSize } from './size'

export const DEFAULT_FAL_IMAGE_SIZE = '1360x1024'

export function getOutputImageLimitForSettings(settings: AppSettings) {
  return getImageProviderCapabilities(getActiveApiProfile(settings)).maxOutputImages
}

export function normalizeParamsForSettings(
  params: TaskParams,
  settings: AppSettings,
  options: { hasInputImages?: boolean } = {},
): TaskParams {
  const activeProfile = getActiveApiProfile(settings)
  const caps = getImageProviderCapabilities(activeProfile)
  const outputImageLimit = caps.maxOutputImages
  if (caps.nativeParameters) {
    // 切换协议时同步界面参数，避免把 GPT 专属选项展示为原生模型已经接受。
    return {
      ...params,
      size: DEFAULT_PARAMS.size,
      quality: DEFAULT_PARAMS.quality,
      output_format: DEFAULT_PARAMS.output_format,
      output_compression: DEFAULT_PARAMS.output_compression,
      moderation: DEFAULT_PARAMS.moderation,
      transparent_output: DEFAULT_PARAMS.transparent_output,
      n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
    }
  }
  const nextParams: TaskParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    n: Math.min(outputImageLimit, Math.max(1, params.n || DEFAULT_PARAMS.n)),
  }

  if (isOpenAICompatibleProvider(settings, activeProfile.provider) && activeProfile.codexCli) {
    nextParams.size = normalizeCodexCliImageSize(nextParams.size)
    nextParams.quality = DEFAULT_PARAMS.quality
  }

  if (activeProfile.provider === 'fal') {
    if (!options.hasInputImages && nextParams.size === 'auto') nextParams.size = DEFAULT_FAL_IMAGE_SIZE
    if (nextParams.quality === 'auto') nextParams.quality = 'high'
    nextParams.moderation = DEFAULT_PARAMS.moderation
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  if ((nextParams.quality === 'xhigh' || nextParams.quality === 'max') && !isGptImage25Model(getImageGenerationModel(activeProfile))) {
    nextParams.quality = 'high'
  }

  if (nextParams.output_format === 'png') {
    nextParams.output_compression = DEFAULT_PARAMS.output_compression
  }

  return nextParams
}

export function getChangedParams(current: TaskParams, next: TaskParams): Partial<TaskParams> {
  const patch: Partial<TaskParams> = {}
  for (const key of Object.keys(next) as Array<keyof TaskParams>) {
    if (current[key] !== next[key]) {
      ;(patch as Record<keyof TaskParams, TaskParams[keyof TaskParams]>)[key] = next[key]
    }
  }
  return patch
}
