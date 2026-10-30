import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import { invalidEvent } from './common'
import { HookLifecycle, parseHookEvent } from './hooks'
import { parseSessionRecord } from './registry'
import { ByteTail } from './transcript'
import { CockpitCollector } from '../collector'

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'cockpit-review-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const first = '2026-10-30T08:00:00.000Z'
const second = '2026-10-30T08:00:01.000Z'
const third = '2026-10-30T08:00:02.000Z'
const hook = (name: string, at: string, ref: string, extra = {}) => {
  const result = parseHookEvent({ session_id: 'sid', cwd: '/project', hook_event_name: name, cockpit_recorded_at: at, ...extra }, at, ref)
  if (!result.ok) throw new Error(result.event.summary)
  return result.event
}

it('clears the derived waiting state after permission completion', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(hook('PermissionRequest', first, 'permission', { tool_name: 'Bash', tool_use_id: 'tool-a' }))
  lifecycle.apply(hook('PostToolUse', second, 'completed', { tool_name: 'Bash', tool_use_id: 'tool-a' }))
  expect(lifecycle.snapshot().waiting).toEqual([])
  expect(lifecycle.snapshot().sessions[0].state).toBe('busy')
})
it('does not reopen a completed request or roll back its timestamp when an old event is replayed', () => {
  const lifecycle = new HookLifecycle()
  const request = hook('PermissionRequest', first, 'permission', { tool_name: 'Bash', tool_use_id: 'tool-a' })
  lifecycle.apply(request)
  lifecycle.apply(hook('PostToolUse', second, 'completed', { tool_name: 'Bash', tool_use_id: 'tool-a' }))
  lifecycle.apply(request)
  expect(lifecycle.snapshot().waiting).toEqual([])
  expect(lifecycle.snapshot().sessions[0].updatedAt).toBe(second)
})
it('keeps an ended session terminal until a genuine later SessionStart', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(hook('SessionEnd', second, 'end'))
  lifecycle.apply(hook('PreToolUse', first, 'old-tool', { tool_name: 'Read' }))
  expect(lifecycle.snapshot().sessions[0]).toMatchObject({ state: 'ended', updatedAt: second, endedAt: second })
  lifecycle.apply(hook('SessionStart', third, 'resume'))
  expect(lifecycle.snapshot().sessions[0].state).toBe('idle')
  expect(lifecycle.snapshot().sessions[0].endedAt).toBeUndefined()
})
it('keeps StopFailure as an error until a newer explicit working event recovers it', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(hook('StopFailure', second, 'failed'))
  expect(lifecycle.snapshot().sessions[0].state).toBe('error')
  lifecycle.apply(hook('PreToolUse', first, 'older-tool', { tool_name: 'Read' }))
  expect(lifecycle.snapshot().sessions[0].state).toBe('error')
  lifecycle.apply(hook('UserPromptSubmit', third, 'new-turn'))
  expect(lifecycle.snapshot().sessions[0].state).toBe('busy')
})
it('preserves a hook failure when the registry merely reports a newer idle state', () => {
  const dir = temp(); const registryDir = join(dir, 'sessions'); const spoolDir = join(dir, 'spool')
  mkdirSync(registryDir); mkdirSync(spoolDir)
  writeFileSync(join(registryDir, '123.json'), JSON.stringify({ pid: 123, procStart: 'original-process', sessionId: 'sid', cwd: '/project', status: 'idle', updatedAt: third }))
  writeFileSync(join(spoolDir, 'cockpit-failure.json'), JSON.stringify({ session_id: 'sid', cwd: '/project', hook_event_name: 'StopFailure', cockpit_recorded_at: second }))
  const result = new CockpitCollector({ registryDir, spoolDir, claudeDir: join(dir, 'claude'), guardDir: join(dir, 'guard'), isProcessAlive: () => true }).poll()
  expect(result.sessions[0].state).toBe('error')
  expect(result.sessions[0].updatedAt).toBe(third)
})
it('retains confirmed dead process identity after registry deletion and a later question hook', () => {
  const dir = temp(); const registryDir = join(dir, 'sessions'); const spoolDir = join(dir, 'spool')
  mkdirSync(registryDir); mkdirSync(spoolDir)
  const file = join(registryDir, '123.json')
  writeFileSync(file, JSON.stringify({ pid: 123, procStart: 'original-process', sessionId: 'sid', cwd: '/project', status: 'busy', updatedAt: first }))
  let now = first
  const collector = new CockpitCollector({ registryDir, spoolDir, claudeDir: join(dir, 'claude'), guardDir: join(dir, 'guard'), clock: () => now, isProcessAlive: () => false })
  expect(collector.poll().sessions[0].state).toBe('ended')
  rmSync(file); now = second
  expect(collector.poll().sessions[0].state).toBe('ended')
  writeFileSync(join(spoolDir, 'cockpit-later-question.json'), JSON.stringify({ session_id: 'sid', cwd: '/project', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'q', cockpit_recorded_at: third }))
  now = third
  const result = collector.poll()
  expect(result.sessions[0].state).toBe('ended')
  expect(result.sessions[0].endedAt).toBe(first)
  expect(result.waiting).toEqual([])
})
it('discards the remainder of an already started physical line when attaching at EOF', () => {
  const file = join(temp(), 'partial.jsonl')
  writeFileSync(file, '{"historic":')
  const reader = new ByteTail()
  expect(reader.read(file).lines).toEqual([])
  appendFileSync(file, '{"suffix":true}\n{"whole":true}\n')
  const result = reader.read(file)
  expect(result.lines).toEqual(['{"whole":true}'])
  expect(result.oversized).toBe(0)
})
it('masks credential values behind Unicode-escaped keys even in malformed raw JSON', () => {
  const event = invalidEvent('hook', 'Invalid JSON', '{"to\\u006ben":"SYNTHETIC_RAW_CREDENTIAL",')
  expect(event.raw).not.toContain('SYNTHETIC_RAW_CREDENTIAL')
})
it('portable sanitizer masks the complete quoted environment assignment', () => {
  const writer = createRequire(import.meta.url)(resolve('resources/cockpit-plugin/cockpit-hook.cjs'))
  const result = JSON.stringify(writer.sanitize({ command: "export PASSWORD='SYNTHETIC_FIRST SYNTHETIC_REMAINDER'" }))
  expect(result).not.toContain('SYNTHETIC_FIRST')
  expect(result).not.toContain('SYNTHETIC_REMAINDER')
})
it('portable sanitizer masks Unicode-escaped keys inside command JSON', () => {
  const writer = createRequire(import.meta.url)(resolve('resources/cockpit-plugin/cockpit-hook.cjs'))
  const result = JSON.stringify(writer.sanitize({ command: '{"api\\u005fkey":"SYNTHETIC_COMMAND_CREDENTIAL"}' }))
  expect(result).not.toContain('SYNTHETIC_COMMAND_CREDENTIAL')
})
it('rejects secret-bearing cwd and process identities rather than publishing a relabeled identity', () => {
  const base = { pid: 123, sessionId: 'sid', cwd: '/project', version: '2.1.312' }
  const path = parseSessionRecord({ ...base, cwd: 'C:\\private\\Bearer SYNTHETIC_PATH_CREDENTIAL' })
  const process = parseSessionRecord({ ...base, procStart: 'Bearer SYNTHETIC_PROCESS_CREDENTIAL' })
  const event = parseHookEvent({ session_id: 'sid', cwd: 'C:\\private\\Bearer SYNTHETIC_HOOK_CREDENTIAL', hook_event_name: 'Stop' })
  expect(path.ok).toBe(false); expect(process.ok).toBe(false); expect(event.ok).toBe(false)
  expect(JSON.stringify([path, process, event])).not.toMatch(/SYNTHETIC_(?:PATH|PROCESS|HOOK)_CREDENTIAL/)
})
it('does not acknowledge a replacement inode with the same bytes on the real temporary filesystem', () => {
  const dir = temp(); const spoolDir = join(dir, 'spool'); mkdirSync(spoolDir)
  const file = join(spoolDir, 'cockpit-original.json'); const replacement = join(spoolDir, 'replacement.tmp')
  const payload = JSON.stringify({ session_id: 'sid', cwd: '/project', hook_event_name: 'Stop' })
  writeFileSync(file, payload)
  const collector = new CockpitCollector({ spoolDir, registryDir: join(dir, 'sessions'), claudeDir: join(dir, 'claude'), guardDir: join(dir, 'guard') })
  const result = collector.poll(); const before = lstatSync(file, { bigint: true })
  writeFileSync(replacement, payload)
  const next = lstatSync(replacement, { bigint: true })
  expect(`${next.dev}:${next.ino}:${next.birthtimeNs}`).not.toBe(`${before.dev}:${before.ino}:${before.birthtimeNs}`)
  renameSync(replacement, file)
  collector.ackSpool(result.spoolToAck)
  expect(existsSync(file)).toBe(true)
})
