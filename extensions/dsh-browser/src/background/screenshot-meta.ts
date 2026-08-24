/**
 * Screenshot size metadata for the controlled tab.
 *
 * `browser_screenshot` (chrome.debugger `Page.captureScreenshot`) captures the
 * viewport at its *real* pixel size (`originalDimensions`). The harness that
 * materialises the PNG for the model down-scales it to a bounded size, so the
 * model reads a **model-visible** image, NOT the raw capture. This module
 * derives the model-visible size from the raw PNG by clamping the longest side
 * to {@link SCREENSHOT_MODEL_MAX_DIMENSION} (the observed harness behaviour for
 * a 3840×1858 capture is 2048×991).
 *
 * The screenshot result exposes both sizes to the model as informational
 * metadata. Locating is DOM-driven (snapshot index + coordinate→element
 * confirmation from the click/hover tools), so no per-tab coordinate basis is
 * recorded and no screenshot-pixel-to-viewport conversion is performed.
 *
 * @module
 */

/** The model-visible screenshot is clamped so its longest side is ≤ this many px. */
export const SCREENSHOT_MODEL_MAX_DIMENSION = 2048

/** A screenshot size in pixels. */
export interface ScreenshotSize {
  width: number
  height: number
}

/**
 * Parse the width/height (bytes 16-23, big-endian) from a base64 PNG IHDR.
 * `Page.captureScreenshot` returns a PNG payload; the IHDR is always at the
 * start, so a header-only decode is cheap and needs no image library.
 * @returns the PNG's true pixel size, or undefined for invalid/truncated data.
 */
export function pngSizeFromBase64(data: string): ScreenshotSize | undefined {
  try {
    // Only the PNG header (signature + IHDR) is needed; decode a short prefix
    // (48 base64 chars = 36 bytes ≥ 24) instead of the whole multi-MB payload.
    const bin = atob(data.slice(0, 48))
    if (bin.length < 24) return undefined
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    for (let i = 0; i < signature.length; i += 1) {
      if (bin.charCodeAt(i) !== signature[i]) return undefined
    }
    if (bin.slice(12, 16) !== 'IHDR') return undefined
    const width = (bin.charCodeAt(16) << 24) | (bin.charCodeAt(17) << 16) | (bin.charCodeAt(18) << 8) | bin.charCodeAt(19)
    const height = (bin.charCodeAt(20) << 24) | (bin.charCodeAt(21) << 16) | (bin.charCodeAt(22) << 8) | bin.charCodeAt(23)
    if (width <= 0 || height <= 0) return undefined
    return { width, height }
  } catch {
    return undefined
  }
}

/**
 * Derive the size of the image the model reads from a raw capture, by clamping
 * the longest side to {@link SCREENSHOT_MODEL_MAX_DIMENSION} while preserving
 * the aspect ratio. This mirrors the harness that bounds screenshots before
 * feeding them to a vision model.
 */
export function modelVisibleImageSize(raw: ScreenshotSize): ScreenshotSize {
  const longest = Math.max(raw.width, raw.height)
  if (longest <= SCREENSHOT_MODEL_MAX_DIMENSION) {
    return { width: raw.width, height: raw.height }
  }
  const scale = SCREENSHOT_MODEL_MAX_DIMENSION / longest
  return {
    width: Math.round(raw.width * scale),
    height: Math.round(raw.height * scale),
  }
}
