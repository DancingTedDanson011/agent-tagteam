import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ContractRepository } from './contracts'
import { CheckRunner, fingerprintProject, type RunnerOptions } from './runner'
import * as sourceWatch from './source-watch'
import { CockpitStore } from './store'

// Covers fixture setup and real Git/OS verification; process timeout tests retain their own budgets.
const INTEGRATION_TIMEOUT_MS = 60_000

const sourceReads = vi.hoisted(() => ({ observe: null as ((path: unknown) => void) | null }))
vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    open: (...args: Parameters<typeof actual.open>) => {
      sourceReads.observe?.(args[0])
      return actual.open(...args)
    }
  }
})

type RunnerFixture = { dir: string; state?: string; store?: CockpitStore; runner?: CheckRunner }
const fixtures: RunnerFixture[] = []
afterEach(async () => {
  sourceReads.observe = null
  vi.restoreAllMocks()
  const cleanupErrors: unknown[] = []
  const temporaryRoot = resolve(tmpdir())
  for (const fixture of fixtures.splice(0)) {
    try { await fixture.runner?.close() } catch (error) { cleanupErrors.push(error) }
    try { fixture.store?.close() } catch (error) { cleanupErrors.push(error) }
    for (const directory of [fixture.dir, fixture.state]) {
      if (directory === undefined) continue
      try {
        const absolute = resolve(directory)
        if (dirname(absolute) !== temporaryRoot || !basename(absolute).startsWith('clio-runner-watch-')) throw new Error('Unexpected runner fixture cleanup path')
        await rm(absolute, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      } catch (error) { cleanupErrors.push(error) }
    }
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0]
  if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Runner fixture cleanup failed', { cause: cleanupErrors[0] })
}, INTEGRATION_TIMEOUT_MS)

async function fixture(code: string, trackedLog = false, options: RunnerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'clio-runner-watch-'))
  const fixtureState: RunnerFixture = { dir }
  fixtures.push(fixtureState)
  const state = mkdtempSync(join(tmpdir(), 'clio-runner-watch-state-'))
  fixtureState.state = state
  execFileSync('git', ['init', '--quiet'], { cwd: dir, windowsHide: true, timeout: 5000 })
  writeFileSync(join(dir, '.gitignore'), '*.log\n')
  writeFileSync(join(dir, 'source.ts'), 'export const value = true\n')
  if (trackedLog) {
    writeFileSync(join(dir, 'tracked.log'), 'source input')
    execFileSync('git', ['add', '--force', '--', 'tracked.log'], { cwd: dir, windowsHide: true, timeout: 5000 })
  }
  const store = new CockpitStore(join(state, 'cockpit.db'))
  fixtureState.store = store
  const repository = new ContractRepository(store)
  const runner = new CheckRunner(store, repository, options)
  fixtureState.runner = runner
  const project = store.ensureProject(dir)
  const draft = await repository.create(project.id, {
    title: 'Watcher selection', objective: 'Validate only changes to source inputs', maxSessions: 2, maxHours: 1,
    command: `"${process.execPath}" -e "${code}"`
  })
  await repository.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  return { dir, store, repository, runner, project, id: draft.id }
}

it('keeps a successful check valid when it writes a Git-ignored output file', async () => {
  const { dir, runner, project, id } = await fixture("require('node:fs').writeFileSync('check.log','check output');setTimeout(()=>process.exit(0),100)")
  const before = await fingerprintProject(dir)
  const result = await runner.run(project.id, id, 'AC1')
  const after = await fingerprintProject(dir)
  expect(after.fingerprint).toBe(before.fingerprint)
  expect(after.paths.has('check.log')).toBe(false)
  expect(result.exitCode).toBe(0)
  expect(result.error).toBeNull()
  expect(result.passed).toBe(true)
}, INTEGRATION_TIMEOUT_MS)

