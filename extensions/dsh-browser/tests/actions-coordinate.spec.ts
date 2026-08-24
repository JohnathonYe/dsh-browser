// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { screenshotPointToCss } from '../src/content/actions.ts'

/**
 * Coordinate-conversion unit tests: the `_at` tools accept pixels the model read
 * from a browser_screenshot image and must map them into viewport CSS pixels
 * (the coordinate space CDP Input and the humanized plan use). The conversion is
 * `cssX = x * (viewportCss.width / imageSize.width)` — the screenshot image spans
 * the whole viewport, so a fraction of the image equals the same fraction of the
 * CSS viewport. The viewport basis is the injected capture-time `viewportCss`
 * (preferred, because the PNG's aspect ratio need not match the CSS viewport),
 * else a live `window.innerWidth` read, else identity.
 */
describe('screenshotPointToCss', () => {
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')

  function setViewport(width: number, height: number): void {
    Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
  }

  afterEach(() => {
    if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
    if (originalHeight !== undefined) Object.defineProperty(window, 'innerHeight', originalHeight)
    vi.restoreAllMocks()
  })

  it('maps a screenshot pixel to CSS px using the injected capture-time viewport (preferred over a stale window read)', () => {
    // The model reads a 2048x971 image down-scaled from a capture whose CSS
    // viewport is 1920x1073 (aspect ~1.79). The PNG aspect ratio (~2.11) does
    // NOT match the CSS viewport, so a stale dispatch-time window read (set to a
    // different 3840x1858) would drift; the injected viewportCss is authoritative.
    setViewport(3840, 1858)
    expect(screenshotPointToCss(470, 370, { width: 2048, height: 971 }, { width: 1920, height: 1073 })).toEqual({
      // 470 * (1920/2048) = 440.625 ; 370 * (1073/971) ≈ 408.86
      x: 470 * (1920 / 2048),
      y: 370 * (1073 / 971),
    })
  })

  it('falls back to a live window.innerWidth/innerHeight read when no viewport was injected', () => {
    setViewport(3840, 1858)
    const imageSize = { width: 2048, height: 991 }
    expect(screenshotPointToCss(900, 500, imageSize)).toEqual({
      x: 900 * (3840 / 2048),
      y: 500 * (1858 / 991),
    })
  })

  it('falls back to an identity scale when neither the viewport nor the window basis is available', () => {
    // Make the viewport unreadable and supply no viewportCss, so the helper falls
    // back to the image size itself (scale = 1 -> identity).
    Object.defineProperty(window, 'innerWidth', { value: undefined, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: undefined, configurable: true })
    try {
      expect(screenshotPointToCss(900, 500, { width: 2048, height: 991 })).toEqual({ x: 900, y: 500 })
    } finally {
      if (originalWidth !== undefined) Object.defineProperty(window, 'innerWidth', originalWidth)
      if (originalHeight !== undefined) Object.defineProperty(window, 'innerHeight', originalHeight)
    }
  })

  it('keeps a coordinate unchanged when no image size is supplied (no screenshot basis)', () => {
    setViewport(3840, 1858)
    expect(screenshotPointToCss(150, 120)).toEqual({ x: 150, y: 120 })
  })

  it('keeps a coordinate unchanged when the image size is missing or invalid', () => {
    setViewport(3840, 1858)
    expect(screenshotPointToCss(150, 120, undefined)).toEqual({ x: 150, y: 120 })
    expect(screenshotPointToCss(150, 120, { width: 0, height: 991 })).toEqual({ x: 150, y: 120 })
    expect(screenshotPointToCss(150, 120, { width: NaN, height: 991 })).toEqual({ x: 150, y: 120 })
    expect(screenshotPointToCss(150, 120, { width: 2048, height: -5 })).toEqual({ x: 150, y: 120 })
  })
})
