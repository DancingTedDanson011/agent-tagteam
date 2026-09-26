import { describe, expect, it } from 'vitest'
import { WindowOps } from './ops'

const tick = () => new Promise((r) => setTimeout(r, 0))

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('WindowOps', () => {
  it('runs jobs for the same window strictly one after another', async () => {
    const ops = new WindowOps()
    const log: string[] = []
    const gate = deferred()
    const a = ops.run('w', async () => {
      log.push('a-start')
      await gate.promise
      log.push('a-end')
    })
    const b = ops.run('w', async () => void log.push('b'))
    await tick()
    expect(log).toEqual(['a-start'])
    gate.resolve()
    await Promise.all([a, b])
    expect(log).toEqual(['a-start', 'a-end', 'b'])
  })

  it('does not let a stuck window delay other windows', async () => {
    const ops = new WindowOps()
    const stuck = deferred()
    void ops.run('hung', () => stuck.promise)
    let other = false
    await ops.run('ok', async () => void (other = true))
    expect(other).toBe(true)
    expect(ops.pending('hung')).toBe(true)
    stuck.resolve()
  })

  it('keeps going after a failing job', async () => {
    const ops = new WindowOps()
    await expect(ops.run('w', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(ops.run('w', async () => 7)).resolves.toBe(7)
  })

  it('coalesces position updates while one is in flight: only the latest runs', async () => {
    const ops = new WindowOps()
    const gate = deferred()
    const ran: number[] = []
    void ops.run('w', () => gate.promise)
    for (let i = 1; i <= 5; i++) ops.coalesce('w', async () => void ran.push(i))
    gate.resolve()
    await tick()
    await ops.idle('w')
    expect(ran).toEqual([5])
  })

  it('forgets a window once its queue is empty', async () => {
    const ops = new WindowOps()
    await ops.run('w', async () => undefined)
    await tick()
    expect(ops.pending('w')).toBe(false)
  })
})
