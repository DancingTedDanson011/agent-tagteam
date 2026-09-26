// DragWatcher: the polling adapter between the real mouse/foreground state and the drag machine.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const APP = 7n
const input = { button: false, fg: 0n as bigint, rect: { left: 0, top: 0, right: 800, bottom: 500 }, cursor: { x: 5000, y: 5000 }, topAt: APP as bigint | null }

vi.mock('electron', () => ({ screen: { dipToScreenRect: (_w: unknown, r: object) => r } }))
vi.mock('../win32/api', () => ({
  GetSystemMetrics: () => 0,
  GetAsyncKeyState: () => (input.button ? -32768 : 0),
  GetForegroundWindow: () => (input.fg === 0n ? null : input.fg)
}))
vi.mock('../win32/windows', () => ({
  getRect: () => ({ ...input.rect }),
  cursorPos: () => ({ ...input.cursor }),
  windowAt: () => input.topAt
}))

const { DragWatcher } = await import('./dragwatch')

const app = {
  isDestroyed: () => false,
  isVisible: () => true,
  isMinimized: () => false,
  getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
  getNativeWindowHandle: () => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(APP)
    return b
  }
}

function watcher(opts: { eligible: boolean; captured: boolean }) {
  const drops: Array<[bigint, string]> = []
  const states: object[] = []
  const w = new DragWatcher({
    appWindow: app as never, // only the four methods above are used
    eligible: () => opts.eligible,
    captured: () => opts.captured,
    rival: (h) => h === 99n,
    onState: (s) => void states.push(s),
    onDrop: (h, kind) => void drops.push([h, kind])
  })
  return { w, drops, states }
}

async function drag(from: { x: number; y: number }, to: { x: number; y: number }) {
  input.fg = 42n
  input.button = true
  input.cursor = from
  await vi.advanceTimersByTimeAsync(60)
  input.rect = { left: 300, top: 200, right: 1100, bottom: 700 } // the window moved with the mouse
  input.cursor = to
  await vi.advanceTimersByTimeAsync(60)
  await vi.advanceTimersByTimeAsync(60)
  input.button = false
  await vi.advanceTimersByTimeAsync(60)
}

beforeEach(() => {
  vi.useFakeTimers()
  input.rect = { left: 0, top: 0, right: 800, bottom: 500 }
  input.topAt = APP
})
afterEach(() => vi.useRealTimers())

describe('DragWatcher', () => {
  it('drops an eligible console window released over the app as a capture', async () => {
    const { w, drops } = watcher({ eligible: true, captured: false })
    w.start()
    await drag({ x: 5000, y: 5000 }, { x: 400, y: 300 })
    w.stop()
    expect(drops).toEqual([[42n, 'capture']])
  })

  it('does nothing for a window that is neither eligible nor captured', async () => {
    const { w, drops } = watcher({ eligible: false, captured: false })
    w.start()
    await drag({ x: 5000, y: 5000 }, { x: 400, y: 300 })
    w.stop()
    expect(drops).toEqual([])
  })

  it('drops a captured window released over the app as a reseat', async () => {
    const { w, drops } = watcher({ eligible: false, captured: true })
    w.start()
    await drag({ x: 5000, y: 5000 }, { x: 400, y: 300 })
    w.stop()
    expect(drops).toEqual([[42n, 'reseat']])
  })

  it('ignores a drop where another window (e.g. a second organizer) covers the app at the cursor', async () => {
    const { w, drops } = watcher({ eligible: true, captured: false })
    input.topAt = 99n // the other instance's window lies on top of this one at the cursor
    w.start()
    await drag({ x: 5000, y: 5000 }, { x: 400, y: 300 })
    w.stop()
    expect(drops).toEqual([])
  })

  it('still accepts a drop over one of its own live terminals', async () => {
    const { w, drops } = watcher({ eligible: true, captured: false })
    input.topAt = 55n
    const own = new DragWatcher({
      appWindow: app as never,
      eligible: () => true,
      captured: (h) => h === 55n,
      rival: (h) => h === 99n,
      onState: () => undefined,
      onDrop: (h, kind) => void drops.push([h, kind])
    })
    own.start()
    await drag({ x: 5000, y: 5000 }, { x: 400, y: 300 })
    own.stop()
    w.stop()
    expect(drops).toEqual([[42n, 'capture']])
  })
})
