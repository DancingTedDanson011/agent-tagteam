import { expect, it } from 'vitest'
import { parseGuardianTodo } from './codeGuardian'

it('maps explicit paused/foreign/dropped statuses without resurrecting them as open tasks', () => {
  const result = parseGuardianTodo('- [ ] T-010 · laeuft · Active\n- [ ] T-011 · blockiert (dependency) · Blocked\n- [ ] T-012 · vertagt (owner) · Later\n- [x] T-013 · verworfen · Dropped\n- [ ] T-014 · fremd (other-project) · Elsewhere', '/project')
  expect(result.tasks.map(task => task.state)).toEqual(['in_progress', 'open', 'dropped', 'dropped', 'dropped'])
  expect(result.tasks[1].sourceState).toBe('blockiert (dependency)')
})
it('reads effect, evidence, and creation/closure metadata from the structured grammar', () => {
  const result = parseGuardianTodo('- [x] T-020 · erledigt · Finished\n      Wirkung: V — owner request\n      Beleg: executed check\n      Angelegt: original timestamp\n      Geschlossen: closing timestamp', '/project')
  expect(result.tasks[0]).toMatchObject({ metadata: { Wirkung: 'V — owner request', Beleg: 'executed check', Angelegt: 'original timestamp', Geschlossen: 'closing timestamp' } })
})
