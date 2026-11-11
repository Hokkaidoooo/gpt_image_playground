import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiProfile } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { createDefaultOpenAIProfile, DEFAULT_SETTINGS } from './apiProfiles'
import { getApiErrorMessage, type CallApiOptions } from './imageApiShared'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import * as canvasImage from './canvasImage'
import { prepareImageInputs } from './imageInputPreparation'

vi.mock('./imageInputPreparation', () => ({
  prepareImageInputs: vi.fn(async (dataUrls: string[], mask?: string) => ({
    blobs: dataUrls.map(() => new Blob(['fixture-image'], { type: 'image/png' })),
    mask: mask ? new Blob(['fixture-mask'], { type: 'image/png' }) : null,
    adjustments: [],
  })),
}))

const inputImage = 'data:image/png;base64,aW1hZ2U='
const profile = createDefaultOpenAIProfile({ baseUrl: 'https://api.freeshengtu.com/v1', apiKey: 'test-key', model: 'gpt-image-2.6-sunburst' })
const options: CallApiOptions = { settings: DEFAULT_SETTINGS, prompt: '参数兼容单元测试', params: { ...DEFAULT_PARAMS }, inputImageDataUrls: [] }
const response = (count = 1) => new Response(JSON.stringify({ data: Array.from({ length: count }, (_, index) => ({ b64_json: `image${index}` })) }), { status: 200, headers: { 'Content-Type': 'application/json' } })

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('Images API 供应商兼容执行', () => {
  it('原生标注与主图一起准备并以markup字段提交，不冒充遮罩', async () => {
    vi.mocked(prepareImageInputs).mockResolvedValueOnce({ blobs: [new Blob(['resized-main'], { type: 'image/png' })], mask: new Blob(['resized-markup'], { type: 'image/png' }), adjustments: ['遮罩主图上传副本：缩小', '遮罩上传副本：同步缩小'] })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    const result = await callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], markupDataUrl: inputImage }, profile)
    expect(prepareImageInputs).toHaveBeenCalledWith([inputImage], inputImage, expect.any(Object))
    const body = fetchMock.mock.calls[0][1]?.body as FormData
    expect(body.has('mask')).toBe(false)
    expect(await (body.get('markup') as File).text()).toBe('resized-markup')
    expect(await (body.get('image[]') as File).text()).toBe('resized-main')
    expect(result.inputImageAdjustments).toEqual(['标注主图上传副本：缩小', '标注上传副本：同步缩小'])
  })

  it('参考图只准备一次，所有批次复用真实MIME和文件名并保留调整记录', async () => {
    const adjustments = ['参考图 1上传副本：20 MB → 10 MB，JPEG；原图保留。']
    vi.mocked(prepareImageInputs).mockResolvedValueOnce({ blobs: [new Blob(['prepared-jpeg'], { type: 'image/jpeg' })], mask: null, adjustments })
    const prepared = vi.fn().mockResolvedValue(undefined)
    const completed = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const result = await callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], params: { ...DEFAULT_PARAMS, n: 3 }, onInputImagesPrepared: prepared, onRequestCompleted: completed }, profile)
    expect(prepareImageInputs).toHaveBeenCalledTimes(1)
    expect(prepared).toHaveBeenCalledExactlyOnceWith(adjustments)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    for (const [, request] of fetchMock.mock.calls) {
      const file = (request?.body as FormData).get('image[]') as File
      expect(file.type).toBe('image/jpeg')
      expect(file.name).toBe('input-1.jpeg')
      expect(await file.text()).toBe('prepared-jpeg')
    }
    expect(completed.mock.calls.every((call) => call[0].inputImageAdjustments === adjustments)).toBe(true)
    expect(result.inputImageAdjustments).toEqual(adjustments)
  })

  it('准备记录先保存再发送，后续供应商失败仍保留调整证据', async () => {
    const adjustments = ['参考图 1已规范为 JPEG。']
    vi.mocked(prepareImageInputs).mockResolvedValueOnce({ blobs: [new Blob(['prepared'], { type: 'image/jpeg' })], mask: null, adjustments })
    const prepared = vi.fn().mockResolvedValue(undefined)
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      expect(prepared).toHaveBeenCalledExactlyOnceWith(adjustments)
      return new Response('supplier failure', { status: 400 })
    })
    await expect(callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], onInputImagesPrepared: prepared }, profile)).rejects.toThrow('HTTP 400')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('参考图损坏时不发送供应商请求', async () => {
    vi.mocked(prepareImageInputs).mockRejectedValueOnce(new Error('参考图 1无法解码，文件已损坏。'))
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage] }, profile)).rejects.toThrow('文件已损坏')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('五张按单张顺序发送，每批保存完成后才发送下一批', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    let release!: () => void
    const checkpoint = new Promise<void>((resolve) => { release = resolve })
    const completed = vi.fn().mockImplementationOnce(() => checkpoint).mockResolvedValue(undefined)
    const task = callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 }, onRequestCompleted: completed }, profile)
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(1))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    release()
    const result = await task
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(completed.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 3, 4])
    expect(result.images).toHaveLength(5)
    expect(result.failedRequests).toBeUndefined()
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).n)).toEqual([undefined, undefined, undefined, undefined, undefined])
  })

  it('自定义每次两张保留总目标，按2、2、1执行', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_, init) => response(JSON.parse(String(init?.body)).n ?? 1))
    const completed = vi.fn().mockResolvedValue(undefined)
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 }, onRequestCompleted: completed }, { ...profile, imageRequestCompatibility: { mode: 'custom', maxImagesPerRequest: 2 } })
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).n ?? 1)).toEqual([2, 2, 1])
    expect(completed.mock.calls.map((call) => call[1])).toEqual([0, 2, 4])
    expect(result.images).toHaveLength(5)
  })

  it('第二批失败保留首张，标明失败及未发送槽位且不重试', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(response()).mockResolvedValueOnce(new Response('error code: 524', { status: 524 }))
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 } }, profile)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toHaveLength(1)
    expect(result.failedRequests?.map((item) => item.requestIndex)).toEqual([1, 2, 3, 4])
    expect(result.failedRequests?.[0].error).toContain('HTTP 524')
    expect(result.failedRequests?.slice(1).every((item) => item.error.includes('未发送'))).toBe(true)
  })

  it('首批失败直接暴露错误并停止', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('no access', { status: 403 }))
    await expect(callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 } }, profile)).rejects.toThrow('HTTP 403')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('任务停止后保留已完成图，不再发送剩余请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    let continuing = true
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 3 }, shouldContinue: () => continuing, onRequestCompleted: async () => { continuing = false } }, profile)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.images).toHaveLength(1)
    expect(result.failedRequests?.map((item) => item.requestIndex)).toEqual([1, 2])
    expect(result.failedRequests?.[0].error).toContain('任务已停止')
  })

  it('供应商少返回图片时显式标记缺失并停止后续', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(2))
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 } }, { ...profile, imageRequestCompatibility: { mode: 'custom', maxImagesPerRequest: 3 } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.images).toHaveLength(2)
    expect(result.failedRequests?.map((item) => item.requestIndex)).toEqual([2, 3, 4])
    expect(result.failedRequests?.[0].error).toContain('供应商只返回 2 张')
  })

  it('供应商多返回图片时保留全部结果并明确报错', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(2))
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 3 } }, profile)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.images).toHaveLength(2)
    expect(result.completionError).toContain('超过本批请求的 1 张')
    expect(result.failedRequests?.map((item) => item.requestIndex)).toEqual([2])
  })

  it('参考图转换期间取消任务不发送生成请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    let continuing = true
    vi.mocked(prepareImageInputs).mockImplementationOnce(async () => {
      continuing = false
      return { blobs: [new Blob(['fixture-image'], { type: 'image/png' })], mask: null, adjustments: [] }
    })
    await expect(callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], shouldContinue: () => continuing }, profile)).rejects.toThrow('本次请求未发送')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('第二批保存失败保留两张生成结果并停止后续', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const completed = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('数据库写入失败'))
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 3 }, onRequestCompleted: completed }, profile)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toHaveLength(2)
    expect(result.completionError).toContain('数据库写入失败')
    expect(result.failedRequests?.map((item) => item.requestIndex)).toEqual([2])
  })

  it('每批拥有独立的超时期限', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_, init) => new Promise<Response>((resolve, reject) => {
      setTimeout(() => resolve(response()), 3000)
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
    }))
    const task = callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 2 } }, { ...profile, timeout: 5 })
    await vi.advanceTimersByTimeAsync(6000)
    const result = await task
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toHaveLength(2)
  })

  it.each([false, true])('Orbitix文生图/编辑采用相同省略规则，编辑=%s', async (edit) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, moderation: 'low' }, inputImageDataUrls: edit ? [inputImage] : [] }, { ...profile, baseUrl: 'https://new.orbitix.site/v1' })
    const body = fetchMock.mock.calls[0][1]?.body
    expect(edit ? (body as FormData).has('moderation') : Object.prototype.hasOwnProperty.call(JSON.parse(String(body)), 'moderation')).toBe(false)
  })

  it('自定义省略在JSON与FormData均生效，输出格式按供应商默认处理', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const custom: ApiProfile = { ...profile, responseFormatB64Json: true, imageRequestCompatibility: { mode: 'custom', omitParameters: ['moderation', 'quality', 'size', 'output_format', 'output_compression', 'response_format'] } }
    for (const inputImageDataUrls of [[], [inputImage]]) {
      const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, output_format: 'jpeg', output_compression: 50 }, inputImageDataUrls }, custom)
      expect(result.images[0]).toMatch(/^data:image\/png;/)
    }
    const generation = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    const edit = fetchMock.mock.calls[1][1]?.body as FormData
    for (const name of custom.imageRequestCompatibility!.omitParameters!) {
      expect(Object.prototype.hasOwnProperty.call(generation, name)).toBe(false)
      expect(edit.has(name)).toBe(false)
    }
    expect(edit.getAll('image[]')).toHaveLength(1)
  })

  it('单参考图字段image真实生效，额外参考图在发送前拒绝', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    const custom: ApiProfile = { ...profile, imageRequestCompatibility: { mode: 'custom', editImageField: 'image' } }
    await callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage] }, custom)
    const body = fetchMock.mock.calls[0][1]?.body as FormData
    expect(body.getAll('image')).toHaveLength(1)
    expect(body.has('image[]')).toBe(false)
    await expect(callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage, inputImage] }, custom)).rejects.toThrow('只保留一张参考图')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('标准模式明确关闭自动分批及站点省略规则', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(5))
    await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5, moderation: 'low' } }, { ...profile, baseUrl: 'https://new.orbitix.site/v1', imageRequestCompatibility: { mode: 'standard' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ n: 5, moderation: 'low' })
  })
})

