// Thumbnails with the DWM API mocked: which properties reach DWM.
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Props = { dwFlags: number; rcDestination: object; rcSource: object }
const updates: Props[] = []
let registered = 0
let unregistered = 0

vi.mock('../win32/api', () => ({
  DwmRegisterThumbnail: (_dest: bigint, _src: bigint, out: unknown[]) => {
    registered++
    out[0] = 42n
    return 0
  },
  DwmUpdateThumbnailProperties: (_thumb: unknown, props: Props) => {
    updates.push(props)
    return 0
  },
  DwmUnregisterThumbnail: () => {
    unregistered++
    return 0
  }
}))

const { Thumbnails } = await import('./thumbs')
const RECTSOURCE = 0x2

beforeEach(() => {
  updates.length = 0
  registered = 0
  unregistered = 0
})

describe('Thumbnails', () => {
  it('registers once and sends the destination rect', () => {
    const t = new Thumbnails(() => 7n)
    expect(t.set('1', 100n, { x: 10, y: 20, width: 200, height: 100 })).toBe(true)
    expect(registered).toBe(1)
    expect(updates[0].rcDestination).toEqual({ left: 10, top: 20, right: 210, bottom: 120 })
    expect(updates[0].dwFlags & RECTSOURCE).toBe(0)
  })

  it('does not resend an unchanged rect', () => {
    const t = new Thumbnails(() => 7n)
    t.set('1', 100n, { x: 10, y: 20, width: 200, height: 100 })
    t.set('1', 100n, { x: 10, y: 20, width: 200, height: 100 })
    expect(updates).toHaveLength(1)
  })

  it('sends a source rect when only part of the window is shown', () => {
    const t = new Thumbnails(() => 7n)
    t.set('1', 100n, { x: 10, y: 20, width: 200, height: 50 }, { x: 0, y: 250, width: 1000, height: 250 })
    expect(updates[0].dwFlags & RECTSOURCE).toBe(RECTSOURCE)
    expect(updates[0].rcSource).toEqual({ left: 0, top: 250, right: 1000, bottom: 500 })
  })

  it('reports where it last drew, and nothing once removed', () => {
    const t = new Thumbnails(() => 7n)
    expect(t.placed('1')).toBeUndefined()
    t.set('1', 100n, { x: 10, y: 20, width: 200, height: 50 }, { x: 0, y: 250, width: 1000, height: 250 })
    expect(t.placed('1')).toEqual({ dest: { x: 10, y: 20, width: 200, height: 50 }, source: { x: 0, y: 250, width: 1000, height: 250 } })
    t.remove('1')
    expect(t.placed('1')).toBeUndefined()
  })

  it('keepOnly unregisters everything else', () => {
    const t = new Thumbnails(() => 7n)
    t.set('1', 100n, { x: 0, y: 0, width: 10, height: 10 })
    t.set('2', 200n, { x: 0, y: 0, width: 10, height: 10 })
    t.keepOnly(new Set(['2']))
    expect(unregistered).toBe(1)
    expect(t.has('1')).toBe(false)
    expect(t.has('2')).toBe(true)
  })
})
