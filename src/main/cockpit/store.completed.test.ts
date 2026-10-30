import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CockpitStore } from './store'
import { HookLifecycle, parseHookEvent } from './adapters/hooks'

const dirs: string[] = []
const stores: CockpitStore[] = []
const setup = () => { const dir = mkdtempSync(join(tmpdir(), 'cockpit-completed-')); dirs.push(dir); const file = join(dir, 'cockpit.db'); const store = new CockpitStore(file); stores.push(store); return { file, store } }
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
it('keeps idempotent causal proof across reopening and event retention', () => {
  const { file, store } = setup()
  store.markToolCompleted('sid', 'tool-a'); store.markToolCompleted('sid', 'tool-a')
  expect(store.isToolCompleted('sid', 'tool-a')).toBe(true)
  expect(store.isToolCompleted('other-session', 'tool-a')).toBe(false)
  store.recordEvent({ sessionId: 'sid', source: 'hook', kind: 'PostToolUse', payload: { tool_use_id: 'tool-a' } })
  expect(store.events()).toHaveLength(1)
  store.pruneEvents('2099-01-01T00:00:00.000Z')
  expect(store.events()).toEqual([])
  store.close()
  const reopened = new CockpitStore(file); stores.push(reopened)
  const lifecycle = new HookLifecycle(undefined, { isToolCompleted: (sid, toolId) => reopened.isToolCompleted(sid, toolId) })
  const parsed = parseHookEvent({ session_id: 'sid', cwd: '/project', hook_event_name: 'PermissionRequest', tool_use_id: 'tool-a', tool_name: 'Bash' })
  if (!parsed.ok) throw new Error(parsed.event.summary)
  lifecycle.apply(parsed.event)
  expect(lifecycle.snapshot().waiting).toEqual([])
})
it('rolls completion proof back with its owning observation transaction and supports readonly lookup', () => {
  const { file, store } = setup()
  expect(() => store.transaction(() => { store.markToolCompleted('sid', 'rolled-back'); throw new Error('rollback') })).toThrow('rollback')
  expect(store.isToolCompleted('sid', 'rolled-back')).toBe(false)
  store.markToolCompleted('sid', 'committed')
  const reader = new CockpitStore(file, { readOnly: true }); stores.push(reader)
  expect(reader.isToolCompleted('sid', 'committed')).toBe(true)
  expect(() => reader.markToolCompleted('sid', 'forbidden')).toThrow(/read.only/i)
})
it('rejects invalid identity keys without silently changing their value', () => {
  const { store } = setup()
  expect(() => store.markToolCompleted('sid', 'Bearer SYNTHETIC_CREDENTIAL')).toThrow(/identity/i)
  expect(() => store.isToolCompleted('', 'tool-a')).toThrow(/identity/i)
})
