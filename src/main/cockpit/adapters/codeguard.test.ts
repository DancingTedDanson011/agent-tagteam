import { expect, it } from 'vitest'
import { parseCodeguardRecord } from './codeguard'

it('distinguishes hard/shadow from unknown modes and masks nested credentials', () => {
  expect(parseCodeguardRecord({ mode: 'hard', event: 'deploy', cwd: '/project' }).kind).toBe('hard:deploy')
  expect(parseCodeguardRecord({ mode: 'shadow', event: 'deploy' }).kind).toBe('shadow:deploy')
  const future = parseCodeguardRecord({ mode: 'future', event: 'new-event', credentials: { token: 'private' }, future: 'visible' })
  expect(future.kind).toBe('unknown:new-event')
  expect(future.raw).toContain('visible')
  expect(future.raw).not.toContain('private')
  expect(parseCodeguardRecord('{').kind).toBe('invalid')
})
