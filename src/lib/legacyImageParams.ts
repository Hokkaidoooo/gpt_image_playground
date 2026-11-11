import type { AppSettings, TaskParams } from '../types'

type LegacyImageParams = { imageAspectRatio?: string; imageResolution?: string }

/** 旧配置与任务只在读取边界迁移；请求和界面统一使用任务参数。 */
export function migrateLegacyImageParams(params: TaskParams, legacy: LegacyImageParams): TaskParams {
  return {
    ...params,
    ...(params.aspect_ratio === undefined && legacy.imageAspectRatio ? { aspect_ratio: legacy.imageAspectRatio } : {}),
    ...(params.resolution === undefined && legacy.imageResolution ? { resolution: legacy.imageResolution } : {}),
  }
}

export function consumeLegacyProfileParams(settings: AppSettings, params: TaskParams, switchedProfile = false): { settings: AppSettings; params: TaskParams } {
  const profile = settings.profiles.find((item) => item.id === settings.activeProfileId)
  if (!profile || (!profile.imageAspectRatio && !profile.imageResolution)) return { settings, params }
  const sourceParams = switchedProfile
    ? {
        ...params,
        ...(profile.imageAspectRatio ? { aspect_ratio: undefined } : {}),
        ...(profile.imageResolution ? { resolution: undefined } : {}),
      }
    : params
  const { imageAspectRatio: _ratio, imageResolution: _resolution, ...migratedProfile } = profile
  const draft = profile.providerDrafts?.[profile.provider]
  if (draft) {
    const { imageAspectRatio: _draftRatio, imageResolution: _draftResolution, ...migratedDraft } = draft
    migratedProfile.providerDrafts = { ...profile.providerDrafts, [profile.provider]: migratedDraft }
  }
  return {
    settings: { ...settings, profiles: settings.profiles.map((item) => item.id === profile.id ? migratedProfile : item) },
    params: migrateLegacyImageParams(sourceParams, profile),
  }
}
