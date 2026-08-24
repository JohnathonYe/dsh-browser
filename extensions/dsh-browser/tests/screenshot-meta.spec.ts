// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  modelVisibleImageSize,
  pngSizeFromBase64,
  SCREENSHOT_MODEL_MAX_DIMENSION,
} from '../src/background/screenshot-meta.ts'

/** A minimal PNG header for width×height (valid signature + IHDR). */
function pngHeader(width: number, height: number): string {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // IHDR length 13, then 'IHDR', then width/height big-endian.
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  bytes[16] = (width >> 24) & 0xff
  bytes[17] = (width >> 16) & 0xff
  bytes[18] = (width >> 8) & 0xff
  bytes[19] = width & 0xff
  bytes[20] = (height >> 24) & 0xff
  bytes[21] = (height >> 16) & 0xff
  bytes[22] = (height >> 8) & 0xff
  bytes[23] = height & 0xff
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

describe('pngSizeFromBase64', () => {
  it('parses width/height from a base64 PNG IHDR', () => {
    expect(pngSizeFromBase64(pngHeader(3840, 1858))).toEqual({ width: 3840, height: 1858 })
    expect(pngSizeFromBase64(pngHeader(2048, 991))).toEqual({ width: 2048, height: 991 })
  })

  it('returns undefined for truncated, invalid, or non-PNG payloads', () => {
    expect(pngSizeFromBase64('')).toBeUndefined()
    expect(pngSizeFromBase64('aGVsbG8=')).toBeUndefined()
    expect(pngSizeFromBase64('not-base64-!!!')).toBeUndefined()
  })
})

describe('modelVisibleImageSize', () => {
  it('keeps a small capture at its native size', () => {
    expect(modelVisibleImageSize({ width: 1024, height: 768 })).toEqual({ width: 1024, height: 768 })
  })

  it('clamps the longest side to the model max dimension, preserving aspect ratio', () => {
    // 3840x1858 -> longest 3840 clamps to 2048 -> 2048x991 (matches the observed
    // harness down-scale of the raw capture to the model-visible image).
    const size = modelVisibleImageSize({ width: 3840, height: 1858 })
    expect(Math.max(size.width, size.height)).toBe(SCREENSHOT_MODEL_MAX_DIMENSION)
    expect(size.width).toBe(2048)
    expect(size.height).toBe(991)
  })
})
