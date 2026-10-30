import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { ContractRepository } from './contracts'
import { CheckRunner, fingerprintProject } from './runner'
import { CockpitStore } from './store'

const fixtures: { dir: string; store?: CockpitStore; runner?: CheckRunner }[] = []
function directory(): string { const dir = mkdtempSync(join(tmpdir(), 'clio-evidence-')); fixtures.push({ dir }); return dir }
afterEach(async () => { for (const fixture of fixtures.splice(0)) { await fixture.runner?.close(); fixture.store?.close(); rmSync(fixture.dir, { recursive: true, force: true }) } })

it('fingerprints every unexcluded file regardless of language or extension', async () => {
  const dir = directory()
  const rust = join(dir, 'main.rs')
  writeFileSync(rust, 'fn main() { println!("ok"); }')
  writeFileSync(join(dir, 'source-without-extension'), 'first')
  const before = await fingerprintProject(dir, { gitPath: null })
  expect(before.paths.has('main.rs')).toBe(true)
  writeFileSync(rust, 'fn main() { panic!("changed"); }')
  const changed = await fingerprintProject(dir, { gitPath: null })
  expect(changed.fingerprint).not.toBe(before.fingerprint)
  writeFileSync(join(dir, 'source-without-extension'), 'second')
  expect((await fingerprintProject(dir, { gitPath: null })).fingerprint).not.toBe(changed.fingerprint)
})

it('does not leak a partial credential at the captured output boundary', async () => {
  const dir = directory()
  const store = new CockpitStore(join(directory(), 'cockpit.db'))
  const repository = new ContractRepository(store)
  const runner = new CheckRunner(store, repository, { maxOutputBytes: 64 })
  Object.assign(fixtures[0], { store, runner })
  const project = store.ensureProject(dir)
  const command = `"${process.execPath}" -e "process.stdout.write('x'.repeat(55)+' '+('sk-'+'a'.repeat(24)))"`
  const draft = await repository.create(project.id, { title: 'Output boundary', objective: 'Mask credentials even when output is cut', maxSessions: 2, maxHours: 1, command })
  await repository.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  const result = await runner.run(project.id, draft.id, 'AC1')
  expect(result.passed).toBe(true)
  expect(result.stdout).not.toContain('sk-')
  expect(Buffer.byteLength(result.stdout + result.stderr)).toBeLessThanOrEqual(64)
}, 15000)

it('masks compound secrets from an actual shell run through stored evidence and the finalized contract excerpt', async () => {
  const dir = directory()
  const store = new CockpitStore(join(directory(), 'cockpit.db'))
  const repository = new ContractRepository(store)
  const runner = new CheckRunner(store, repository)
  Object.assign(fixtures[0], { store, runner })
  const output = [
    '{"access_token":"AUDIT_SYNTHETIC_ACCESS","refresh_token":"AUDIT_SYNTHETIC_REFRESH"}',
    'ACCESS_TOKEN=AUDIT_SYNTHETIC_ENV',
    "DB_PASSWORD='AUDIT_SYNTHETIC_FIRST AUDIT_SYNTHETIC_REMAINDER'",
    '{"client\\u005fsecret":"AUDIT_SYNTHETIC_ESCAPED"}'
  ].join('\n') + '\n'
  const errors = 'CLIENT_SECRET=AUDIT_SYNTHETIC_STDERR\n'
  writeFileSync(join(dir, 'emit-credentials.cjs'), `process.stdout.write(${JSON.stringify(output)});process.stderr.write(${JSON.stringify(errors)});`)
  const project = store.ensureProject(dir)
  const command = `"${process.execPath}" emit-credentials.cjs`
  const draft = await repository.create(project.id, { title: 'Safe evidence', objective: 'Persist only masked check output', maxSessions: 2, maxHours: 1,
    criteria: [{ description: 'Emit synthetic credential output', command }, { description: 'Verify normal completion', command: `"${process.execPath}" -e "process.exit(0)"` }] })
  await repository.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  const runs = await runner.runAll(project.id, draft.id)
  expect(runs.every(run => run.passed)).toBe(true)
  const persisted = store.runs(project.id, draft.id).map(run => run.stdout + run.stderr).join('\n')
  expect(persisted).not.toContain('AUDIT_SYNTHETIC_')
  expect(persisted).toContain('****')
  const view = (await repository.list(project.id, true)).find(contract => contract.id === draft.id)!
  expect(view.fulfilled).toBe(true)
  const exported = await repository.finalize(project.id, draft.id, draft.definitionHash!, view.sourceFingerprint!)
  const document = JSON.parse(readFileSync(exported.path, 'utf8'))
  const excerpts = document.milestones.flatMap((milestone: { criteria: { evidence?: { output_excerpt?: string } }[] }) => milestone.criteria.map(criterion => criterion.evidence?.output_excerpt ?? '')).join('\n')
  expect(excerpts).toContain('****')
  expect(excerpts).not.toContain('AUDIT_SYNTHETIC_')
}, 20000)

it('records actual Git HEAD for this worktree without starting a project-local executable', async () => {
  const stamp = await fingerprintProject(process.cwd())
  expect(stamp.gitHead).toMatch(/^[a-f0-9]{40}([a-f0-9]{24})?$/)
  expect(stamp.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  const dir = directory()
  const local = join(dir, 'git.exe')
  writeFileSync(local, 'not a trusted executable')
  await expect(fingerprintProject(dir, { gitPath: local })).rejects.toThrow(/outside the project/i)
  expect(existsSync(local)).toBe(true)
}, 15000)

it('refuses oversized source files instead of issuing incomplete freshness evidence', async () => {
  const dir = directory()
  writeFileSync(join(dir, 'oversized.ts'), Buffer.alloc(4 * 1024 * 1024 + 1))
  await expect(fingerprintProject(dir, { gitPath: null })).rejects.toThrow(/byte limit/i)
})

it('persists a pending check so a separate read-only instance sees running state', async () => {
  const dir = directory()
  const path = join(directory(), 'cockpit.db')
  const store = new CockpitStore(path)
  const repository = new ContractRepository(store)
  const runner = new CheckRunner(store, repository, { timeoutMs: 10000 })
  Object.assign(fixtures[0], { store, runner })
  const project = store.ensureProject(dir)
  const command = `"${process.execPath}" -e "require('node:fs').writeFileSync('started.marker','yes');setInterval(()=>{},1000)"`
  const draft = await repository.create(project.id, { title: 'Pending check', objective: 'Share pending status', maxSessions: 2, maxHours: 1, command })
  await repository.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  const pending = runner.run(project.id, draft.id, 'AC1')
  const reader = new CockpitStore(path, { readOnly: true })
  try {
    const deadline = Date.now() + 8000
    await Promise.race([
      (async () => { while (!existsSync(join(dir, 'started.marker'))) { if (Date.now() > deadline) throw new Error('Check did not start'); await delay(20) } })(),
      pending.then(() => { throw new Error('Check ended before its start marker') })
    ])
    expect(reader.runs(project.id, draft.id)[0]?.finishedAt).toBeNull()
    const readRepository = new ContractRepository(reader)
    const readRunner = new CheckRunner(reader, readRepository)
    try { expect((await readRepository.list(project.id))[0].running).toBe(true) } finally { await readRunner.close() }
  } finally { reader.close(); runner.cancel(project.id, draft.id); await pending }
}, 15000)
