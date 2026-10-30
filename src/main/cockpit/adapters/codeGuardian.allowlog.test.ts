import { expect, it } from 'vitest'
import { parseAllowLog } from './codeGuardian'

it('keeps malformed records visible and masks credential syntax within command excerpts', () => {
  const result = parseAllowLog('bad row\n2026-10-30T08:00:00Z\tSECRET\tdeny\t/project\techo {"token":"hidden-value"}\tsecret detected')
  expect(result[0].kind).toBe('invalid')
  expect(result[1].kind).toBe('SECRET:deny')
  expect(result[1].raw).not.toContain('hidden-value')
})
