import { canvasToBlob } from './canvasImage'

const BYTES_PER_MB = 1_000_000
const MAX_RESIZE_ATTEMPTS = 8
const JPEG_QUALITIES = [0.94, 0.88, 0.8]
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const

type ImageType = typeof ALLOWED_IMAGE_TYPES[number]

export interface ImageInputPolicy {
  referenceImagePolicy: 'auto' | 'original'
  maxReferenceImageMB: number
}

export interface PreparedImageInputs {
  blobs: Blob[]
  mask: Blob | null
  adjustments: string[]
}

export interface DecodedInputImage {
  width: number
  height: number
  hasAlpha: boolean
  source: CanvasImageSource
  close: () => void
}

export interface ImageInputCodec {
  decode: (blob: Blob) => Promise<DecodedInputImage>
  encode: (image: DecodedInputImage, width: number, height: number, type: ImageType, quality?: number, mask?: boolean) => Promise<Blob>
}

const browserCodec: ImageInputCodec = {
  async decode(blob) {
    const image = await createImageBitmap(blob)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d', { willReadFrequently: true })
      if (!context) throw new Error('当前浏览器不支持图片像素读取。')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, image.width, image.height).data
      let hasAlpha = false
      for (let i = 3; i < pixels.length; i += 4) {
        if (pixels[i] < 255) { hasAlpha = true; break }
      }
      canvas.width = canvas.height = 0
      return { width: image.width, height: image.height, hasAlpha, source: image, close: () => image.close() }
    } catch (error) {
      image.close()
      throw error
    }
  },
  async encode(image, width, height, type, quality, mask = false) {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    try {
      const context = canvas.getContext('2d')
      if (!context) throw new Error('当前浏览器不支持图片编码。')
      context.imageSmoothingEnabled = !mask
      context.imageSmoothingQuality = 'high'
      context.drawImage(image.source, 0, 0, width, height)
      const blob = await canvasToBlob(canvas, type, quality)
      if (blob.type !== type) throw new Error(`当前浏览器无法编码 ${type} 图片。`)
      return blob
    } finally {
      canvas.width = canvas.height = 0
    }
  },
}

function imageType(bytes: Uint8Array): ImageType {
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png'
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  throw new Error('图片内容不是受支持的 PNG、JPEG 或 WebP，或文件已损坏。')
}

