export function readRuntimeEnv(value: string | undefined): string {
  const raw = String.prototype.trim.call(value ?? '')
  if (raw !== '__LOCAL_IMAGE_PRESET__') return raw
  const preset = typeof window === 'undefined' ? undefined : window.__LOCAL_IMAGE_BOOTSTRAP__?.preset
  if (!preset) throw new Error('本机连接配置未加载，请重新打开新版生图工具。')
  return preset
}