describe('供应商错误分类', () => {
  it.each([
    [524, '网关等待'], [502, '上游暂时不可用'], [503, '上游暂时不可用'], [504, '上游暂时不可用'],
    [429, '限流或额度不足'], [401, '身份验证失败'], [403, '拒绝访问'],
  ])('HTTP %s保留原始错误并提供对应说明', async (status, hint) => {
    const message = await getApiErrorMessage(new Response(JSON.stringify({ error: { message: 'original failure' } }), { status: Number(status) }))
    expect(message).toContain(`HTTP ${status}`)
    expect(message).toContain('original failure')
    expect(message).toContain(hint)
  })

  it('识别张数与参数不兼容，保留原始错误', async () => {
    expect(await getApiErrorMessage(new Response(JSON.stringify({ error: 'n must be between 1 and 4' }), { status: 400 }))).toContain('降低每次请求张数')
    const message = await getApiErrorMessage(new Response(JSON.stringify({ error: { code: 'unsupported_backend_parameter', message: 'The ChatGPT web transport cannot honor moderation.' } }), { status: 400 }))
    expect(message).toContain('cannot honor moderation')
    expect(message).toContain('供应商后端不支持该参数')
  })

  it('HTML网关页只保留可读摘要，不把脚本和整页标记显示出来', async () => {
    const message = await getApiErrorMessage(new Response('<html><head><style>hidden-css</style></head><body><script>hidden-script</script><h1>Gateway Timeout</h1></body></html>', { status: 504 }))
    expect(message).toContain('Gateway Timeout')
    expect(message).not.toMatch(/<html|hidden-css|hidden-script/)
  })

  it('读取错误响应失败仍保留HTTP状态与真实读取原因', async () => {
    const failed = new Response('failure', { status: 503 })
    vi.spyOn(failed, 'text').mockRejectedValue(new Error('连接中断'))
    expect(await getApiErrorMessage(failed)).toBe('HTTP 503：无法读取供应商错误响应：连接中断')
  })
})


