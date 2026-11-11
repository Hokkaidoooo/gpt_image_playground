import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile, type ImageApiDialect } from '../types'
import { callImageApi } from './api'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS, normalizeSettings } from './apiProfiles'
import type { CallApiOptions } from './imageApiShared'
import { callNativeImageApi } from './nativeImageApi'
import * as platform from './platform'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const IMAGE = `data:image/png;base64,${PNG}`
const makeProfile = (model = 'grok-imagine-image', patch: Partial<ApiProfile> = {}) => createDefaultOpenAIProfile({ baseUrl: 'https://provider.example/v1', apiKey: 'private-test-key', model, imageApiDialect: 'auto', streamImages: false, apiProxy: false, ...patch })
const makeOptions = (profile: ApiProfile, patch: Partial<CallApiOptions> = {}): CallApiOptions => ({
  settings: normalizeSettings({ ...DEFAULT_SETTINGS, profiles: [profile], activeProfileId: profile.id }),
  prompt: '生成一只小猫',
  params: { ...DEFAULT_PARAMS, aspect_ratio: profile.imageAspectRatio ?? DEFAULT_PARAMS.aspect_ratio, resolution: profile.imageResolution ?? DEFAULT_PARAMS.resolution },
  inputImageDataUrls: [],
  ...patch,
})
const jsonResponse = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('xAI native image requests', () => {
  it('sends only documented generation parameters and preserves response MIME', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG, mime_type: 'image/png' }] }))
    const profile = makeProfile('grok-imagine-image-2.0', { imageAspectRatio: '16:9', imageResolution: '2K' })
    const result = await callNativeImageApi(makeOptions(profile, { params: { ...DEFAULT_PARAMS, n: 2, aspect_ratio: '16:9', resolution: '2K' } }), profile)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/images/generations')
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.headers).toMatchObject({ Authorization: 'Bearer private-test-key', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ model: 'grok-imagine-image-2.0', prompt: '生成一只小猫', n: 2, aspect_ratio: '16:9', resolution: '2k', quality: 'auto' })
    expect(result.images).toEqual([IMAGE])
    expect(result.images[0]).toMatch(/^data:image\/png;/)
  })

  it('uses JSON image for single image editing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG, mime_type: 'image/png' }] }))
    const profile = makeProfile()
    await callNativeImageApi(makeOptions(profile, { inputImageDataUrls: [IMAGE] }), profile)
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/images/edits')
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.image).toEqual({ type: 'image_url', url: IMAGE })
    expect(body).not.toHaveProperty('images')
    expect(body).not.toHaveProperty('size')
    expect(body).not.toHaveProperty('mask')
  })

  it('uses JSON images for multi-image editing and permits its aspect ratio', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG, mime_type: 'image/png' }] }))
    const profile = makeProfile('grok-imagine-image', { imageAspectRatio: '3:4' })
    await callNativeImageApi(makeOptions(profile, { inputImageDataUrls: [IMAGE, IMAGE] }), profile)
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body.images).toEqual([{ type: 'image_url', url: IMAGE }, { type: 'image_url', url: IMAGE }])
    expect(body).not.toHaveProperty('image')
    expect(body.aspect_ratio).toBe('3:4')
  })

  it('uses supported aspect ratio and quality for native xAI editing', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG }] }))
    const profile = makeProfile('grok-imagine-image-2.0')
    await callNativeImageApi(makeOptions(profile, { inputImageDataUrls: [IMAGE], params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', quality: 'medium' } }), profile)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ aspect_ratio: '16:9', quality: 'medium', image: { type: 'image_url', url: IMAGE } })
  })

  it('rejects more than five reference images before requesting the API', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = makeProfile()
    await expect(callNativeImageApi(makeOptions(profile, { inputImageDataUrls: Array(6).fill(IMAGE) }), profile)).rejects.toThrow('5')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('downloads a returned URL through the existing image fetch helper', async () => {
    const apiFetchMock = vi.spyOn(platform, 'apiFetch')
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [{ url: 'https://images.example/cat.png', mime_type: 'image/png' }] }))
      .mockResolvedValueOnce(new Response(Uint8Array.from(atob(PNG), (character) => character.charCodeAt(0)), { status: 200, headers: { 'Content-Type': 'image/png' } }))
    const profile = makeProfile('grok-imagine-image', { timeout: 900 })
    const result = await callNativeImageApi(makeOptions(profile), profile)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe('https://images.example/cat.png')
    expect(result.images).toEqual([IMAGE])
    expect(result.rawImageUrls).toEqual(['https://images.example/cat.png'])
    expect(apiFetchMock.mock.calls.map(([, init]) => init)).toEqual([
      expect.objectContaining({ timeoutSeconds: 900 }),
      expect.objectContaining({ timeoutSeconds: 900 }),
    ])
  })

  it.each([
    ['HTTP 403', () => new Response('expired', { status: 403 })],
    ['interrupted body', () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('下载中断 private-test-key')) },
    }), { headers: { 'Content-Type': 'image/png' } })],
  ] as const)('keeps every generated URL when downloading fails with %s', async (_, failedResponse) => {
    const urls = ['https://images.example/first.png?signature=keep-first', 'https://images.example/second.png?signature=keep-second']
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: urls.map((url) => ({ url, mime_type: 'image/png' })) }))
      .mockResolvedValueOnce(failedResponse())
    const profile = makeProfile()
    const error = await callNativeImageApi(makeOptions(profile), profile).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ rawImageUrls: urls })
    expect((error as Error).message).not.toContain(profile.apiKey)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1][0]).toBe(urls[0])
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).has('Authorization')).toBe(false)
  })
})

