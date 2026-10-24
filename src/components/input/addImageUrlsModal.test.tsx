// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AddImageUrlsModal from './addImageUrlsModal'

const fixture = vi.hoisted(() => {
  const state = {
    inputImages: [] as Array<{ id: string }>,
    privacyModeEpoch: 0,
    showToast: vi.fn(),
    setConfirmDialog: vi.fn(),
  }
  return {
    state,
    addImageFromUrl: vi.fn(),
    useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }),
  }
})

vi.mock('../../store', () => ({ useStore: fixture.useStore, addImageFromUrl: fixture.addImageFromUrl }))

let root: Root | null = null
let container: HTMLDivElement

async function open(maxImages: number, onClose = vi.fn()) {
  await act(async () => root!.render(<AddImageUrlsModal maxImages={maxImages} onClose={onClose} />))
  return onClose
}

async function submit(text: string) {
  const input = document.querySelector('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('添加') && !item.textContent?.includes('取消'))!
  await act(async () => button.click())
}

describe('本机链接参考图与原生接口上限', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    fixture.state.inputImages = []
    fixture.state.privacyModeEpoch = 0
    fixture.addImageFromUrl.mockReset()
    fixture.state.showToast.mockReset()
    fixture.state.setConfirmDialog.mockReset()
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root!.unmount())
    container.remove()
    delete window.__LOCAL_IMAGE_BOOTSTRAP__
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    root = null
  })

  it('Grok 只剩一个位置时在下载前明确拒绝两张参考图', async () => {
    fixture.state.inputImages = Array.from({ length: 4 }, (_, index) => ({ id: String(index) }))
    await open(5)
    await submit('https://fixture.example/a.png\nhttps://fixture.example/b.png')
    expect(fixture.addImageFromUrl).not.toHaveBeenCalled()
    expect(fixture.state.showToast).toHaveBeenCalledWith('参考图最多 5 张，当前还能添加 1 张', 'error')
  })

  it('Imagen 在下载前拒绝参考图', async () => {
    await open(0)
    await submit('https://fixture.example/a.png')
    const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('添加'))!
    expect(button.disabled).toBe(true)
    await act(async () => document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true })))
    expect(fixture.addImageFromUrl).not.toHaveBeenCalled()
    expect(fixture.state.showToast).toHaveBeenCalledWith('参考图最多 0 张，当前还能添加 0 张', 'error')
  })

  it('Gemini 按顺序添加并将同一上限传到最终插入入口', async () => {
    fixture.state.inputImages = Array.from({ length: 12 }, (_, index) => ({ id: String(index) }))
    fixture.addImageFromUrl.mockImplementation(async (url: string) => { fixture.state.inputImages.push({ id: url }) })
    const onClose = await open(14)
    await submit('https://fixture.example/a.png\nhttps://fixture.example/b.png')
    expect(fixture.addImageFromUrl.mock.calls).toEqual([['https://fixture.example/a.png', 14], ['https://fixture.example/b.png', 14]])
    expect(fixture.state.inputImages).toHaveLength(14)
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('本机代理的下载断流明确显示失败，保留失败链接且不误报跨域', async () => {
    window.__LOCAL_IMAGE_BOOTSTRAP__ = { bridgeVersion: 2, preset: 'fixture', token: 'test-only-session' }
    fixture.addImageFromUrl.mockRejectedValue(new TypeError('fixture stream closed'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onClose = await open(5)
    await submit('https://fixture.example/a.png')
    expect(fixture.addImageFromUrl).toHaveBeenCalledOnce()
    expect(onClose).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')!.value).toBe('https://fixture.example/a.png')
    expect(fixture.state.showToast).toHaveBeenCalledWith('链接添加失败，可能是链接失效或网络异常', 'error')
  })
})
