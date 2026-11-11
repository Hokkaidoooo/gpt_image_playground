import { getActiveApiProfile, getCustomProviderDefinition } from './apiProfiles'
import { composeMarkupDataUrl, toApiInputImageDataUrl } from './canvasImage'
import { callFalAiImageApi } from './falAiImageApi'
import { callGoogleImageApi } from './googleImageApi'
import { supportsImageMarkup } from './imageModels'
import { getImageSearchSupport } from './imageSearch'
import { callOpenAICompatibleImageApi } from './openaiCompatibleImageApi'
import { getImageProviderCapabilities } from './imageProvider'
import { callNativeImageApi } from './nativeImageApi'
import type { CallApiOptions, CallApiResult } from './imageApiShared'

export type { CallApiOptions, CallApiResult } from './imageApiShared'
export { normalizeBaseUrl } from './devProxy'

export async function callImageApi(opts: CallApiOptions): Promise<CallApiResult> {
  const profile = getActiveApiProfile(opts.settings)
  if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
  const capabilities = getImageProviderCapabilities(profile)
  const nativeGoogle = capabilities.nativeParameters && capabilities.dialect === 'gemini'
  const googleProfile = nativeGoogle ? { ...profile, provider: 'google' } : profile
  const inputImageDataUrls = await Promise.all(opts.inputImageDataUrls.map(toApiInputImageDataUrl))
  const inputImageUrls = opts.inputImageUrls ? [...opts.inputImageUrls] : undefined
  let markupDataUrl = opts.markupDataUrl
  // 接口不支持 markup，或已有遮罩（两者不能同时使用）时，把标注直接画进第一张图
  if (markupDataUrl && inputImageDataUrls.length && (opts.maskDataUrl || !supportsImageMarkup(profile))) {
    inputImageDataUrls[0] = await composeMarkupDataUrl(inputImageDataUrls[0], markupDataUrl)
    if (inputImageUrls) inputImageUrls[0] = null
    markupDataUrl = undefined
  }
  const customProvider = getCustomProviderDefinition(opts.settings, profile.provider)
  const search = getImageSearchSupport(googleProfile, customProvider)
  const prefix = opts.settings.imagePromptHints && nativeGoogle ? '生成图像：' : ''
  const suffix = opts.settings.imagePromptHints ? [
    !search.googleSearch && opts.params.google_search ? '请使用 google:search 搜索相关信息。' : '',
    !search.imageSearch && opts.params.image_search ? '请使用 google:image_search 搜索图片，作为生成图像的参考。' : '',
  ].filter(Boolean).join('\n') : ''
  await opts.onPromptHintsPrepared?.(prefix || suffix ? { prefix, suffix } : undefined)
  const prompt = `${prefix ? `${prefix}\n` : ''}${opts.prompt}${suffix ? `\n${suffix}` : ''}`
  const requestOpts = { ...opts, prompt, inputImageDataUrls, inputImageUrls, markupDataUrl }
  if (opts.shouldContinue && !opts.shouldContinue()) throw new Error('任务已停止，本次请求未发送。')
  if (profile.provider === 'fal') return callFalAiImageApi(requestOpts, profile)
  if (capabilities.nativeParameters) {
    return capabilities.dialect === 'gemini' ? callGoogleImageApi(requestOpts, profile) : callNativeImageApi(requestOpts, profile)
  }

  return callOpenAICompatibleImageApi(requestOpts, profile, customProvider)
}
