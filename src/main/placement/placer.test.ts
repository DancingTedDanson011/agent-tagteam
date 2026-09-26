// Placer with Electron and Win32 mocked: which calls go to which window for which layout.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WindowOps } from '../capture/ops'

const log: string[] = []
const rects = new Map<string, { left: number; top: number; right: number; bottom: number }>()
const zoomed = new Set<string>()

vi.mock('electron', () => ({
  screen: {
    getDisplayMatching: () => ({ scaleFactor: 1 }),
    dipToScreenRect: (_w: unknown, r: { x: number; y: number; width: number; height: number }) => r
  }
}))
vi.mock('../capture/live', () => ({
  setOwner: async (h: bigint, o: bigint) => void log.push(`owner ${h} ${o}`)
}))
vi.mock('../win32/api', () => ({ SetWindowPos: () => 1, IsZoomed: (h: bigint) => (zoomed.has(h.toString()) ? 1 : 0) }))
vi.mock('../win32/async', () => ({
  isHung: () => false,
  setWindowPos: async (h: bigint, after: bigint, x: number, y: number, cx: number, cy: number) => {
    log.push(`pos ${h} after=${after} ${x},${y},${cx},${cy}`)
    rects.set(h.toString(), { left: x, top: y, right: x + cx, bottom: y + cy })
    return 1
  },
  showWindow: async () => 1,
  setWindowPlacement: async (h: bigint, wp: { showCmd: number }) => {
    log.push(`placement ${h} show=${wp.showCmd}`)
    zoomed.delete(h.toString())
    return 1
  }
}))
vi.mock('../win32/windows', () => ({
  SWP_NOSIZE: 0x1,
  SWP_NOMOVE: 0x2,
  SWP_NOZORDER: 0x4,
  SWP_NOACTIVATE: 0x10,
  SWP_SHOWWINDOW: 0x40,
  SW_HIDE: 0,
  SW_SHOWNORMAL: 1,
  SW_SHOWNOACTIVATE: 4,
  getRect: (h: bigint) => rects.get(h.toString()) ?? null,
  isMinimized: () => false,
  getPlacement: () => ({
    length: 44,
    flags: 0,
    showCmd: 3,
    ptMinPosition: { x: 0, y: 0 },
    ptMaxPosition: { x: 0, y: 0 },
    rcNormalPosition: { left: 0, top: 0, right: 10, bottom: 10 }
  })
}))

const { Placer } = await import('./placer')

const APP = 777n
function setup(ids: string[]) {
  const ops = new WindowOps()
  const sessions = { list: () => ids.map((id) => ({ id, hwnd: BigInt(id) })), ops }
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(APP)
  const win = {
    getNativeWindowHandle: () => handle,
    isDestroyed: () => false,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 })
  }
  const thumbs = {
    set: (id: string, _src: bigint, dest: object, source?: object) => {
      log.push(`thumb ${id} ${JSON.stringify(dest)} ${source ? JSON.stringify(source) : '-'}`)
      return true
    },
    remove: () => undefined,
    keepOnly: () => undefined,
    clear: () => undefined
  }
  const placer = new Placer(win as never, sessions as never, thumbs as never, { sizeChanged: () => undefined })
  const settle = async () => {
    for (const id of ids) await ops.idle(id)
    await new Promise((r) => setTimeout(r, 0))
    for (const id of ids) await ops.idle(id)
  }
  return { placer, settle }
}

beforeEach(() => {
  log.length = 0
  rects.clear()
  zoomed.clear()
})

describe('Placer: windows dragged out of their slot', () => {
  const live = { placements: [{ id: '1', mode: 'live' as const, rect: { x: 10, y: 40, width: 500, height: 300 } }], attended: [] }

  it('reports a live window that the user dragged away', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout(live)
    await settle()
    expect(placer.displacedIds()).toEqual([])
    rects.set('1', { left: 900, top: 500, right: 1400, bottom: 800 }) // dragged by its own tab bar
    expect(placer.displacedIds()).toEqual(['1'])
  })

  it('reports a live window that the user maximized', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout(live)
    await settle()
    zoomed.add('1')
    expect(placer.displacedIds()).toEqual(['1'])
  })

  it('never reports parked windows', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({ placements: [{ id: '1', mode: 'parked' }], attended: [] })
    await settle()
    rects.set('1', { left: 5000, top: 5000, right: 5100, bottom: 5100 })
    expect(placer.displacedIds()).toEqual([])
  })

  it('reseat puts a dragged-away window back over its slot although the layout did not change', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout(live)
    await settle()
    rects.set('1', { left: 900, top: 500, right: 1400, bottom: 800 })
    log.length = 0
    placer.reseat()
    await settle()
    expect(log).toContain('pos 1 after=0 10,40,500,300')
    expect(placer.displacedIds()).toEqual([])
  })

  it('reseat un-maximizes first, then places', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout(live)
    await settle()
    zoomed.add('1')
    log.length = 0
    placer.reseat(['1'])
    await settle()
    const placement = log.findIndex((l) => l.startsWith('placement 1 show=1'))
    const pos = log.indexOf('pos 1 after=0 10,40,500,300')
    expect(placement).toBeGreaterThanOrEqual(0)
    expect(pos).toBeGreaterThan(placement)
  })
})