describe('Google generateContent image requests', () => {
  it('sends native text and inlineData with imageConfig without GPT parameters', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '一只小猫' }, { inlineData: { mimeType: 'image/png', data: PNG } }] } }] }))
    const profile = makeProfile('gemini-3.1-flash-image-preview', { baseUrl: 'https://google.example/v1beta', imageAspectRatio: '4:5', imageResolution: '4K' })
    const result = await callNativeImageApi(makeOptions(profile, { inputImageDataUrls: [IMAGE] }), profile)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(fetchMock.mock.calls[0][0]).toBe('https://google.example/v1beta/models/gemini-3.1-flash-image-preview:generateContent')
    expect(init.headers).toEqual({ 'x-goog-api-key': 'private-test-key', 'Content-Type': 'application/json' })
    expect(JSON.parse(String(init.body))).toEqual({ contents: [{ role: 'user', parts: [{ text: '生成一只小猫' }, { inlineData: { mimeType: 'image/png', data: PNG } }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '4:5', imageSize: '4K' } } })
    expect(result.images).toEqual([IMAGE])
  })

  it('accepts the documented snake-case inline_data response from compatible gateways', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: PNG } }] } }] }))
    const profile = makeProfile('gemini-2.5-flash-image', { baseUrl: 'https://google.example' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).resolves.toMatchObject({ images: [IMAGE] })
  })

  it.each([
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'SAFETY'],
    [{ candidates: [{ finishReason: 'IMAGE_SAFETY', content: { parts: [] } }] }, 'IMAGE_SAFETY'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }, 'MAX_TOKENS'],
    [{ candidates: [{ content: { parts: [{ text: '不能生成图片' }] } }] }, '不能生成图片'],
  ])('fails explicitly for blocked or image-free responses', async (payload, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload))
    const profile = makeProfile('gemini-2.5-flash-image', { baseUrl: 'https://google.example' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow(String(reason))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('executes explicitly requested Google images sequentially and checkpoints each result', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] }))
    const completed = vi.fn().mockResolvedValue(undefined)
    const profile = makeProfile('gemini-3.1-flash-image', { baseUrl: 'https://google.example' })
    const result = await callNativeImageApi(makeOptions(profile, { params: { ...DEFAULT_PARAMS, n: 2 }, onRequestCompleted: completed }), profile)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(completed.mock.calls.map((call) => call[1])).toEqual([0, 1])
    expect(result.images).toEqual([IMAGE, IMAGE])
  })
})

