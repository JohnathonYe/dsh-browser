/**
 * Screenshot coordinate metadata for the controlled tab.
 *
 * `browser_screenshot` (chrome.debugger `Page.captureScreenshot`) captures the
 * viewport at its *real* pixel size (`originalDimensions`). The harness that
 * materialises the PNG for the model down-scales it to a bounded size, so the
 * model reads coordinates in that **model-visible** image, NOT in the raw
 * capture. The `browser_click_at` / `browser_hover_at` / `browser_drag_at` tools
 * accept those screenshot pixels and must map them back to viewport CSS pixels.
 *
 * The background records the model-visible size (plus the raw size) per tab so
 * the coordinate tools can convert. The conversion basis is the image the model
 * actually read, so this module derives the model-visible size from the raw PNG
 * by clamping the longest side to {@link SCREENSHOT_MODEL_MAX_DIMENSION}
 * (the observed harness behaviour for a 3840×1858 capture is 2048×991).
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

/** The viewport's CSS-pixel size at the moment a screenshot was captured.
 *  `Page.captureScreenshot` fills the raw PNG at device-pixel resolution, so
 *  the PNG's aspect ratio need NOT match the CSS viewport (a 3840×1820 PNG can
 *  come from a ~1.79-ratio CSS viewport when a device-pixel-ratio/scrollbar
 *  shift makes the capture area skew). Converting a model-visible point by the
 *  PNG width against a *different-time* `window.innerWidth` therefore drifts;
 *  recording the capture-time CSS viewport is the only pixel-true basis. */
export interface ScreenshotViewportCss {
  width: number
  height: number
}

/** Per-tab screenshot coordinate metadata recorded for `_at` conversion. */
export interface ScreenshotMeta {
  /** Size of the image the model reads coordinates from (model-visible). */
  imageSize: ScreenshotSize
  /** Raw captured PNG size (page/device pixels) before harness down-scaling. */
  originalDimensions: ScreenshotSize
  /** Capture-time viewport CSS size (the real coordinate space the model maps to).
   *  Absent only when neither CDP layout metrics nor a `window.innerWidth` read
   *  succeeded at capture time; the content script then falls back to a live read. */
  viewportCss?: ScreenshotViewportCss
  /** Wall-clock capture time (used to prefer the most recent basis). */
  capturedAt: number
}

const screenshotMetaByTab = new Map<number, ScreenshotMeta>()

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

/** Record the coordinate basis for a tab's latest screenshot. `viewportCss` is the
 *  capture-time CSS viewport size preferred by the `_at` tools; it is optional so
 *  callers keep working when layout metrics could not be read (the content script
 *  then falls back to a live `window.innerWidth` read). */
export function recordScreenshotMeta(
  tabId: number,
  imageSize: ScreenshotSize,
  originalDimensions: ScreenshotSize,
  viewportCss?: ScreenshotViewportCss,
): void {
  screenshotMetaByTab.set(tabId, {
    imageSize,
    originalDimensions,
    ...viewportCss === undefined ? {} : { viewportCss },
    capturedAt: Date.now(),
  })
}

/** Read the most recent screenshot coordinate basis for a tab. */
export function getScreenshotMeta(tabId: number): ScreenshotMeta | undefined {
  return screenshotMetaByTab.get(tabId)
}

/** Forget a tab's screenshot basis (e.g. when the tab is closed or navigated). */
export function clearScreenshotMeta(tabId: number): void {
  screenshotMetaByTab.delete(tabId)
}
