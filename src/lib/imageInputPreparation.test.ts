import { describe, expect, it, vi } from 'vitest'
import { prepareImageInputs, type DecodedInputImage, type ImageInputCodec } from './imageInputPreparation'

const signatures = { png: [137, 80, 78, 71, 13, 10, 26, 10], jpeg: [255, 216, 255, 224], webp: [82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80] }
function fixture(format: keyof typeof signatures, size = 64, declaredType = `image/${format}`) {
  const bytes = new Uint8Array(size)
  bytes.set(signatures[format])
  const chunks: string[] = []
  for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)))
  return `data:${declaredType};base64,${btoa(chunks.join(''))}`
}
function decoded(overrides: Partial<DecodedInputImage> = {}): DecodedInputImage {
  return { width: 2000, height: 1000, hasAlpha: false, source: {} as CanvasImageSource, close: vi.fn(), ...overrides }
}
function codec(image = decoded()): ImageInputCodec {
  return { decode: vi.fn().mockResolvedValue(image), encode: vi.fn(async (_, width, height, type) => new Blob([new Uint8Array(Math.ceil(width * height / 4))], { type })) }
}
const auto = { referenceImagePolicy: 'auto' as const, maxReferenceImageMB: 1 }

describe('参考图本机准备', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('小型%s真实格式识别并解码，保留原始字节', async (format) => {
    const input = fixture(format)
    const implementation = codec()
    const result = await prepareImageInputs([input], undefined, auto, implementation)
    expect(result.blobs[0].size).toBe(64)
    expect(result.blobs[0].type).toBe(`image/${format}`)
    expect(implementation.decode).toHaveBeenCalledTimes(1)
    expect(implementation.encode).not.toHaveBeenCalled()
    expect(result.adjustments).toEqual([])
  })

  it('声明MIME与签名不同则规范真实格式并记录', async () => {
    const result = await prepareImageInputs([fixture('jpeg', 64, 'image/png')], undefined, auto, codec())
    expect(result.blobs[0].type).toBe('image/jpeg')
    expect(result.adjustments[0]).toContain('JPEG')
  })

  it('十进制MB阈值包含边界，超过1字节才生成上传副本', async () => {
    const implementation = codec()
    const result = await prepareImageInputs([fixture('png', 1_000_000), fixture('png', 1_000_001)], undefined, auto, implementation)
    expect(result.blobs[0].size).toBe(1_000_000)
    expect(result.blobs[1].size).toBeLessThanOrEqual(1_000_000)
    expect(implementation.encode).toHaveBeenCalledTimes(1)
    expect(result.adjustments).toHaveLength(1)
  })

  it('损坏签名与损坏编码都在发送前明确失败', async () => {
    const implementation = codec()
    await expect(prepareImageInputs(['data:image/png;base64,aW1hZ2U='], undefined, auto, implementation)).rejects.toThrow('文件已损坏')
    expect(implementation.decode).not.toHaveBeenCalled()
    vi.mocked(implementation.decode).mockRejectedValueOnce(new Error('truncated image'))
    await expect(prepareImageInputs([fixture('png')], undefined, auto, implementation)).rejects.toThrow('无法解码')
  })

  it('不透明大图先高质量JPEG，仍过大再等比缩小', async () => {
    const implementation = codec()
    vi.mocked(implementation.encode).mockImplementation(async (_, width, height, type) => new Blob([new Uint8Array(Math.ceil(width * height))], { type }))
    const result = await prepareImageInputs([fixture('png', 2_000_000)], undefined, auto, implementation)
    expect(result.blobs[0].type).toBe('image/jpeg')
    expect(result.blobs[0].size).toBeLessThanOrEqual(1_000_000)
    const calls = vi.mocked(implementation.encode).mock.calls
    expect(calls[0].slice(1, 5)).toEqual([2000, 1000, 'image/jpeg', 0.94])
    expect(calls[1].slice(1, 5)).toEqual([2000, 1000, 'image/jpeg', 0.88])
    expect(calls.some((call) => call[1] < 2000 && call[2] < 1000)).toBe(true)
    expect(result.adjustments[0]).toContain('原图保留')
  })

  it('透明大图保持PNG，不丢失透明通道', async () => {
    const implementation = codec(decoded({ hasAlpha: true }))
    const result = await prepareImageInputs([fixture('webp', 1_000_001)], undefined, auto, implementation)
    expect(result.blobs[0].type).toBe('image/png')
    expect(vi.mocked(implementation.encode).mock.calls.every((call) => call[3] === 'image/png')).toBe(true)
  })

  it('original关闭自动优化并明确拦截超限原图', async () => {
    const implementation = codec()
    await expect(prepareImageInputs([fixture('png', 1_000_001)], undefined, { ...auto, referenceImagePolicy: 'original' }, implementation)).rejects.toThrow('启用参考图自动优化')
    expect(implementation.encode).not.toHaveBeenCalled()
  })

  it('遮罩与主图同步缩小、均为PNG且遮罩保留alpha采样模式', async () => {
    const implementation = codec()
    vi.mocked(implementation.decode).mockResolvedValueOnce(decoded()).mockResolvedValueOnce(decoded({ hasAlpha: true }))
    vi.mocked(implementation.encode).mockImplementation(async (_, width, height, type) => new Blob([new Uint8Array(width * height)], { type }))
    const result = await prepareImageInputs([fixture('jpeg', 1_500_000)], fixture('png', 1_200_000), auto, implementation)
    expect(result.blobs[0].type).toBe('image/png')
    expect(result.mask?.type).toBe('image/png')
    expect(result.blobs[0].size).toBeLessThanOrEqual(1_000_000)
    expect(result.mask!.size).toBeLessThanOrEqual(1_000_000)
    const calls = vi.mocked(implementation.encode).mock.calls
    for (let index = 0; index < calls.length; index += 2) {
      expect(calls[index].slice(1, 4)).toEqual(calls[index + 1].slice(1, 4))
      expect(calls[index + 1][5]).toBe(true)
    }
    expect(result.adjustments).toHaveLength(2)
  })

  it('遮罩尺寸不一致与original非PNG均明确拒绝', async () => {
    const implementation = codec()
    vi.mocked(implementation.decode).mockResolvedValueOnce(decoded()).mockResolvedValueOnce(decoded({ width: 1999 }))
    await expect(prepareImageInputs([fixture('png')], fixture('png'), auto, implementation)).rejects.toThrow('尺寸与主图不一致')
    await expect(prepareImageInputs([fixture('jpeg')], fixture('png'), { ...auto, referenceImagePolicy: 'original' }, codec())).rejects.toThrow('均为 PNG')
  })

  it('编码始终过大时有界退出并释放解码资源', async () => {
    const image = decoded()
    const implementation = codec(image)
    vi.mocked(implementation.encode).mockImplementation(async () => new Blob([new Uint8Array(2_000_000)], { type: 'image/jpeg' }))
    await expect(prepareImageInputs([fixture('png', 2_000_000)], undefined, auto, implementation)).rejects.toThrow('无法在保持完整画面')
    expect(implementation.encode).toHaveBeenCalledTimes(24)
    expect(image.close).toHaveBeenCalledTimes(1)
  })
})
