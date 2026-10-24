import type { ApiProfile, TaskRecord } from '../types'
import type { ApiRequestInit } from './platform'
import { resolveApiProfileModel } from './imageModels'

export interface LocalImageBootstrap {
  preset: string
  token: string
  bridgeVersion?: number
  managedBaseUrl?: string
  managedKeyMarker?: string
  saveGeneratedImages?: boolean
  configurationError?: string
}

declare global {
  interface Window {
    __LOCAL_IMAGE_BOOTSTRAP__?: LocalImageBootstrap
  }
}

export function hasLocalImageBridge() {
  return typeof window !== 'undefined' && window.__LOCAL_IMAGE_BOOTSTRAP__?.bridgeVersion === 2
}

function getLocalBootstrap() {
  const bootstrap = typeof window === 'undefined' ? undefined : window.__LOCAL_IMAGE_BOOTSTRAP__
  if (!bootstrap || bootstrap.bridgeVersion !== 2) throw new Error('本机服务版本已更新，请停止后重新启动，再刷新页面。')
  return bootstrap
}

/** 只向本机发送会话凭据；上游 URL 和密钥来自当前界面选中的配置。 */
export async function fetchThroughLocalBridge(input: string | URL, init: ApiRequestInit = {}): Promise<Response> {
  const bootstrap = getLocalBootstrap()
  const { timeoutSeconds, ...requestInit } = init
  const url = new URL(input, window.location.href)
  if (!['http:', 'https:'].includes(url.protocol)) return globalThis.fetch(input, requestInit)
  if (url.origin === window.location.origin) return globalThis.fetch(input, requestInit)
  const entries = init.headers instanceof Headers
    ? [...init.headers.entries()]
    : Array.isArray(init.headers) ? init.headers : Object.entries(init.headers ?? {})
  if (entries.some(([, value]) => value.includes(bootstrap.token))) throw new Error('本机连接凭据不能作为供应商密钥发送。')
  const request = new Request(url, requestInit)
  const method = request.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()
  const metadata = {
    url: request.url,
    method,
    headers: [...request.headers.entries()],
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  }
  return globalThis.fetch('/local/proxy', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bootstrap.token}`,
      'Content-Type': 'application/octet-stream',
      'X-Local-Request': encodeURIComponent(JSON.stringify(metadata)),
    },
    body,
    signal: init.signal,
    cache: 'no-store',
    redirect: 'error',
  })
}

function cleanEndpoint(value: string) {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return url.href
}

export class LocalImageSaveError extends Error {
  constructor(detail: string, readonly invalidImages = false) {
    super(`图片已经生成，但本地保存失败：${detail}。请查看图库和供应商记录，避免重复提交。`)
    this.name = 'LocalImageSaveError'
  }
}

/** 图库、异步恢复和 Agent 最终图片均经同一个本地保存入口。 */
export async function saveLocalGeneratedImages(
  images: string[],
  request: { prompt: string; model: string; provider?: string; profile_name?: string; api_mode?: string; size?: string; quality?: string; n?: number; aspect_ratio?: string; resolution?: string },
  endpoint: string,
): Promise<void> {
  if (!hasLocalImageBridge()) return
  const bootstrap = getLocalBootstrap()
  let response: Response
  try {
    response = await globalThis.fetch('/local/save-images', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bootstrap.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ images, endpoint: cleanEndpoint(endpoint), request }),
      cache: 'no-store',
    })
  } catch (err) {
    throw new LocalImageSaveError(err instanceof Error ? err.message : String(err))
  }
  if (response.ok) return
  let error: { error?: { message?: string; code?: string } }
  try {
    error = await response.json()
  } catch (err) {
    throw new LocalImageSaveError(`HTTP ${response.status}，错误响应无法解析：${err instanceof Error ? err.message : String(err)}`)
  }
  throw new LocalImageSaveError(error.error?.message ?? `HTTP ${response.status}`, error.error?.code === 'invalid_image')
}

export function localImageRecord(task: TaskRecord, profile?: ApiProfile) {
  return {
    prompt: task.prompt,
    model: task.apiModel || (profile ? resolveApiProfileModel(profile).model : ''),
    provider: task.apiProvider ?? profile?.provider,
    profile_name: task.apiProfileName ?? profile?.name,
    api_mode: task.apiMode ?? profile?.apiMode,
    size: task.params.size,
    quality: task.params.quality,
    n: task.params.n,
    ...(task.imageAspectRatio ? { aspect_ratio: task.imageAspectRatio } : {}),
    ...(task.imageResolution ? { resolution: task.imageResolution } : {}),
  }
}
