import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { buildImageProviderUrl, classifyImageModel, getImageProviderCapabilities, listImageModels, normalizeGoogleImageBaseUrl, resolveImageApiDialect } from './imageProvider'
import * as platform from './platform'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const makeProfile = (model = 'gpt-image-1') => createDefaultOpenAIProfile({ baseUrl: 'https://relay.example/v1', apiKey: 'private-test-key', model, apiProxy: false, streamImages: false })

describe('image provider protocol selection', () => {
  it.each([
    ['gpt-image-2.5-sunburst', 'openai'],
    ['dall-e-3', 'openai'],
    ['grok-2-image', 'xai'],
    ['grok-imagine-image-2.0', 'xai'],
    ['gemini-2.5-flash-image', 'gemini'],
    ['gemini-3.1-flash-image-preview', 'gemini'],
    ['gemini-nano-banana-2.1', 'gemini-interactions'],
    ['imagen-4.0-generate-001', 'imagen'],
    ['vendor/custom-image-model', 'openai'],
  ])('selects %s using the configured protocol or name', (model, dialect) => {
    expect(resolveImageApiDialect(makeProfile(model))).toBe(dialect)
  })

  it('keeps an explicit Images protocol for a relay wrapping Gemini', () => {
    expect(resolveImageApiDialect({ ...makeProfile('gemini-nano-banana-2.1'), imageApiDialect: 'openai' })).toBe('openai')
  })

  it('uses the selected model from a configured model list', () => {
    expect(resolveImageApiDialect({ ...makeProfile('gpt-image-1, grok-imagine-image'), selectedModel: 'grok-imagine-image' })).toBe('xai')
  })

  it('leaves custom provider and Responses parameter rules active', () => {
    expect(getImageProviderCapabilities({ ...makeProfile('gemini-3.1-flash-image'), provider: 'custom-provider' }).nativeParameters).toBe(false)
    expect(getImageProviderCapabilities({ ...makeProfile('gemini-3.1-flash-image'), apiMode: 'responses' }).nativeParameters).toBe(false)
  })

  it('expresses different native reference and output limits in one capability source', () => {
    expect(getImageProviderCapabilities(makeProfile('grok-imagine-image'))).toMatchObject({ maxInputImages: 5, maxOutputImages: 10, supportsMask: false })
    expect(getImageProviderCapabilities(makeProfile('gemini-nano-banana-2.1'))).toMatchObject({ maxInputImages: 14, maxOutputImages: 1, supportsMask: false })
    expect(getImageProviderCapabilities(makeProfile('imagen-4.0-generate-001'))).toMatchObject({ maxInputImages: 0, maxOutputImages: 4, supportsMask: false })
  })

  it('excludes unsupported resolutions for named native Google models', () => {
    expect(getImageProviderCapabilities(makeProfile('gemini-nano-banana-2.1')).resolutions).toEqual(['1K', '2K', '4K'])
    expect(getImageProviderCapabilities(makeProfile('gemini-3.1-flash-lite-image')).resolutions).toEqual(['1K'])
    expect(getImageProviderCapabilities(makeProfile('gemini-3.1-flash-image')).resolutions).toContain('512')
  })
})

describe('image provider URL construction', () => {
  it.each([
    ['https://google.example', 'https://google.example/v1beta'],
    ['google.example/prefix', 'https://google.example/prefix/v1beta'],
    ['https://google.example/v1beta/', 'https://google.example/v1beta'],
    ['https://google.example/prefix/v1beta/models/gemini:generateContent', 'https://google.example/prefix/v1beta'],
    ['https://google.example/v1', 'https://google.example/v1'],
  ])('preserves the explicitly configured native version in %s', (baseUrl, expected) => {
    expect(normalizeGoogleImageBaseUrl(baseUrl)).toBe(expected)
  })

  it('uses the configured relay prefix with the Images API', () => {
    expect(buildImageProviderUrl({ ...makeProfile(), baseUrl: 'https://relay.example/prefix/v1' }, 'models', 'openai')).toBe('https://relay.example/prefix/v1/models')
  })

  it('rejects native Google use through an OpenAI proxy explicitly', () => {
    vi.stubEnv('VITE_API_PROXY_AVAILABLE', 'true')
    expect(() => buildImageProviderUrl({ ...makeProfile(), apiProxy: true }, 'models', 'gemini')).toThrow('Google 原生生图接口不支持 OpenAI API 代理')
  })

  it('rejects credentials hidden in native URLs', () => {
    expect(() => normalizeGoogleImageBaseUrl('https://user:secret@google.example/v1beta')).toThrow('不能包含账号')
    expect(() => normalizeGoogleImageBaseUrl('https://google.example/v1beta?key=secret')).toThrow('不能包含账号')
  })
})

