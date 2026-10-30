import { describe, expect, it } from 'vitest'
import { parseGuardianTodo, parseGuardianTask, parseCellContract, parseGateSignal, parseAllowLog } from './codeGuardian'
import { digest } from './common'

describe('read-only guardian artifacts', () => {
  it('preserves nonempty titles, legacy references, metadata and decisions', () => {
    const result = parseGuardianTodo('- [ ] T-007 · entscheidung (Which approach?) ·  Choose work  \t\n      Wirkung: V — request\n- [x]  Completed work  ', '/project')
    expect(result.tasks[1].sourceRef).toBe(`legacy:${digest('Completed work  ')}:0`)
    expect(result.tasks.map(task => task.title)).toEqual(['Choose work  \t', 'Completed work  '])
    expect(result.tasks[0].metadata).toEqual({ Wirkung: 'V — request' })
    expect(result.waiting[0].summary).toContain('Which approach?')
  })
  it.each(['', '    ', '\t \t', '\u0000\u0007\u001f', '\u202e\u2067'])('ignores an empty sanitized checkbox title %j without rebinding its metadata', (title) => {
    const content = `- [ ] First valid task\n      Wirkung: V — first task\n- [ ] ${title}\n      Wirkung: V — ignored checkbox\n      Beleg: must stay unbound\n- [x] Last valid task\n      Wirkung: V — last task`
    const result = parseGuardianTodo(content, '/project')
    expect(result.tasks.map(task => task.title)).toEqual(['First valid task', 'Last valid task'])
    expect(result.tasks.map(task => task.metadata)).toEqual([{ Wirkung: 'V — first task' }, { Wirkung: 'V — last task' }])
    expect(result.waiting).toEqual([])
    expect(result.raw).toContain('Wirkung: V — ignored checkbox')
    expect(result.raw).toContain('Beleg: must stay unbound')
  })
  it('does not create an owner decision from a sanitized empty task title', () => {
    const result = parseGuardianTodo('- [ ] T-007 · entscheidung (Which approach?) · \u0000\u0007', '/project')
    expect(result.tasks).toEqual([])
    expect(result.waiting).toEqual([])
    expect(result.raw).toContain('entscheidung (Which approach?)')
  })
  it('preserves current states, legacy items and unknown lines without losing decisions', () => {
    const result = parseGuardianTodo('- [ ] T-007 · entscheidung (Which approach?) · Choose work\n      Wirkung: V — request\n- [x] legacy complete\n- [ ] old open\nUnrecognized future metadata', '/project')
    expect(result.tasks.map(t => t.state)).toEqual(['open', 'done', 'open'])
    expect(result.tasks[0].sourceState).toContain('entscheidung')
    expect(result.waiting[0].summary).toContain('Which approach?')
    expect(result.raw).toContain('Unrecognized future metadata')
  })
  it('reads task identity and contract checklist sections', () => {
    const task = parseGuardianTask('Ziel: Implement\nSitzung: sid\nTodo: T-007\n## Plan\n- [x] verified\n- [ ] pending', '/project', 'trace')
    expect(task).toMatchObject({ sessionId: 'sid', title: 'Implement', state: 'in_progress' })
    const cell = parseCellContract('## Zusagen\n- [x] proven\n- [ ] pending\n## Angenommen\n- [ ] needs check', 'cell')
    expect(cell.sections).toEqual([{ name: 'Zusagen', total: 2, open: 1 }, { name: 'Angenommen', total: 1, open: 1 }])
  })
  it('parses gate state and allow-log records without exposing commands secrets', () => {
    expect(parseGateSignal('sid.DEPLOY.fragt')).toMatchObject({ sessionId: 'sid', gate: 'DEPLOY', stage: 'fragt' })
    expect(parseGateSignal('sid.FUTURE.fragt')).toBeNull()
    const entries = parseAllowLog('2026-10-30T08:00:00Z\tDEPLOY\task\t/project\techo token=private-value\tapproval needed')
    expect(entries[0]).toMatchObject({ cwd: '/project', kind: 'DEPLOY:ask' })
    expect(JSON.stringify(entries)).not.toContain('private-value')
  })
})
