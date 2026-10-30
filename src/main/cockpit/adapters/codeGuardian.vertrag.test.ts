import { expect, it } from 'vitest'
import { parseCellContract } from './codeGuardian'

it('keeps promises, exclusions, and assumptions as separate checklist sections', () => {
  const result = parseCellContract('## Zusagen\n- [x] promise\n## Ausdrücklich NICHT zugesichert\n- [ ] exclusion\n## Angenommen\n- [x] checked assumption\n- [ ] unverified assumption', 'cell-a')
  expect(result.sections).toEqual([{ name: 'Zusagen', total: 1, open: 0 }, { name: 'Ausdrücklich NICHT zugesichert', total: 1, open: 1 }, { name: 'Angenommen', total: 2, open: 1 }])
})
