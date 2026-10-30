import { expect, it } from 'vitest'
import { completedToolOf, HookLifecycle, parseHookEvent } from './hooks'

const at = '2026-10-30T08:00:00.000Z'
const later = '2026-10-30T08:00:01.000Z'
const event = (name: string, toolUseId: string, ref: string, when = at, session = 'sid') => {
  const parsed = parseHookEvent({ session_id: session, cwd: '/project', hook_event_name: name, tool_use_id: toolUseId,
    tool_name: name === 'PreToolUse' ? 'AskUserQuestion' : 'Bash', cockpit_recorded_at: when }, when, ref)
  if (!parsed.ok) throw new Error(parsed.event.summary)
  return parsed.event
}
it('does not reopen a completed tool through another spool reference at the same timestamp', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(event('PostToolUse', 'tool-a', 'closed'))
  lifecycle.apply(event('PreToolUse', 'tool-a', 'different-spool'))
  expect(lifecycle.snapshot().waiting).toEqual([])
})
it('does not reopen a failed tool through an asynchronously later permission event', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(event('PostToolUseFailure', 'tool-a', 'closed'))
  lifecycle.apply(event('PermissionRequest', 'tool-a', 'later-permission', later))
  expect(lifecycle.snapshot().waiting).toEqual([])
})
it('applies causal completion even when its observation timestamp is older than the permission delivery', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(event('PermissionRequest', 'tool-a', 'late-permission', later))
  lifecycle.apply(event('PostToolUse', 'tool-a', 'older-completion'))
  expect(lifecycle.snapshot().waiting).toEqual([])
  expect(lifecycle.snapshot().sessions[0]).toMatchObject({ state: 'busy', updatedAt: later })
})
it('keeps different tool executions and different sessions independent', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(event('PostToolUse', 'tool-a', 'closed'))
  lifecycle.apply(event('PreToolUse', 'tool-b', 'new-tool', later))
  lifecycle.apply(event('PreToolUse', 'tool-a', 'other-session', later, 'another-session'))
  expect(lifecycle.snapshot().waiting.map(item => [item.sessionId, item.ref])).toEqual([['sid', 'tool-b'], ['another-session', 'tool-a']])
})
it('consults durable completion proof after a fresh instance and bounded cache eviction', () => {
  const completed = new Set(['sid\0old-tool'])
  const lookup = (sessionId: string, toolUseId: string) => completed.has(`${sessionId}\0${toolUseId}`)
  const lifecycle = new HookLifecycle(undefined, { isToolCompleted: lookup, maxCompletedTools: 1 })
  lifecycle.apply(event('PostToolUse', 'new-tool', 'new-completion'))
  completed.add('sid\0new-tool')
  lifecycle.apply(event('PermissionRequest', 'old-tool', 'old-permission', later))
  expect(lifecycle.snapshot().waiting).toEqual([])
  const reopened = new HookLifecycle(undefined, { isToolCompleted: lookup, maxCompletedTools: 1 })
  reopened.apply(event('PreToolUse', 'new-tool', 'after-restart', later))
  expect(reopened.snapshot().waiting).toEqual([])
})
it('removes a persisted stale question when durable completion evidence already exists', () => {
  const initial = { sessions: [], tasks: [], waiting: [{ sessionId: 'sid', cwd: '/project', kind: 'question' as const, ref: 'closed-tool', summary: 'stale question', openedAt: at, source: 'hook' as const }] }
  const lifecycle = new HookLifecycle(initial, { isToolCompleted: (_sessionId, toolUseId) => toolUseId === 'closed-tool' })
  expect(lifecycle.snapshot().waiting).toEqual([])
})
it('fails visibly rather than silently discarding causal proof if standalone memory capacity is exhausted', () => {
  const lifecycle = new HookLifecycle(undefined, { maxCompletedTools: 1 })
  lifecycle.apply(event('PostToolUse', 'tool-a', 'first'))
  expect(() => lifecycle.apply(event('PostToolUse', 'tool-b', 'second', later))).toThrow(/persistent completion lookup/i)
  lifecycle.apply(event('PermissionRequest', 'tool-a', 'old-request', later))
  expect(lifecycle.snapshot().waiting).toEqual([])
})
it('exposes validated completion identity even when its raw display excerpt is truncated before the tool id', () => {
  const parsed = parseHookEvent({ session_id: 'sid', cwd: '/project', hook_event_name: 'PostToolUse',
    tool_input: Object.fromEntries(['a', 'b', 'c', 'd', 'e'].map(key => [key, 'x'.repeat(3000)])), tool_use_id: 'completion-id-at-end' })
  if (!parsed.ok) throw new Error(parsed.event.summary)
  expect(parsed.event.raw).not.toContain('completion-id-at-end')
  expect(completedToolOf(parsed.event)).toEqual({ sessionId: 'sid', toolUseId: 'completion-id-at-end' })
})
it('surfaces a missing authoritative store instead of treating unknown closure proof as an open request', () => {
  const lifecycle = new HookLifecycle(undefined, { isToolCompleted: () => { throw new Error('Completion store unavailable') } })
  expect(() => lifecycle.apply(event('PermissionRequest', 'tool-a', 'request'))).toThrow('Completion store unavailable')
  expect(lifecycle.snapshot().waiting).toEqual([])
})