describe('image model capability classification', () => {
  it('uses output capability metadata ahead of model names', () => {
    expect(classifyImageModel({ id: 'mystery-model', output_modalities: ['text', 'image'] })).toMatchObject({ imageSupport: 'confirmed', source: 'metadata' })
    expect(classifyImageModel({ id: 'other-model', capabilities: { image_generation: true } })).toMatchObject({ imageSupport: 'confirmed' })
    expect(classifyImageModel({ id: 'image-input-only', input_modalities: ['image'], output_modalities: ['text'] })).toMatchObject({ imageSupport: 'unknown' })
  })

  it.each(['gpt-image-1', 'dall-e-3', 'grok-imagine-image', 'gemini-3.1-flash-image-preview', 'gemini-nano-banana-2.1', 'nano-banana-pro', 'imagen-4.0-generate-001', 'black-forest-labs/flux-2-pro', 'stability-ai/stable-diffusion-xl', 'sdxl', 'recraft-v3', 'qwen-image-edit', 'hunyuan-image-3.0'])('recognizes %s as a possible image model without claiming verification', (id) => {
    expect(classifyImageModel({ id })).toMatchObject({ id, imageSupport: 'likely', source: 'name' })
  })

  it.each(['gemini-3.6-flash', 'gemini-2.5-pro', 'grok-4', 'gpt-4.1', 'clip-vision-encoder'])('keeps ordinary multimodal or text model %s unclassified', (id) => {
    expect(classifyImageModel({ id }).imageSupport).toBe('unknown')
  })

  it('does not override an explicit output capability with an image-sounding name', () => {
    expect(classifyImageModel({ id: 'qwen-image-analyzer', output_modalities: ['text'] }).imageSupport).toBe('unknown')
    expect(classifyImageModel({ id: 'gemini-custom-image', capabilities: { image_generation: false } }).imageSupport).toBe('unknown')
  })
})

describe('model discovery request contract', () => {
  it.each([
    { output_modalities: ['text'] },
    { capabilities: { image_generation: false } },
  ])('lets declared output metadata override a repeated image-sounding name: %j', async (capabilities) => {
    const declared = { id: 'gemini-custom-image', ...capabilities }
    for (const data of [[{ id: declared.id }, declared], [declared, { id: declared.id }]]) {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }))
      const result = await listImageModels({ ...makeProfile(), imageApiDialect: 'openai' })
      expect(result).toMatchObject({ total: 1, unclassified: 1 })
      expect(result.models).toEqual([{ id: declared.id, label: declared.id, imageSupport: 'unknown', source: 'metadata' }])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockRestore()
    }
  })

  it('rejects contradictory declared capabilities for the same model in either order', async () => {
    const image = { id: 'duplicate-model', output_modalities: ['image'] }
    const text = { id: image.id, output_modalities: ['text'] }
    for (const data of [[image, text], [text, image]]) {
      const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }))
      await expect(listImageModels(makeProfile())).rejects.toThrow('生图能力相互矛盾')
      expect(fetchMock).toHaveBeenCalledTimes(1)
      fetchMock.mockRestore()
    }
  })

  it('queries the configured URL with the current key and returns unknown models too', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [
      { id: 'gemini-3.6-flash' },
      { id: 'gemini-nano-banana-2.1' },
      { id: 'odd-model', output_modalities: ['image'], display_name: '图片模型' },
      { id: 'gemini-nano-banana-2.1' },
    ] }), { status: 200 }))
    const result = await listImageModels({ ...makeProfile('gemini-nano-banana-2.1'), imageApiDialect: 'openai' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://relay.example/v1/models')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer private-test-key' })
    expect(result).toMatchObject({ total: 3, unclassified: 1 })
    expect(result.models.map((model) => model.id)).toEqual(['odd-model', 'gemini-nano-banana-2.1', 'gemini-3.6-flash'])
  })

  it('follows Google page tokens with the Google key header and resource names', async () => {
    const apiFetchMock = vi.spyOn(platform, 'apiFetch')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'models/gemini-3.6-flash', displayName: 'Gemini Flash' }], nextPageToken: 'page+2' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'models/gemini-nano-banana-2.1' }] }), { status: 200 }))
    const result = await listImageModels({ ...makeProfile('gemini-nano-banana-2.1'), baseUrl: 'https://google.example', timeout: 900 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toBe('https://google.example/v1beta/models?pageSize=1000')
    expect(fetchMock.mock.calls[1][0]).toBe('https://google.example/v1beta/models?pageSize=1000&pageToken=page%2B2')
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toEqual({ 'x-goog-api-key': 'private-test-key' })
    expect(result).toMatchObject({ total: 2, unclassified: 1 })
    expect(result.models.find((model) => model.id === 'gemini-3.6-flash')?.label).toBe('Gemini Flash')
    expect(apiFetchMock.mock.calls.map(([, init]) => init)).toEqual([
      expect.objectContaining({ timeoutSeconds: 900 }),
      expect.objectContaining({ timeoutSeconds: 900 }),
    ])
  })

  it('rejects duplicate page tokens instead of looping indefinitely', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ models: [], nextPageToken: 'same' }), { status: 200 }))
    await expect(listImageModels({ ...makeProfile('gemini-nano-banana-2.1'), baseUrl: 'https://google.example/v1beta' })).rejects.toThrow('重复返回')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([401, 404, 429, 500])('surfaces HTTP %s without trying another endpoint', async (status) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: `HTTP ${status}: private-test-key` } }), { status }))
    await expect(listImageModels(makeProfile())).rejects.toThrow(`HTTP ${status}: [已隐藏 API Key]`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects an API error carried by a successful HTTP response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: 'key rejected: private-test-key' }, data: [] }), { status: 200 }))
    await expect(listImageModels(makeProfile())).rejects.toThrow('key rejected: [已隐藏 API Key]')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([{ data: [{ missing: 'id' }] }, { success: true }, { data: null }])('rejects malformed model lists without invented candidates', async (payload) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }))
    await expect(listImageModels(makeProfile())).rejects.toThrow()
  })

  it('returns an empty list as a factual empty response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }))
    await expect(listImageModels(makeProfile())).resolves.toEqual({ models: [], total: 0, unclassified: 0 })
  })

  it('preserves cancellation as AbortError', async () => {
    const reason = new DOMException('用户已取消', 'AbortError')
    const controller = new AbortController()
    controller.abort(reason)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => {
      if (init?.signal?.aborted) throw init.signal.reason
      throw new Error('expected cancellation')
    })
    await expect(listImageModels(makeProfile(), controller.signal)).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
