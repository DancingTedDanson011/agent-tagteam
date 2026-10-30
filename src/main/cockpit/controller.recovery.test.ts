import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CockpitController } from './controller'
import { CockpitStore } from './store'

const directories: string[] = []
const controllers: CockpitController[] = []
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'clio-recovery-')); directories.push(root)
  const home = join(root, 'home'); mkdirSync(home)
  const data = join(root, 'data')
  const options = { home, registryDir: join(home, 'registry'), spoolDir: join(home, 'spool'), isProcessAlive: () => true }
  const controller = new CockpitController(data, options); controllers.push(controller)
  return { root, data, options, controller }
}

describe('project identity and lifecycle recovery', () => {
  it('persists valid sessions and tasks across repeated ticks despite an empty guardian checkbox', async () => {
    const { root, options, controller } = setup()
    const project = join(root, 'project'); mkdirSync(project)
    const skillDirectory = join(options.home, '.claude', 'skills', 'code-guardian')
    mkdirSync(skillDirectory, { recursive: true })
    writeFileSync(join(skillDirectory, 'SKILL.md'), '# Code Guardian (v17.14)')
    expect((await controller.command({ type: 'add-project', root: project })).ok).toBe(true)
    mkdirSync(options.registryDir)
    const at = '2026-10-30T00:00:00.000Z'
    writeFileSync(join(options.registryDir, '123.json'), JSON.stringify({
      pid: 123, sessionId: 'valid-session', cwd: project, name: 'Valid session', version: '2.1.312',
      status: 'busy', startedAt: at, updatedAt: at
    }))
    const todo = '- [ ] T-001 · offen · First valid task\n      Wirkung: V — first task\n- [ ]    \n      Wirkung: V — ignored checkbox\n      Beleg: must stay unbound\n- [x] T-002 · erledigt · Last valid task\n      Wirkung: V — last task'
    writeFileSync(join(project, '.code-guardian-todo.md'), todo)

    await controller.tick()
    const snapshot = controller.snapshot()
    expect(snapshot.error).toBeNull()
    expect(snapshot.adapters).toContainEqual(expect.objectContaining({ source: 'code_guardian', status: 'ok' }))
    expect(snapshot.projects[0].sessions).toMatchObject([{ id: 'valid-session', name: 'Valid session', state: 'running' }])
    expect(snapshot.projects[0].tasks.map(task => ({ title: task.title, state: task.state, metadata: task.metadata }))).toEqual([
      { title: 'First valid task', state: 'todo', metadata: { Wirkung: 'V — first task' } },
      { title: 'Last valid task', state: 'done', metadata: { Wirkung: 'V — last task' } }
    ])
    expect(snapshot.projects[0].events.find(event => event.kind === 'todo_snapshot')?.detail).toContain(todo)
    const taskIds = snapshot.projects[0].tasks.map(task => task.id)

    await controller.tick()
    const repeated = controller.snapshot()
    expect(repeated.error).toBeNull()
    expect(repeated.projects[0].sessions).toMatchObject([{ id: 'valid-session', state: 'running' }])
    expect(repeated.projects[0].tasks.map(task => task.id)).toEqual(taskIds)
    expect(repeated.projects[0].tasks.map(task => task.title)).toEqual(['First valid task', 'Last valid task'])
  })
  it('retains the observed session end time across a writer restart', async () => {
    const { root, data, options, controller } = setup()
    const project = join(root, 'project'); mkdirSync(project)
    await controller.command({ type: 'add-project', root: project })
    mkdirSync(options.spoolDir)
    const endedAt = '2026-10-30T00:00:00.000Z'
    writeFileSync(join(options.spoolDir, 'cockpit-ended.json'), JSON.stringify({
      session_id: 'ended-session', cwd: project, hook_event_name: 'SessionEnd',
      version: '2.1.312', cockpit_recorded_at: endedAt
    }))
    await controller.tick()
    const readEnd = () => {
      const reader = new CockpitStore(join(data, 'cockpit.db'), { readOnly: true })
      try { return reader.sessions().find(session => session.sessionId === 'ended-session')?.endedAt }
      finally { reader.close() }
    }
    expect(readEnd()).toBe(endedAt)
    await controller.close()
    const restarted = new CockpitController(data, options); controllers.push(restarted)
    await restarted.tick()
    expect(readEnd()).toBe(endedAt)
  })

  it.skipIf(process.platform !== 'win32')('keeps distinct Unicode folders and their MCP contract scopes separate', async () => {
    const { root, controller } = setup()
    const ascii = join(root, 'project-k'), unicode = join(root, 'project-\u212a')
    mkdirSync(ascii); mkdirSync(unicode)
    expect((await controller.command({ type: 'add-project', root: ascii })).ok).toBe(true)
    const firstId = controller.snapshot().projects[0].id
    expect((await controller.command({ type: 'create-contract', projectId: firstId, title: 'ASCII scope only',
      objective: 'Keep this contract private to its project', maxSessions: 1, maxHours: 1, command: 'echo fixture' })).ok).toBe(true)
    expect((await controller.command({ type: 'add-project', root: unicode })).ok).toBe(true)
    expect(await controller.mcp.listContracts(unicode)).toEqual([])
    expect(controller.snapshot().projects).toHaveLength(2)
    expect(await controller.mcp.listContracts(ascii)).toMatchObject([{ title: 'ASCII scope only' }])
    expect((await controller.command({ type: 'add-project', root: ascii.toUpperCase() })).ok).toBe(true)
    expect(controller.snapshot().projects).toHaveLength(2)
  })

  it.skipIf(process.platform !== 'win32')('rejects a contract junction into a distinct Unicode sibling', async () => {
    const { root, controller } = setup()
    const ascii = join(root, 'project-k'), unicode = join(root, 'project-\u212a')
    mkdirSync(ascii); mkdirSync(unicode)
    const external = join(unicode, '.contracts'); mkdirSync(external)
    symlinkSync(external, join(ascii, '.contracts'), 'junction')
    await controller.command({ type: 'add-project', root: ascii })
    const result = await controller.command({ type: 'create-contract', projectId: controller.snapshot().projects[0].id,
      title: 'Must remain inside', objective: 'Reject the external contract directory', maxSessions: 1, maxHours: 1, command: '' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/escapes/)
  })
})
