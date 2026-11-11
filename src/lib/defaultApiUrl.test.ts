import { describe, expect, it } from 'vitest'
import { buildApiUrl } from './devProxy'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { parseDefaultApiUrl } from './defaultApiUrl'
import { buildImageProviderUrl, resolveImageApiDialect } from './imageProvider'

describe('parseDefaultApiUrl', () => {
  it.each(['', '   ', ' gpt-image-2.5-flare '])('preserves and trims an explicit image generation model %j', (model) => {
    const params = new URLSearchParams({ apiMode: 'responses', imageGenerationModel: model })
    const parsed = parseDefaultApiUrl(`https://api.example.com?${params}`)

    expect(parsed).toMatchObject({ apiMode: 'responses', imageGenerationModel: model.trim() })
  })

  it('leaves an omitted image generation model unset', () => {
    expect(parseDefaultApiUrl('https://api.example.com?apiMode=responses')).not.toHaveProperty('imageGenerationModel')
  })

  it('keeps automatic v1 routing for a root URL without a trailing slash', () => {
    const parsed = parseDefaultApiUrl('https://api.example.com')

    expect(parsed.baseUrl).toBe('https://api.example.com')
    expect(buildApiUrl(parsed.baseUrl, 'responses')).toBe('https://api.example.com/v1/responses')
  })

  it('preserves a trailing slash for direct endpoint joining', () => {
    const parsed = parseDefaultApiUrl('https://api.example.com/')

    expect(parsed.baseUrl).toBe('https://api.example.com/')
    expect(buildApiUrl(parsed.baseUrl, 'responses')).toBe('https://api.example.com/responses')
  })

  it.each(['gemini', 'gemini-interactions', 'imagen'])('原生 %s 预置保留版本、画面比例及分辨率', (imageApiDialect) => {
    const params = new URLSearchParams({
      apiUrl: 'https://google.example.test/prefix/v1beta/',
      apiMode: 'images',
      imageApiDialect,
      imageAspectRatio: ' 16:9 ',
      imageResolution: ' 2K ',
      model: 'gemini-nano-banana-2.1',
    })
    const parsed = parseDefaultApiUrl(`http://127.0.0.1:17865/?${params}`)

    expect(parsed).toMatchObject({
      baseUrl: 'https://google.example.test/prefix/v1beta',
      imageApiDialect,
      imageAspectRatio: '16:9',
      imageResolution: '2K',
    })
  })

  it('原生 Google 完整接口按同一 URL 规则恢复基础地址', () => {
    const parsed = parseDefaultApiUrl('https://google.example.test/prefix/v1beta/models/gemini-image:generateContent?imageApiDialect=gemini')

    expect(parsed.baseUrl).toBe('https://google.example.test/prefix/v1beta')
    const profile = createDefaultOpenAIProfile({ ...parsed, model: 'gemini-image', apiProxy: false })
    expect(buildImageProviderUrl(profile, 'models/gemini-image:generateContent', resolveImageApiDialect(profile))).toBe('https://google.example.test/prefix/v1beta/models/gemini-image:generateContent')
  })

  it.each([
    ['gemini-image', 'https://google.example.test/v1beta', 'gemini', 'models/gemini-image:generateContent', 'https://google.example.test/v1beta/models/gemini-image:generateContent'],
    ['gpt-image-1', 'https://openai.example.test/direct/', 'openai', 'images/generations', 'https://openai.example.test/direct/images/generations'],
  ])('自动协议预置在选择 %s 后仍使用正确地址', (model, apiUrl, dialect, endpoint, expected) => {
    const params = new URLSearchParams({ apiUrl, apiMode: 'images', imageApiDialect: 'auto', model })
    const parsed = parseDefaultApiUrl(`http://127.0.0.1:17865/?${params}`)
    const profile = createDefaultOpenAIProfile({ ...parsed, apiProxy: false })

    expect(resolveImageApiDialect(profile)).toBe(dialect)
    expect(buildImageProviderUrl(profile, endpoint, resolveImageApiDialect(profile))).toBe(expected)
  })

  it.each(['openai', 'xai'])('显式 %s 预置仍遵守统一接口地址规则', (imageApiDialect) => {
    const params = new URLSearchParams({ apiUrl: 'https://relay.example.test/prefix/v1/images/generations', imageApiDialect })

    expect(parseDefaultApiUrl(`http://127.0.0.1:17865/?${params}`)).toMatchObject({
      baseUrl: 'https://relay.example.test/prefix/v1',
      imageApiDialect,
    })
  })

  it('省略新增图片字段时不覆盖已有配置', () => {
    const parsed = parseDefaultApiUrl('https://api.example.test/v1?model=custom-model')

    expect(parsed).not.toHaveProperty('imageApiDialect')
    expect(parsed).not.toHaveProperty('imageAspectRatio')
    expect(parsed).not.toHaveProperty('imageResolution')
  })

  it('图片协议无效时显式报错，不悄悄恢复成默认接口', () => {
    expect(() => parseDefaultApiUrl('https://api.example.test/v1?imageApiDialect=unsupported')).toThrow('图片接口协议无效')
  })

  it('原生 Google 地址带密钥查询时显式拒绝', () => {
    const params = new URLSearchParams({ apiUrl: 'https://google.example.test/v1beta?key=private-test-key', imageApiDialect: 'gemini' })

    expect(() => parseDefaultApiUrl(`http://127.0.0.1:17865/?${params}`)).toThrow('不能包含账号、密码、查询参数或片段')
  })
})


describe('兼容设置URL预置', () => {
  it('保留显式兼容参数', () => {
    const compatibility = { mode: 'custom', maxImagesPerRequest: 4, omitParameters: ['moderation'], editImageField: 'image' }
    const params = new URLSearchParams({ imageRequestCompatibility: JSON.stringify(compatibility) })
    expect(parseDefaultApiUrl(`https://relay.example.test/v1?${params}`).imageRequestCompatibility).toEqual(compatibility)
  })

  it('非法兼容参数显示可读错误', () => {
    expect(() => parseDefaultApiUrl('https://relay.example.test/v1?imageRequestCompatibility=oops')).toThrow('兼容设置不是有效 JSON')
  })
})
