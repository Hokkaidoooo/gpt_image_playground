import { describe, expect, it } from 'vitest'
import { createDefaultOpenAIProfile, normalizeSettings, switchApiProfileProvider, findEquivalentApiProfile, importCustomProviderSettingsFromJson, mergePresetImportedSettings } from './apiProfiles'
import { getImageRequestBatchCount, normalizeImageRequestCompatibility, resolveImageRequestCompatibility, usesSequentialImageRequests } from './imageRequestCompatibility'
import type { ApiProfile, ImageRequestCompatibility } from '../types'

const profile = (overrides: Partial<ApiProfile> = {}) => createDefaultOpenAIProfile({ baseUrl: 'https://relay.example.test/v1', ...overrides })

describe('图片请求兼容策略', () => {
  it('旧供应商配置无需修改即可按单张顺序生成', () => {
    const current = profile()
    expect(current.imageRequestCompatibility).toBeUndefined()
    expect(resolveImageRequestCompatibility(current)).toEqual({ mode: 'auto', maxImagesPerRequest: 1, omitParameters: [], editImageField: 'image[]', referenceImagePolicy: 'auto', maxReferenceImageMB: 14 })
    expect(usesSequentialImageRequests(current, 5)).toBe(true)
    expect(getImageRequestBatchCount(current, 5)).toBe(5)
    expect(usesSequentialImageRequests(current, 1)).toBe(false)
  })

  it('官方接口保留单次多张能力，流式和Codex每次仅一张', () => {
    const current = profile({ baseUrl: 'https://api.openai.com/v1' })
    expect(resolveImageRequestCompatibility(current).maxImagesPerRequest).toBe(10)
    expect(getImageRequestBatchCount(current, 10)).toBe(1)
    expect(usesSequentialImageRequests({ ...current, streamImages: true }, 3)).toBe(true)
    expect(usesSequentialImageRequests({ ...current, codexCli: true }, 3)).toBe(true)
  })

  it('只向精确匹配的Orbitix省略moderation，换站后重新推导', () => {
    const current = profile({ baseUrl: 'https://new.orbitix.site/v1' })
    expect(resolveImageRequestCompatibility(current).omitParameters).toEqual(['moderation'])
    expect(resolveImageRequestCompatibility({ ...current, baseUrl: 'https://api.freeshengtu.com' }).omitParameters).toEqual([])
    expect(current.imageRequestCompatibility).toBeUndefined()
  })

  it.each(['https://new.orbitix.site.evil.test', 'https://other-new.orbitix.site', 'https://new.orbitix.site@evil.test', 'https://api.openai.com.evil.test'])('不将相似域名 %s 当作已知供应商', (baseUrl) => {
    expect(resolveImageRequestCompatibility(profile({ baseUrl }))).toMatchObject({ maxImagesPerRequest: 1, omitParameters: [] })
  })

  it('无协议和大小写地址使用请求层同一地址规则', () => {
    expect(resolveImageRequestCompatibility(profile({ baseUrl: 'NEW.ORBITIX.SITE/v1' })).omitParameters).toEqual(['moderation'])
    expect(resolveImageRequestCompatibility(profile({ baseUrl: 'api.openai.com/v1/' })).maxImagesPerRequest).toBe(10)
  })

  it('标准模式明确关闭自动参数适配及顺序拆分', () => {
    const current = profile({ baseUrl: 'https://new.orbitix.site/v1', imageRequestCompatibility: { mode: 'standard' }, streamImages: true })
    expect(resolveImageRequestCompatibility(current)).toEqual({ mode: 'standard', maxImagesPerRequest: 1, omitParameters: [], editImageField: 'image[]', referenceImagePolicy: 'original', maxReferenceImageMB: 14 })
    expect(usesSequentialImageRequests(current, 5)).toBe(false)
  })

  it('自定义批大小向上取整，返回独立的参数列表', () => {
    const current = profile({ imageRequestCompatibility: { mode: 'custom', maxImagesPerRequest: 4, omitParameters: ['quality', 'moderation'], editImageField: 'image' } })
    const result = resolveImageRequestCompatibility(current)
    expect(getImageRequestBatchCount(current, 5)).toBe(2)
    expect(result).toEqual({ mode: 'custom', maxImagesPerRequest: 4, omitParameters: ['moderation', 'quality'], editImageField: 'image', referenceImagePolicy: 'auto', maxReferenceImageMB: 14 })
    result.omitParameters.push('size')
    expect(current.imageRequestCompatibility?.omitParameters).toEqual(['quality', 'moderation'])
  })

  it.each([
    { provider: 'fal' },
    { provider: 'custom-http' },
    { apiMode: 'responses' as const },
    { imageApiDialect: 'gemini' as const },
    { model: 'gpt-image-2, grok-imagine-image', selectedModel: 'grok-imagine-image' },
    { model: 'gemini-3-pro-image' },
  ])('原生协议和其他供应商保持其自身契约 %o', (overrides) => {
    const current = profile({ imageRequestCompatibility: { mode: 'custom', maxImagesPerRequest: 1, omitParameters: ['quality'] }, ...overrides })
    expect(resolveImageRequestCompatibility(current)).toEqual({ mode: 'standard', maxImagesPerRequest: 10, omitParameters: [], editImageField: 'image[]', referenceImagePolicy: 'original', maxReferenceImageMB: 50 })
    expect(usesSequentialImageRequests(current, 5)).toBe(false)
  })

  it('显式OpenAI协议优先于模型名称推断', () => {
    expect(usesSequentialImageRequests(profile({ model: 'gemini-image', imageApiDialect: 'openai' }), 2)).toBe(true)
  })

  it('未填完的地址不触发已知供应商规则', () => {
    expect(resolveImageRequestCompatibility(profile({ baseUrl: '' })).omitParameters).toEqual([])
  })
})

