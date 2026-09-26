import { describe, expect, it } from 'vitest'
import { clampSize, clipThumbnail, fitAspect, gridDims, moved, offsetRect, scaleRect, containsPoint, isDisplaced } from './geometry'

describe('clipThumbnail', () => {
  // source window 1000x500, thumbnail drawn at 200x100 in the side column
  const dest = { x: 50, y: 100, width: 200, height: 100 }

  it('leaves a fully visible thumbnail untouched', () => {
    expect(clipThumbnail(dest, { x: 0, y: 50, width: 400, height: 600 }, 1000, 500)).toEqual({ dest, source: undefined })
  })
  it('cuts off the part scrolled above the column and shows the matching lower part of the source', () => {
    // column starts at y=150: the top 50 px of the 100 px thumbnail are hidden
    expect(clipThumbnail(dest, { x: 0, y: 150, width: 400, height: 600 }, 1000, 500)).toEqual({
      dest: { x: 50, y: 150, width: 200, height: 50 },
      source: { x: 0, y: 250, width: 1000, height: 250 }
    })
  })
  it('returns null when the thumbnail is scrolled completely out of view', () => {
    expect(clipThumbnail(dest, { x: 0, y: 300, width: 400, height: 600 }, 1000, 500)).toBeNull()
  })
})

describe('isDisplaced', () => {
  const expected = { x: 100, y: 50, width: 800, height: 600 }
  const at = (left: number, top: number, w = 800, h = 600) => ({ left, top, right: left + w, bottom: top + h })

  it('a window exactly on its slot is in place', () => {
    expect(isDisplaced(at(100, 50), expected)).toBe(false)
  })
  it('tolerates a few pixels of rounding', () => {
    expect(isDisplaced(at(102, 48, 801, 599), expected)).toBe(false)
  })
  it('a window dragged away is displaced', () => {
    expect(isDisplaced(at(900, 400), expected)).toBe(true)
  })
  it('a window resized by the user is displaced', () => {
    expect(isDisplaced(at(100, 50, 1200, 600), expected)).toBe(true)
  })
  it('an unknown rect (window gone) is not reported as displaced', () => {
    expect(isDisplaced(null, expected)).toBe(false)
  })
})

describe('offsetRect', () => {
  it('turns a slot rect relative to the content area into an absolute rect', () => {
    expect(offsetRect({ x: 100, y: 50 }, { x: 10, y: 20, width: 300, height: 200 })).toEqual({
      x: 110,
      y: 70,
      width: 300,
      height: 200
    })
  })
})

describe('scaleRect', () => {
  it('scales CSS pixels to device pixels and rounds outward-safe', () => {
    expect(scaleRect({ x: 10, y: 20, width: 101, height: 51 }, 1.5)).toEqual({ x: 15, y: 30, width: 152, height: 77 })
  })
  it('is the identity at scale 1', () => {
    expect(scaleRect({ x: 3, y: 4, width: 5, height: 6 }, 1)).toEqual({ x: 3, y: 4, width: 5, height: 6 })
  })
})

describe('fitAspect', () => {
  it('letterboxes a wide source into a square slot, centered', () => {
    expect(fitAspect({ x: 0, y: 0, width: 100, height: 100 }, 200, 100)).toEqual({ x: 0, y: 25, width: 100, height: 50 })
  })
  it('pillarboxes a tall source', () => {
    expect(fitAspect({ x: 10, y: 10, width: 100, height: 50 }, 100, 100)).toEqual({ x: 35, y: 10, width: 50, height: 50 })
  })
  it('returns the slot unchanged for an unknown source size', () => {
    expect(fitAspect({ x: 1, y: 2, width: 3, height: 4 }, 0, 0)).toEqual({ x: 1, y: 2, width: 3, height: 4 })
  })
})

describe('clampSize', () => {
  it('never exceeds the container (a parked window must stay hidden behind the app)', () => {
    expect(clampSize({ width: 2000, height: 300 }, { width: 1200, height: 800 })).toEqual({ width: 1200, height: 300 })
  })
  it('keeps a minimum usable size', () => {
    expect(clampSize({ width: 10, height: 10 }, { width: 1200, height: 800 })).toEqual({ width: 200, height: 120 })
  })
})

describe('gridDims', () => {
  it('handles 0 and 1 sessions', () => {
    expect(gridDims(0, 1600, 900)).toEqual({ cols: 0, rows: 0 })
    expect(gridDims(1, 1600, 900)).toEqual({ cols: 1, rows: 1 })
  })
  it('puts 2 sessions side by side on a wide screen', () => {
    expect(gridDims(2, 1600, 900)).toEqual({ cols: 2, rows: 1 })
  })
  it('stacks 2 sessions on a tall area', () => {
    expect(gridDims(2, 700, 1200)).toEqual({ cols: 1, rows: 2 })
  })
  it('uses 2x2 for 4 and 3x2 for 5 or 6 on a wide screen', () => {
    expect(gridDims(4, 1600, 900)).toEqual({ cols: 2, rows: 2 })
    expect(gridDims(5, 1600, 900)).toEqual({ cols: 3, rows: 2 })
    expect(gridDims(6, 1600, 900)).toEqual({ cols: 3, rows: 2 })
  })
  it('always has enough cells', () => {
    for (let n = 1; n <= 20; n++) {
      const { cols, rows } = gridDims(n, 1400, 800)
      expect(cols * rows).toBeGreaterThanOrEqual(n)
      expect((cols - 1) * rows < n || cols * (rows - 1) < n).toBe(true)
    }
  })
})

describe('moved', () => {
  it('is a move when the position changed and the size did not', () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(moved(a, { left: 5, top: 0, right: 105, bottom: 100 })).toBe(true)
  })
  it('a resize is not a move', () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(moved(a, { left: 0, top: 0, right: 150, bottom: 100 })).toBe(false)
    expect(moved(a, { left: -10, top: 0, right: 100, bottom: 100 })).toBe(false)
  })
  it('no change is not a move', () => {
    const a = { left: 0, top: 0, right: 100, bottom: 100 }
    expect(moved(a, { ...a })).toBe(false)
  })
})

describe('containsPoint', () => {
  it('includes the top-left edge and excludes the bottom-right edge', () => {
    const r = { x: 10, y: 10, width: 100, height: 50 }
    expect(containsPoint(r, { x: 10, y: 10 })).toBe(true)
    expect(containsPoint(r, { x: 109, y: 59 })).toBe(true)
    expect(containsPoint(r, { x: 110, y: 30 })).toBe(false)
    expect(containsPoint(r, { x: 50, y: 60 })).toBe(false)
  })
})
