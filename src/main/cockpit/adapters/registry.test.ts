import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseSessionRecord, readRegistry } from './registry'

// Synthetic values; field names follow the registry observed during implementation.
const record = (extra = {}) => ({ pid: 123, sessionId: 'session-a', cwd: 'C:\\project', startedAt: '2026-10-30T08:00:00.000Z', updatedAt: '2026-10-30T08:01:00.000Z', version: '2.1.301', status: 'waiting', waitingFor: 'Approve work', ...extra })
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('registry boundary', () => {
  it('normalizes the observed registry shape and preserves unknown fields without secrets', () => {
    const result = parseSessionRecord(record({ future: 'new value', credentials: { password: 'private' } }), ['2.1.301'])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.session).toMatchObject({ sessionId: 'session-a', cwd: 'C:\\project', state: 'waiting', versionSupported: true })
    expect(result.raw).toContain('new value')
    expect(result.raw).not.toContain('private')
  })
  it('keeps an unknown state visible and refuses malformed identity', () => {
    const result = parseSessionRecord(record({ status: 'future-state' }), ['2.1.301'])
    expect(result.ok && result.session.state).toBe('unknown')
    expect(result.ok && result.session.statusRaw).toBe('future-state')
    expect(parseSessionRecord(record({ cwd: null }), []).ok).toBe(false)
    expect(parseSessionRecord(record({ pid: -1 }), []).ok).toBe(false)
  })
  it('reads only numeric registry json files, reports malformed records, and never opens key files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-registry-')); dirs.push(dir)
    writeFileSync(join(dir, '123.json'), JSON.stringify(record({ futureProperty: 'visible-future-value' })))
    writeFileSync(join(dir, '124.json'), '{')
    writeFileSync(join(dir, '123.key'), 'do-not-read')
    writeFileSync(join(dir, 'other.json'), JSON.stringify(record({ sessionId: 'ignored' })))
    const result = readRegistry(dir, ['2.1.301'])
    expect(result.sessions.map(s => s.sessionId)).toEqual(['session-a'])
    expect(result.events.filter(event => event.kind === 'invalid')).toHaveLength(1)
    expect(result.events.some(event => event.kind === 'session_snapshot' && event.raw.includes('visible-future-value'))).toBe(true)
    expect(JSON.stringify(result)).not.toContain('do-not-read')
  })
})
