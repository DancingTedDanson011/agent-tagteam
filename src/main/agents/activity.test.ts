import { describe, expect, it } from 'vitest'
import { AgentActivity, type Observed } from './activity'

// One tick per second; `screen` is the masked screen hash, `title` the terminal title.
function run(frames: Array<Partial<Observed>>, attended = false) {
  const act = new AgentActivity()
  let t = 0
  const out: Array<{ activity: string; badge: boolean }> = []
  for (const f of frames) {
    t += 1000
    act.tick('a1', { now: t, screen: f.screen ?? 'same', title: f.title ?? '' }, attended)
    out.push(act.info('a1'))
  }
  return { act, out }
}

describe('AgentActivity', () => {
  it('output that keeps changing is work; when it goes quiet the tile waits for you (badge)', () => {
    const changing = Array.from({ length: 4 }, (_, i) => ({ screen: `s${i}` }))
    const quiet = Array.from({ length: 6 }, () => ({ screen: 's3' }))
    const { out } = run([...changing, ...quiet])
    expect(out[2].activity).toBe('working')
    expect(out[out.length - 1]).toEqual({ activity: 'waiting', badge: true })
  })

  it('the Claude title is exact: ✳ after a spinner title means done at once', () => {
    const { out } = run([{ title: '⠋ Claude Code' }, { title: '⠙ Claude Code' }, { title: '✳ Claude Code' }])
    expect(out[0].activity).toBe('working')
    expect(out[2]).toEqual({ activity: 'waiting', badge: true })
  })

  it('no badge for the tile the user is looking at', () => {
    const { out } = run([{ title: '⠋ x' }, { title: '✳ x' }], true)
    expect(out[1].badge).toBe(false)
  })

  it('clearBadge and forget', () => {
    const { act } = run([{ title: '⠋ x' }, { title: '✳ x' }])
    act.clearBadge('a1')
    expect(act.info('a1').badge).toBe(false)
    act.forget('a1')
    expect(act.info('a1')).toEqual({ activity: 'idle', badge: false })
  })
})
