import { expect, it } from 'vitest'
import { HookLifecycle, parseHookEvent } from './hooks'

const first = '2026-10-30T08:00:00.000Z'
const second = '2026-10-30T08:00:01.000Z'
const third = '2026-10-30T08:00:02.000Z'
const fourth = '2026-10-30T08:00:03.000Z'
const make = (name: string, at: string, ref: string, toolName = 'Bash', extra = {}) => {
  const parsed = parseHookEvent({ session_id: 'sid', cwd: '/project', hook_event_name: name, cockpit_recorded_at: at, tool_name: toolName, tool_use_id: ref, ...extra }, at, `spool:${ref}:${name}`)
  if (!parsed.ok) throw new Error(parsed.event.summary)
  return parsed.event
}
const create = (at = first, ref = 'create-call') => make('PostToolUse', at, ref, 'TaskCreate', { tool_response: { task: { id: 't1', subject: 'Deliver work' } } })
const update = (status: string, at = second, ref = 'update-call', taskId = 't1') => make('PostToolUse', at, ref, 'TaskUpdate', { tool_input: { taskId, status } })

for (const name of ['PostToolUse', 'PostToolUseFailure']) it(`keeps another tool's known permission open after ${name}`, () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(make('PermissionRequest', first, 'blocked-tool'))
  lifecycle.apply(make(name, second, 'different-tool'))
  expect(lifecycle.snapshot().waiting.map(item => item.ref)).toEqual(['blocked-tool'])
  expect(lifecycle.snapshot().sessions[0].state).toBe('waiting')
})
it('uses the documented next-completion fallback when a permission or completion has no tool id', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(make('PermissionRequest', first, ''))
  lifecycle.apply(make('PostToolUse', second, 'known-completion'))
  expect(lifecycle.snapshot().waiting).toEqual([])
  lifecycle.apply(make('PermissionRequest', third, 'known-request'))
  lifecycle.apply(make('PostToolUse', fourth, ''))
  expect(lifecycle.snapshot().waiting).toEqual([])
})
it('applies a delayed task completion independently of a newer unrelated session event', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(create())
  lifecycle.apply(make('PreToolUse', third, 'unrelated', 'Read'))
  lifecycle.apply(update('completed'))
  expect(lifecycle.snapshot().tasks[0].state).toBe('done')
  expect(lifecycle.snapshot().sessions[0]).toMatchObject({ state: 'busy', updatedAt: third, currentTool: 'Read' })
})
it('records a historical task fact after SessionEnd without reactivating the session', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(create())
  lifecycle.apply(make('SessionEnd', third, 'end'))
  lifecycle.apply(update('completed'))
  expect(lifecycle.snapshot().tasks[0].state).toBe('done')
  expect(lifecycle.snapshot().sessions[0]).toMatchObject({ state: 'ended', updatedAt: third })
})
it('uses independent task watermarks and ignores old state replays after an explicit newer reopening', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(create())
  lifecycle.apply(update('completed', third, 'close-t1'))
  lifecycle.apply(update('in_progress', second, 'older-t1'))
  lifecycle.apply(update('completed', second, 'close-t2', 't2'))
  expect(lifecycle.snapshot().tasks.map(task => [task.sourceRef, task.state])).toEqual([['sid:t1', 'done'], ['sid:t2', 'done']])
  lifecycle.apply(update('pending', fourth, 'reopen-t1'))
  lifecycle.apply(update('completed', third, 'replayed-close-t1'))
  expect(lifecycle.snapshot().tasks[0].state).toBe('open')
})
it('never lets a delayed create reset a mutation, and can enrich a missing historical title', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(update('completed', first, 'early-update'))
  lifecycle.apply(create(third, 'delayed-create'))
  expect(lifecycle.snapshot().tasks[0]).toMatchObject({ title: 'Deliver work', state: 'done' })
})
it('prefers observed terminal progress for tied task timestamps but permits strictly newer reopening', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(create())
  lifecycle.apply(update('in_progress', second, 'doing'))
  lifecycle.apply(update('completed', second, 'completed'))
  lifecycle.apply(update('pending', second, 'stale-pending'))
  expect(lifecycle.snapshot().tasks[0].state).toBe('done')
  lifecycle.apply(update('pending', third, 'explicit-reopen'))
  expect(lifecycle.snapshot().tasks[0].state).toBe('open')
})
it('preserves per-task ordering through metadata restoration', () => {
  const before = new HookLifecycle()
  before.apply(create())
  before.apply(update('completed', third, 'completion'))
  const reopened = new HookLifecycle(before.snapshot())
  reopened.apply(update('pending', second, 'stale-after-restart'))
  expect(reopened.snapshot().tasks[0].state).toBe('done')
  expect(reopened.snapshot().tasks[0].metadata?._hook_task_at).toBe(third)
})
it('keeps a completed task completed when a newer update changes only its subject', () => {
  const lifecycle = new HookLifecycle()
  lifecycle.apply(create())
  lifecycle.apply(update('completed'))
  lifecycle.apply(make('PostToolUse', third, 'rename', 'TaskUpdate', { tool_input: { taskId: 't1', subject: 'Revised subject' } }))
  expect(lifecycle.snapshot().tasks[0]).toMatchObject({ title: 'Revised subject', state: 'done' })
})
