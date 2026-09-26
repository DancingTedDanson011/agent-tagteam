import { describe, expect, it } from 'vitest'
import { blockHashes, countChanged } from './frames'

function frame(width: number, height: number, paint?: (x: number, y: number) => number): Uint8Array {
  const px = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = paint ? paint(x, y) : 0
      const i = (y * width + x) * 4
      px[i] = v
      px[i + 1] = v
      px[i + 2] = v
      px[i + 3] = 255
    }
  return px
}

describe('frame block hashing', () => {
  it('reports zero changes for identical frames', () => {
    const a = blockHashes(frame(64, 64, (x) => x), 64, 64)
    const b = blockHashes(frame(64, 64, (x) => x), 64, 64)
    expect(countChanged(a, b)).toBe(0)
  })

  it('counts one block for a change inside one 8x16 cell', () => {
    const a = blockHashes(frame(64, 64), 64, 64)
    const b = blockHashes(frame(64, 64, (x, y) => (x >= 10 && x < 14 && y >= 20 && y < 28 ? 200 : 0)), 64, 64)
    expect(countChanged(a, b)).toBe(1)
  })

  it('detects a one-pixel-thin glyph stroke despite row/column sampling', () => {
    const a = blockHashes(frame(64, 64), 64, 64)
    const b = blockHashes(frame(64, 64, (x, y) => (x === 33 && y >= 2 && y < 12 ? 255 : 0)), 64, 64)
    expect(countChanged(a, b)).toBe(1)
  })

  it('returns null when the frame size differs (layout change is not activity)', () => {
    const a = blockHashes(frame(64, 64), 64, 64)
    const b = blockHashes(frame(64, 48), 64, 48)
    expect(countChanged(a, b)).toBeNull()
  })

  it('does not hash the alpha channel', () => {
    const f = frame(16, 16)
    const g = frame(16, 16)
    for (let i = 3; i < g.length; i += 4) g[i] = 0
    expect(countChanged(blockHashes(f, 16, 16), blockHashes(g, 16, 16))).toBe(0)
  })
})
