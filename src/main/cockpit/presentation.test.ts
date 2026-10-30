import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { criterionState, milestoneProgress } from '../../renderer/src/views/cockpit-model'
import { ContractRepository } from './contracts'
import { CockpitStore } from './store'

it('keeps cancelled contract criteria and milestone progress consistent with the repository', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'clio-presentation-'))
  const store = new CockpitStore(':memory:')
  try {
    const project = store.ensureProject(directory)
    const repository = new ContractRepository(store)
    const fingerprint = 'a'.repeat(64)
    repository.setFingerprintProvider(async () => ({ fingerprint, gitHead: 'head', error: null }))
    const draft = await repository.create(project.id, { title: 'Delivery', objective: 'Deliver a verified result', maxSessions: 2, maxHours: 1, command: 'verify' })
    const frozen = await repository.freeze(project.id, draft.id, 'Owner', draft.definitionHash!)
    store.recordRun({ projectId: project.id, contractId: draft.id, criterionId: 'AC1', startedAt: 'started', finishedAt: 'finished', command: 'verify', exitCode: 0, signal: null, stdout: 'passed', stderr: '', error: null, gitHead: 'head', freezeHash: frozen.definitionHash!, sourceFingerprint: fingerprint, passed: true })
    const accepted = await repository.approveManual(project.id, draft.id, 'AC2', 'Owner', frozen.definitionHash!, fingerprint)
    expect(accepted.progress).toEqual({ met: 2, total: 2 })
    expect(accepted.document!.milestones.flatMap((milestone) => milestone.criteria.map((criterion) => criterionState(accepted, criterion)))).toEqual(['met', 'met'])

    const document = JSON.parse(readFileSync(draft.path, 'utf8'))
    document.status = 'cancelled'
    writeFileSync(draft.path, JSON.stringify(document))
    const cancelled = (await repository.list(project.id))[0]
    expect(cancelled.document!.status).toBe('cancelled')
    expect(cancelled.changed).toBe(false)
    expect(cancelled.freeze).toEqual(accepted.freeze)
    expect(cancelled.runs).toHaveLength(1)
    expect(cancelled.manualApprovals).toHaveLength(1)
    expect(cancelled.progress).toEqual({ met: 0, total: 2 })
    expect(cancelled.document!.milestones.flatMap((milestone) => milestone.criteria.map((criterion) => criterion.status))).toEqual(['open', 'open'])
    expect(cancelled.document!.milestones.flatMap((milestone) => milestone.criteria.map((criterion) => criterionState(cancelled, criterion)))).toEqual(['open', 'open'])
    expect(milestoneProgress(cancelled, cancelled.document!.milestones[0])).toEqual(cancelled.progress)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
