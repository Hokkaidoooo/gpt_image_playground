import { describe, expect, it, vi } from 'vitest'
import type { ColorMode } from '../types'
import { COLOR_MODE_KEY, resolveDarkMode } from './colorMode'
import SCRIPT from '../../public/color-mode.js?raw'

// 在模拟的浏览器环境中运行 public/color-mode.js，返回它是否加上了 dark 类
function runEarlyScript(stored: string | null, systemDark: boolean) {
  const classes = new Set<string>()
  const localStorage = { getItem: (key: string) => (key === COLOR_MODE_KEY ? stored : null) }
  const matchMedia = (query: string) => ({ matches: query === '(prefers-color-scheme: dark)' && systemDark })
  const document = {
    documentElement: {
      classList: { toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)) },
    },
  }
  new Function('localStorage', 'matchMedia', 'document', SCRIPT)(localStorage, matchMedia, document)
  return classes.has('dark')
}

describe('color mode', () => {
  it.each<[ColorMode, boolean]>([
    ['system', false],
    ['system', true],
    ['light', false],
    ['light', true],
    ['dark', false],
    ['dark', true],
  ])('early script matches the app for %s mode (system dark: %s)', (mode, systemDark) => {
    expect(runEarlyScript(mode, systemDark)).toBe(resolveDarkMode(mode, systemDark))
  })

  it('early script follows the system without a cached mode', () => {
    expect(runEarlyScript(null, true)).toBe(true)
    expect(runEarlyScript(null, false)).toBe(false)
  })

  it('reports storage access failure and renders the explicit system mode', () => {
    const failure = new Error('test-only blocked storage')
    const warn = vi.fn()
    const toggle = vi.fn()
    const localStorage = { getItem: () => { throw failure } }
    new Function('localStorage', 'matchMedia', 'document', 'console', SCRIPT)(
      localStorage,
      () => ({ matches: true }),
      { documentElement: { classList: { toggle } } },
      { warn },
    )
    expect(warn).toHaveBeenCalledExactlyOnceWith('读取已保存的颜色模式失败，使用系统模式', failure)
    expect(toggle).toHaveBeenCalledExactlyOnceWith('dark', true)
  })
})
