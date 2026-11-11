import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, normalizeSettings } from './apiProfiles'
import { consumeLegacyProfileParams, migrateLegacyImageParams } from './legacyImageParams'

describe('旧版原生参数迁移', () => {
  it('任务参数优先，未保存的字段才从旧记录迁移', () => {
    expect(migrateLegacyImageParams({ ...DEFAULT_PARAMS, aspect_ratio: 'auto' }, {
      imageAspectRatio: '16:9', imageResolution: '2K',
    })).toMatchObject({ aspect_ratio: 'auto', resolution: '2K' })
  })

  it('首次激活旧配置恢复其参数，之后用户修改不会被旧字段覆盖', () => {
    const profile = createDefaultOpenAIProfile({ id: 'legacy', imageAspectRatio: '16:9', imageResolution: '2K' })
    const settings = normalizeSettings({ profiles: [profile], activeProfileId: profile.id })
    const migrated = consumeLegacyProfileParams(settings, { ...DEFAULT_PARAMS, aspect_ratio: '1:1' }, true)
    expect(migrated.params).toMatchObject({ aspect_ratio: '16:9', resolution: '2K' })
    expect(migrated.settings.profiles[0]).not.toHaveProperty('imageAspectRatio')
    expect(migrated.settings.profiles[0]).not.toHaveProperty('imageResolution')
    const edited = consumeLegacyProfileParams(migrated.settings, { ...migrated.params, aspect_ratio: '3:2' }, true)
    expect(edited.params.aspect_ratio).toBe('3:2')
    expect(settings.profiles[0].imageAspectRatio).toBe('16:9')
  })

  it('保留未激活配置的迁移来源', () => {
    const profiles = [
      createDefaultOpenAIProfile({ id: 'first', imageAspectRatio: '1:1' }),
      createDefaultOpenAIProfile({ id: 'second', imageAspectRatio: '16:9' }),
    ]
    const migrated = consumeLegacyProfileParams(normalizeSettings({ profiles, activeProfileId: 'first' }), DEFAULT_PARAMS)
    expect(migrated.settings.profiles[1].imageAspectRatio).toBe('16:9')
    expect(migrated.params.aspect_ratio).toBe('1:1')
  })
})
