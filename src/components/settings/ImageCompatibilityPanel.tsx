import type { ApiProfile, ImageRequestCompatibility } from '../../types'
import { MAX_IMAGES_PER_REQUEST, resolveImageRequestCompatibility } from '../../lib/imageRequestCompatibility'
import Select from '../Select'

const PARAMETER_LABELS = {
  moderation: '审核强度',
  quality: '画质',
  size: '尺寸',
  output_format: '图片格式',
  output_compression: '压缩率',
  response_format: 'Base64 返回格式',
} as const

const SELECT_CLASS = 'w-full rounded-xl border border-transparent bg-black/[0.04] px-3 py-2 text-xs text-gray-700 outline-none focus:border-blue-300 dark:bg-white/[0.06] dark:text-gray-200'

export default function ImageCompatibilityPanel({ profile, onPatch, disabled = false }: {
  profile: ApiProfile
  onPatch: (patch: Partial<ApiProfile>) => void
  disabled?: boolean
}) {
  const resolved = resolveImageRequestCompatibility(profile)
  const mode = profile.imageRequestCompatibility?.mode ?? 'auto'
  const custom: ImageRequestCompatibility = {
    mode: 'custom',
    maxImagesPerRequest: resolved.maxImagesPerRequest,
    omitParameters: resolved.omitParameters,
    editImageField: resolved.editImageField,
    referenceImagePolicy: resolved.referenceImagePolicy,
    maxReferenceImageMB: resolved.maxReferenceImageMB,
  }
  const patchCustom = (patch: Partial<ImageRequestCompatibility>) => onPatch({
    imageRequestCompatibility: { ...custom, ...patch, mode: 'custom' },
  })

  return (
    <section aria-label="图片接口兼容性" className="space-y-3 rounded-xl bg-black/[0.025] p-3 dark:bg-white/[0.025]">
      <label className="block space-y-1.5">
        <span className="text-sm text-gray-600 dark:text-gray-300">图片接口兼容性</span>
        <Select
          value={mode}
          onChange={(value) => onPatch({ imageRequestCompatibility: value === 'custom' ? custom : { mode: value as 'auto' | 'standard' } })}
          options={[
            { label: '自动兼容（推荐）', value: 'auto' },
            { label: '标准接口（关闭自动适配）', value: 'standard' },
            { label: '自定义', value: 'custom' },
          ]}
          disabled={disabled}
          className={SELECT_CLASS}
        />
      </label>
      <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        {mode === 'standard'
          ? '按标准接口发送所选参数。供应商需要支持对应的张数、画质和审核选项。'
          : `多张图片每次生成 ${resolved.maxImagesPerRequest} 张，按顺序完成；遇到失败即停止，已完成的图片保留。`}
        {resolved.omitParameters.length > 0 && ` ${resolved.omitParameters.map((name) => PARAMETER_LABELS[name]).join('、')}使用供应商默认值。`}
      </p>
      <label className="block space-y-1.5">
        <span className="text-xs text-gray-600 dark:text-gray-300">参考图处理</span>
        <Select
          value={resolved.referenceImagePolicy}
          onChange={(value) => onPatch({ imageRequestCompatibility: {
            ...profile.imageRequestCompatibility,
            mode: mode === 'standard' ? 'custom' : mode,
            referenceImagePolicy: value as 'auto' | 'original',
          } })}
          options={[
            { label: '自动优化上传副本（保留原图）', value: 'auto' },
            { label: '保留原图，仅检查大小和格式', value: 'original' },
          ]}
          disabled={disabled || mode === 'standard'}
          className={SELECT_CLASS}
        />
      </label>
      <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
        每张上传图片最多 {resolved.maxReferenceImageMB} MB。自动优化会在超限时调整上传副本的编码或尺寸，详情中可查看调整记录。
      </p>
      {mode === 'custom' && (
        <>
          <label className="block space-y-1.5">
            <span className="text-xs text-gray-600 dark:text-gray-300">参考图大小上限</span>
            <Select
              value={String(resolved.maxReferenceImageMB)}
              onChange={(value) => patchCustom({ maxReferenceImageMB: Number(value) })}
              options={Array.from({ length: 50 }, (_, index) => ({ label: `${index + 1} MB`, value: String(index + 1) }))}
              disabled={disabled}
              className={SELECT_CLASS}
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-gray-600 dark:text-gray-300">每次请求最多生成</span>
            <Select
              value={String(resolved.maxImagesPerRequest)}
              onChange={(value) => patchCustom({ maxImagesPerRequest: Number(value) })}
              options={Array.from({ length: MAX_IMAGES_PER_REQUEST }, (_, index) => ({ label: `${index + 1} 张`, value: String(index + 1) }))}
              disabled={disabled}
              className={SELECT_CLASS}
            />
          </label>
          <fieldset disabled={disabled} className="space-y-2 text-xs text-gray-600 dark:text-gray-300">
            <legend className="mb-2">使用供应商默认值的选项</legend>
            {Object.entries(PARAMETER_LABELS).map(([name, label]) => {
              const parameter = name as keyof typeof PARAMETER_LABELS
              return (
                <label key={name} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={resolved.omitParameters.includes(parameter)}
                    onChange={(event) => patchCustom({
                      omitParameters: event.target.checked
                        ? [...resolved.omitParameters, parameter]
                        : resolved.omitParameters.filter((item) => item !== parameter),
                    })}
                  />
                  {label}
                </label>
              )
            })}
          </fieldset>
          <label className="block space-y-1.5">
            <span className="text-xs text-gray-600 dark:text-gray-300">参考图上传方式</span>
            <Select
              value={resolved.editImageField}
              onChange={(value) => patchCustom({ editImageField: value as 'image[]' | 'image' })}
              options={[
                { label: '多参考图（image[]）', value: 'image[]' },
                { label: '单参考图（image）', value: 'image' },
              ]}
              disabled={disabled}
              className={SELECT_CLASS}
            />
          </label>
        </>
      )}
    </section>
  )
}
