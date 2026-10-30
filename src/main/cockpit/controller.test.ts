import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CockpitController } from './controller'

const dirs: string[] = []
const controllers: CockpitController[] = []
afterEach(async () => { for (const item of controllers.splice(0)) await item.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'cg-cockpit-controller-')); dirs.push(root)
  const project = join(root, 'project'); mkdirSync(project)
  const home = join(root, 'home'); mkdirSync(home)
  const registryDir = join(home, '.claude', 'sessions'); mkdirSync(registryDir, { recursive: true })
  const dataDir = join(root, 'data')
  const options = { home, registryDir, spoolDir: join(home, 'spool'), getTiles: () => [{ id: 'a1', pid: 123 }], parentPid: () => null, isProcessAlive: () => true }
  const controller = new CockpitController(dataDir, options); controllers.push(controller)
  return { root, project, home, registryDir, dataDir, options, controller }
}

describe('integrated local cockpit', () => {
  it('restores task ordering metadata and title when a delayed update arrives after writer restart', async () => {
    const { project, dataDir, options, controller } = setup()
    await controller.command({ type: 'add-project', root: project })
    mkdirSync(options.spoolDir, { recursive: true })
    const hook = (file: string, kind: string, at: string, extra: object) => writeFileSync(join(options.spoolDir, file), JSON.stringify({
      session_id: 'task-session', cwd: project, version: '2.1.312', hook_event_name: kind, cockpit_recorded_at: at, ...extra
    }))
    hook('cockpit-task-create.json', 'PostToolUse', '2026-10-30T08:00:00Z', { tool_name: 'TaskCreate', tool_use_id: 'create-use', tool_response: { task: { id: 't1', subject: 'Original task title' } } })
    await controller.tick()
    hook('cockpit-newer-session.json', 'PreToolUse', '2026-10-30T08:00:02Z', { tool_name: 'Read', tool_use_id: 'unrelated-use' })
    await controller.tick()
    await controller.close()
    const restarted = new CockpitController(dataDir, options); controllers.push(restarted)
    hook('cockpit-delayed-task.json', 'PostToolUse', '2026-10-30T08:00:01Z', { tool_name: 'TaskUpdate', tool_use_id: 'update-use', tool_input: { taskId: 't1', status: 'completed' } })
    await restarted.tick()
    expect(restarted.snapshot().projects[0].tasks).toHaveLength(1)
    expect(restarted.snapshot().projects[0].tasks[0]).toMatchObject({ title: 'Original task title', state: 'done' })
  })
  it('persists causal tool completion across a writer restart before acknowledging later hook files', async () => {
    const { project, dataDir, options, controller } = setup()
    await controller.command({ type: 'add-project', root: project })
    mkdirSync(options.spoolDir, { recursive: true })
    const writeHook = (file: string, name: string) => writeFileSync(join(options.spoolDir, file), JSON.stringify({
      session_id: 'causal-session', cwd: project, version: '2.1.312', hook_event_name: name,
      tool_name: 'Bash', tool_use_id: 'completed-use', cockpit_recorded_at: new Date().toISOString()
    }))
    writeHook('cockpit-completion.json', 'PostToolUse')
    await controller.tick()
    await controller.close()
    const restarted = new CockpitController(dataDir, options); controllers.push(restarted)
    writeHook('cockpit-late-permission.json', 'PermissionRequest')
    await restarted.tick()
    expect(restarted.snapshot().projects[0].waiting).toEqual([])
    expect(restarted.snapshot().projects[0].sessions[0].state).not.toBe('waiting')
  })
  it('persists user tasks, ingests a real source shape and links only an exact tile process', async () => {
    const { project, registryDir, controller } = setup()
    expect((await controller.command({ type: 'add-project', root: project })).ok).toBe(true)
    const id = controller.snapshot().projects[0].id
    expect((await controller.command({ type: 'create-task', projectId: id, title: 'Review the result' })).ok).toBe(true)
    writeFileSync(join(registryDir, '123.json'), JSON.stringify({ pid: 123, sessionId: 'session-test', cwd: project, startedAt: Date.now(), version: '2.1.302', status: 'busy', updatedAt: Date.now() }))
    await controller.tick()
    const view = controller.snapshot().projects.find(p => p.id === id)!
    expect(view.tasks[0].title).toBe('Review the result')
    expect(view.sessions[0]).toMatchObject({ id: 'session-test', tileId: 'a1', state: 'running' })
    expect((await controller.command({ type: 'move-task', projectId: id + 100, taskId: view.tasks[0].id, state: 'done' })).ok).toBe(false)
    expect(controller.snapshot().projects.find(p => p.id === id)!.tasks[0].state).toBe('todo')
  })

  it('keeps another instance read-only and lets it take over after the writer closes', async () => {
    const { project, dataDir, options, controller } = setup()
    await controller.command({ type: 'add-project', root: project })
    const reader = new CockpitController(dataDir, options); controllers.push(reader)
    await reader.tick()
    expect(reader.snapshot().writable).toBe(false)
    const id = reader.snapshot().projects[0].id
    expect((await reader.command({ type: 'create-task', projectId: id, title: 'Not a writer' })).ok).toBe(false)
    await controller.close()
    await reader.tick()
    expect(reader.snapshot().writable).toBe(true)
    expect((await reader.command({ type: 'create-task', projectId: id, title: 'Writer recovered' })).ok).toBe(true)
  })

  it('does not reuse writer-local tile ids in another instance', async () => {
    const { project, registryDir, dataDir, options, controller } = setup()
    writeFileSync(join(registryDir, '123.json'), JSON.stringify({ pid: 123, sessionId: 'session-test', cwd: project, version: '2.1.302', status: 'busy', updatedAt: Date.now() }))
    await controller.tick()
    expect(controller.snapshot().projects[0].sessions[0].tileId).toBe('a1')
    const reader = new CockpitController(dataDir, { ...options, getTiles: () => [{ id: 'a1', pid: 999 }] }); controllers.push(reader)
    await reader.tick()
    expect(reader.snapshot().projects[0].sessions[0].tileId).toBeNull()
  })

  it('keeps a documented hook failure visible even without registry version metadata', async () => {
    const { project, options, controller } = setup()
    await controller.command({ type: 'add-project', root: project })
    mkdirSync(options.spoolDir, { recursive: true })
    writeFileSync(join(options.spoolDir, 'cockpit-selftest-error.json'), JSON.stringify({ session_id: 'broken-session', cwd: project,
      hook_event_name: 'StopFailure', timestamp: new Date().toISOString() }))
    await controller.tick()
    expect(controller.snapshot().projects[0].state).toBe('error')
    expect(controller.snapshot().projects[0].sessions[0].state).toBe('error')
  })
})
