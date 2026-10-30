import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { ContractRepository } from './contracts'
import { CheckRunner } from './runner'
import { CockpitStore } from './store'

const fixtures: { dir: string; state: string; store: CockpitStore; runner: CheckRunner }[] = []
const command = (code: string) => `"${process.execPath}" -e "${code}"`
async function fixture(code: string, options: { timeoutMs?: number; maxOutputBytes?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clio-runner-'))
  writeFileSync(join(dir, 'source.ts'), 'export const value = true\n')
  const state = mkdtempSync(join(tmpdir(), 'clio-runner-state-'))
  const store = new CockpitStore(join(state, 'cockpit.db'))
  const project = store.ensureProject(dir)
  const repository = new ContractRepository(store)
  const runner = new CheckRunner(store, repository, options)
  fixtures.push({ dir, state, store, runner })
  const draft = await repository.create(project.id, { title: 'Check', objective: 'Check actual behavior', maxSessions: 2, maxHours: 1, command: command(code) })
  await repository.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  return { dir, store, project, repository, runner, id: draft.id }
}
afterEach(async () => {
  for (const item of fixtures.splice(0)) { await item.runner.close(); item.store.close(); rmSync(item.dir, { recursive: true, force: true }); rmSync(item.state, { recursive: true, force: true }) }
})
async function waitFor(path: string) {
  const deadline = Date.now() + 8000
  while (!existsSync(path)) { if (Date.now() > deadline) throw new Error('Check process did not start'); await delay(20) }
}

describe('frozen check execution', () => {
  it('runs in the canonical project root with capped, redacted persisted evidence', async () => {
    const { dir, store, project, repository, runner, id } = await fixture("process.stdout.write(process.cwd()+' '+('sk-'+'a'.repeat(24))+' '+('x'.repeat(5000)))", { maxOutputBytes: 800 })
    const result = await runner.run(project.id, id, 'AC1')
    expect(result.passed).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(project.rootPath)
    expect(result.stdout).not.toContain('a'.repeat(24))
    expect(result.stdout.length).toBeLessThanOrEqual(900)
    expect(result.sourceFingerprint).toBeTruthy()
    expect(store.runs(project.id, id)[0].id).toBe(result.id)
    expect((await repository.list(project.id, true))[0].progress.met).toBe(1)
  }, 15000)
  it('refuses a changed frozen definition before spawning a command', async () => {
    const { project, repository, runner, id } = await fixture("process.stdout.write('must not run')")
    const view = (await repository.list(project.id))[0]
    const changed = JSON.parse(readFileSync(view.path, 'utf8'))
    changed.objective = 'changed without an amendment'
    writeFileSync(view.path, JSON.stringify(changed))
    await expect(runner.run(project.id, id, 'AC1')).rejects.toThrow(/changed|amendment/i)
  })
  it('fails timeouts and honors cancellation before child creation', async () => {
    const timed = await fixture('setInterval(()=>{},1000)', { timeoutMs: 200 })
    const timeout = await timed.runner.run(timed.project.id, timed.id, 'AC1')
    expect(timeout.passed).toBe(false)
    expect(timeout.error).toMatch(/timeout/i)
    const cancelled = await fixture("require('node:fs').writeFileSync('executed.marker','yes')")
    const pending = cancelled.runner.run(cancelled.project.id, cancelled.id, 'AC1')
    cancelled.runner.cancel(cancelled.project.id, cancelled.id)
    const result = await pending
    expect(result.passed).toBe(false)
    expect(result.error).toMatch(/cancel/i)
    expect(existsSync(join(cancelled.dir, 'executed.marker'))).toBe(false)
  }, 15000)
  it('invalidates passing results when source changes during or after a check', async () => {
    const { dir, project, repository, runner, id } = await fixture("require('node:fs').writeFileSync('.code-guardian-started.marker','yes');setTimeout(()=>process.exit(0),500)")
    const pending = runner.run(project.id, id, 'AC1')
    await Promise.race([waitFor(join(dir, '.code-guardian-started.marker')), pending.then(() => { throw new Error('Check ended before its start marker') })])
    writeFileSync(join(dir, 'source.ts'), 'export const value = false\n')
    const changed = await pending
    expect(changed.passed).toBe(false)
    expect(changed.error).toMatch(/source|changed/i)
    const valid = await runner.run(project.id, id, 'AC1')
    expect(valid.passed).toBe(true)
    writeFileSync(join(dir, 'source.ts'), 'export const value = null\n')
    expect((await repository.list(project.id, true))[0].progress.met).toBe(0)
  }, 15000)
  it('kills the command process tree when cancellation is requested', async () => {
    const code = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync('child.pid',String(c.pid));setInterval(()=>{},1000)"
    const { dir, project, runner, id } = await fixture(code, { timeoutMs: 10000 })
    const pending = runner.run(project.id, id, 'AC1')
    await Promise.race([waitFor(join(dir, 'child.pid')), pending.then(() => { throw new Error('Check ended before its child marker') })])
    const pid = Number(readFileSync(join(dir, 'child.pid'), 'utf8'))
    runner.cancel(project.id, id)
    const result = await pending
    expect(result.passed).toBe(false)
    expect(() => process.kill(pid, 0)).toThrow()
  }, 15000)
  it('ignores project-local tool shadows and exports completion without invalidating its source proof', async () => {
    const { dir, project, repository, runner, id } = await fixture("process.stdout.write('verified')")
    writeFileSync(join(dir, 'git.exe'), 'project content, never a tool')
    writeFileSync(join(dir, 'cmd.exe'), 'project content, never a shell')
    const result = await runner.run(project.id, id, 'AC1')
    expect(result.passed).toBe(true)
    const current = (await repository.list(project.id, true))[0]
    await repository.approveManual(project.id, id, 'AC2', 'Marco', current.definitionHash!, current.sourceFingerprint!)
    const completed = await repository.finalize(project.id, id, current.definitionHash!, current.sourceFingerprint!)
    expect(completed.fulfilled).toBe(true)
    expect(completed.sourceFingerprint).toBe(current.sourceFingerprint)
    const document = JSON.parse(readFileSync(completed.path, 'utf8'))
    expect(document.milestones[0].criteria[0].evidence.source_fingerprint).toBe(result.sourceFingerprint)
  }, 15000)
})