function readInput(dataUrl: string, label: string): { blob: Blob; correctedType: boolean } {
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([A-Za-z0-9+/]*={0,2})$/i.exec(dataUrl)
  if (!match) throw new Error(`${label}不是有效的 Base64 图片数据。`)
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const binary = atob(match[2])
    bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch (error) {
    throw new Error(`${label}的 Base64 数据已损坏：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const type = imageType(bytes)
    return { blob: new Blob([bytes], { type }), correctedType: match[1].toLowerCase() !== type }
  } catch (error) {
    throw new Error(`${label}：${error instanceof Error ? error.message : String(error)}`)
  }
}

function smallerDimensions(width: number, height: number, bytes: number, limit: number) {
  const scale = Math.min(0.85, Math.max(0.5, Math.sqrt(limit / bytes) * 0.92))
  return { width: Math.max(1, Math.floor(width * scale)), height: Math.max(1, Math.floor(height * scale)) }
}

function describeAdjustment(label: string, before: Blob, after: Blob, image: DecodedInputImage, width: number, height: number) {
  return `${label}上传副本：${(before.size / BYTES_PER_MB).toFixed(2)} MB → ${(after.size / BYTES_PER_MB).toFixed(2)} MB，${image.width}×${image.height} → ${width}×${height}，${after.type.replace('image/', '').toUpperCase()}；原图保留。`
}

async function optimizeInput(blob: Blob, image: DecodedInputImage, limit: number, codec: ImageInputCodec, label: string): Promise<{ blob: Blob; width: number; height: number }> {
  const type: ImageType = image.hasAlpha ? 'image/png' : 'image/jpeg'
  let width = image.width
  let height = image.height
  let output = blob
  for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt++) {
    for (const quality of type === 'image/jpeg' ? JPEG_QUALITIES : [undefined]) {
      output = await codec.encode(image, width, height, type, quality)
      if (output.size <= limit) return { blob: output, width, height }
    }
    const next = smallerDimensions(width, height, output.size, limit)
    if (next.width === width && next.height === height) break
    width = next.width
    height = next.height
  }
  throw new Error(`${label}无法在保持完整画面的前提下压缩至 ${(limit / BYTES_PER_MB).toFixed(0)} MB，请更换参考图或调整单图大小上限。`)
}

export async function prepareImageInputs(dataUrls: string[], maskDataUrl: string | undefined, policy: ImageInputPolicy, codec: ImageInputCodec = browserCodec): Promise<PreparedImageInputs> {
  if (!Number.isFinite(policy.maxReferenceImageMB) || policy.maxReferenceImageMB < 1 || policy.maxReferenceImageMB > 50) throw new Error('参考图大小上限必须为 1 至 50 MB。')
  if (maskDataUrl && !dataUrls.length) throw new Error('遮罩缺少对应的主图。')
  const limit = policy.maxReferenceImageMB * BYTES_PER_MB
  const inputs = [...dataUrls.map((dataUrl, index) => ({ dataUrl, label: `参考图 ${index + 1}` })), ...(maskDataUrl ? [{ dataUrl: maskDataUrl, label: '遮罩' }] : [])]
  const decoded: DecodedInputImage[] = []
  const blobs: Blob[] = []
  const adjustments: string[] = []
  try {
    for (const input of inputs) {
      const parsed = readInput(input.dataUrl, input.label)
      let image: DecodedInputImage
      try {
        image = await codec.decode(parsed.blob)
      } catch (error) {
        throw new Error(`${input.label}无法解码，文件可能已损坏：${error instanceof Error ? error.message : String(error)}`)
      }
      decoded.push(image)
      if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) || image.width < 1 || image.height < 1) throw new Error(`${input.label}尺寸无效。`)
      blobs.push(parsed.blob)
      if (parsed.correctedType) adjustments.push(`${input.label}已按实际文件内容规范为 ${parsed.blob.type.replace('image/', '').toUpperCase()}。`)
      if (policy.referenceImagePolicy === 'original' && parsed.blob.size > limit) throw new Error(`${input.label}为 ${(parsed.blob.size / BYTES_PER_MB).toFixed(2)} MB，超过 ${policy.maxReferenceImageMB} MB 上限。请启用参考图自动优化，或调整上限。`)
    }
    const maskIndex = maskDataUrl ? blobs.length - 1 : -1
    if (maskIndex >= 0) {
      const main = decoded[0]
      const mask = decoded[maskIndex]
      if (main.width !== mask.width || main.height !== mask.height) throw new Error('遮罩尺寸与主图不一致，请重新绘制遮罩。')
      if (policy.referenceImagePolicy === 'original' && (blobs[0].type !== 'image/png' || blobs[maskIndex].type !== 'image/png')) throw new Error('保留原图模式要求遮罩及主图均为 PNG；请启用参考图自动优化或提供 PNG 文件。')
      const originalMain = blobs[0]
      const originalMask = blobs[maskIndex]
      let width = main.width
      let height = main.height
      if (originalMain.type !== 'image/png' || originalMask.type !== 'image/png' || originalMain.size > limit || originalMask.size > limit) {
        let fitted = false
        for (let attempt = 0; attempt < MAX_RESIZE_ATTEMPTS; attempt++) {
          const mainBlob = await codec.encode(main, width, height, 'image/png')
          const maskBlob = await codec.encode(mask, width, height, 'image/png', undefined, true)
          if (mainBlob.size <= limit && maskBlob.size <= limit) {
            blobs[0] = mainBlob
            blobs[maskIndex] = maskBlob
            fitted = true
            break
          }
          const next = smallerDimensions(width, height, Math.max(mainBlob.size, maskBlob.size), limit)
          if (next.width === width && next.height === height) break
          width = next.width
          height = next.height
        }
        if (!fitted) throw new Error(`遮罩和主图无法同时压缩至 ${policy.maxReferenceImageMB} MB，请更换主图或调整上限。`)
        adjustments.push(describeAdjustment('遮罩主图', originalMain, blobs[0], main, width, height))
        adjustments.push(describeAdjustment('遮罩', originalMask, blobs[maskIndex], mask, width, height))
      }
    }
    for (let index = 0; index < dataUrls.length; index++) {
      if (index === 0 && maskIndex >= 0) continue
      if (blobs[index].size <= limit) continue
      const original = blobs[index]
      const optimized = await optimizeInput(original, decoded[index], limit, codec, inputs[index].label)
      blobs[index] = optimized.blob
      adjustments.push(describeAdjustment(inputs[index].label, original, optimized.blob, decoded[index], optimized.width, optimized.height))
    }
    return { blobs: blobs.slice(0, dataUrls.length), mask: maskIndex >= 0 ? blobs[maskIndex] : null, adjustments }
  } finally {
    for (const image of decoded) image.close()
  }
}
