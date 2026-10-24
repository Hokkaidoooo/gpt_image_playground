import type { ApiProfile, ImageApiDialect } from '../types'
import { buildApiUrl, normalizeBaseUrl, readClientDevProxyConfig, shouldUseApiProxy } from './devProxy'

export type ResolvedImageApiDialect = Exclude<ImageApiDialect, 'auto'>

export function normalizeGoogleImageBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim()
  if (!trimmed) throw new Error('请先填写供应商 API 地址')
  const url = new URL(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('供应商 API 地址只支持 HTTP 或 HTTPS')
  if (url.username || url.password || url.search || url.hash) throw new Error('供应商 API 地址不能包含账号、密码、查询参数或片段')

  const segments = url.pathname.split('/').filter(Boolean)
  const versionIndex = segments.findIndex((part) => /^v\d+(?:beta\d*|alpha\d*)?$/.test(part))
  const path = versionIndex >= 0 ? segments.slice(0, versionIndex + 1) : [...segments, 'v1beta']
  return `${url.origin}/${path.join('/')}`
}

export function normalizeImageProviderBaseUrl(baseUrl: string, dialect?: ImageApiDialect): string {
  // 自动协议在选择模型后确定，不能提前把 Google 版本前缀改成 OpenAI 路径。
  if (dialect === 'auto') return baseUrl.trim()
  if (dialect && !['openai', 'xai'].includes(dialect)) return normalizeGoogleImageBaseUrl(baseUrl)
  return normalizeBaseUrl(baseUrl.trim())
}

export function buildImageProviderUrl(profile: ApiProfile, path: string, dialect: ResolvedImageApiDialect): string {
  const proxyConfig = readClientDevProxyConfig()
  const useApiProxy = shouldUseApiProxy(profile.apiProxy, proxyConfig)
  if (dialect === 'openai' || dialect === 'xai') return buildApiUrl(profile.baseUrl, path, proxyConfig, useApiProxy)

  // 通用 OpenAI 代理的上游版本由部署决定，不能把原生 Google 请求默默发给它。
  if (useApiProxy) throw new Error('Google 原生生图接口不支持 OpenAI API 代理，请关闭 API 代理后使用供应商原生地址')
  return `${normalizeGoogleImageBaseUrl(profile.baseUrl)}/${path.replace(/^\/+/, '')}`
}

export function createImageProviderHeaders(profile: ApiProfile, dialect: ResolvedImageApiDialect): Record<string, string> {
  if (!profile.apiKey.trim()) throw new Error('请先填写供应商 API Key')
  return dialect === 'gemini' || dialect === 'gemini-interactions' || dialect === 'imagen'
    ? { 'x-goog-api-key': profile.apiKey }
    : { Authorization: `Bearer ${profile.apiKey}` }
}

export function redactImageProviderError(message: string, apiKey: string): string {
  const redacted = apiKey ? message.split(apiKey).join('[已隐藏 API Key]') : message
  return redacted.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:x-goog-api-key|api[-_]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"'<>]+/gi, '$1[已隐藏]')
}