describe('OpenAI兼容模型的批次与上传副本', () => {
  it.each(['gemini-example-image', 'grok-imagine-image-2.0'])('%s自动兼容每次一张，逐批保存且只准备一次参考图', async (model) => {
    const adjustments = ['已生成JPEG上传副本']
    vi.mocked(prepareImageInputs).mockResolvedValueOnce({ blobs: [new Blob(['small-jpeg'], { type: 'image/jpeg' })], mask: null, adjustments })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const completed = vi.fn().mockResolvedValue(undefined)
    const result = await callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], params: { ...DEFAULT_PARAMS, n: 5 }, onRequestCompleted: completed }, { ...profile, model, imageApiDialect: 'openai' })
    expect(prepareImageInputs).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(completed.mock.calls.map((call) => call[1])).toEqual([0, 1, 2, 3, 4])
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body))
      expect(body.n).toBe(1)
      expect(model.startsWith('gemini') ? body.image_urls[0] : body.image.url).toBe('data:image/jpeg;base64,c21hbGwtanBlZw==')
    }
    expect(result.images).toHaveLength(5)
    expect(result.inputImageAdjustments).toEqual(adjustments)
  })

  it('兼容模型逐批保存失败后保留已生成图并停止后续', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    const completed = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('保存失败'))
    const result = await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 }, onRequestCompleted: completed }, { ...profile, model: 'gemini-example-image', imageApiDialect: 'openai' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.images).toHaveLength(2)
    expect(result.completionError).toContain('保存失败')
    expect(result.failedRequests?.map((failure) => failure.requestIndex)).toEqual([2, 3, 4])
  })

  it('family参数省略按实际字段执行且标准模式保留原批量', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => response())
    for (const model of ['gemini-example-image', 'grok-imagine-1.5-ext', 'grok-imagine-image-2.0']) {
      await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, aspect_ratio: '16:9', quality: 'medium' } }, { ...profile, model, imageApiDialect: 'openai', responseFormatB64Json: true, imageRequestCompatibility: { mode: 'custom', omitParameters: ['size', 'quality', 'response_format'] } })
      const body = JSON.parse(String(fetchMock.mock.lastCall?.[1]?.body))
      expect(body).not.toHaveProperty('size')
      expect(body).not.toHaveProperty('quality')
      expect(body).not.toHaveProperty('response_format')
    }
    fetchMock.mockClear()
    await callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 5 } }, { ...profile, model: 'gemini-example-image', imageApiDialect: 'openai', imageRequestCompatibility: { mode: 'standard' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).n).toBe(5)
  })

  it('链接型Grok参考图保持原URL契约并明确上传副本不适用', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response())
    const result = await callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], inputImageUrls: ['https://images.example/input.png'] }, { ...profile, model: 'grok-imagine-1.5-apimart', imageApiDialect: 'openai' })
    expect(prepareImageInputs).not.toHaveBeenCalled()
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)).image_urls).toEqual(['https://images.example/input.png'])
    expect(result.inputImageAdjustments?.[0]).toContain('自动优化不适用')
  })

  it('custom multipart转换期间取消后不发真正请求', async () => {
    let continuing = true
    vi.spyOn(canvasImage, 'dataUrlToBlob').mockImplementationOnce(async () => {
      await Promise.resolve()
      continuing = false
      return new Blob(['prepared'], { type: 'image/png' })
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    await expect(callOpenAICompatibleImageApi({ ...options, inputImageDataUrls: [inputImage], shouldContinue: () => continuing }, { ...profile, provider: 'custom' }, {
      id: 'custom', name: 'custom', template: 'http-image', submit: { path: 'generate', contentType: 'multipart', body: { prompt: '$prompt' }, files: [{ field: 'image', source: 'inputImages' }], result: { b64JsonPaths: ['data.*.b64_json'] } },
    })).rejects.toThrow('本次请求未发送')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})


it('后续异步批次连接中断交回恢复流程，保留已checkpoint结果且不提交第三批', async () => {
  let release!: () => void
  const persisted = new Promise<void>((resolve) => { release = resolve })
  const checkpoint = vi.fn().mockResolvedValue(undefined)
  const queued = vi.fn(() => persisted)
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ task_id: 'pending-second' }] }), { status: 202 }))
    .mockImplementationOnce(async (_url, init) => {
      if (!(init?.signal instanceof AbortSignal)) throw new Error('missing signal')
      init.signal.dispatchEvent(new Event('abort'))
      Object.defineProperty(init.signal, 'aborted', { value: true })
      throw new DOMException('连接已中断', 'AbortError')
    })
  const task = callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 3 }, onRequestCompleted: checkpoint, onCustomTaskEnqueued: queued }, { ...profile, model: 'gemini-example-image', imageApiDialect: 'openai' })
  const rejection = expect(task).rejects.toMatchObject({ name: 'AbortError', recoverableImageTask: true })
  await vi.waitFor(() => expect(queued).toHaveBeenCalledExactlyOnceWith({ taskId: 'pending-second' }))
  expect(checkpoint).toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  release()
  await rejection
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2)
})


