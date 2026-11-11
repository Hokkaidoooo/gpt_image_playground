import type { ApiProfile } from '../types'
import { buildImageProviderUrl, createImageProviderHeaders, redactImageProviderError } from './imageProviderUrl'
import { getImageProviderCapabilities } from './imageProvider'
import { base64ToBytes } from './dataUrl'
import { getImageModelParams } from './imageModelParams'
import { getImageSearchSupport, getImageThinkingSupport, parseImageSearchGrounding } from './imageSearch'
import { assertImageInputPayloadSize, createRequestTimeoutError, getApiErrorMessage, runSequentialImageRequests, type CallApiOptions, type CallApiResult } from './imageApiShared'
import { apiFetch } from './platform'

export async function callGoogleImageApi(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (!Number.isSafeInteger(opts.params.n) || opts.params.n < 1 || opts.params.n > 10) throw new Error('Google生图张数必须为1至10的整数')
  return runSequentialImageRequests(opts, 1, (batch) => callGoogleImageApiSingle(batch, profile))
}

async function callGoogleImageApiSingle(opts: CallApiOptions, profile: ApiProfile): Promise<CallApiResult> {
  if (opts.maskDataUrl) throw new Error('此模型不支持遮罩编辑，请使用参考图和提示词描述修改内容')
  const googleProfile = { ...profile, provider: 'google' }
  const caps = getImageProviderCapabilities({ ...profile, imageApiDialect: 'gemini' })
  if (opts.inputImageDataUrls.length > caps.maxInputImages) throw new Error(`Google生图最多支持 ${caps.maxInputImages} 张参考图`)
  if (opts.params.aspect_ratio && opts.params.aspect_ratio !== 'auto' && !caps.aspectRatios.includes(opts.params.aspect_ratio)) throw new Error(`当前模型不支持宽高比 ${opts.params.aspect_ratio}`)
  if (caps.resolutions.length && opts.params.resolution && opts.params.resolution !== 'auto' && !caps.resolutions.includes(opts.params.resolution.toUpperCase())) throw new Error(`当前模型不支持分辨率 ${opts.params.resolution}`)
  const params = getImageModelParams(googleProfile, opts.params)
  const search = getImageSearchSupport(googleProfile)
  const googleSearch = !search.googleSearch && opts.params.google_search
  const imageSearch = !search.imageSearch && opts.params.image_search
  const thinking = getImageThinkingSupport(googleProfile)
  const thinkingConfig = thinking.levels.includes(opts.params.thinking_level ?? '') ? { thinkingLevel: opts.params.thinking_level!.toUpperCase() } : undefined
  const tools = googleSearch || imageSearch ? [{ googleSearch: search.imageSearch ? {} : {
    searchTypes: { ...(googleSearch ? { webSearch: {} } : {}), ...(imageSearch ? { imageSearch: {} } : {}) },
  } }] : undefined
  const parts: Array<Record<string, unknown>> = [{ text: opts.prompt }]
  for (const url of opts.inputImageDataUrls) {
    const match = url.match(/^data:(image\/[\w.+-]+);base64,([\s\S]+)$/)
    if (!match || !base64ToBytes(match[2]).length) throw new Error('参考图不是有效的 Base64 图片')
    parts.push({ inlineData: { mimeType: match[1], data: match[2] } })
  }
  assertImageInputPayloadSize(opts.inputImageDataUrls.reduce((sum, url) => sum + url.length, 0))
  const imageConfig = {
    ...(params.aspect_ratio === 'auto' ? {} : { aspectRatio: params.aspect_ratio }),
    ...(params.resolution ? { imageSize: params.resolution } : {}),
  }
  const model = profile.model.replace(/^models\//, '')
  if (!model || /[\s,:?#]/.test(model)) throw new Error('原生 Google 生图需要一个有效的模型 ID')
  const url = buildImageProviderUrl(profile, `models/${encodeURIComponent(model)}:generateContent`, 'gemini')
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(createRequestTimeoutError(profile.timeout)), profile.timeout * 1000)
  try {
    if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
    const response = await apiFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...createImageProviderHeaders(profile, 'gemini') },
      cache: 'no-store',
      body: JSON.stringify({ contents: [{ role: 'user', parts }], tools, generationConfig: { responseModalities: ['IMAGE'], imageConfig, thinkingConfig } }),
      signal: controller.signal,
      timeoutSeconds: profile.timeout,
    })
    if (!response.ok) throw new Error(await getApiErrorMessage(response))
    const payload = await response.json()
    if (!payload || typeof payload !== 'object') throw new Error('Google生图接口返回的JSON格式无效')
    if (payload.error) throw new Error(`Google生图失败：${typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)}`)
    const blockReason = payload.promptFeedback?.blockReason ?? payload.prompt_feedback?.block_reason
    if (blockReason && blockReason !== 'BLOCK_REASON_UNSPECIFIED') throw Object.assign(new Error(`接口未返回图片：${blockReason}`), { rawResponsePayload: JSON.stringify(payload, null, 2) })
    if (!Array.isArray(payload.candidates)) throw new Error('Google生图接口没有返回candidates[]图片结果')
    const images: string[] = []
    const texts: string[] = []
    const actualParamsList: NonNullable<CallApiResult['actualParamsList']> = []
    const searchGrounding: NonNullable<CallApiResult['searchGrounding']> = []
    for (const candidate of Array.isArray(payload?.candidates) ? payload.candidates : []) {
      // 启用 Image Search 后仍可能只返回 web 来源或缺少 groundingMetadata，按实际响应展示，不能据此判定未执行图片搜索
      const finishReason = candidate?.finishReason ?? candidate?.finish_reason
      if (finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED') throw new Error(`Google生图未正常完成：${finishReason}`)
      const grounding = parseImageSearchGrounding(candidate?.groundingMetadata)
      if (grounding) searchGrounding.push(grounding)
      for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
        if (!part || part.thought) continue
        if (typeof part.text === 'string') texts.push(part.text)
        const data = part.inlineData ?? part.inline_data
        const mime = data?.mimeType ?? data?.mime_type
        if (typeof data?.data !== 'string' || !data.data || typeof mime !== 'string' || !mime.startsWith('image/')) continue
        if (!base64ToBytes(data.data).length) throw new Error('Google生图返回的图片内容无效')
        images.push(`data:${mime};base64,${data.data}`)
        actualParamsList.push({ aspect_ratio: params.aspect_ratio, ...(params.resolution ? { resolution: params.resolution } : {}), ...(mime === 'image/jpeg' ? { output_format: 'jpeg' } : mime === 'image/png' ? { output_format: 'png' } : {}) })
      }
    }
    if (!images.length) {
      const reason = payload?.promptFeedback?.blockReason ?? payload?.candidates?.[0]?.finishReason ?? texts.join('\n')
      throw Object.assign(new Error(`接口未返回图片${reason ? `：${reason}` : ''}`), { rawResponsePayload: JSON.stringify(payload, null, 2) })
    }
    return { images, actualParamsList, ...(searchGrounding.length ? { searchGrounding } : {}) }
  } catch (err) {
    if (err instanceof Error) {
      const message = redactImageProviderError(err.message, profile.apiKey)
      const originalPayload = 'rawResponsePayload' in err ? String(err.rawResponsePayload) : undefined
      const rawResponsePayload = originalPayload === undefined ? undefined : redactImageProviderError(originalPayload, profile.apiKey)
      if (message !== err.message || rawResponsePayload !== originalPayload) throw Object.assign(new Error(message), { name: err.name, ...('rawImageUrls' in err ? { rawImageUrls: err.rawImageUrls } : {}), ...(rawResponsePayload !== undefined ? { rawResponsePayload } : {}) })
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
