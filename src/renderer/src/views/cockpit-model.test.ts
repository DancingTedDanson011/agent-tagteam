import { describe, expect, it } from 'vitest'
import type { ContractCriterion, ContractStatus, ContractView, CriterionRun } from '../../../shared/cockpit'
import { criterionState, currentRun, elapsedTime, milestoneProgress } from './cockpit-model'

const criterion: ContractCriterion = { id: 'AC-test', type: 'automated', description: 'A real check', status: 'met', check: { command: 'npm test', expect: 'exit_code_0' } }
const manual: ContractCriterion = { id: 'AC-manual', type: 'manual', description: 'Owner accepts the result', status: 'met' }
const base = (): ContractView => ({
  id: 'C-test', path: '/project/.contracts/C-test.json', document: {
    contract_id: 'C-test', project: 'project', title: 'Delivery', status: 'frozen', objective: 'Deliver a verified result',
    non_goals: [], budget: { max_sessions: 2, max_hours: 1, stop_when_exceeded: true },
    milestones: [{ id: 'M-test', title: 'Outcome', criteria: [criterion, manual] }],
    approved_by: 'Owner', frozen_at: '2026-10-30T00:00:00Z', amendments: [], links: { sessions: [], code_guardian_task: null }
  }, errors: [], definitionHash: 'current',
  freeze: { hash: 'current', approvedBy: 'Owner', at: '2026-10-30T00:00:00Z' }, changed: false, sourceFingerprint: 'source-current',
  runs: [], manualApprovals: [], progress: { met: 0, total: 1 }, usage: { sessions: 0, observedSeconds: 0, exceeded: false },
  fulfilled: false, running: false, goalText: null
})
const run = (id: number, partial: Partial<CriterionRun> = {}): CriterionRun => ({
  id, projectId: 1, contractId: 'C-test', criterionId: 'AC-test', startedAt: '2026-10-30T00:00:00Z',
  finishedAt: '2026-10-30T00:00:01Z', command: 'npm test', exitCode: 0, signal: null, stdout: '', stderr: '',
  error: null, gitHead: 'revision', freezeHash: 'current', sourceFingerprint: 'source-current', passed: true, ...partial
})
const withCurrentEvidence = (status: ContractStatus): ContractView => {
  const contract = base()
  contract.document!.status = status
  contract.runs = [run(1)]
  contract.manualApprovals = [{ criterionId: manual.id, approvedBy: 'Owner', at: '2026-10-30T00:00:00Z', freezeHash: 'current', sourceFingerprint: 'source-current' }]
  return contract
}

describe('criterion evidence shown by the cockpit', () => {
  it.each<ContractStatus>(['draft', 'amended', 'cancelled'])('does not count current evidence for an inactive %s contract', (status) => {
    const contract = withCurrentEvidence(status)
    expect([criterionState(contract, criterion), criterionState(contract, manual)]).toEqual(['open', 'open'])
    expect(milestoneProgress(contract, contract.document!.milestones[0])).toEqual({ met: 0, total: 2 })
  })
  it.each<ContractStatus>(['frozen', 'in_progress', 'fulfilled'])('counts current evidence for an active %s contract', (status) => {
    const contract = withCurrentEvidence(status)
    expect([criterionState(contract, criterion), criterionState(contract, manual)]).toEqual(['met', 'met'])
    expect(milestoneProgress(contract, contract.document!.milestones[0])).toEqual({ met: 2, total: 2 })
  })
  it('does not count retained evidence when the contract document is unavailable', () => {
    const contract = { ...withCurrentEvidence('frozen'), document: null }
    expect([criterionState(contract, criterion), criterionState(contract, manual)]).toEqual(['open', 'open'])
    expect(milestoneProgress(contract, { id: 'M-test', title: 'Outcome', criteria: [criterion, manual] })).toEqual({ met: 0, total: 2 })
  })
  it('ignores a file-authored met status without an executed check', () => {
    expect(criterionState(base(), criterion)).toBe('open')
  })
  it('uses the newest run for the current frozen definition, independent of array order', () => {
    const contract = { ...base(), runs: [run(3, { freezeHash: 'old' }), run(1), run(2, { passed: false, exitCode: 1 })] }
    expect(currentRun(contract, criterion.id)?.id).toBe(2)
    expect(criterionState(contract, criterion)).toBe('failed')
  })
  it('shows a running check separately from a finished failure', () => {
    expect(criterionState({ ...base(), runs: [run(1, { finishedAt: null, exitCode: null, passed: false })] }, criterion)).toBe('running')
  })
  it('invalidates old successful checks when the contract definition changes', () => {
    const contract = { ...base(), changed: true, runs: [run(1)] }
    expect(criterionState(contract, criterion)).toBe('stale')
    expect(currentRun(contract, criterion.id)).toBeNull()
  })
  it('never counts results for an unfrozen draft', () => {
    expect(criterionState({ ...base(), freeze: null, runs: [run(1)] }, criterion)).toBe('open')
  })
  it('invalidates automatic evidence after the checked source tree changes', () => {
    expect(criterionState({ ...base(), runs: [run(1, { sourceFingerprint: 'old-source' })] }, criterion)).toBe('stale')
  })
  it('invalidates manual approvals after the inspected source tree changes', () => {
    const manual = { ...criterion, type: 'manual' as const }
    const contract = { ...base(), manualApprovals: [{ criterionId: manual.id, approvedBy: 'Owner', at: '2026-10-30T00:00:00Z',
      freezeHash: 'current', sourceFingerprint: 'old-source' }] }
    expect(criterionState(contract, manual)).toBe('stale')
  })
  it('requires manual approval for the current freeze instead of trusting the document status', () => {
    const manual = { ...criterion, type: 'manual' as const }
    const contract = { ...base(), manualApprovals: [{ criterionId: manual.id, approvedBy: 'Owner', at: '2026-10-30T00:00:00Z', freezeHash: 'old', sourceFingerprint: 'source-current' }] }
    expect(criterionState(contract, manual)).toBe('open')
    contract.manualApprovals[0].freezeHash = 'current'
    expect(criterionState(contract, manual)).toBe('met')
    expect(milestoneProgress(contract, { id: 'M-test', title: 'Outcome', criteria: [manual] })).toEqual({ met: 1, total: 1 })
  })
})

describe('observed elapsed time', () => {
  it('formats observed seconds without inventing costs or dropping seconds', () => {
    expect(elapsedTime(3661)).toBe('01:01:01')
    expect(elapsedTime(0)).toBe('00:00:00')
    expect(elapsedTime(Number.NaN)).toBe('—')
    expect(elapsedTime(-1)).toBe('—')
  })
})
