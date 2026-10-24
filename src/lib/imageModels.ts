import type { ApiProfile } from '../types'

export const DEFAULT_IMAGES_MODEL = 'gpt-image-2.5-sunburst'

/** 拆分模型列表，兼容中英文逗号并去重。 */
export function splitModelList(value: string) {
  return Array.from(new Set(value.split(/[,，]/).map((item) => item.trim()).filter(Boolean)))
}

export function normalizeModelList(value: string) {
  return splitModelList(value).join(', ')
}

/** 优先使用复用任务指定的模型，其次是首页选中的模型。 */
export function resolveApiProfileModel(profile: ApiProfile, preferred?: string): ApiProfile {
  const models = splitModelList(profile.model)
  const model = [preferred, profile.selectedModel].find((item) => item && models.includes(item)) ?? models[0] ?? profile.model
  return { ...profile, model }
}

export function getImageGenerationModel(profile: ApiProfile) {
  return profile.provider === 'openai' && profile.apiMode === 'responses'
    ? profile.imageGenerationModel?.trim() ?? ''
    : profile.model
}

export function isGptImage25Model(model: string) {
  return model.trim().toLowerCase().includes('gpt-image-2.5')
}
