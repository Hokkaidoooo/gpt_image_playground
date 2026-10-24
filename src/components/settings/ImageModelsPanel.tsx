import { useEffect, useRef, useState } from 'react'
import type { ApiProfile, ImageApiDialect } from '../../types'
import { splitModelList } from '../../lib/apiProfiles'
import { getImageProviderCapabilities, listImageModels, type ImageModelList } from '../../lib/imageProvider'
import { Checkbox } from '../Checkbox'
import Select from '../Select'

const IMAGE_API_OPTIONS = [
  { label: '自动选择', value: 'auto' },
  { label: 'OpenAI Images（统一中转接口）', value: 'openai' },
  { label: 'xAI Grok 图片接口', value: 'xai' },
  { label: 'Gemini generateContent', value: 'gemini' },
  { label: 'Gemini Interactions', value: 'gemini-interactions' },
  { label: 'Imagen（旧接口兼容）', value: 'imagen' },
]
const SUPPORT_LABELS = {
  confirmed: '已标明支持生图',
  likely: '生图候选（名称）',
  unknown: '能力未知',
}
const INPUT_CLASS = 'w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2.5 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200 dark:focus:border-blue-500/50'

export function ImageParameterControls({ profile, onPatch, disabled = false, compactClassName }: {
  profile: ApiProfile
  onPatch: (patch: Partial<ApiProfile>) => void
  disabled?: boolean
  compactClassName?: string
}) {
  const capabilities = getImageProviderCapabilities(profile)
  const controls = [
    { field: 'imageAspectRatio' as const, label: compactClassName ? '比例' : '画面比例', defaultLabel: '自动', values: capabilities.aspectRatios },
    { field: 'imageResolution' as const, label: '分辨率', defaultLabel: '默认', values: capabilities.resolutions },
  ]

  return (
    <div className={compactClassName ? 'contents' : 'grid grid-cols-2 gap-3'}>
      {controls.map((control) => {
        const value = profile[control.field] ?? ''
        const options = [{ label: control.defaultLabel, value: '' }, ...control.values.map((value) => ({ label: value, value }))]
        if (value && !control.values.includes(value)) options.push({ label: `${value}（此模型不支持）`, value })
        return (
          <div key={control.field} className={compactClassName ? 'relative max-sm:flex-auto sm:shrink-0' : undefined}>
            {!compactClassName && <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">{control.label}</span>}
            <Select
              value={value}
              onChange={(value) => onPatch({ [control.field]: String(value) })}
              options={options}
              disabled={disabled}
              prefix={compactClassName ? <span className="mr-1.5 text-gray-400 dark:text-gray-500">{control.label}</span> : undefined}
              menuClassName="min-w-max"
              className={compactClassName ?? INPUT_CLASS}
            />
          </div>
        )
      })}
    </div>
  )
}

export default function ImageModelsPanel({ profile, onPatch, disabled = false }: {
  profile: ApiProfile
  onPatch: (patch: Partial<ApiProfile>) => void
  disabled?: boolean
}) {
  const [result, setResult] = useState<ImageModelList | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const requestRef = useRef<AbortController | null>(null)
  const capabilities = getImageProviderCapabilities(profile)
  const selectedModels = splitModelList(profile.model)
  const selected = new Set(selectedModels)
  const dialectLabel = IMAGE_API_OPTIONS.find((option) => option.value === capabilities.dialect)?.label

  useEffect(() => {
    requestRef.current?.abort()
    requestRef.current = null
    setResult(null)
    setLoading(false)
    setError(null)
    setQuery('')
    return () => requestRef.current?.abort()
  }, [profile.id, profile.provider, profile.apiMode, profile.baseUrl, profile.apiKey, capabilities.dialect])

  const fetchModels = async () => {
    requestRef.current?.abort()
    const controller = new AbortController()
    requestRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const next = await listImageModels(profile, controller.signal)
      if (!controller.signal.aborted && requestRef.current === controller) setResult(next)
    } catch (err) {
      if (controller.signal.aborted || requestRef.current !== controller) return
      console.error('获取供应商模型列表失败', err)
      setResult(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null
        setLoading(false)
      }
    }
  }

  const patchProfile = (patch: Partial<ApiProfile>) => {
    const next = { ...profile, ...patch }
    onPatch(getImageProviderCapabilities(next).nativeParameters
      ? { ...patch, codexCli: false, streamImages: false, responseFormatB64Json: false, transparentBackgroundMethod: 'api' }
      : patch)
  }

  const toggleModel = (id: string, checked: boolean) => {
    const models = checked ? [...selectedModels, id] : selectedModels.filter((model) => model !== id)
    if (!models.length) return
    const currentModel = profile.selectedModel ?? selectedModels[0]
    patchProfile({
      model: models.join(', '),
      selectedModel: currentModel && models.includes(currentModel) ? currentModel : models[0],
    })
  }

  const normalizedQuery = query.trim().toLowerCase()
  const models = result?.models.filter((model) => (
    (showAll || model.imageSupport !== 'unknown') &&
    (!normalizedQuery || `${model.id} ${model.label}`.toLowerCase().includes(normalizedQuery))
  )) ?? []

  return (
    <div className="space-y-4">
      <div>
        <span className="mb-1.5 block text-sm text-gray-600 dark:text-gray-300">图片接口</span>
        <Select
          value={profile.imageApiDialect ?? 'auto'}
          onChange={(value) => patchProfile({ imageApiDialect: value as ImageApiDialect })}
          options={IMAGE_API_OPTIONS}
          disabled={disabled}
          className={INPUT_CLASS}
        />
        <p className="mt-1.5 text-xs leading-relaxed text-gray-500">
          {(profile.imageApiDialect ?? 'auto') === 'auto' && <>当前自动选择：{dialectLabel}。 </>}
          中转站使用统一图片接口时，请选择 OpenAI Images；其他接口按供应商说明选择。
        </p>
      </div>
      {capabilities.nativeParameters && (
        <div className="space-y-2">
          <ImageParameterControls profile={profile} onPatch={onPatch} disabled={disabled} />
          <p className="text-xs leading-relaxed text-gray-500">此接口使用画面比例和分辨率。切换后会恢复不适用的图片参数，并关闭透明背景、流式传输和 Codex CLI 选项。</p>
        </div>
      )}
      <div className="rounded-xl border border-gray-200/70 p-3 dark:border-white/[0.08]">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-sm text-gray-600 dark:text-gray-300">可用模型</span>
            <p className="mt-1 text-xs text-gray-500">读取当前地址和 API Key 的模型列表。</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchModels()}
            disabled={disabled || loading || !profile.baseUrl.trim() || !profile.apiKey.trim()}
            className="shrink-0 rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? '正在获取…' : '获取模型'}
          </button>
        </div>
        {error && <p role="alert" className="mt-3 whitespace-pre-wrap break-words rounded-lg bg-red-500/[0.08] p-2.5 text-xs leading-relaxed text-red-600 dark:text-red-400">{error}</p>}
        {result && (
          <div className="mt-3 space-y-3">
            <p role="status" className="text-xs leading-relaxed text-gray-500">
              共 {result.total} 个模型，{result.total - result.unclassified} 个生图候选，{result.unclassified} 个能力未知。已选 {selectedModels.length} 个模型。
            </p>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索模型名称或 ID" aria-label="搜索模型" className={INPUT_CLASS} />
            <Checkbox checked={showAll} onChange={setShowAll} label="显示全部模型（含未知能力）" />
            <div className="max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-gray-200/60 dark:border-white/[0.06]">
              {models.map((model) => (
                <div key={model.id} className="flex items-center gap-3 border-b border-gray-200/50 px-2.5 py-2.5 last:border-b-0 dark:border-white/[0.06]">
                  <Checkbox
                    checked={selected.has(model.id)}
                    onChange={(checked) => toggleModel(model.id, checked)}
                    disabled={disabled || (selected.has(model.id) && selectedModels.length === 1)}
                    aria-label={`选择模型 ${model.id}`}
                    label={<span className="block break-all font-mono text-xs">{model.id}{model.label !== model.id && <span className="mt-0.5 block font-sans text-gray-500">{model.label}</span>}</span>}
                    className="min-w-0 flex-1"
                  />
                  <span className={`shrink-0 rounded-md px-1.5 py-1 text-[10px] ${model.imageSupport === 'confirmed' ? 'bg-green-500/[0.1] text-green-700 dark:text-green-400' : model.imageSupport === 'likely' ? 'bg-amber-500/[0.1] text-amber-700 dark:text-amber-400' : 'bg-black/[0.04] text-gray-500 dark:bg-white/[0.06]'}`}>{SUPPORT_LABELS[model.imageSupport]}</span>
                </div>
              ))}
              {models.length === 0 && <p className="px-3 py-4 text-xs leading-relaxed text-gray-500">没有匹配的模型。可调整搜索、查看全部模型，或在下方手动填写模型 ID。</p>}
            </div>
            <p className="text-xs leading-relaxed text-gray-500">勾选后可在首页切换模型；手动填写的模型会保留。名称只能提示生图候选，实际支持和权限以供应商为准。</p>
          </div>
        )}
      </div>
    </div>
  )
}