describe('Google Interactions image requests', () => {
  it('uses the Interactions request and steps content response contract', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'completed', steps: [
      { type: 'user_input', content: [{ type: 'image', mime_type: 'image/png', data: 'ignored-user-image' }] },
      { type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG }] },
    ] }))
    const profile = makeProfile('gemini-nano-banana-2.1', { baseUrl: 'https://google.example/v1beta', imageAspectRatio: '5:4', imageResolution: '2K' })
    const result = await callNativeImageApi(makeOptions(profile, { inputImageDataUrls: [IMAGE] }), profile)
    expect(fetchMock.mock.calls[0][0]).toBe('https://google.example/v1beta/interactions')
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ model: 'gemini-nano-banana-2.1', input: [{ type: 'text', text: '生成一只小猫' }, { type: 'image', mime_type: 'image/png', data: PNG }], response_format: { type: 'image', delivery: 'inline', aspect_ratio: '5:4', image_size: '2K' } })
    expect(body).not.toHaveProperty('generationConfig')
    expect(body).not.toHaveProperty('responseModalities')
    expect(result.images).toEqual([IMAGE])
  })

  it('rejects an unfinished response without inventing output fields or polling', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'in_progress', steps: [] }))
    const profile = makeProfile('gemini-nano-banana-2.1', { baseUrl: 'https://google.example' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow('in_progress')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('rejects obsolete outputs payloads instead of reporting fake success', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'completed', outputs: [{ type: 'image', data: PNG, mime_type: 'image/png' }] }))
    const profile = makeProfile('gemini-nano-banana-2.1', { baseUrl: 'https://google.example' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow('steps')
  })

  it('rejects a model-specific unsupported resolution before calling Google', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = makeProfile('gemini-nano-banana-2.1', { baseUrl: 'https://google.example', imageResolution: '512' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow('分辨率')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('historical Imagen relay compatibility', () => {
  it('requires explicit historical protocol selection', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = makeProfile('imagen-4.0-generate-001', { baseUrl: 'https://google-relay.example/v1beta' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow('手动选择')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('accepts explicit legacy predict requests and prediction image bytes', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ predictions: [{ bytesBase64Encoded: PNG, mimeType: 'image/png' }] }))
    const profile = makeProfile('imagen-4.0-generate-001', { baseUrl: 'https://google-relay.example/v1beta', imageApiDialect: 'imagen', imageAspectRatio: '16:9', imageResolution: '2K' })
    const result = await callNativeImageApi(makeOptions(profile, { params: { ...DEFAULT_PARAMS, n: 4, aspect_ratio: '16:9', resolution: '2K' } }), profile)
    expect(fetchMock.mock.calls[0][0]).toBe('https://google-relay.example/v1beta/models/imagen-4.0-generate-001:predict')
    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))
    expect(body).toEqual({ instances: [{ prompt: '生成一只小猫' }], parameters: { sampleCount: 4, aspectRatio: '16:9', sampleImageSize: '2K' } })
    expect(result.images).toEqual([IMAGE])
  })
})

describe('native image validation and errors', () => {
  it('preserves AbortError without rewriting its read-only DOMException message', async () => {
    const reason = new DOMException('请求超时', 'AbortError')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(reason)
    const profile = makeProfile()
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toBe(reason)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ maskDataUrl: IMAGE }, '遮罩'],
    [{ nativeTransparentBackground: true }, '透明背景'],
    [{ params: { ...DEFAULT_PARAMS, size: '1024x1024' } }, '像素尺寸'],
    [{ params: { ...DEFAULT_PARAMS, quality: 'high' as const } }, '质量'],
    [{ params: { ...DEFAULT_PARAMS, moderation: 'low' as const } }, '审核'],
    [{ params: { ...DEFAULT_PARAMS, output_compression: 80 } }, '压缩'],
    [{ params: { ...DEFAULT_PARAMS, transparent_output: true } }, '透明背景'],
  ] satisfies Array<[Partial<CallApiOptions>, string]>)('rejects unsupported options without dropping them silently', async (patch, reason) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = makeProfile()
    await expect(callNativeImageApi(makeOptions(profile, patch), profile)).rejects.toThrow(reason)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([-1, 0, 1.5, 11, Number.NaN])('rejects invalid xAI output counts %s before requesting', async (n) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const profile = makeProfile()
    await expect(callNativeImageApi(makeOptions(profile, { params: { ...DEFAULT_PARAMS, n } }), profile)).rejects.toThrow('数量')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each(['xai', 'gemini', 'gemini-interactions'] satisfies ImageApiDialect[])('does not change protocol or model after %s fails', async (dialect) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: { message: 'provider refused private-test-key' } }, 429))
    const profile = makeProfile('selected-image-model', { imageApiDialect: dialect })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow('provider refused [已隐藏 API Key]')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([{ data: [] }, { data: [{}] }, { error: { message: 'API rejected' } }])('does not mark malformed or unsuccessful JSON as generated images', async (payload) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse(payload))
    const profile = makeProfile()
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not treat internal thought images as finished Google output', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ candidates: [{ content: { parts: [{ thought: true, inlineData: { mimeType: 'image/png', data: PNG } }] } }] }))
    const profile = makeProfile('gemini-3.1-flash-image', { baseUrl: 'https://google.example' })
    await expect(callNativeImageApi(makeOptions(profile), profile)).rejects.toThrow('未返回图片')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('image API dispatch', () => {
  it('dispatches native image models through their chosen protocol', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'image', mime_type: 'image/png', data: PNG }] }] }))
    const profile = makeProfile('gemini-nano-banana-2.1', { baseUrl: 'https://google.example/v1beta' })
    await expect(callImageApi(makeOptions(profile))).resolves.toMatchObject({ images: [IMAGE] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://google.example/v1beta/interactions')
  })

  it('keeps the Images API for a Gemini model explicitly wrapped by a relay', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ data: [{ b64_json: PNG, output_format: 'png' }] }))
    const profile = makeProfile('gemini-nano-banana-2.1', { imageApiDialect: 'openai' })
    await expect(callImageApi(makeOptions(profile))).resolves.toMatchObject({ images: [IMAGE] })
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/images/generations')
  })
})
