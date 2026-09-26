// Pure geometry used by main (placement) and renderer (layouts).

export type Box = { x: number; y: number; width: number; height: number }
export type Size = { width: number; height: number }
export type WinRect = { left: number; top: number; right: number; bottom: number }

/** Terminal cells are wider than tall; grids aim for cells of roughly this width/height ratio. */
const TERMINAL_ASPECT = 1.6

export function offsetRect(origin: { x: number; y: number }, r: Box): Box {
  return { x: origin.x + r.x, y: origin.y + r.y, width: r.width, height: r.height }
}

/** Scales edges (not sizes), so adjacent rects stay adjacent after rounding. */
export function scaleRect(r: Box, scale: number): Box {
  const left = Math.round(r.x * scale)
  const top = Math.round(r.y * scale)
  return {
    x: left,
    y: top,
    width: Math.round((r.x + r.width) * scale) - left,
    height: Math.round((r.y + r.height) * scale) - top
  }
}

export function fitAspect(slot: Box, srcWidth: number, srcHeight: number): Box {
  if (srcWidth <= 0 || srcHeight <= 0) return slot
  const scale = Math.min(slot.width / srcWidth, slot.height / srcHeight)
  const width = Math.round(srcWidth * scale)
  const height = Math.round(srcHeight * scale)
  return {
    x: slot.x + Math.round((slot.width - width) / 2),
    y: slot.y + Math.round((slot.height - height) / 2),
    width,
    height
  }
}

const MIN_SIZE: Size = { width: 200, height: 120 }

export function clampSize(size: Size, container: Size): Size {
  return {
    width: Math.min(Math.max(size.width, MIN_SIZE.width), container.width),
    height: Math.min(Math.max(size.height, MIN_SIZE.height), container.height)
  }
}

/** Column/row count that gives the largest terminal-shaped cells for n sessions. */
export function gridDims(n: number, width: number, height: number): { cols: number; rows: number } {
  if (n <= 0) return { cols: 0, rows: 0 }
  let best = { cols: 1, rows: n, score: -1 }
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const score = Math.min(width / cols / TERMINAL_ASPECT, height / rows)
    if (score > best.score) best = { cols, rows, score }
  }
  return { cols: best.cols, rows: best.rows }
}

/** True for a pure move: the position changed but the size stayed (a resize is not a drag-in). */
export function moved(a: WinRect, b: WinRect): boolean {
  const sameSize = a.right - a.left === b.right - b.left && a.bottom - a.top === b.bottom - b.top
  return sameSize && (a.left !== b.left || a.top !== b.top)
}

/**
 * DWM draws a thumbnail over the whole window and ignores CSS clipping, so a thumbnail scrolled
 * out of its list would paint over the title bar. This clips it to the visible `clip` area and
 * returns the matching part of the source window, or null when nothing of it is visible.
 */
export function clipThumbnail(dest: Box, clip: Box, srcWidth: number, srcHeight: number): { dest: Box; source: Box | undefined } | null {
  const left = Math.max(dest.x, clip.x)
  const top = Math.max(dest.y, clip.y)
  const right = Math.min(dest.x + dest.width, clip.x + clip.width)
  const bottom = Math.min(dest.y + dest.height, clip.y + clip.height)
  if (right <= left || bottom <= top || dest.width <= 0 || dest.height <= 0) return null
  if (left === dest.x && top === dest.y && right === dest.x + dest.width && bottom === dest.y + dest.height) return { dest, source: undefined }
  const sx = srcWidth / dest.width
  const sy = srcHeight / dest.height
  return {
    dest: { x: left, y: top, width: right - left, height: bottom - top },
    source: {
      x: Math.round((left - dest.x) * sx),
      y: Math.round((top - dest.y) * sy),
      width: Math.round((right - left) * sx),
      height: Math.round((bottom - top) * sy)
    }
  }
}

/** The window no longer covers its slot: dragged or resized away by the user. Unknown rect → false. */
export function isDisplaced(actual: WinRect | null, expected: Box, tolerance = 4): boolean {
  if (!actual) return false
  return (
    Math.abs(actual.left - expected.x) > tolerance ||
    Math.abs(actual.top - expected.y) > tolerance ||
    Math.abs(actual.right - actual.left - expected.width) > tolerance ||
    Math.abs(actual.bottom - actual.top - expected.height) > tolerance
  )
}

export function containsPoint(r: Box, p: { x: number; y: number }): boolean {
  return p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
}
