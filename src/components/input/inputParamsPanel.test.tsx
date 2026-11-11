import type { ComponentProps } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, type ApiProfile } from '../../types'
import { createDefaultOpenAIProfile } from '../../lib/apiProfiles'
import { getImageProviderCapabilities } from '../../lib/imageProvider'
import { getParamDisabledReasons } from '../../lib/paramCompatibility'
import { getImageSearchSupport, getImageThinkingSupport } from '../../lib/imageSearch'
import InputParamsPanel from './inputParamsPanel'

const noop = () => {}
const hint = { visible: false, show: noop, hide: noop, clearTimer: noop, startTouch: noop }

function render(profile: ApiProfile) {
  const props: ComponentProps<typeof InputParamsPanel> = {
    params: DEFAULT_PARAMS,
    setParams: vi.fn(),
    activeProfile: profile,
    searchSupport: getImageSearchSupport(profile),
    thinkingSupport: getImageThinkingSupport(profile),
    complexityHint: hint,
    disabledReasons: getParamDisabledReasons(profile),
    hasInputImages: false,
    modelOptions: [{ label: profile.model, value: profile.model }],
    onModelChange: vi.fn(),
    isFalProvider: profile.provider === 'fal',
    displaySize: '1024x1024',
    qualityOptions: [{ label: 'auto', value: 'auto' }],
    selectClass: '',
    transparentOutputAvailable: true,
    showTransparentOutputControl: true,
    transparentOutputEnabled: false,
    transparentOutputHint: hint,
    onTransparentOutputMenuOpenChange: noop,
    compressionHint: hint,
    compressionDisabled: false,
    outputCompressionInput: '',
    setOutputCompressionInput: noop,
    commitOutputCompression: noop,
    moderationHint: hint,
    moderationDisabled: false,
    agentAutoImageCount: false,
    outputImageLimit: getImageProviderCapabilities(profile).maxOutputImages,
    nInput: '1',
    setNInputFocused: noop,
    commitN: noop,
    handleNInputChange: noop,
    handleNLimitIncreaseAttempt: noop,
    showAgentNHint: noop,
    hideNLimitHint: noop,
    startAgentNHintTouch: noop,
    clearAgentNHintTouchTimer: noop,
    nLimitHint: hint,
    nLimitHintText: '',
    streamConcurrentByN: false,
    streamConcurrentHint: hint,
    sizeHint: hint,
    qualityHint: hint,
    onOpenSizePicker: noop,
    showBatch: false,
    batchEnabled: false,
    batchMode: 'queue',
    batchConcurrencyLimited: true,
    batchConcurrency: 1,
    batchPromptCount: 0,
    batchProgress: null,
    onBatchChange: noop,
    onStopBatch: noop,
  }
  return renderToStaticMarkup(<InputParamsPanel {...props} />)
}

describe('图片参数栏的协议能力', () => {
  it.each([
    ['xai', 'grok-imagine-image', 10],
    ['gemini', 'gemini-3.1-flash-image', 10],
    ['gemini-interactions', 'gemini-nano-banana-2.1', 10],
    ['imagen', 'imagen-4.0-generate-001', 4],
  ] as const)('%s 使用比例和分辨率，隐藏 GPT 专属参数，并采用数量上限', (dialect, model, limit) => {
    const html = render(createDefaultOpenAIProfile({ model, imageApiDialect: dialect }))
    expect(html).toContain('比例')
    expect(html).toContain('分辨率')
    expect(html).not.toContain('尺寸')
    expect(html).not.toContain('PNG')
    expect(html).toContain(`max="${limit}"`)
  })

  it('OpenAI兼容的Grok模型使用统一任务比例参数', () => {
    const html = render(createDefaultOpenAIProfile({ model: 'grok-imagine-image', imageApiDialect: 'openai' }))
    expect(html).toContain('比例')
    expect(html).toContain('质量')
    expect(html).toContain('分辨率')
    expect(html).not.toContain('PNG')
  })

  it.each(['fal', 'custom-http'])('%s的Gemini模型复用TaskParams比例参数', (provider) => {
    const html = render({ ...createDefaultOpenAIProfile({ model: 'gemini-3.1-flash-image' }), provider })
    expect(html).toContain('比例')
    expect(html).toContain('分辨率')
    expect(html).not.toContain('尺寸')
  })

  it('Responses API 保留现有参数，即使图片协议字段被预先保存', () => {
    const html = render(createDefaultOpenAIProfile({ model: 'text-model', apiMode: 'responses', imageApiDialect: 'gemini' }))
    expect(html).toContain('尺寸')
    expect(html).toContain('质量')
    expect(html).toContain('更多')
    expect(html).not.toContain('分辨率')
  })
})
