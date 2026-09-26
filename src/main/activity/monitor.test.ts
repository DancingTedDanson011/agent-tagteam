// Badge ownership: attended sessions never get a badge; an unattended session gets exactly one per phase.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../win32/async', () => ({ isHung: () => false }))
vi.mock('../win32/snapshot', () => ({ snapshotWindow: async () => null }))

const { ActivityMonitor } = await import('./monitor')

type S = { id: string; hwnd: bigint; className: string; processName: string; title: string }

function setup(attended: () => boolean) {
  let t = 0
  const s: S = { id: 'a', hwnd: 1n, className: 'X', processName: 'p', title: '✳ idle' }
  const m = new ActivityMonitor({ sessions: () => [s], isAttended: attended, paused: () => false, now: () => t })
  const at = async (ms: number, title: string) => {
    t = ms
    s.title = title
    await m.tick()
    return m.info('a')
  }
  return { m, at }
}

describe('ActivityMonitor badges', () => {
  it('an unattended agent that finishes gets a badge', async () => {
    const { at } = setup(() => false)
    await at(0, '◐ working')
    expect((await at(1000, '◐ working')).badge).toBe(false)
    expect(await at(2000, '✳ done')).toEqual({ activity: 'waiting', badge: true })
  })

  it('the attended session never gets a badge', async () => {
    const { at } = setup(() => true)
    await at(0, '◐ working')
    expect((await at(1000, '✳ done')).badge).toBe(false)
  })

  it('a badge disappears once the session is attended', async () => {
    let attended = false
    const { at } = setup(() => attended)
    await at(0, '◐ working')
    expect((await at(1000, '✳ done')).badge).toBe(true)
    attended = true
    expect((await at(2000, '✳ done')).badge).toBe(false)
  })

  it('clearBadge removes it explicitly and it does not come back without new work', async () => {
    const { m, at } = setup(() => false)
    await at(0, '◐ working')
    await at(1000, '✳ done')
    m.clearBadge('a')
    expect((await at(2000, '✳ done')).badge).toBe(false)
    expect((await at(3000, '✳ done')).badge).toBe(false)
  })

  it('tick reports whether anything visible changed', async () => {
    const { m } = setup(() => false)
    expect(await m.tick()).toBe(false)
  })
})
