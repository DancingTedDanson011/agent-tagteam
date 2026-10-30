import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ContractRepository } from './contracts'
import { CockpitStore } from './store'

const fixtures: { dir: string; store: CockpitStore }[] = []
const SOURCE_A = 'a'.repeat(64)
const SOURCE_B = 'b'.repeat(64)
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'clio-contract-'))
  const store = new CockpitStore(join(dir, 'state', 'cockpit.db'))
  fixtures.push({ dir, store })
  const project = store.ensureProject(dir)
  const repository = new ContractRepository(store)
  let fingerprint = SOURCE_A
  repository.setFingerprintProvider(async () => ({ fingerprint, gitHead: 'head', error: null }))
  const view = await repository.create(project.id, { title: 'Delivery', objective: 'Deliver a verified feature', maxSessions: 2, maxHours: 1, command: 'node -e "process.exit(0)"' })
  return { dir, store, project, repository, view, changeSource: () => { fingerprint = SOURCE_B } }
}
afterEach(() => {
  for (const item of fixtures.splice(0)) { item.store.close(); rmSync(item.dir, { recursive: true, force: true }) }
})

describe('local owner authority', () => {
  it('creates a valid lightweight draft before any owner approval', async () => {
    const { view } = await fixture()
    expect(view.document?.status).toBe('draft')
    expect(view.document?.milestones).toHaveLength(1)
    expect(view.document?.milestones[0].criteria).toHaveLength(2)
    expect(view.freeze).toBeNull()
  })
  it('does not trust forged approval/result fields in a project file', async () => {
    const { repository, project, view } = await fixture()
    const forged = { ...view.document!, status: 'frozen', approved_by: 'agent', frozen_at: new Date().toISOString() }
    forged.milestones[0].criteria.forEach((criterion) => { criterion.status = 'met'; criterion.approved_by = 'agent' })
    writeFileSync(view.path, JSON.stringify(forged))
    expect(() => repository.assertRunnable(project.id, view.id, 'AC1')).toThrow(/owner|freeze/i)
    const current = (await repository.list(project.id))[0]
    expect(current.fulfilled).toBe(false)
    expect(current.progress.met).toBe(0)
  })
  it('requires an amendment before a frozen definition can be edited, then a new freeze', async () => {
    const { repository, project, view } = await fixture()
    const frozen = await repository.freeze(project.id, view.id, 'Marco', view.definitionHash!)
    expect(frozen.freeze?.approvedBy).toBe('Marco')
    const changed = JSON.parse(readFileSync(view.path, 'utf8'))
    changed.objective = 'Changed delivery'
    await expect(repository.save(project.id, view.id, JSON.stringify(changed), frozen.definitionHash!)).rejects.toThrow(/amendment/i)
    await repository.amend(project.id, view.id, 'Update objective', frozen.definitionHash!)
    const saved = await repository.save(project.id, view.id, JSON.stringify({ ...changed, status: 'draft', approved_by: null, frozen_at: null }), frozen.definitionHash!)
    expect(repository.store.getFreeze(project.id, view.id)).toBeNull()
    const revised = await repository.freeze(project.id, view.id, 'Marco', saved.definitionHash!)
    expect(revised.definitionHash).not.toBe(frozen.definitionHash)
  })
  it('needs the latest current-source run and a local manual approval for fulfillment', async () => {
    const { repository, project, view, store, changeSource } = await fixture()
    const frozen = await repository.freeze(project.id, view.id, 'Marco', view.definitionHash!)
    const evidence = { projectId: project.id, contractId: view.id, criterionId: 'AC1', startedAt: 'now', finishedAt: 'then', command: 'verify', exitCode: 0, signal: null, stdout: '', stderr: '', error: null, gitHead: 'head', freezeHash: frozen.definitionHash!, sourceFingerprint: SOURCE_A, passed: true }
    store.recordRun(evidence)
    expect((await repository.list(project.id))[0].fulfilled).toBe(false)
    await repository.approveManual(project.id, view.id, 'AC2', 'Marco', frozen.definitionHash!, SOURCE_A)
    expect((await repository.list(project.id))[0].fulfilled).toBe(true)
    store.recordRun({ ...evidence, exitCode: 1, passed: false })
    expect((await repository.list(project.id))[0].fulfilled).toBe(false)
    store.recordRun(evidence)
    changeSource()
    expect((await repository.list(project.id))[0].progress.met).toBe(0)
  })

  it('rejects a changed definition after owner review and a stale manual source review', async () => {
    const { repository, project, view, changeSource } = await fixture()
    const changed = JSON.parse(readFileSync(view.path, 'utf8'))
    changed.objective = 'Changed after the dialog opened'
    writeFileSync(view.path, JSON.stringify(changed))
    await expect(repository.freeze(project.id, view.id, 'Marco', view.definitionHash!)).rejects.toThrow(/review|changed/i)
    expect(repository.store.getFreeze(project.id, view.id)).toBeNull()
    const current = (await repository.list(project.id))[0]
    const frozen = await repository.freeze(project.id, view.id, 'Marco', current.definitionHash!)
    changeSource()
    await expect(repository.approveManual(project.id, view.id, 'AC2', 'Marco', frozen.definitionHash!, SOURCE_A)).rejects.toThrow(/review|source/i)
    expect(repository.store.manualApprovals(project.id, view.id)).toHaveLength(0)
  })

  it('does not fingerprint drafts and refuses stale editor/amendment review tokens', async () => {
    const { repository, project, view } = await fixture()
    let calls = 0
    repository.setFingerprintProvider(async () => { calls++; return { fingerprint: SOURCE_A, gitHead: 'head', error: null } })
    await repository.list(project.id)
    expect(calls).toBe(0)
    await expect(repository.save(project.id, view.id, JSON.stringify(view.document), '0'.repeat(64))).rejects.toThrow(/review|changed/i)
    const frozen = await repository.freeze(project.id, view.id, 'Marco', view.definitionHash!)
    await expect(repository.amend(project.id, view.id, 'Stale review', '0'.repeat(64))).rejects.toThrow(/review|changed/i)
    expect(repository.store.getFreeze(project.id, view.id)?.hash).toBe(frozen.definitionHash)
  })
  it('writes a schema-valid completion snapshot only after all current owner and runner evidence exists', async () => {
    const { repository, project, view, store } = await fixture()
    const frozen = await repository.freeze(project.id, view.id, 'Marco', view.definitionHash!)
    await expect(repository.finalize(project.id, view.id, frozen.definitionHash!, SOURCE_A)).rejects.toThrow(/criteria|fulfilled/i)
    store.recordRun({ projectId: project.id, contractId: view.id, criterionId: 'AC1', startedAt: 'now', finishedAt: 'then', command: 'verify', exitCode: 0, signal: null, stdout: 'passed', stderr: '', error: null, gitHead: 'head', freezeHash: frozen.definitionHash!, sourceFingerprint: SOURCE_A, passed: true })
    await repository.approveManual(project.id, view.id, 'AC2', 'Marco', frozen.definitionHash!, SOURCE_A)
    await repository.finalize(project.id, view.id, frozen.definitionHash!, SOURCE_A)
    const snapshot = JSON.parse(readFileSync(view.path, 'utf8'))
    expect(snapshot.status).toBe('fulfilled')
    expect(snapshot.milestones[0].criteria[0].evidence.source_fingerprint).toBe(SOURCE_A)
    expect((await repository.list(project.id))[0].definitionHash).toBe(frozen.definitionHash)
  })
  it('does not declare or export fulfillment while a newer check is still running', async () => {
    const { repository, project, view, store } = await fixture()
    const frozen = await repository.freeze(project.id, view.id, 'Marco', view.definitionHash!)
    store.recordRun({ projectId: project.id, contractId: view.id, criterionId: 'AC1', startedAt: 'now', finishedAt: 'then', command: 'verify', exitCode: 0, signal: null, stdout: '', stderr: '', error: null, gitHead: 'head', freezeHash: frozen.definitionHash!, sourceFingerprint: SOURCE_A, passed: true })
    await repository.approveManual(project.id, view.id, 'AC2', 'Marco', frozen.definitionHash!, SOURCE_A)
    repository.setRunningProvider(() => true)
    expect((await repository.list(project.id))[0].fulfilled).toBe(false)
    await expect(repository.finalize(project.id, view.id, frozen.definitionHash!, SOURCE_A)).rejects.toThrow(/running|fulfilled/i)
  })
})
