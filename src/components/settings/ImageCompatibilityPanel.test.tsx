// @vitest-environment jsdom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaultOpenAIProfile } from '../../lib/apiProfiles'
import ImageCompatibilityPanel from './ImageCompatibilityPanel'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('供应商兼容设置', () => {
  it('Orbitix在提交前明确展示顺序生成与默认审核规则', async () => {
    const onPatch = vi.fn()
    const profile = createDefaultOpenAIProfile({ baseUrl: 'https://new.orbitix.site/v1' })
    await act(async () => root.render(<ImageCompatibilityPanel profile={profile} onPatch={onPatch} />))
    expect(container.textContent).toContain('每次生成 1 张')
    expect(container.textContent).toContain('审核强度使用供应商默认值')
    expect(container.textContent).toContain('自动兼容（推荐）')
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('自定义参数勾选保留批量大小与参考图协议', async () => {
    const onPatch = vi.fn()
    const profile = createDefaultOpenAIProfile({
      baseUrl: 'https://relay.example.test',
      imageRequestCompatibility: { mode: 'custom', maxImagesPerRequest: 4, omitParameters: ['moderation'], editImageField: 'image' },
    })
    await act(async () => root.render(<ImageCompatibilityPanel profile={profile} onPatch={onPatch} />))
    const quality = [...container.querySelectorAll('label')].find((label) => label.textContent === '画质')!.querySelector('input')!
    await act(async () => quality.click())
    expect(onPatch).toHaveBeenCalledWith({ imageRequestCompatibility: {
      mode: 'custom', maxImagesPerRequest: 4, omitParameters: ['moderation', 'quality'], editImageField: 'image',
      referenceImagePolicy: 'auto', maxReferenceImageMB: 14,
    } })
  })

  it.each([
    ['gemini-3-pro-image', ['画面比例', 'Base64 返回格式'], false],
    ['grok-imagine-image-2.0', ['画质', 'Base64 返回格式'], false],
    ['grok-imagine-1.5-apimart', ['画面比例', 'Base64 返回格式'], true],
    ['grok-imagine-1.5-ext', ['画面比例', 'Base64 返回格式'], true],
  ] as const)('%s只显示实际JSON参数及适用的参考图设置', async (model, labels, urlOnly) => {
    const profile = createDefaultOpenAIProfile({ model, imageApiDialect: 'openai', imageRequestCompatibility: { mode: 'custom', omitParameters: ['moderation'] } })
    await act(async () => root.render(<ImageCompatibilityPanel profile={profile} onPatch={vi.fn()} />))
    expect([...container.querySelectorAll('fieldset label')].map((label) => label.textContent?.trim())).toEqual(labels)
    expect(container.textContent).not.toContain('参考图上传方式')
    expect(container.textContent).not.toContain('image[]')
    expect(container.textContent).not.toContain('审核强度使用供应商默认值')
    if (urlOnly) {
      expect(container.textContent).toContain('本机自动优化和图片大小设置不适用')
      expect(container.textContent).not.toContain('参考图处理')
      expect(container.textContent).not.toContain('参考图大小上限')
    } else {
      expect(container.textContent).toContain('参考图处理')
    }
  })

  it('锁定配置的自定义参数不能修改', async () => {
    const onPatch = vi.fn()
    const profile = createDefaultOpenAIProfile({ imageRequestCompatibility: { mode: 'custom' } })
    await act(async () => root.render(<ImageCompatibilityPanel profile={profile} disabled onPatch={onPatch} />))
    expect(container.querySelector('fieldset')!.disabled).toBe(true)
    await act(async () => container.querySelector('input')!.click())
    expect(onPatch).not.toHaveBeenCalled()
  })
})
