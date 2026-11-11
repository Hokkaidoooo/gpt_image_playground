import { DEFAULT_STREAM_PARTIAL_IMAGES, type ApiProfile, type CustomProviderDefinition, type CustomProviderPollMapping, type CustomProviderResultMapping, type CustomProviderSubmitMapping, type ImageApiResponse, type ImageResponseItem, type ResponsesApiResponse, type ResponsesOutputItem, type TaskParams } from '../types'
import { dataUrlToBlob, imageDataUrlToPngBlob, maskDataUrlToPngBlob } from './canvasImage'
import { buildApiUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'
import {
  assertImageInputPayloadSize,
  assertMaskEditFileSize,
  appendStreamingFormatHint,
  createRequestTimeoutError,
  maybeAppendStreamingHint,
  type CallApiOptions,
  type CallApiResult,
  fetchImageUrlAsDataUrl,
  getApiErrorMessage,
  getDataUrlDecodedByteSize,
  getDataUrlEncodedByteSize,
  getResponsesImageResultBase64,
  isDataUrl,
  isHttpUrl,
  mergeActualParams,
  maybeAppendTransparentBackgroundHint,
  maybeAppendImageToolDroppedHint,
  MIME_MAP,
  normalizeBase64Image,
  pickActualParams,
  PROMPT_REWRITE_GUARD_PREFIX,
} from './imageApiShared'
import { getImageGenerationModel } from './imageModels'
import { resolveImageRequestCompatibility, usesSequentialImageRequests } from './imageRequestCompatibility'
import { prepareImageInputs, type PreparedImageInputs } from './imageInputPreparation'
import { apiFetch, FetchConnectError } from './platform'
import { isEventStreamResponse, readJsonServerSentEvents } from './serverSentEvents'
import { prependCodexCliSizePrompt } from './size'

function getStreamPartialImages(profile: ApiProfile): number {
  return profile.streamPartialImages ?? DEFAULT_STREAM_PARTIAL_IMAGES
}

function appendQuery(path: string, query?: Record<string, string>): string {
  if (!query || !Object.keys(query).length) return path
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  return `${path}${path.includes('?') ? '&' : '?'}${params.toString()}`
}

function createOpenAICompatiblePaths() {
  return {
    generationPath: 'images/generations',
    editPath: 'images/edits',
  }
}

function getByPath(source: unknown, path: string | undefined): unknown {
  if (!path) return source
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (current == null) return undefined
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)]
    if (typeof current === 'object') return (current as Record<string, unknown>)[key]
    return undefined
  }, source)
}

function getAllByPath(source: unknown, path: string | undefined): unknown[] {
  if (!path) return [source]
  const parts = path.split('.').filter(Boolean)
  let current: unknown[] = [source]

  for (const key of parts) {
    const next: unknown[] = []
    for (const item of current) {
      if (item == null) continue
      if (key === '*') {
        if (Array.isArray(item)) next.push(...item)
        else if (typeof item === 'object') next.push(...Object.values(item as Record<string, unknown>))
        continue
      }
      if (/^\d+$/.test(key) && Array.isArray(item)) {
        next.push(item[Number(key)])
        continue
      }
      if (typeof item === 'object') next.push((item as Record<string, unknown>)[key])
    }
    current = next
  }

  return current.flatMap((item) => Array.isArray(item) ? item : [item]).filter((item) => item != null)
}

function normalizeImageApiPayload(value: unknown): ImageApiResponse {
  if (Array.isArray(value)) return { data: value as ImageApiResponse['data'] }
  if (value && typeof value === 'object') return value as ImageApiResponse
  return { data: [] }
}

