import { describe, expect, it } from 'vitest'
import type { JournalEntry } from './journal'
import { restoreEntry, type RestoreApi } from './restore'

const base: JournalEntry = {
  hwnd: '100',
  pid: 42,
  startTime: '999',
  className: 'ConsoleWindowClass',
  style: 0x14ef0000,
  exStyle: 0xc0110,
  placement: {
    length: 44,
    flags: 0,
    showCmd: 1,
    ptMinPosition: { x: -1, y: -1 },
    ptMaxPosition: { x: -1, y: -1 },
    rcNormalPosition: { left: 10, top: 20, right: 810, bottom: 520 }
  }
}

function fakeApi(opts: { exists?: boolean; pid?: number; start?: string | null; className?: string } = {}) {
  const calls: string[] = []
  const api: RestoreApi = {
    isWindow: () => opts.exists ?? true,
    getPid: () => opts.pid ?? 42,
    processStartTime: () => (opts.start === undefined ? '999' : opts.start),
    getClassName: () => opts.className ?? 'ConsoleWindowClass',
    clearOwner: () => void calls.push('owner:0'),
    setStyle: (_h, s) => void calls.push(`style:${s.toString(16)}`),
    setExStyle: (_h, s) => void calls.push(`ex:${s.toString(16)}`),
    frameChanged: () => void calls.push('frame'),
    setPlacement: (_h, wp) => {
      calls.push(`placement:${wp.showCmd}:${wp.rcNormalPosition.left}`)
      return true
    }
  }
  return { api, calls }
}

describe('restoreEntry', () => {
  it('detaches from the app window, then restores style, ex-style, frame and placement', async () => {
    const { api, calls } = fakeApi()
    expect(await restoreEntry(base, api)).toBe('restored')
    expect(calls).toEqual(['owner:0', 'style:14ef0000', 'ex:c0110', 'frame', 'placement:4:10'])
  })

  it('shows a normal window without stealing focus (SW_SHOWNORMAL -> SW_SHOWNOACTIVATE)', async () => {
    const { api, calls } = fakeApi()
    await restoreEntry(base, api)
    expect(calls.at(-1)).toBe('placement:4:10')
  })

  it('keeps a maximized or minimized show state', async () => {
    const { api, calls } = fakeApi()
    await restoreEntry({ ...base, placement: { ...base.placement, showCmd: 3 } }, api)
    expect(calls.at(-1)).toBe('placement:3:10')
  })

  it('does nothing when the window no longer exists', async () => {
    const { api, calls } = fakeApi({ exists: false })
    expect(await restoreEntry(base, api)).toBe('gone')
    expect(calls).toEqual([])
  })

  it('refuses a reused HWND that now belongs to another process', async () => {
    const { api, calls } = fakeApi({ pid: 77 })
    expect(await restoreEntry(base, api)).toBe('mismatch')
    expect(calls).toEqual([])
  })

  it('refuses when the same PID was reused by a newer process', async () => {
    const { api, calls } = fakeApi({ start: '1234' })
    expect(await restoreEntry(base, api)).toBe('mismatch')
    expect(calls).toEqual([])
  })

  it('refuses when the window class changed', async () => {
    const { api, calls } = fakeApi({ className: 'Notepad' })
    expect(await restoreEntry(base, api)).toBe('mismatch')
    expect(calls).toEqual([])
  })

  it('restores when the start time could not be read at capture time', async () => {
    const { api } = fakeApi()
    expect(await restoreEntry({ ...base, startTime: null }, api)).toBe('restored')
  })
})

describe('restoreEntry with asynchronous window calls', () => {
  it('waits for each step before the next one (order is preserved across worker threads)', async () => {
    const calls: string[] = []
    const later = (label: string, ms: number) => () =>
      new Promise<void>((r) => setTimeout(() => (calls.push(label), r()), ms))
    const api: RestoreApi = {
      isWindow: () => true,
      getPid: () => 42,
      processStartTime: () => '999',
      getClassName: () => 'ConsoleWindowClass',
      clearOwner: later('owner', 30),
      setStyle: later('style', 20),
      setExStyle: later('ex', 10),
      frameChanged: later('frame', 5),
      setPlacement: async () => (calls.push('placement'), true)
    }
    expect(await restoreEntry(base, api)).toBe('restored')
    expect(calls).toEqual(['owner', 'style', 'ex', 'frame', 'placement'])
  })

  it('reports failed when a window call throws', async () => {
    const { api } = fakeApi()
    api.setStyle = async () => Promise.reject(new Error('access denied'))
    expect(await restoreEntry(base, api)).toBe('failed')
  })
})

describe('restoreEntry with a broken entry', () => {
  it('reports failed instead of throwing when the hwnd is not a number', async () => {
    const { api, calls } = fakeApi()
    expect(await restoreEntry({ ...base, hwnd: 'nope' }, api)).toBe('failed')
    expect(calls).toEqual([])
  })
})
