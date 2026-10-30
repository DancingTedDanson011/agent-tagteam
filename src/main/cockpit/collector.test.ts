import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CockpitCollector } from './collector'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('reconciles registry disappearance, guards spool ownership and waits for persistence acknowledgement', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-collector-')); dirs.push(dir)
  const registryDir = join(dir, 'sessions'); const spoolDir = join(dir, 'spool')
  mkdirSync(registryDir); mkdirSync(spoolDir)
  const registry = join(registryDir, '123.json')
  writeFileSync(registry, JSON.stringify({ pid: 123, sessionId: 'sid', cwd: '/project', version: '2.1.301', status: 'idle' }))
  const file = join(spoolDir, 'cockpit-20261030-abcdefgh.json')
  writeFileSync(file, JSON.stringify({ session_id: 'sid', cwd: '/project', hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode', tool_use_id: 'p1' }))
  const collector = new CockpitCollector({ registryDir, spoolDir, claudeDir: join(dir, 'claude'), guardDir: join(dir, 'guard'), knownVersions: ['2.1.301'] })
  const first = collector.poll()
  expect(first.sessions[0].state).toBe('waiting')
  expect(first.waiting[0].kind).toBe('plan_approval')
  expect(first.spoolToAck).toEqual([file])
  expect(existsSync(file)).toBe(true)
  collector.ackSpool([join(dir, 'outside.json'), file])
  expect(existsSync(file)).toBe(false)
  rmSync(registry)
  expect(collector.poll().sessions[0].state).toBe('ended')
})
it('does not revive a reused PID through a queued hook observation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-collector-')); dirs.push(dir)
  const registryDir = join(dir, 'sessions'); const spoolDir = join(dir, 'spool'); mkdirSync(registryDir); mkdirSync(spoolDir)
  writeFileSync(join(registryDir, '123.json'), JSON.stringify({ pid: 123, procStart: 'opaque-start', sessionId: 'old', cwd: '/project', status: 'busy', updatedAt: '2026-01-01T00:00:00Z' }))
  writeFileSync(join(spoolDir, 'cockpit-20261030-stale.json'), JSON.stringify({ session_id: 'old', cwd: '/project', hook_event_name: 'PreToolUse', tool_name: 'Read' }))
  let seen: unknown
  const result = new CockpitCollector({ registryDir, spoolDir, claudeDir: join(dir, 'claude'), guardDir: join(dir, 'guard'), isProcessAlive: (_pid, start) => { seen = start; return false } }).poll()
  expect(seen).toBe('opaque-start')
  expect(result.sessions[0].state).toBe('ended')
})
it('does not keep restored hook questions alive after their registry session has disappeared', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-collector-')); dirs.push(dir)
  const registryDir = join(dir, 'sessions'); mkdirSync(registryDir)
  const session = { sessionId: 'old', cwd: '/project', pid: 123, name: 'old', version: '', versionSupported: false, state: 'waiting' as const, statusRaw: 'waiting', startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
  const result = new CockpitCollector({ registryDir, spoolDir: join(dir, 'spool'), claudeDir: join(dir, 'claude'), guardDir: join(dir, 'guard'), initialLifecycle: { sessions: [session], waiting: [{ sessionId: 'old', cwd: '/project', kind: 'question', ref: 'q1', summary: 'old question', openedAt: session.startedAt, source: 'hook' }] } }).poll()
  expect(result.sessions[0].state).toBe('ended')
  expect(result.waiting).toEqual([])
})
