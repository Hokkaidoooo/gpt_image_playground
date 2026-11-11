import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchThroughLocalBridge, hasLocalImageBridge, LocalImageSaveError, localImageRecord, saveLocalGeneratedImages } from './localRuntime'
import { createDefaultOpenAIProfile } from './apiProfiles'
import { DEFAULT_PARAMS, type TaskRecord } from '../types'

const origin = 'http://127.0.0.1:17865'
const token = 'test-only-session-token'

function metadata(init: RequestInit) {
  const value = new Headers(init.headers).get('X-Local-Request')
  if (!value) throw new Error('测试没有收到代理元数据')
  return JSON.parse(decodeURIComponent(value)) as { url: string; method: string; headers: string[][]; timeoutSeconds?: number }
}

describe('通用供应商本机连接', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      location: new URL(origin + '/'),
      __LOCAL_IMAGE_BOOTSTRAP__: { preset: 'embedded-config:test-only', token, bridgeVersion: 2, saveGeneratedImages: true },
      get localStorage() { throw new Error('会话凭据禁止持久化') },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ['https://first.example.test/v1/images/generations', 'Bearer first-test-key'],
    ['https://second.example.test/v1/models', 'Bearer second-test-key'],
    ['https://google.example.test/v1beta/models/gemini-image:generateContent', 'Key third-test-key'],
  ])('转发当前选择的URL和密钥，向上游不暴露本机会话：%s', async (url, credential) => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    await fetchThroughLocalBridge(url, { method: 'POST', headers: { Authorization: credential, 'Content-Type': 'application/json' }, body: '{"model":"selected-image-model"}' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [target, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(target).toBe('/local/proxy')
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${token}`)
    const meta = metadata(init)
    expect(meta.url).toBe(url)
    expect(meta.headers).toContainEqual(['authorization', credential])
    expect(JSON.stringify(meta)).not.toContain(token)
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe('{"model":"selected-image-model"}')
  })

  it('供应商等待时间原样送到后端，未指定时由后端统一决定', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    await fetchThroughLocalBridge('https://supplier.example.test/v1/models', { timeoutSeconds: 1800 })
    expect(metadata(fetch.mock.calls[0][1]).timeoutSeconds).toBe(1800)
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('timeoutSeconds')
    await fetchThroughLocalBridge('https://supplier.example.test/v1/models')
    expect(metadata(fetch.mock.calls[1][1])).not.toHaveProperty('timeoutSeconds')
  })

  it('本机同源请求不携带内部超时配置字段', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    await fetchThroughLocalBridge('/health', { timeoutSeconds: 1200 })
    expect(fetch.mock.calls[0][1]).not.toHaveProperty('timeoutSeconds')
  })

  it('模型列表只做一次只读GET，未发送生图body', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"data":[]}'))
    vi.stubGlobal('fetch', fetch)
    await fetchThroughLocalBridge('https://supplier.example.test/v1/models', { headers: { 'x-goog-api-key': 'google-test-key' } })
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(metadata(init).method).toBe('GET')
    expect(metadata(init).headers).toContainEqual(['x-goog-api-key', 'google-test-key'])
    expect(init.body).toBeUndefined()
  })

  it('multipart使用实际生成的边界，参考图字节不丢失', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const data = new FormData()
    data.append('prompt', '保留参考图')
    data.append('image[]', new Blob(['test-image-bytes'], { type: 'image/png' }), 'input.png')
    await fetchThroughLocalBridge('https://supplier.example.test/v1/images/edits', { method: 'POST', body: data })
    const [, init] = fetch.mock.calls[0] as [string, RequestInit]
    const contentType = metadata(init).headers.find(([name]) => name === 'content-type')?.[1]
    expect(contentType).toMatch(/^multipart\/form-data; boundary=/)
    const body = new TextDecoder().decode(init.body as ArrayBuffer)
    expect(body).toContain('test-image-bytes')
    expect(body).toContain('保留参考图')
  })

  it('只读本机资源和data URL不使用代理', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('ok'))
    vi.stubGlobal('fetch', fetch)
    await fetchThroughLocalBridge('/health')
    await fetchThroughLocalBridge('data:text/plain,ok')
    expect(fetch.mock.calls.map(([target]) => target)).toEqual(['/health', 'data:text/plain,ok'])
  })

  it('上游失败原样返回且不重试', async () => {
    const response = new Response('{"error":{"message":"actual upstream failure"}}', { status: 429 })
    const fetch = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetch)
    expect(await fetchThroughLocalBridge('https://supplier.example.test/v1/models')).toBe(response)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('误把本机会话token填到供应商Key时阻止转发', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(fetchThroughLocalBridge('https://supplier.example.test/v1/models', { headers: { Authorization: `Bearer ${token}` } })).rejects.toThrow('本机连接凭据不能作为供应商密钥')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('取消请求的信号仍传给本机代理', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    await fetchThroughLocalBridge('https://supplier.example.test/v1/models', { signal: controller.signal })
    expect(fetch.mock.calls[0][1].signal).toBe(controller.signal)
  })

  it('旧后台版本明确失败，不能静默回落到原固定站点', async () => {
    window.__LOCAL_IMAGE_BOOTSTRAP__!.bridgeVersion = 1
    vi.stubGlobal('fetch', vi.fn())
    expect(hasLocalImageBridge()).toBe(false)
    await expect(fetchThroughLocalBridge('https://supplier.example.test/v1/models')).rejects.toThrow('本机服务版本已更新')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('本地保存与提示词摘要', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: new URL(origin + '/'), __LOCAL_IMAGE_BOOTSTRAP__: { preset: 'test', token, bridgeVersion: 2, saveGeneratedImages: true } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('摘要只包含图片参数，不含API Key', () => {
    const profile = createDefaultOpenAIProfile({ model: 'gpt-image, grok-imagine-image', selectedModel: 'grok-imagine-image', apiKey: 'do-not-record-test-key', imageAspectRatio: '16:9' })
    const task: TaskRecord = { id: 'record-fixture', prompt: '记录原提示词', params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9' }, inputImageIds: [], outputImages: [], status: 'done', error: null, createdAt: 1, finishedAt: 2, elapsed: 1 }
    const record = localImageRecord(task, profile)
    expect(record.model).toBe('grok-imagine-image')
    expect(record.aspect_ratio).toBe('16:9')
    expect(JSON.stringify(record)).not.toContain(profile.apiKey)
    expect(record).not.toHaveProperty('apiKey')
    expect(localImageRecord({ ...task, apiModel: 'captured-image-model' }, profile).model).toBe('captured-image-model')
  })

  it('只保存最终图片，清除endpoint中的敏感查询字段', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{"saved":true}'))
    vi.stubGlobal('fetch', fetch)
    await saveLocalGeneratedImages(['data:image/png;base64,aW1hZ2U='], { prompt: '真实提示词', model: 'grok-image' }, 'https://supplier.example.test/v1?key=do-not-save-test-key')
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/local/save-images')
    const body = JSON.parse(init.body as string)
    expect(body.endpoint).toBe('https://supplier.example.test/v1')
    expect(body.request.prompt).toBe('真实提示词')
    expect(JSON.stringify(body)).not.toContain('do-not-save-test-key')
  })

  it('关闭落盘后仍交给后端验证，不静默接受损坏图片', async () => {
    window.__LOCAL_IMAGE_BOOTSTRAP__!.saveGeneratedImages = false
    const fetch = vi.fn().mockResolvedValue(new Response('{"saved":false}'))
    vi.stubGlobal('fetch', fetch)
    await saveLocalGeneratedImages(['data:image/png;base64,aW1hZ2U='], { prompt: 'test', model: 'test-image' }, 'https://supplier.example.test/v1')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('保存失败明确保留“已生成”信息，不能误导重新扣费', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"message":"磁盘写入失败"}}', { status: 502 })))
    await expect(saveLocalGeneratedImages(['data:image/png;base64,aW1hZ2U='], { prompt: 'test', model: 'test-image' }, 'https://supplier.example.test/v1')).rejects.toThrow('图片已经生成，但本地保存失败')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('损坏图片返回独立的验证失败，不能成为普通落盘提示', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":{"code":"invalid_image","message":"图片内容损坏"}}', { status: 502 })))
    await expect(saveLocalGeneratedImages(['data:image/png;base64,aW1hZ2U='], { prompt: 'test', model: 'test-image' }, 'https://supplier.example.test/v1')).rejects.toMatchObject({ name: 'LocalImageSaveError', invalidImages: true })
  })

  it('保存连接失败明确抛错，且没有再次发送请求', async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError('本机连接中断'))
    vi.stubGlobal('fetch', fetch)
    await expect(saveLocalGeneratedImages(['data:image/png;base64,aW1hZ2U='], { prompt: 'test', model: 'test-image' }, 'https://supplier.example.test/v1')).rejects.toBeInstanceOf(LocalImageSaveError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
