import { expect, it } from 'vitest'
import { parseGateSignal } from './codeGuardian'

it('retains the session identifier and distinguishes waiting, held and checked signals', () => {
  for (const stage of ['fragt', 'angehalten', 'geprueft']) expect(parseGateSignal(`real-session.MIGRATION.${stage}`)).toMatchObject({ sessionId: 'real-session', gate: 'MIGRATION', stage })
  expect(parseGateSignal('../outside.MIGRATION.fragt')).toBeNull()
})
