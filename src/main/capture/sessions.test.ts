// Regression tests for the cold-review findings on SessionManager / recoverOrphans.
// Win32 is mocked; the Journal is real.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG = 0x14cf0000
const STRIPPED = ORIG & ~(0x00c00000 | 0x00040000)
const state = { style: ORIG, adoptThrows: false, placementOk: true, hung: new Set<string>(), restores: 0 }
let gate: { promise: Promise<void>; resolve: () => void }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = () => new Promise((r) => setTimeout(r, 5))

vi.mock('../win32/windows', () => ({
  isWindow: () => true,
  rootOf: (h: bigint) => h,
  isConsoleWindow: () => true,
  isVisible: () => true,
  getPid: () => 42,
  isProcessElevated: () => false,
  processImageName: () => 'cmd.exe',
  getTitle: () => 't'
}))
vi.mock('../win32/async', () => ({ isHung: (h: bigint) => state.hung.has(h.toString()) }))
vi.mock('./live', () => ({
  snapshotOriginal: (h: bigint) => ({
    hwnd: h.toString(),
    pid: 42,
    startTime: '9',
    className: 'ConsoleWindowClass',
    style: state.style,
    exStyle: 0,
    placement: { length: 44, flags: 0, showCmd: 1, ptMinPosition: { x: 0, y: 0 }, ptMaxPosition: { x: 0, y: 0 }, rcNormalPosition: { left: 0, top: 0, right: 1, bottom: 1 } }
  }),
  adoptWindow: async () => {
    state.style = STRIPPED
    if (state.adoptThrows) throw new Error('worker rejected')
  },
  liveRestoreApi: {
    isWindow: () => true,
    getPid: () => 42,
    processStartTime: () => '9',
    getClassName: () => 'ConsoleWindowClass',
    clearOwner: async () => {
      state.restores++
      return gate.promise
    },
    setStyle: async (_h: bigint, s: number) => {
      state.style = s
    },
    setExStyle: async () => undefined,
    frameChanged: async () => undefined,
    setPlacement: async () => state.placementOk
  },
  setOwner: async () => undefined
}))

const { Journal } = await import('./journal')
const { SessionManager, recoverOrphans } = await import('./sessions')

const journalFile = () => join(mkdtempSync(join(tmpdir(), 'clio-sess-')), 'journal.json')
const manager = (j: InstanceType<typeof Journal>) => new SessionManager(j, { ownWindows: () => [], selfElevated: false })

beforeEach(() => {
  state.style = ORIG
  state.adoptThrows = false
  state.placementOk = true
  state.hung = new Set()
  state.restores = 0
  gate = deferred()
})

describe('SessionManager', () => {
  it('refuses to capture a window whose release is still in flight (no stranded frameless window)', async () => {
    const j = new Journal(journalFile())
    const m = manager(j)
    expect((await m.capture(100n)).ok).toBe(true)

    const releasing = m.release('100')
    await tick()
    expect(await m.capture(100n)).toEqual({ ok: false, reason: 'already' })

    gate.resolve()
    expect(await releasing).toBe('restored')
    expect(state.style).toBe(ORIG)
    expect(j.entries()).toEqual([])
    expect((await m.capture(100n)).ok, 'capturable again once released').toBe(true)
  })

  it('keeps the journal entry when the rollback after a failed adopt could not restore', async () => {
    const j = new Journal(journalFile())
    state.adoptThrows = true
    state.placementOk = false
    gate.resolve()
    expect(await manager(j).capture(100n)).toEqual({ ok: false, reason: 'failed' })
    expect(j.entries().map((e) => e.hwnd), 'watchdog / next start can still retry it').toEqual(['100'])
  })

  it('drops the journal entry when the rollback succeeded', async () => {
    const j = new Journal(journalFile())
    state.adoptThrows = true
    gate.resolve()
    expect(await manager(j).capture(100n)).toEqual({ ok: false, reason: 'failed' })
    expect(j.entries()).toEqual([])
  })
})

describe('SessionManager: a second release while one is in flight', () => {
  it('does not restore again (a late second restore would undo another instance that took the window over)', async () => {
    const j = new Journal(journalFile())
    const m = manager(j)
    expect((await m.capture(100n)).ok).toBe(true)
    const first = m.release('100') // e.g. serving a handover
    await tick()
    const second = m.release('100') // e.g. the user clicks "Freigeben" meanwhile
    const all = m.releaseAll() // or the app closes meanwhile
    gate.resolve()
    expect(await first).toBe('restored')
    await second
    await all
    expect(state.restores).toBe(1)
    expect(j.entries()).toEqual([])
  })
})

describe('SessionManager with several instances', () => {
  it('refuses a window another running instance holds, and touches nothing', async () => {
    const j = new Journal(journalFile())
    gate.resolve()
    const m = new SessionManager(j, { ownWindows: () => [], selfElevated: false, claimedElsewhere: (id) => id === '100' })
    expect(await m.capture(100n)).toEqual({ ok: false, reason: 'other-instance' })
    expect(j.entries()).toEqual([])
    expect(state.style).toBe(ORIG)
    expect((await m.capture(101n)).ok).toBe(true)
  })
})

describe('recoverOrphans', () => {
  it('skips hung windows (they stay journaled) instead of blocking on them', async () => {
    const file = journalFile()
    const j = new Journal(file)
    gate.resolve()
    await manager(j).capture(200n)
    await manager(j).capture(300n)
    state.hung.add('200')
    const outcomes = await recoverOrphans(new Journal(file))
    expect(outcomes.sort()).toEqual(['hung', 'restored'])
    expect(new Journal(file).entries().map((e) => e.hwnd)).toEqual(['200'])
  })
})
