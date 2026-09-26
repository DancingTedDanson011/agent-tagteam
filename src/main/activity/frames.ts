// Content fingerprint of a window frame: one FNV-style hash per 8x16 pixel block
// (roughly one terminal character cell), so changes can be counted per cell.

export type FrameHashes = { width: number; height: number; blocks: Uint32Array }

const BLOCK_W = 8
const BLOCK_H = 16

export function blockHashes(bgra: Uint8Array, width: number, height: number): FrameHashes {
  const cols = Math.ceil(width / BLOCK_W)
  const rows = Math.ceil(height / BLOCK_H)
  const blocks = new Uint32Array(cols * rows).fill(2166136261)
  const px = new Uint32Array(bgra.buffer, bgra.byteOffset, width * height)
  for (let y = 0; y < height; y++) {
    const rowBase = ((y / BLOCK_H) | 0) * cols
    const lineBase = y * width
    for (let x = 0; x < width; x++) {
      const idx = rowBase + ((x / BLOCK_W) | 0)
      blocks[idx] = Math.imul(blocks[idx] ^ (px[lineBase + x] & 0x00ffffff), 16777619) >>> 0
    }
  }
  return { width, height, blocks }
}

/** Number of changed blocks, or null when the frames are not comparable (size changed). */
export function countChanged(a: FrameHashes, b: FrameHashes): number | null {
  if (a.width !== b.width || a.height !== b.height) return null
  let n = 0
  for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) n++
  return n
}
