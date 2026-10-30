import { describe, expect, it } from 'vitest'
import { HookLifecycle, parseHookEvent } from './hooks'

// These are synthetic boundary fixtures, not captures of real Claude hook payloads.
const hook = (hook_event_name: string, extra = {}) => ({ session_id: 'session-a', cwd: '/project', hook_event_name, ...extra })
const parse = (name: string, extra = {}) => {
  const result = parseHookEvent(hook(name, extra), '2026-10-30T08:00:00.000Z')
  if (!result.ok) throw new Error(result.event.summary)
  return result.event
}
describe('hook lifecycle', () => {
  it('upserts questions, merges permission overlap, matches tool ids, and permits reopening', () => {
    const state = new HookLifecycle()
    const question = parse('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q1', tool_input: { questions: [{ question: 'Which change?' }] } })
    state.apply(question); state.apply(question)
    state.apply(parse('PermissionRequest', { tool_name: 'AskUserQuestion', tool_use_id: 'q1' }))
    expect(state.snapshot().waiting).toHaveLength(1)
    expect(state.snapshot().waiting[0].kind).toBe('question')
    state.apply(parse('PostToolUse', { tool_use_id: 'other' }))
    expect(state.snapshot().waiting).toHaveLength(1)
    state.apply(parse('PostToolUseFailure', { tool_use_id: 'q1' }))
    expect(state.snapshot().waiting).toHaveLength(0)
    state.apply(parse('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'q2', tool_input: { questions: [{ question: 'A new execution?' }] }, cockpit_recorded_at: '2026-10-30T08:00:01.000Z' }))
    expect(state.snapshot().waiting).toHaveLength(1)
  })
  it('does not treat PermissionDenied as completion and isolates sessions', () => {
    const state = new HookLifecycle()
    state.apply(parse('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'b1' }))
    state.apply(parse('PermissionDenied'))
    state.apply({ ...parse('Stop'), sessionId: 'different' })
    expect(state.snapshot().waiting).toHaveLength(1)
    state.apply(parse('UserPromptSubmit'))
    expect(state.snapshot().waiting).toHaveLength(0)
  })
  it('ends dialogs on the next event and retains completed tasks across session end', () => {
    const state = new HookLifecycle()
    state.apply(parse('Notification', { notification_type: 'elicitation_dialog', message: 'Choose one' }))
    expect(state.snapshot().waiting).toHaveLength(1)
    state.apply(parse('PostToolUse', { tool_name: 'TaskCreate', tool_response: { task: { id: 't1', subject: 'Persist task' } } }))
    expect(state.snapshot().waiting).toHaveLength(0)
    state.apply(parse('PostToolUse', { tool_name: 'TaskUpdate', tool_input: { taskId: 't1', status: 'completed' } }))
    state.apply(parse('SessionEnd'))
    expect(state.snapshot().tasks[0]).toMatchObject({ title: 'Persist task', state: 'done', sourceRef: 'session-a:t1' })
  })
  it('rejects missing identity, oversized input and invalid JSON without driving state', () => {
    expect(parseHookEvent('{').ok).toBe(false)
    expect(parseHookEvent(hook('Stop', { cwd: null })).ok).toBe(false)
    expect(parseHookEvent(' '.repeat(300_000)).ok).toBe(false)
    const valid = parseHookEvent(hook('FutureEvent', { extra: { api_key: 'private-value' }, arbitrary: 'retained' }))
    expect(valid.ok).toBe(true)
    expect(JSON.stringify(valid)).toContain('retained')
    expect(JSON.stringify(valid)).not.toContain('private-value')
  })
})