function createRequestHeaders(profile: ApiProfile): Record<string, string> {
  return {
    Authorization: `Bearer ${profile.apiKey}`,
  }
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function getStringValue(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function getNumberValue(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function getStreamEventErrorMessage(event: Record<string, unknown>): string | null {
  const error = event.error
  if (isRecordValue(error)) {
    const message = getStringValue(error, 'message')
    if (message) return message
  }
  if (typeof error === 'string' && error.trim()) return error

  const type = getStringValue(event, 'type')
  if (type?.endsWith('.failed')) {
    return getStringValue(event, 'message') ?? '流式请求失败'
  }
  return null
}

function createResponsesImageTool(
  params: TaskParams,
  isEdit: boolean,
  profile: ApiProfile,
  maskDataUrl?: string,
  nativeTransparentBackground?: boolean,
): Record<string, unknown> {
  const tool: Record<string, unknown> = {
    type: 'image_generation',
    action: isEdit ? 'edit' : 'generate',
    output_format: params.output_format,
    moderation: params.moderation,
  }
  const imageModel = getImageGenerationModel(profile)
  if (imageModel) tool.model = imageModel

  if (!profile.codexCli) {
    tool.size = params.size
  }

  if (profile.streamImages) {
    tool.partial_images = getStreamPartialImages(profile)
  }

  if (!profile.codexCli) {
    tool.quality = params.quality
  }

  if (params.output_format !== 'png' && params.output_compression != null) {
    tool.output_compression = params.output_compression
  }

  if (nativeTransparentBackground) {
    tool.background = 'transparent'
  }

  if (maskDataUrl) {
    tool.input_image_mask = {
      image_url: maskDataUrl,
    }
  }

  return tool
}

function createResponsesInput(prompt: string, inputImageDataUrls: string[], allowPromptRewrite: boolean): unknown {
  const text = allowPromptRewrite ? prompt : `${PROMPT_REWRITE_GUARD_PREFIX}\n${prompt}`
  if (!inputImageDataUrls.length) return text

  return [
    {
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...inputImageDataUrls.map((dataUrl) => ({
          type: 'input_image',
          image_url: dataUrl,
        })),
      ],
    },
  ]
}

function parseResponsesImageResults(payload: ResponsesApiResponse, fallbackMime: string): Array<{
  image: string
  actualParams?: Partial<TaskParams>
  revisedPrompt?: string
}> {
  const output = payload.output
  if (!Array.isArray(output) || !output.length) {
    const err = new Error('接口未返回图片数据')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const results: Array<{ image: string; actualParams?: Partial<TaskParams>; revisedPrompt?: string }> = []

  for (const item of output) {
    if (item?.type !== 'image_generation_call') continue

    const b64 = getResponsesImageResultBase64(item.result)
    if (b64) {
      results.push({
        image: normalizeBase64Image(b64, fallbackMime),
        actualParams: mergeActualParams(pickActualParams(item)),
        revisedPrompt: typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined,
      })
    }
  }

  if (!results.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return results
}

async function parseImagesApiResponse(payload: ImageApiResponse, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const data = payload.data
  if (!Array.isArray(data) || !data.length) {
    const err = new Error('接口没有返回图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  const images: string[] = []
  const rawImageUrls = data.map((item) => item.url).filter(isHttpUrl)
  const revisedPrompts: Array<string | undefined> = []
  const actualParams = mergeActualParams(pickActualParams(payload))
  const actualParamsList: Array<Partial<TaskParams> | undefined> = []
  try {
    for (const item of data) {
      const b64 = item.b64_json
      const itemParams = mergeActualParams(actualParams, pickActualParams(item))
      const imageMime = itemParams?.output_format ? MIME_MAP[itemParams.output_format] : mime
      if (b64) {
        images.push(normalizeBase64Image(b64, imageMime))
        actualParamsList.push(itemParams)
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
        continue
      }

      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, imageMime, signal))
        actualParamsList.push(itemParams)
        revisedPrompts.push(typeof item.revised_prompt === 'string' ? item.revised_prompt : undefined)
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认服务商实际返回的数据结构。如果使用的是中转或兼容接口，建议创建并使用「自定义服务商」配置。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }

  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function eventToImageResponseItem(event: Record<string, unknown>): ImageResponseItem {
  return {
    b64_json: getStringValue(event, 'b64_json'),
    url: getStringValue(event, 'url'),
    revised_prompt: getStringValue(event, 'revised_prompt'),
    size: getStringValue(event, 'size'),
    quality: getStringValue(event, 'quality'),
    output_format: getStringValue(event, 'output_format'),
    output_compression: getNumberValue(event, 'output_compression'),
    moderation: getStringValue(event, 'moderation'),
  }
}

async function parseImagesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const completedItems: ImageResponseItem[] = []
  let resultPayload: ImageApiResponse | null = null

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    const object = getStringValue(event, 'object')
    if (type === 'image_generation.partial_image' || type === 'image_edit.partial_image') {
      const b64 = getStringValue(event, 'b64_json')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    if (object === 'image.generation.result' || object === 'image.edit.result') {
      resultPayload = normalizeImageApiPayload(event)
      return
    }

    if (type === 'image_generation.completed' || type === 'image_edit.completed') {
      completedItems.push(eventToImageResponseItem(event))
    }
  }, {
    signals: [signal],
    formatErrorMessage: appendStreamingFormatHint,
    getEventErrorMessage: getStreamEventErrorMessage,
  })

  if (resultPayload) {
    return parseImagesApiResponse(resultPayload, mime)
  }

  if (!completedItems.length) {
    throw new Error('流式接口未返回最终图片数据')
  }

  const images: string[] = []
  const rawImageUrls = completedItems.map((item) => item.url).filter(isHttpUrl)
  try {
    for (const item of completedItems) {
      if (item.b64_json) {
        images.push(normalizeBase64Image(item.b64_json, mime))
        continue
      }
      if (isHttpUrl(item.url) || isDataUrl(item.url)) {
        images.push(await fetchImageUrlAsDataUrl(item.url, mime, signal))
      }
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }
  if (!images.length) throw new Error('流式接口未返回可用图片数据')

  const actualParamsList = completedItems.map((item) => mergeActualParams(pickActualParams(item)))
  const actualParams = mergeActualParams(
    actualParamsList[0],
    images.length > 1 ? { n: images.length } : undefined,
  )
  return {
    images,
    actualParams,
    actualParamsList,
    revisedPrompts: completedItems.map((item) => item.revised_prompt),
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
  }
}

function getResponsesStreamPayload(event: Record<string, unknown>): ResponsesApiResponse | null {
  const response = event.response
  if (isRecordValue(response)) return response as ResponsesApiResponse

  const item = event.item
  if (isRecordValue(item) && item.type === 'image_generation_call') {
    return { output: [item as ResponsesOutputItem] }
  }

  return null
}

async function parseResponsesApiStreamResponse(
  response: Response,
  mime: string,
  onPartialImage?: CallApiOptions['onPartialImage'],
): Promise<CallApiResult> {
  let completedPayload: ResponsesApiResponse | null = null
  const outputItems: ResponsesOutputItem[] = []

  await readJsonServerSentEvents(response, (event) => {
    const type = getStringValue(event, 'type')
    if (type === 'response.image_generation_call.partial_image') {
      const b64 = getStringValue(event, 'partial_image_b64')
      if (b64) {
        onPartialImage?.({
          image: normalizeBase64Image(b64, mime),
          partialImageIndex: getNumberValue(event, 'partial_image_index'),
        })
      }
      return
    }

    const payload = getResponsesStreamPayload(event)
    if (!payload) return

    if (type === 'response.output_item.done' && Array.isArray(payload.output)) {
      outputItems.push(...payload.output)
      return
    }

    completedPayload = payload
  }, {
    formatErrorMessage: appendStreamingFormatHint,
    getEventErrorMessage: getStreamEventErrorMessage,
  })

  const payload = completedPayload ?? (outputItems.length ? { output: outputItems } : null)
  if (!payload) throw new Error('流式接口未返回最终图片数据')

  let imageResults: ReturnType<typeof parseResponsesImageResults>
  try {
    imageResults = parseResponsesImageResults(payload, mime)
  } catch (err) {
    const collectedImageItems = outputItems.filter((item) => getResponsesImageResultBase64(item.result))
    if (collectedImageItems.length === 0) throw err
    imageResults = parseResponsesImageResults({ output: collectedImageItems }, mime)
  }
  const actualParams = mergeActualParams(imageResults[0]?.actualParams ?? {})
  return {
    images: imageResults.map((result) => result.image),
    actualParams,
    actualParamsList: imageResults.map((result) => mergeActualParams(result.actualParams ?? {})),
    revisedPrompts: imageResults.map((result) => result.revisedPrompt),
  }
}

export async function callOpenAICompatibleImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider?: CustomProviderDefinition | null): Promise<CallApiResult> {
  if (customProvider) {
    const n = opts.params.n > 0 ? opts.params.n : 1
    const submitMapping = opts.inputImageDataUrls.length > 0 && customProvider.editSubmit
      ? customProvider.editSubmit
      : customProvider.submit
    const isAsync = Boolean(submitMapping.taskIdPath)
    if (profile.codexCli && n > 1 && !isAsync) return callCustomHttpImageApiConcurrent(opts, profile, customProvider, n)
    return callCustomHttpImageApi(opts, profile, customProvider)
  }

  return profile.apiMode === 'responses'
    ? callResponsesImageApi(opts, profile)
    : callImagesApi(opts, profile)
}

type PreparedImageApiOptions = CallApiOptions & { preparedImageInputs: PreparedImageInputs }

async function callImagesApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('生成张数必须是正整数。')
  const compatibility = resolveImageRequestCompatibility(profile)
  if (compatibility.editImageField === 'image' && opts.inputImageDataUrls.length > 1) throw new Error('当前供应商配置使用单张参考图字段 image，请只保留一张参考图，或在兼容设置中选择 image[]。')
  if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
  const preparedImageInputs = await prepareImageInputs(opts.inputImageDataUrls, opts.maskDataUrl, compatibility)
  if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
  await opts.onInputImagesPrepared?.(preparedImageInputs.adjustments)
  const preparedOptions = { ...opts, preparedImageInputs }
  if (compatibility.mode !== 'standard') {
    const batchSize = usesSequentialImageRequests(profile, n) ? compatibility.maxImagesPerRequest : n
    return callImagesApiSequential(preparedOptions, profile, batchSize)
  }
  if ((profile.codexCli || profile.streamImages) && n > 1) {
    return callImagesApiConcurrent(preparedOptions, profile, n)
  }
  return callImagesApiSingle(preparedOptions, profile)
}

async function callImagesApiSequential(opts: PreparedImageApiOptions, profile: ApiProfile, batchSize: number): Promise<CallApiResult> {
  const results: PromiseSettledResult<CallApiResult>[] = []
  const counts: number[] = []
  const total = opts.params.n
  for (let requestIndex = 0; requestIndex < total; requestIndex += batchSize) {
    const count = Math.min(batchSize, total - requestIndex)
    if (opts.shouldContinue && !opts.shouldContinue()) {
      results.push({ status: 'rejected', reason: new Error('任务已停止，剩余图片未发送。') })
      counts.push(total - requestIndex)
      break
    }
    let result: CallApiResult
    try {
      result = await callImagesApiSingle({
        ...opts,
        params: { ...opts.params, n: count },
        onPartialImage: opts.onPartialImage
          ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
          : undefined,
      }, profile)
    } catch (error) {
      results.push({ status: 'rejected', reason: error })
      counts.push(count)
      if (requestIndex + count < total) {
        results.push({ status: 'rejected', reason: new Error('前一批请求失败，后续图片未发送。') })
        counts.push(total - requestIndex - count)
      }
      break
    }
    if (result.images.length < count) {
      result = {
        ...result,
        failedRequests: Array.from({ length: count - result.images.length }, (_, index) => ({
          requestIndex: result.images.length + index,
          error: `供应商只返回 ${result.images.length} 张图片，本批请求 ${count} 张；缺少的图片未自动补发。`,
        })),
      }
    } else if (result.images.length > count) {
      result = { ...result, completionError: `供应商返回 ${result.images.length} 张图片，超过本批请求的 ${count} 张；已保留全部结果并停止后续请求。` }
    }
    try {
      await opts.onRequestCompleted?.(result, requestIndex)
    } catch (error) {
      result = { ...result, completionError: `图片已生成，但结果保存未完成：${getErrorMessage(error)}` }
    }
    results.push({ status: 'fulfilled', value: result })
    const occupiedSlots = Math.max(count, result.images.length)
    counts.push(occupiedSlots)
    if (result.failedRequests?.length || result.completionError) {
      if (requestIndex + occupiedSlots < total) {
        results.push({ status: 'rejected', reason: new Error('前一批结果未完整确认，后续图片未发送。') })
        counts.push(total - requestIndex - occupiedSlots)
      }
      break
    }
  }
  if (results.length === 1 && results[0].status === 'fulfilled') return results[0].value
  return mergeImageApiResults(results, counts)
}

async function callImagesApiConcurrent(opts: PreparedImageApiOptions, profile: ApiProfile, n: number): Promise<CallApiResult> {
  const singleOpts = {
    ...opts,
    params: {
      ...opts.params,
      n: 1,
      ...(profile.codexCli ? { quality: 'auto' as const } : {}),
    },
  }
  const results = await Promise.allSettled(
    Array.from({ length: n }).map((_, requestIndex) => callImagesApiSingle({
      ...singleOpts,
      onPartialImage: opts.onPartialImage
        ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
        : undefined,
    }, profile)),
  )

  return mergeImageApiResults(results)
}

async function callImagesApiSingle(opts: PreparedImageApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt: originalPrompt, params, inputImageDataUrls } = opts
  const sizePrompt = profile.codexCli && !opts.skipCodexCliSizePrompt
    ? prependCodexCliSizePrompt(originalPrompt, params.size)
    : originalPrompt
  const prompt = profile.codexCli && !opts.settings.allowPromptRewrite
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${sizePrompt}`
    : sizePrompt
  const isEdit = inputImageDataUrls.length > 0
  const compatibility = resolveImageRequestCompatibility(profile)
  const mime = compatibility.omitParameters.includes('output_format') ? MIME_MAP.png : MIME_MAP[params.output_format]
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = createRequestHeaders(profile)
  const paths = createOpenAICompatiblePaths()
  const body: Record<string, string | number | boolean> = {
    model: profile.model,
    prompt,
    output_format: params.output_format,
    moderation: params.moderation,
  }
  if (!profile.codexCli) {
    body.size = params.size
    body.quality = params.quality
  }
  if (opts.nativeTransparentBackground) body.background = 'transparent'
  if (params.output_format !== 'png' && params.output_compression != null) body.output_compression = params.output_compression
  if (params.n > 1) body.n = params.n
  if (profile.responseFormatB64Json) body.response_format = 'b64_json'
  if (profile.streamImages) {
    body.stream = true
    body.partial_images = getStreamPartialImages(profile)
  }
  for (const parameter of compatibility.omitParameters) delete body[parameter]

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    let response: Response

    if (isEdit) {
      const formData = new FormData()
      for (const [name, value] of Object.entries(body)) formData.append(name, String(value))

      const imageBlobs = opts.preparedImageInputs.blobs
      const maskBlob = opts.preparedImageInputs.mask
      if (opts.maskDataUrl) {
        assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
        assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
      }
      assertImageInputPayloadSize(
        imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0),
      )

      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append(compatibility.editImageField, blob, `input-${i + 1}.${ext}`)
      }

      if (maskBlob) {
        formData.append('mask', maskBlob, 'mask.png')
      }

      if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
      response = await apiFetch(buildApiUrl(profile.baseUrl, paths.editPath, proxyConfig, useApiProxy), {
        timeoutSeconds: profile.timeout,
        method: 'POST',
        headers: requestHeaders,
        cache: 'no-store',
        body: formData,
        signal: controller.signal,
      })
    } else {
      if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
      response = await apiFetch(buildApiUrl(profile.baseUrl, paths.generationPath, proxyConfig, useApiProxy), {
        timeoutSeconds: profile.timeout,
        method: 'POST',
        headers: {
          ...requestHeaders,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    }

    if (!response.ok) {
      const errorMessage = await getApiErrorMessage(response)
      throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages))
    }

    const result = profile.streamImages && isEventStreamResponse(response)
      ? await parseImagesApiStreamResponse(response, mime, opts.onPartialImage, controller.signal)
      : await parseImagesApiResponse(await response.json() as ImageApiResponse, mime, controller.signal)
    return { ...result, ...(opts.preparedImageInputs.adjustments.length ? { inputImageAdjustments: opts.preparedImageInputs.adjustments } : {}) }
  } finally {
    clearTimeout(timeoutId)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }, { once: true })
  })
}

function getTaskState(payload: unknown, poll: CustomProviderPollMapping): 'success' | 'failure' | 'pending' {
  const status = getByPath(payload, poll.statusPath)
  const statusText = typeof status === 'string' ? status : String(status ?? '')
  if (poll.successValues.includes(statusText)) return 'success'
  if (poll.failureValues.includes(statusText)) return 'failure'
  return 'pending'
}

function isRecoverablePollingError(err: unknown): boolean {
  if (typeof DOMException !== 'undefined' && err instanceof DOMException && err.name === 'AbortError') return true
  if (err instanceof FetchConnectError) return true
  const message = err instanceof Error ? err.message : String(err)
  return /abort|network|failed to fetch|fetch failed|load failed|timeout|连接|断开|中断/i.test(message)
}

function isRetryablePollingStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

function buildTaskPath(path: string, taskId: string): string {
  return path
    .replace(/\{task_id\}/g, encodeURIComponent(taskId))
    .replace(/\{taskId\}/g, encodeURIComponent(taskId))
}

function resolveTemplateValue(value: unknown, context: Record<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return getByPath(context, value.slice(1))
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplateValue(item, context)).filter((item) => item !== undefined && item !== null)
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, resolveTemplateValue(item, context)] as const)
      .filter(([, item]) => item !== undefined && item !== null && (!Array.isArray(item) || item.length > 0))
    return Object.fromEntries(entries)
  }
  return value
}

function createCustomProviderContext(opts: CallApiOptions, profile: ApiProfile) {
  const sizePrompt = profile.codexCli && !opts.skipCodexCliSizePrompt
    ? prependCodexCliSizePrompt(opts.prompt, opts.params.size)
    : opts.prompt
  const prompt = profile.codexCli && !opts.settings.allowPromptRewrite
    ? `${PROMPT_REWRITE_GUARD_PREFIX}\n${sizePrompt}`
    : sizePrompt
  const params = {
    ...opts.params,
    ...(profile.codexCli ? { size: undefined, quality: undefined } : {}),
    ...(opts.nativeTransparentBackground ? { background: 'transparent' } : {}),
  }

  const inputImageUrls = opts.inputImageUrls?.filter(isHttpUrl) ?? []

  return {
    profile,
    prompt,
    params,
    inputImages: {
      dataUrls: opts.inputImageDataUrls.length ? opts.inputImageDataUrls : undefined,
      base64: opts.inputImageDataUrls.length ? opts.inputImageDataUrls.map((url) => url.replace(/^data:[^;]+;base64,/, '')) : undefined,
      urls: inputImageUrls.length ? inputImageUrls : undefined,
      count: opts.inputImageDataUrls.length,
    },
    mask: {
      dataUrl: opts.maskDataUrl,
    },
  }
}

function renderQuery(query: Record<string, string> | undefined, context: Record<string, unknown>): Record<string, string> | undefined {
  if (!query) return undefined
  const entries = Object.entries(query)
    .map(([key, value]) => [key, resolveTemplateValue(value, context)] as const)
    .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
    .map(([key, value]) => [key, String(value)] as const)
  return entries.length ? Object.fromEntries(entries) : undefined
}

async function createCustomMultipartBody(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, context: Record<string, unknown>): Promise<FormData> {
  const formData = new FormData()
  const body = resolveTemplateValue(mapping.body ?? {}, context)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined || value === null) continue
      if (Array.isArray(value)) {
        for (const item of value) formData.append(key, String(item))
      } else {
        formData.append(key, String(value))
      }
    }
  }

  const needsInputImages = mapping.files?.some((file) => file.source === 'inputImages')
  const needsMask = mapping.files?.some((file) => file.source === 'mask')
  const imageBlobs: Blob[] = []
  if (needsInputImages) {
    for (let i = 0; i < opts.inputImageDataUrls.length; i++) {
      const dataUrl = opts.inputImageDataUrls[i]
      const blob = opts.maskDataUrl && i === 0 ? await imageDataUrlToPngBlob(dataUrl) : await dataUrlToBlob(dataUrl)
      imageBlobs.push(blob)
    }
  }
  const maskBlob = needsMask && opts.maskDataUrl ? await maskDataUrlToPngBlob(opts.maskDataUrl) : null
  if (opts.maskDataUrl && (needsInputImages || needsMask)) {
    assertMaskEditFileSize('遮罩主图文件', imageBlobs[0]?.size ?? 0)
    assertMaskEditFileSize('遮罩文件', maskBlob?.size ?? 0)
  }
  assertImageInputPayloadSize(imageBlobs.reduce((sum, blob) => sum + blob.size, 0) + (maskBlob?.size ?? 0))

  for (const file of mapping.files ?? []) {
    if (file.source === 'inputImages') {
      for (let i = 0; i < imageBlobs.length; i++) {
        const blob = imageBlobs[i]
        const ext = blob.type.split('/')[1] || 'png'
        formData.append(file.field, blob, `input-${i + 1}.${ext}`)
      }
    } else if (file.source === 'mask' && maskBlob) {
      formData.append(file.field, maskBlob, 'mask.png')
    }
  }

  return formData
}

async function extractCustomImages(payload: unknown, result: CustomProviderResultMapping, mime: string, signal?: AbortSignal): Promise<CallApiResult> {
  const images: string[] = []
  const imageUrls = (result.imageUrlPaths ?? []).flatMap((path) =>
    getAllByPath(payload, path).filter((value): value is string => isHttpUrl(value) || isDataUrl(value)),
  )
  const rawImageUrls = imageUrls.filter(isHttpUrl)
  try {
    for (const path of result.b64JsonPaths ?? []) {
      for (const value of getAllByPath(payload, path)) {
        if (typeof value === 'string' && value.trim()) images.push(normalizeBase64Image(value, mime))
      }
    }
    for (const url of imageUrls) {
      images.push(await fetchImageUrlAsDataUrl(url, mime, signal))
    }
  } catch (err) {
    if (rawImageUrls.length > 0 && err instanceof Error) {
      (err as any).rawImageUrls = rawImageUrls
    }
    throw err
  }

  if (!images.length) {
    const err = new Error('接口没有返回可识别的图片数据，请查看原始响应内容确认接口实际返回的数据结构，并根据 API 文档调整「自定义服务商」配置中的结果提取路径。')
    ;(err as any).rawResponsePayload = JSON.stringify(payload, null, 2)
    throw err
  }
  return { images, ...(rawImageUrls.length ? { rawImageUrls } : {}) }
}

async function submitCustomRequest(mapping: CustomProviderSubmitMapping, opts: CallApiOptions, profile: ApiProfile, controller: AbortController, proxyConfig: ReturnType<typeof readClientDevProxyConfig>, useApiProxy: boolean): Promise<unknown> {
  const requestHeaders = createRequestHeaders(profile)
  const context = createCustomProviderContext(opts, profile)
  // 只用链接传参考图时，不能把其余参考图静默丢掉；同时用其他方式传参考图时链接只是补充
  const template = JSON.stringify([mapping.body, mapping.query])
  const linkOnly = template.includes('$inputImages.urls')
    && !template.includes('$inputImages.dataUrls')
    && !template.includes('$inputImages.base64')
    && !mapping.files?.some((file) => file.source === 'inputImages')
  const missingUrlCount = context.inputImages.count - (context.inputImages.urls?.length ?? 0)
  if (linkOnly && missingUrlCount > 0) {
    throw new Error(`当前服务商只接受链接参考图，有 ${missingUrlCount} 张参考图不是通过链接添加的。请在输入框的「+ → 添加链接」中添加，或移除这些参考图后重试。`)
  }
  const method = mapping.method ?? 'POST'
  const contentType = mapping.contentType ?? 'json'
  const path = appendQuery(mapping.path, renderQuery(mapping.query, context))
  const headers: Record<string, string> = { ...requestHeaders }
  let body: BodyInit | undefined

  if (method !== 'GET') {
    if (contentType === 'multipart') {
      const formData = await createCustomMultipartBody(mapping, opts, context)
      if (profile.responseFormatB64Json) {
        formData.append('response_format', 'b64_json')
      }
      body = formData
    } else {
      assertImageInputPayloadSize(
        opts.inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
          (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
      )
      headers['Content-Type'] = 'application/json'
      const resolved = resolveTemplateValue(mapping.body ?? {}, context)
      if (profile.responseFormatB64Json && resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
        (resolved as Record<string, unknown>).response_format = 'b64_json'
      }
      body = JSON.stringify(resolved)
    }
  }

  const response = await apiFetch(buildApiUrl(profile.baseUrl, path, proxyConfig, useApiProxy), {
    timeoutSeconds: profile.timeout,
    method,
    headers,
    cache: 'no-store',
    body,
    signal: controller.signal,
  })

  if (!response.ok) {
    const errorMessage = await getApiErrorMessage(response)
    throw new Error(maybeAppendStreamingHint(errorMessage, response.status, profile.streamImages))
  }
  return response.json()
}

async function pollCustomTaskResult(
  profile: ApiProfile,
  poll: CustomProviderPollMapping,
  taskId: string,
  mime: string,
  signal?: AbortSignal,
): Promise<CallApiResult> {
  const proxyConfig = readClientDevProxyConfig()
  const requestHeaders = createRequestHeaders(profile)
  let isFirstPoll = true

  while (true) {
    if (isFirstPoll) {
      isFirstPoll = false
    } else if (signal) {
      await sleep((poll.intervalSeconds ?? 5) * 1000, signal)
    } else {
      await new Promise((resolve) => setTimeout(resolve, (poll.intervalSeconds ?? 5) * 1000))
    }

    const taskPath = appendQuery(buildTaskPath(poll.path, taskId), poll.query)
    let taskPayload: unknown
    try {
      const taskResponse = await apiFetch(buildApiUrl(profile.baseUrl, taskPath, proxyConfig, false), {
        timeoutSeconds: profile.timeout,
        method: poll.method ?? 'GET',
        headers: requestHeaders,
        cache: 'no-store',
        signal,
      })

      if (!taskResponse.ok) {
        if (isRetryablePollingStatus(taskResponse.status)) {
          // 不读的响应体要主动取消，否则客户端中连接会保留到服务端发完为止
          void taskResponse.body?.cancel().catch(() => undefined)
          continue
        }
        throw new Error(await getApiErrorMessage(taskResponse))
      }

      taskPayload = await taskResponse.json()
    } catch (err) {
      if (!signal?.aborted && isRecoverablePollingError(err)) continue
      throw err
    }

    const state = getTaskState(taskPayload, poll)
    if (state === 'failure') {
      const message = getByPath(taskPayload, poll.errorPath) || getByPath(taskPayload, 'message') || getByPath(taskPayload, 'data.fail_reason') || getByPath(taskPayload, 'error.message')
      const errorMessage = typeof message === 'string' && message.trim() ? message : '异步任务失败'
      throw new Error(maybeAppendTransparentBackgroundHint(errorMessage))
    }
    if (state === 'success') {
      try {
        return await extractCustomImages(taskPayload, poll.result, mime, signal)
      } catch (err) {
        if (!signal?.aborted && isRecoverablePollingError(err)) continue
        throw err
      }
    }
  }
}

export async function getCustomQueuedImageResult(
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  taskId: string,
  params: TaskParams,
): Promise<CallApiResult> {
  if (!customProvider.poll) throw new Error('自定义异步任务缺少 poll 配置')
  const mime = MIME_MAP[params.output_format] || 'image/png'
  return pollCustomTaskResult(profile, customProvider.poll, taskId, mime)
}

async function callCustomHttpImageApi(opts: CallApiOptions, profile: ApiProfile, customProvider: CustomProviderDefinition): Promise<CallApiResult> {
  const { params, inputImageDataUrls } = opts
  const isEdit = inputImageDataUrls.length > 0
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const controller = new AbortController()
  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    const proxyConfig = readClientDevProxyConfig()
    const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
    const submitMapping = isEdit && customProvider.editSubmit ? customProvider.editSubmit : customProvider.submit
    if (useApiProxy && (submitMapping.method ?? 'POST') !== 'POST') {
      throw new Error('API 代理暂不支持使用 GET 提交的自定义服务商。请关闭 API 代理，或改用 POST 提交的自定义服务商配置。')
    }
    if (useApiProxy && (submitMapping.taskIdPath || customProvider.poll)) {
      throw new Error('API 代理暂不支持使用异步任务的自定义服务商。请关闭 API 代理，或改用同步返回图片的自定义服务商配置。')
    }
    const submitPayload = await submitCustomRequest(submitMapping, opts, profile, controller, proxyConfig, useApiProxy)
    const taskIdValue = submitMapping.taskIdPath ? getByPath(submitPayload, submitMapping.taskIdPath) : undefined
    const taskId = typeof taskIdValue === 'string' ? taskIdValue.trim() : String(taskIdValue ?? '').trim()
    if (submitMapping.taskIdPath && !taskId) {
      const err = new Error('无法从响应中提取异步任务 ID，请查看原始响应内容确认接口实际返回的数据结构，并根据 API 文档调整「自定义服务商」配置中的 taskIdPath。')
      ;(err as any).rawResponsePayload = JSON.stringify(submitPayload, null, 2)
      throw err
    }
    if (!taskId) return await extractCustomImages(submitPayload, submitMapping.result ?? {}, mime, controller.signal)
    if (!customProvider.poll) throw new Error('异步接口返回了 task_id，但服务商配置缺少 poll')
    opts.onCustomTaskEnqueued?.({ taskId })
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    return pollCustomTaskResult(profile, customProvider.poll, taskId, mime, controller.signal)
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

function mergeImageApiResults(results: PromiseSettledResult<CallApiResult>[], counts = results.map(() => 1)): CallApiResult {
  const successfulResults = results
    .filter((result): result is PromiseFulfilledResult<CallApiResult> => result.status === 'fulfilled')
    .map((result) => result.value)
  if (!successfulResults.length) {
    const firstError = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    throw firstError.reason
  }

  const images = successfulResults.flatMap((result) => result.images)
  const actualParamsList = successfulResults.flatMap((result) =>
    result.actualParamsList?.length ? result.actualParamsList : result.images.map(() => result.actualParams),
  )
  const revisedPrompts = successfulResults.flatMap((result) =>
    result.revisedPrompts?.length ? result.revisedPrompts : result.images.map(() => undefined),
  )
  const rawImageUrls = successfulResults.flatMap((result) => result.rawImageUrls ?? [])
  let offset = 0
  const failedRequests = results.flatMap((result, index) => {
    const start = offset
    offset += counts[index]
    return result.status === 'rejected'
      ? Array.from({ length: counts[index] }, (_, slot) => ({ requestIndex: start + slot, error: getErrorMessage(result.reason) }))
      : (result.value.failedRequests ?? []).map((failure) => ({ ...failure, requestIndex: start + failure.requestIndex }))
  })
  const completionError = successfulResults.map((result) => result.completionError).filter(Boolean).join('\n')
  const inputImageAdjustments = [...new Set(successfulResults.flatMap((result) => result.inputImageAdjustments ?? []))]

  return {
    images,
    actualParams: mergeActualParams(successfulResults[0].actualParams ?? {}, { n: images.length }),
    actualParamsList,
    revisedPrompts,
    ...(rawImageUrls.length ? { rawImageUrls } : {}),
    ...(failedRequests.length ? { failedRequests } : {}),
    ...(completionError ? { completionError } : {}),
    ...(inputImageAdjustments.length ? { inputImageAdjustments } : {}),
  }
}

async function callCustomHttpImageApiConcurrent(
  opts: CallApiOptions,
  profile: ApiProfile,
  customProvider: CustomProviderDefinition,
  n: number,
): Promise<CallApiResult> {
  const results = await Promise.allSettled(Array.from({ length: n }).map(() => callCustomHttpImageApi({
    ...opts,
    params: { ...opts.params, n: 1 },
  }, profile, customProvider)))
  return mergeImageApiResults(results)
}

async function callResponsesImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const n = opts.params.n > 0 ? opts.params.n : 1
  if (n === 1) {
    return callResponsesImageApiSingle(opts, profile)
  }

  const promises = Array.from({ length: n }).map((_, requestIndex) => callResponsesImageApiSingle({
    ...opts,
    onPartialImage: opts.onPartialImage
      ? (partial) => opts.onPartialImage?.({ ...partial, requestIndex })
      : undefined,
  }, profile))
  const results = await Promise.allSettled(promises)
  return mergeImageApiResults(results)
}

async function callResponsesImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  const { prompt, params, inputImageDataUrls } = opts
  const requestPrompt = profile.codexCli && !opts.skipCodexCliSizePrompt
    ? prependCodexCliSizePrompt(prompt, params.size)
    : prompt
  const mime = MIME_MAP[params.output_format] || 'image/png'
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  const requestHeaders = createRequestHeaders(profile)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)

  try {
    if (opts.maskDataUrl) {
      assertMaskEditFileSize('遮罩主图文件', getDataUrlDecodedByteSize(inputImageDataUrls[0] ?? ''))
      assertMaskEditFileSize('遮罩文件', getDataUrlDecodedByteSize(opts.maskDataUrl))
    }
    assertImageInputPayloadSize(
      inputImageDataUrls.reduce((sum, dataUrl) => sum + getDataUrlEncodedByteSize(dataUrl), 0) +
        (opts.maskDataUrl ? getDataUrlEncodedByteSize(opts.maskDataUrl) : 0),
    )

    const body: Record<string, unknown> = {
      model: profile.model,
      input: createResponsesInput(requestPrompt, inputImageDataUrls, opts.settings.allowPromptRewrite),
      tools: [createResponsesImageTool(params, inputImageDataUrls.length > 0, profile, opts.maskDataUrl, opts.nativeTransparentBackground)],
      tool_choice: 'required',
    }
    if (profile.reasoningEffort) body.reasoning = { effort: profile.reasoningEffort }
    if (profile.streamImages) {
      body.stream = true
    }

    const response = await apiFetch(buildApiUrl(profile.baseUrl, 'responses', proxyConfig, useApiProxy), {
      timeoutSeconds: profile.timeout,
      method: 'POST',
      headers: {
        ...requestHeaders,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      const errorMessage = await getApiErrorMessage(response)
      throw new Error(maybeAppendStreamingHint(maybeAppendImageToolDroppedHint(errorMessage), response.status, profile.streamImages))
    }

    if (profile.streamImages && isEventStreamResponse(response)) {
      return await parseResponsesApiStreamResponse(response, mime, opts.onPartialImage)
    }

    const payload = await response.json() as ResponsesApiResponse
    const imageResults = parseResponsesImageResults(payload, mime)
    const actualParams = mergeActualParams(
      imageResults[0]?.actualParams ?? {},
    )
    return {
      images: imageResults.map((result) => result.image),
      actualParams,
      actualParamsList: imageResults.map((result) =>
        mergeActualParams(result.actualParams ?? {}),
      ),
      revisedPrompts: imageResults.map((result) => result.revisedPrompt),
    }
  } finally {
    clearTimeout(timeoutId)
  }
}
