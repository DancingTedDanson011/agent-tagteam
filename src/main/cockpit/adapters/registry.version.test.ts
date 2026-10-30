import { expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parseSessionRecord } from './registry'

it('marks an unverified version per session without dropping it', () => {
  const result = parseSessionRecord({ pid: 1, sessionId: 'future', cwd: '/project', version: '99.1.1', status: 'busy' }, ['2.1.301'])
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.session).toMatchObject({ versionSupported: false, state: 'busy', version: '99.1.1' })
})
it('preserves observed numeric session timestamps instead of making old sessions look new', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/registry-2.1.312.observed.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
  expect(typeof fixture.record.startedAt).toBe('number')
  expect(typeof fixture.record.updatedAt).toBe('number')
  const result = parseSessionRecord(fixture.record, ['2.1.312'], '2099-01-01T00:00:00.000Z')
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.session.startedAt).toBe(new Date(fixture.record.startedAt).toISOString())
    expect(result.session.updatedAt).toBe(new Date(fixture.record.updatedAt).toISOString())
  }
})
it('supports the actual anonymized live registry shape verified during implementation', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/registry-2.1.312.observed.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''))
  expect(fixture.provenance).toContain('Real local Claude registry')
  const result = parseSessionRecord(fixture.record)
  expect(result.ok).toBe(true)
  if (result.ok) {
    expect(result.session.versionSupported).toBe(true)
    expect(result.session.procStart).toBe(fixture.record.procStart)
    expect(result.session.cwd).toBe('C:\\fixture\\project')
  }
})
