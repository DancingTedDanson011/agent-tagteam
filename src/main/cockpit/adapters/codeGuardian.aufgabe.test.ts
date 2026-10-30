import { expect, it } from 'vitest'
import { parseGuardianTask } from './codeGuardian'

it('matches exact header fields and keeps later section checkboxes outside the plan', () => {
  const input = 'NichtZiel: decoy\ninline Ziel: decoy\nZiel: Actual goal\nSitzung: sid\n## Plan\n- [x] done\n## Notes\n- [ ] not part of plan'
  expect(parseGuardianTask(input, '/project', 'trace')).toMatchObject({ title: 'Actual goal', sessionId: 'sid', state: 'done' })
  expect(parseGuardianTask('NichtZiel: decoy\ninline Ziel: decoy', '/project', 'fallback')).toMatchObject({ title: 'fallback', sessionId: null })
})

it('uses the explicit session header and only the plan section for task progress', () => {
  const result = parseGuardianTask('Ziel: Accepted work\nSitzung: real-session\n## Plan\n- [x] finished\n## Zusagen\n- [ ] separate acceptance', '/project', 'trace-a')
  expect(result).toMatchObject({ sessionId: 'real-session', state: 'done', sourceRef: 'trace:trace-a' })
})
