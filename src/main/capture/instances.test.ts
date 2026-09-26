import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claimedByOtherInstances, instanceJournalPath, journalsOfDeadInstances, listJournals } from './instances'

const dir = () => mkdtempSync(join(tmpdir(), 'clio-inst-'))
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

// pid 100 (start "a") and pid 200 (start "b") are alive; everything else is dead
const isAlive = (pid: number, start: string) => (pid === 100 && start === 'a') || (pid === 200 && start === 'b')
const alive = { isAlive, legacyAlive: false }

describe('instance journals', () => {
  it('names a journal after its process id and start time', () => {
    expect(instanceJournalPath('C:\\d', 100, 'a')).toBe(join('C:\\d', 'restore-journal-100-a.json'))
  })

  it('lists instance journals and the legacy single-instance journal, nothing else', () => {
    const d = dir()
    writeJournal(join(d, 'restore-journal-100-a.json'), [])
    writeJournal(join(d, 'restore-journal.json'), [])
    writeFileSync(join(d, 'workspaces.json'), '[]')
    writeFileSync(join(d, 'restore-journal-100-a.json.tmp'), '{}')
    expect(listJournals(d).map((j) => j.file.slice(d.length + 1)).sort()).toEqual(['restore-journal-100-a.json', 'restore-journal.json'])
  })

  it('picks journals of dead instances (and the legacy one) for recovery, never a live one', () => {
    const d = dir()
    writeJournal(join(d, 'restore-journal-100-a.json'), ['1']) // alive
    writeJournal(join(d, 'restore-journal-100-z.json'), ['2']) // same pid, other start time: a reused PID -> dead
    writeJournal(join(d, 'restore-journal-300-c.json'), ['3']) // dead
    writeJournal(join(d, 'restore-journal.json'), ['4']) // legacy
    const self = join(d, 'restore-journal-200-b.json')
    expect(journalsOfDeadInstances(d, self, alive).map((f) => f.slice(d.length + 1)).sort()).toEqual([
      'restore-journal-100-z.json',
      'restore-journal-300-c.json',
      'restore-journal.json'
    ])
  })

  it('claims the windows of every other journal, live or dead (a dead one is not restored yet)', () => {
    const d = dir()
    writeJournal(join(d, 'restore-journal-100-a.json'), ['11', '12']) // other, alive
    writeJournal(join(d, 'restore-journal-300-c.json'), ['13']) // other, dead: its watchdog may still be restoring
    const self = join(d, 'restore-journal-200-b.json')
    writeJournal(self, ['14']) // own windows are not "claimed elsewhere"
    expect([...claimedByOtherInstances(d, self)].sort()).toEqual(['11', '12', '13'])
  })

  it('a legacy journal whose (older-version) owner still runs is live: not recovered, its windows are claimed', () => {
    const d = dir()
    writeJournal(join(d, 'restore-journal.json'), ['21'])
    writeJournal(join(d, 'restore-journal-300-c.json'), ['22']) // dead
    const self = join(d, 'restore-journal-200-b.json')
    const legacyRuns = { isAlive, legacyAlive: true }
    expect(journalsOfDeadInstances(d, self, legacyRuns).map((f) => f.slice(d.length + 1))).toEqual(['restore-journal-300-c.json'])
    expect([...claimedByOtherInstances(d, self)].sort()).toEqual(['21', '22'])
  })

  it('an empty or missing directory yields nothing', () => {
    const d = join(dir(), 'missing')
    expect(existsSync(d)).toBe(false)
    expect(listJournals(d)).toEqual([])
    expect(claimedByOtherInstances(d, join(d, 'x.json')).size).toBe(0)
  })
})
