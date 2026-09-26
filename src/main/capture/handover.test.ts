import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { awaitRelease, clearHandover, claimKind, handoversFor, requestHandover } from './handover'

const dir = () => mkdtempSync(join(tmpdir(), 'clio-hand-'))
const entry = (hwnd: string) => ({
  hwnd,
  pid: 5,
  startTime: null,
  className: 'X',
  style: 0,
  exStyle: 0,
  placement: { length: 44, flags: 0, showCmd: 1, ptMinPosition: { x: 0, y: 0 }, ptMaxPosition: { x: 0, y: 0 }, rcNormalPosition: { left: 0, top: 0, right: 1, bottom: 1 } }
})
const writeJournal = (file: string, hwnds: string[]) => writeFileSync(file, JSON.stringify({ version: 1, entries: hwnds.map(entry) }))
const alive = (pid: number, start: string) => (pid === 200 && start === 'b') || (pid === 100 && start === 'a')

describe('handover requests', () => {
  it('a request names the window and the instance that wants it; only the holder sees its own', () => {
    const d = dir()
    requestHandover(d, '42', { pid: 200, start: 'b' })
    requestHandover(d, '43', { pid: 200, start: 'b' })
    expect(handoversFor(d, (id) => id === '42', alive)).toEqual(['42'])
    expect(readdirSync(d).filter((f) => f.endsWith('.tmp'))).toEqual([]) // written atomically
  })

  it('ignores malformed names and content, and drops requests of a requester that is gone', () => {
    const d = dir()
    writeFileSync(join(d, 'handover-..\\x.json'.replace('\\', '_')), '{}')
    writeFileSync(join(d, 'handover-7.json'), 'not json')
    writeFileSync(join(d, 'handover-8.json'), JSON.stringify({ pid: 'x', start: 'b' }))
    requestHandover(d, '9', { pid: 300, start: 'c' }) // requester is dead
    expect(handoversFor(d, () => true, alive)).toEqual([])
    expect(existsSync(join(d, 'handover-9.json')), 'stale request removed').toBe(false)
  })

  it('clearHandover removes the request, and is fine when it is already gone', () => {
    const d = dir()
    requestHandover(d, '42', { pid: 200, start: 'b' })
    clearHandover(d, '42')
    clearHandover(d, '42')
    expect(handoversFor(d, () => true, alive)).toEqual([])
  })
})

describe('claimKind', () => {
  it('tells a window of a new-style instance from one of an older single-instance version', () => {
    const d = dir()
    const self = join(d, 'restore-journal-200-b.json')
    writeJournal(join(d, 'restore-journal-100-a.json'), ['11'])
    writeJournal(join(d, 'restore-journal.json'), ['21'])
    writeJournal(self, ['31'])
    writeJournal(join(d, 'restore-journal-300-c.json'), ['41']) // owner gone, window not restored yet
    expect(claimKind(d, self, '11', alive)).toBe('instance')
    expect(claimKind(d, self, '21', alive)).toBe('legacy')
    expect(claimKind(d, self, '41', alive), 'nobody would answer a request').toBe('stale')
    expect(claimKind(d, self, '31', alive)).toBeNull() // own window
    expect(claimKind(d, self, '99', alive)).toBeNull()
  })
})

describe('awaitRelease', () => {
  it('resolves true as soon as the window is no longer claimed', async () => {
    let checks = 0
    expect(await awaitRelease(() => ++checks < 3, 1000, 5)).toBe(true)
    expect(checks).toBe(3)
  })
  it('gives up after the timeout', async () => {
    const t = Date.now()
    expect(await awaitRelease(() => true, 60, 5)).toBe(false)
    expect(Date.now() - t).toBeGreaterThanOrEqual(55)
  })
})