it('第二批已提交但编号保存失败时保留原错误及恢复标记，不返回普通部分成功', async () => {
  const storageError = new DOMException('IndexedDB写入失败', 'QuotaExceededError')
  const checkpoint = vi.fn().mockResolvedValue(undefined)
  const queued = vi.fn().mockRejectedValue(storageError)
  const fetchMock = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(response())
    .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ task_id: 'submitted-second' }] }), { status: 202 }))
  const task = callOpenAICompatibleImageApi({ ...options, params: { ...DEFAULT_PARAMS, n: 3 }, onRequestCompleted: checkpoint, onCustomTaskEnqueued: queued }, { ...profile, model: 'gemini-example-image', imageApiDialect: 'openai' })
  await expect(task).rejects.toBe(storageError)
  expect(storageError).toMatchObject({ recoverableImageTask: true, name: 'QuotaExceededError', message: '异步任务已提交，但任务编号保存失败：IndexedDB写入失败；正在保留任务编号并继续查询' })
  expect(checkpoint).toHaveBeenCalledTimes(1)
  expect(queued).toHaveBeenCalledExactlyOnceWith({ taskId: 'submitted-second' })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(fetchMock.mock.calls.every(([, init]) => init?.method === 'POST')).toBe(true)
})

it('自定义异步任务编号保存失败同样标记恢复且不重新提交', async () => {
  const storageError = new Error('任务记录写入失败')
  const queued = vi.fn().mockRejectedValue(storageError)
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ task_id: 'custom-submitted' }), { status: 202 }))
  await expect(callOpenAICompatibleImageApi({ ...options, onCustomTaskEnqueued: queued }, { ...profile, provider: 'custom' }, {
    id: 'custom', name: 'custom', template: 'http-image', submit: { path: 'generate', body: { prompt: '$prompt' }, taskIdPath: 'task_id' },
    poll: { path: 'tasks/{task_id}', statusPath: 'status', successValues: ['done'], failureValues: ['failed'], result: { b64JsonPaths: ['data.*.b64_json'] } },
  })).rejects.toBe(storageError)
  expect(storageError).toMatchObject({ recoverableImageTask: true, message: expect.stringContaining('异步任务已提交') })
  expect(queued).toHaveBeenCalledExactlyOnceWith({ taskId: 'custom-submitted' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
})