describe('兼容配置保存与校验', () => {
  const compatibility: ImageRequestCompatibility = { mode: 'custom', maxImagesPerRequest: 4, omitParameters: ['moderation', 'size'], editImageField: 'image', referenceImagePolicy: 'original', maxReferenceImageMB: 12.5 }

  it('规范化、JSON导入和provider切换均保留显式设置', () => {
    const current = profile({ id: 'custom-compatible', imageRequestCompatibility: compatibility })
    const saved = normalizeSettings(JSON.parse(JSON.stringify({ profiles: [current] }))).profiles[0]
    expect(saved.imageRequestCompatibility).toEqual(compatibility)
    const restored = switchApiProfileProvider(switchApiProfileProvider(saved, 'fal'), 'openai')
    expect(restored.imageRequestCompatibility).toEqual(compatibility)
    const imported = importCustomProviderSettingsFromJson(JSON.stringify({ profiles: [current] }))
    expect(imported.profiles[0].imageRequestCompatibility).toEqual(compatibility)
  })

  it('不同显式兼容规则不会被去重合并', () => {
    const current = profile({ id: 'saved', imageRequestCompatibility: compatibility })
    const other = profile({ id: 'different', imageRequestCompatibility: { mode: 'standard' } })
    expect(findEquivalentApiProfile({ profiles: [current] }, other)).toBeNull()
  })

  it('预置更新只覆盖与旧预置一致的规则，保留用户自定义设置', () => {
    const old = profile({ id: 'preset', imageRequestCompatibility: { mode: 'standard' } })
    const updated = { ...old, imageRequestCompatibility: { mode: 'auto' as const } }
    const previousPresetConfig = { profiles: [old], customProviders: [] }
    const next = { profiles: [updated], customProviders: [] }
    const migrated = mergePresetImportedSettings({ profiles: [old] }, next, { previousPresetConfig }).settings
    expect(migrated.profiles[0].imageRequestCompatibility).toEqual({ mode: 'auto' })
    const customized = mergePresetImportedSettings({ profiles: [{ ...old, imageRequestCompatibility: compatibility }] }, next, { previousPresetConfig }).settings
    expect(customized.profiles[0].imageRequestCompatibility).toEqual(compatibility)
    const locked = mergePresetImportedSettings({ profiles: [{ ...old, imageRequestCompatibility: compatibility }] }, next, { previousPresetConfig, lockPresetParams: true }).settings
    expect(locked.profiles[0].imageRequestCompatibility).toEqual({ mode: 'auto' })
  })

  it.each([
    null,
    'auto',
    { mode: 'fallback' },
    { mode: 'custom', maxImagesPerRequest: 0 },
    { mode: 'custom', maxImagesPerRequest: 11 },
    { mode: 'custom', maxImagesPerRequest: 1.5 },
    { mode: 'custom', maxImagesPerRequest: '4' },
    { mode: 'custom', omitParameters: ['apiKey'] },
    { mode: 'custom', omitParameters: 'moderation' },
    { mode: 'custom', editImageField: 'image[0]' },
    { mode: 'custom', retry: true },
    { mode: 'custom', maxReferenceImageMB: 0.99 },
    { mode: 'custom', maxReferenceImageMB: 50.1 },
    { mode: 'custom', maxReferenceImageMB: '14' },
    { mode: 'custom', referenceImagePolicy: 'silent' },
  ])('非法显式规则清楚报错：%o', (value) => {
    expect(() => normalizeImageRequestCompatibility(value)).toThrow()
    expect(() => importCustomProviderSettingsFromJson(JSON.stringify({ profiles: [{ ...profile(), imageRequestCompatibility: value }] }))).toThrow()
  })

  it('去除重复参数并保持稳定的序列化顺序', () => {
    expect(normalizeImageRequestCompatibility({ mode: 'custom', omitParameters: ['size', 'moderation', 'size'] })).toEqual({ mode: 'custom', omitParameters: ['moderation', 'size'] })
  })
})