it('keeps a check valid for temporary ignored output', async () => {
  const code = "const fs=require('node:fs');fs.writeFileSync('check.log','output');setTimeout(()=>{fs.unlinkSync('check.log');process.exit(0)},100)"
  const { dir, runner, project, id } = await fixture(code)
  const before = await fingerprintProject(dir)
  const result = await runner.run(project.id, id, 'AC1')
  expect((await fingerprintProject(dir)).fingerprint).toBe(before.fingerprint)
  expect(result.error).toBeNull()
  expect(result.passed).toBe(true)
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32').each([
  ['a directory containing only ignored output', "const fs=require('node:fs');fs.mkdirSync('logs');fs.writeFileSync('logs/check.log','output');setTimeout(()=>process.exit(0),100)"],
  ['a removed directory containing only ignored output', "const fs=require('node:fs');fs.mkdirSync('logs');fs.writeFileSync('logs/check.log','output');setTimeout(()=>{fs.rmSync('logs',{recursive:true});process.stdout.write('done')},150)"],
  ['an immediately removed directory containing only ignored output', "const fs=require('node:fs');fs.mkdirSync('logs');fs.writeFileSync('logs/check.log','output');fs.rmSync('logs',{recursive:true});process.stdout.write('done')"]
])('keeps a check valid for %s', async (_name, code) => {
  const { dir, runner, project, id } = await fixture(code)
  const before = await fingerprintProject(dir)
  const result = await runner.run(project.id, id, 'AC1')
  expect((await fingerprintProject(dir)).fingerprint).toBe(before.fingerprint)
  expect(result.error).toBeNull()
  expect(result.passed).toBe(true)
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32').each([false, true])('invalidates transient empty-file reuse of an output-directory name (directory remains: %s)', async (directoryRemains) => {
  const code = "const fs=require('node:fs');fs.mkdirSync('logs');fs.writeFileSync('logs/check.log','output');setTimeout(()=>{fs.rmSync('logs',{recursive:true});fs.writeFileSync('logs','');fs.unlinkSync('logs');" + (directoryRemains ? "fs.mkdirSync('logs');" : '') + "process.stdout.write('done')},150)"
  const { dir, runner, project, id } = await fixture(code)
  const before = await fingerprintProject(dir)
  const result = await runner.run(project.id, id, 'AC1')
  expect((await fingerprintProject(dir)).fingerprint).toBe(before.fingerprint)
  expect(result.exitCode).toBe(0)
  expect(result.error).toMatch(/source changed/i)
  expect(result.passed).toBe(false)
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32')('invalidates directory renames even when ignored contents and source fingerprints are restored', async () => {
  const code = "const fs=require('node:fs');fs.mkdirSync('logs');fs.writeFileSync('logs/check.log','output');setTimeout(()=>{fs.renameSync('logs','moved');fs.renameSync('moved','logs');process.stdout.write('done')},150)"
  const { dir, runner, project, id } = await fixture(code)
  const before = await fingerprintProject(dir)
  const result = await runner.run(project.id, id, 'AC1')
  expect((await fingerprintProject(dir)).fingerprint).toBe(before.fingerprint)
  expect(result.exitCode).toBe(0)
  expect(result.error).toMatch(/source changed/i)
  expect(result.passed).toBe(false)
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32')('records native observer errors even when the command succeeds', async () => {
  vi.spyOn(sourceWatch, 'startNativeSourceWatch').mockImplementation((_root, _onEvent, onError) => {
    queueMicrotask(() => onError(new Error('fixture observer overflow')))
    return { close: async () => {} }
  })
  const { store, runner, project, id } = await fixture('process.exit(0)')
  const result = await runner.run(project.id, id, 'AC1')
  expect(result.exitCode).toBe(0)
  expect(result.passed).toBe(false)
  expect(result.error).toMatch(/fixture observer overflow/)
  expect(store.runs(project.id, id)[0].finishedAt).not.toBeNull()
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32')('finishes the pending criterion when native observer close rejects', async () => {
  vi.spyOn(sourceWatch, 'startNativeSourceWatch').mockReturnValue({ close: async () => { throw new Error('fixture close failure') } })
  const { store, runner, project, id } = await fixture('process.exit(0)')
  const result = await runner.run(project.id, id, 'AC1')
  expect(result.exitCode).toBe(0)
  expect(result.passed).toBe(false)
  expect(result.error).toMatch(/fixture close failure/)
  expect(store.runs(project.id, id)[0].finishedAt).not.toBeNull()
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32')('keeps native source observation active through the final fingerprint reads', async () => {
  let active = false
  vi.spyOn(sourceWatch, 'startNativeSourceWatch').mockImplementation(() => {
    active = true
    return { close: async () => { active = false } }
  })
  const { runner, project, id } = await fixture('process.exit(0)')
  const observations: boolean[] = []
  sourceReads.observe = (path) => { if (String(path) === join(project.rootPath, 'source.ts')) observations.push(active) }
  const result = await runner.run(project.id, id, 'AC1')
  expect(result.passed).toBe(true)
  expect(observations).toEqual([true, true])
  expect(active).toBe(false)
}, INTEGRATION_TIMEOUT_MS)

it.skipIf(process.platform !== 'win32')('closes source observation and finishes the pending criterion after check setup fails', async () => {
  const close = vi.fn(async () => {})
  vi.spyOn(sourceWatch, 'startNativeSourceWatch').mockReturnValue({ close })
  const { store, runner, project, id } = await fixture('process.exit(0)', false, { shellPath: 'relative-untrusted-shell' })
  const result = await runner.run(project.id, id, 'AC1')
  expect(result.passed).toBe(false)
  expect(result.error).toMatch(/absolute executable paths/)
  expect(close).toHaveBeenCalledTimes(1)
  expect(store.runs(project.id, id)[0].finishedAt).not.toBeNull()
}, INTEGRATION_TIMEOUT_MS)

it('invalidates a tracked ignored file even when its contents are restored during the check', async () => {
  const code = "const fs=require('node:fs');fs.writeFileSync('tracked.log','changed');setTimeout(()=>{fs.writeFileSync('tracked.log','source input');process.exit(0)},100)"
  const { dir, runner, project, id } = await fixture(code, true)
  const before = await fingerprintProject(dir)
  expect(before.paths.has('tracked.log')).toBe(true)
  const result = await runner.run(project.id, id, 'AC1')
  expect((await fingerprintProject(dir)).fingerprint).toBe(before.fingerprint)
  expect(result.exitCode).toBe(0)
  expect(result.error).toMatch(/source changed/i)
  expect(result.passed).toBe(false)
}, INTEGRATION_TIMEOUT_MS)

it('invalidates a new unignored source file even when it is removed before the check ends', async () => {
  const code = "const fs=require('node:fs');fs.writeFileSync('temporary-source.rs','new source');setTimeout(()=>{fs.unlinkSync('temporary-source.rs');process.exit(0)},100)"
  const { dir, runner, project, id } = await fixture(code)
  const before = await fingerprintProject(dir)
  const result = await runner.run(project.id, id, 'AC1')
  expect((await fingerprintProject(dir)).fingerprint).toBe(before.fingerprint)
  expect(result.exitCode).toBe(0)
  expect(result.error).toMatch(/source changed/i)
  expect(result.passed).toBe(false)
}, INTEGRATION_TIMEOUT_MS)
