import { describe, expect, it } from 'vitest'
import { initialActivity, parseTitleHint, step, type ActivityConfig, type ActivityState } from './activity'

const cfg: ActivityConfig = { changeThreshold: 2, quietMs: 4000, minWorkMs: 1500 }

function run(ticks: Array<{ t: number; changed?: number | null; title?: 'working' | 'idle' | null }>) {
  let state: ActivityState = initialActivity()
  const events: number[] = []
  for (const k of ticks) {
    const r = step(state, { now: k.t, changedBlocks: k.changed ?? 0, titleHint: k.title ?? null }, cfg)
    state = r.state
    if (r.becameWaiting) events.push(k.t)
  }
  return { state, events }
}

describe('parseTitleHint', () => {
  it('reads Claude Code title glyphs', () => {
    expect(parseTitleHint('✳ Schmerz-Achsen für Geschäftsideen')).toBe('idle')
    expect(parseTitleHint('◐ Windows CLI session organizer')).toBe('working')
    expect(parseTitleHint('◑ AI spawning')).toBe('working')
    expect(parseTitleHint('⠋ building')).toBe('working')
  })
  it('returns null for ordinary titles', () => {
    expect(parseTitleHint('cmd.exe - ping  -n 7 127.0.0.1')).toBeNull()
    expect(parseTitleHint('')).toBeNull()
  })
})

describe('activity state machine (pixel signal)', () => {
  it('ignores a blinking cursor (changes at or below threshold)', () => {
    const ticks = Array.from({ length: 20 }, (_, i) => ({ t: i * 1000, changed: i % 2 }))
    const { state, events } = run(ticks)
    expect(state.activity).toBe('idle')
    expect(events).toEqual([])
  })

  it('does not fire while output keeps streaming', () => {
    const ticks = Array.from({ length: 30 }, (_, i) => ({ t: i * 1000, changed: 40 }))
    const { state, events } = run(ticks)
    expect(state.activity).toBe('working')
    expect(events).toEqual([])
  })

  it('fires exactly once when work stops for the quiet period', () => {
    const ticks = [
      ...Array.from({ length: 6 }, (_, i) => ({ t: i * 1000, changed: 50 })),
      ...Array.from({ length: 12 }, (_, i) => ({ t: 6000 + i * 1000, changed: 0 }))
    ]
    const { state, events } = run(ticks)
    expect(events).toEqual([9000]) // last change at 5000 + quiet 4000
    expect(state.activity).toBe('waiting')
  })

  it('treats a single short burst as noise, not as finished work', () => {
    const ticks = [
      { t: 0, changed: 0 },
      { t: 1000, changed: 30 },
      ...Array.from({ length: 10 }, (_, i) => ({ t: 2000 + i * 1000, changed: 0 }))
    ]
    const { state, events } = run(ticks)
    expect(events).toEqual([])
    expect(state.activity).toBe('idle')
  })

  it('treats an unknown frame (null) as no change', () => {
    const ticks = [
      ...Array.from({ length: 4 }, (_, i) => ({ t: i * 1000, changed: 50 })),
      { t: 4000, changed: null },
      { t: 5000, changed: null }
    ]
    expect(run(ticks).state.activity).toBe('working')
  })

  it('fires again for a second work phase', () => {
    const phase = (start: number) => [
      ...Array.from({ length: 3 }, (_, i) => ({ t: start + i * 1000, changed: 50 })),
      ...Array.from({ length: 6 }, (_, i) => ({ t: start + 3000 + i * 1000, changed: 0 }))
    ]
    const { events } = run([...phase(0), ...phase(20000)])
    expect(events).toEqual([6000, 26000])
  })
})

describe('activity state machine (title signal)', () => {
  it('fires on the working -> idle transition only', () => {
    const { state, events } = run([
      { t: 0, title: 'idle' },
      { t: 1000, title: 'working', changed: 90 },
      { t: 2000, title: 'working', changed: 90 },
      { t: 3000, title: 'idle' },
      { t: 4000, title: 'idle' }
    ])
    expect(events).toEqual([3000])
    expect(state.activity).toBe('waiting')
  })

  it('never fires for a session that was idle from the start', () => {
    const { events } = run(Array.from({ length: 10 }, (_, i) => ({ t: i * 1000, title: 'idle' as const, changed: 20 })))
    expect(events).toEqual([])
  })

  it('title idle overrides pixel changes (e.g. a redraw after the agent stopped)', () => {
    const { state } = run([
      { t: 0, title: 'working' },
      { t: 1000, title: 'idle', changed: 200 }
    ])
    expect(state.activity).toBe('waiting')
  })
})
