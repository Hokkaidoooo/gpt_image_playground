// @vitest-environment jsdom

import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiProfile } from '../../types'
import { createDefaultOpenAIProfile } from '../../lib/apiProfiles'
import ImageModelsPanel, { ImageParameterControls } from './ImageModelsPanel'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../../lib/platform', () => ({ isTauri: false, apiFetch }))

let root: ReturnType<typeof createRoot> | null = null
let container: HTMLDivElement

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const profile = createDefaultOpenAIProfile({ id: 'provider-a', baseUrl: 'https://provider-a.example', apiKey: 'offline-key', model: 'my-handwritten-model' })
const payload = {
  data: [
    { id: 'gpt-image-2', display_name: 'GPT 图片' },
    { id: 'vendor-art', output_modalities: ['image'] },
    { id: 'vendor-text', output_modalities: ['text'] },
  ],
}

beforeEach(() => {
  apiFetch.mockReset()
  apiFetch.mockImplementation(async () => new Response(JSON.stringify(payload), { status: 200 }))
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

async function render(profileValue = profile, onPatch = vi.fn()) {
  await act(async () => root!.render(<ImageModelsPanel profile={profileValue} onPatch={onPatch} />))
  return onPatch
}

async function fetchModels() {
  const button = [...container.querySelectorAll('button')].find((button) => button.textContent === '获取模型')!
  await act(async () => button.click())
}

describe('供应商模型选择', () => {
  it('仅主动获取时 GET 模型列表，候选与未知分开，刷新保留手写模型', async () => {
    const onPatch = await render()
    expect(apiFetch).not.toHaveBeenCalled()

    await fetchModels()

    expect(apiFetch).toHaveBeenCalledWith('https://provider-a.example/v1/models', expect.objectContaining({ method: 'GET' }))
    expect(container.textContent).toContain('共 3 个模型，2 个生图候选，1 个能力未知')
    expect(container.querySelector('[aria-label="选择模型 vendor-art"]')).not.toBeNull()
    expect(container.textContent).toContain('已标明支持生图')
    expect(container.textContent).toContain('生图候选（名称）')
    expect(container.querySelector('[aria-label="选择模型 vendor-text"]')).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()

    await fetchModels()
    expect(apiFetch).toHaveBeenCalledTimes(2)
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('多选追加到已有模型，取消选择不删除其他手写模型', async () => {
    const patches = vi.fn()
    function Harness() {
      const [value, setValue] = useState(profile)
      return <ImageModelsPanel profile={value} onPatch={(patch) => { patches(patch); setValue((previous) => ({ ...previous, ...patch })) }} />
    }
    await act(async () => root!.render(<Harness />))
    await fetchModels()

    await act(async () => (container.querySelector('[aria-label="选择模型 gpt-image-2"]') as HTMLInputElement).click())
    expect(patches).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'my-handwritten-model, gpt-image-2', selectedModel: 'my-handwritten-model' }))
    await act(async () => (container.querySelector('[aria-label="选择模型 vendor-art"]') as HTMLInputElement).click())
    expect(patches).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'my-handwritten-model, gpt-image-2, vendor-art' }))
    await act(async () => (container.querySelector('[aria-label="选择模型 gpt-image-2"]') as HTMLInputElement).click())
    expect(patches).toHaveBeenLastCalledWith(expect.objectContaining({ model: 'my-handwritten-model, vendor-art' }))
  })

  it('显式显示未知模型并可选择，搜索按名称或 ID 过滤', async () => {
    const onPatch = await render()
    await fetchModels()
    await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
    const unknown = container.querySelector('[aria-label="选择模型 vendor-text"]') as HTMLInputElement
    expect(unknown).not.toBeNull()
    expect(unknown.closest('label')?.parentElement?.textContent).toContain('能力未知')
    await act(async () => unknown.click())
    expect(onPatch).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-handwritten-model, vendor-text' }))

    const search = container.querySelector('input[type="search"]') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'vendor-art')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.querySelector('[aria-label="选择模型 vendor-art"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="选择模型 vendor-text"]')).toBeNull()
    expect(container.querySelector('[aria-label="选择模型 gpt-image-2"]')).toBeNull()
  })

  it('获取失败显示上游错误，不更改模型也不回退假名单', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ error: { message: '此密钥没有读取模型权限' } }), { status: 403 }))
    const onPatch = await render()
    await fetchModels()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('此密钥没有读取模型权限')
    expect(container.querySelector('[aria-label="选择模型 gpt-image-2"]')).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
    expect(apiFetch).toHaveBeenCalledTimes(1)
    expect(errorLog).toHaveBeenCalled()
  })

  it.each(['id', 'baseUrl', 'apiKey'] as const)('切换 %s 取消旧请求且不显示旧供应商结果', async (field) => {
    let resolveResponse!: (response: Response) => void
    apiFetch.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))
    const onPatch = await render()
    const button = [...container.querySelectorAll('button')].find((button) => button.textContent === '获取模型')!
    await act(async () => button.click())
    const requestSignal = apiFetch.mock.calls[0][1].signal as AbortSignal
    const nextProfile = { ...profile, [field]: field === 'baseUrl' ? 'https://provider-b.example' : 'provider-b' }
    await render(nextProfile, onPatch)
    expect(requestSignal.aborted).toBe(true)

    await act(async () => resolveResponse(new Response(JSON.stringify(payload), { status: 200 })))
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
    expect(container.textContent).toContain('获取模型')
  })

  it('列表请求期间改手写模型不会取消请求或覆盖输入', async () => {
    let resolveResponse!: (response: Response) => void
    apiFetch.mockImplementation(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))
    const onPatch = await render()
    const button = [...container.querySelectorAll('button')].find((button) => button.textContent === '获取模型')!
    await act(async () => button.click())
    const requestSignal = apiFetch.mock.calls[0][1].signal as AbortSignal
    await render({ ...profile, model: 'second-handwritten-model' }, onPatch)
    expect(requestSignal.aborted).toBe(false)
    await act(async () => resolveResponse(new Response(JSON.stringify(payload), { status: 200 })))
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    expect(onPatch).not.toHaveBeenCalled()
  })
})