describe('Placer: thumbnails inside a scrolling list', () => {
  it('does not draw a thumbnail that is scrolled completely out of its list', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({
      placements: [{ id: '1', mode: 'thumb', rect: { x: 900, y: 10, width: 200, height: 100 }, clip: { x: 880, y: 200, width: 300, height: 500 } }],
      attended: []
    })
    await settle()
    expect(log.some((l) => l.startsWith('thumb 1'))).toBe(false)
  })

  it('draws only the visible part of a partly scrolled thumbnail', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({
      placements: [{ id: '1', mode: 'thumb', rect: { x: 900, y: 150, width: 200, height: 100 }, clip: { x: 880, y: 200, width: 300, height: 500 } }],
      attended: []
    })
    await settle()
    const line = log.find((l) => l.startsWith('thumb 1'))
    expect(line).toBeDefined()
    expect(line).not.toContain(' -') // carries a source rect
    expect(line).toContain('"y":200') // destination starts at the list's top edge
  })
})

describe('Placer: dialogs stay on top', () => {
  it('re-parks a captured window that came to the front while a dialog is open', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({ placements: [{ id: '1', mode: 'parked' }], attended: [], modal: true })
    await settle()
    log.length = 0
    expect(placer.guardModal(1n)).toBe(true)
    await settle()
    expect(log.some((l) => l.startsWith(`pos 1 after=${APP}`))).toBe(true)
  })

  it('does nothing without a dialog or for a foreign foreground window', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({ placements: [{ id: '1', mode: 'parked' }], attended: [] })
    await settle()
    expect(placer.guardModal(1n)).toBe(false)
    placer.setLayout({ placements: [{ id: '1', mode: 'parked' }], attended: [], modal: true })
    expect(placer.guardModal(99n)).toBe(false)
  })
})

describe('Placer (current behaviour)', () => {
  it('a live slot owns the window to the app and moves it over the slot', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({ placements: [{ id: '1', mode: 'live', rect: { x: 10, y: 40, width: 500, height: 300 } }], attended: [] })
    await settle()
    expect(log).toContain(`owner 1 ${APP}`)
    expect(log).toContain('pos 1 after=0 10,40,500,300')
    expect(placer.isLive('1')).toBe(true)
  })

  it('a parked window is not owned and sits right below the app window', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({ placements: [{ id: '1', mode: 'parked' }], attended: [] })
    await settle()
    expect(log.some((l) => l.startsWith(`pos 1 after=${APP}`))).toBe(true)
    expect(placer.isLive('1')).toBe(false)
  })

  it('does not move a window again for an unchanged layout', async () => {
    const { placer, settle } = setup(['1'])
    const layout = { placements: [{ id: '1', mode: 'live' as const, rect: { x: 10, y: 40, width: 500, height: 300 } }], attended: [] }
    placer.setLayout(layout)
    await settle()
    const moves = log.filter((l) => l.startsWith('pos 1')).length
    placer.setLayout(layout)
    await settle()
    expect(log.filter((l) => l.startsWith('pos 1')).length).toBe(moves)
  })
})

describe('Placer: a dialog is open', () => {
  it('parks every window and draws no previews, whatever slots the layout still lists', async () => {
    const { placer, settle } = setup(['1', '2'])
    placer.setLayout({ placements: [{ id: '1', mode: 'live', rect: { x: 10, y: 40, width: 500, height: 300 } }], attended: [] })
    await settle()
    log.length = 0
    placer.setLayout({
      placements: [
        { id: '1', mode: 'live', rect: { x: 10, y: 40, width: 500, height: 300 } },
        { id: '2', mode: 'thumb', rect: { x: 600, y: 40, width: 200, height: 100 } }
      ],
      attended: [],
      modal: true
    })
    await settle()
    expect(placer.isLive('1')).toBe(false)
    expect(log).toContain(`owner 1 0`)
    expect(log.filter((l) => l.startsWith('thumb'))).toEqual([])
    expect(log.filter((l) => l.startsWith('pos')).every((l) => l.includes(`after=${APP}`))).toBe(true)
  })
})

describe('Placer: the big window mirrored in the side list (focus view)', () => {
  it('a live window with a mirror slot is placed over its slot AND drawn as a preview in the list', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({
      placements: [
        { id: '1', mode: 'live', rect: { x: 10, y: 40, width: 800, height: 500 }, mirror: { x: 900, y: 60, width: 200, height: 125 }, clip: { x: 880, y: 40, width: 300, height: 700 } }
      ],
      attended: []
    })
    await settle()
    expect(log.some((l) => l.startsWith('pos 1') && l.includes('10,40,800,500'))).toBe(true)
    expect(log.some((l) => l.startsWith('thumb 1#mirror'))).toBe(true)
  })
  it('without a mirror slot no preview is drawn for the live window', async () => {
    const { placer, settle } = setup(['1'])
    placer.setLayout({ placements: [{ id: '1', mode: 'live', rect: { x: 10, y: 40, width: 800, height: 500 } }], attended: [] })
    await settle()
    expect(log.some((l) => l.startsWith('thumb'))).toBe(false)
  })
})