describe('原生图片参数', () => {
  it('协议选择支持 Grok、Gemini 和 Imagen，并显式清除不支持的旧开关', async () => {
    const onPatch = await render({ ...profile, codexCli: true, streamImages: true, responseFormatB64Json: true, transparentBackgroundMethod: 'local' })
    await act(async () => (container.querySelector('div.cursor-pointer') as HTMLElement).click())
    const option = [...document.querySelectorAll('div')].find((element) => element.childElementCount === 1 && element.textContent === 'Gemini generateContent')
    expect(document.body.textContent).toContain('xAI Grok 图片接口')
    expect(document.body.textContent).toContain('Gemini Interactions')
    expect(document.body.textContent).toContain('Imagen（旧接口兼容）')
    expect(option).not.toBeNull()
    await act(async () => option!.click())
    expect(onPatch).toHaveBeenCalledWith({ imageApiDialect: 'gemini', codexCli: false, streamImages: false, responseFormatB64Json: false, transparentBackgroundMethod: 'api' })
  })

  it('显示不支持的历史分辨率，允许用户明确改为合法值', async () => {
    const onPatch = vi.fn()
    const geminiProfile: ApiProfile = { ...profile, model: 'gemini-2.5-flash-image', imageApiDialect: 'gemini', imageResolution: '4K' }
    await act(async () => root!.render(<ImageParameterControls profile={geminiProfile} onPatch={onPatch} />))
    expect(container.textContent).toContain('4K（此模型不支持）')
    expect(onPatch).not.toHaveBeenCalled()
    const selects = container.querySelectorAll('div.cursor-pointer')
    await act(async () => (selects[1] as HTMLElement).click())
    const option = [...document.querySelectorAll('div')].find((element) => element.childElementCount === 1 && element.textContent === '1K')
    await act(async () => option!.click())
    expect(onPatch).toHaveBeenCalledWith({ imageResolution: '1K' })
  })
})
