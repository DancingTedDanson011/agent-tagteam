import type { ContractCriterion, ContractView, CriterionRun, ContractMilestone } from '../../../shared/cockpit'

export type CriterionState = 'open' | 'met' | 'failed' | 'running' | 'stale'

/** File-authored status is not evidence. Only results tied to the current approved definition count. */
export function currentRun(contract: ContractView, criterionId: string): CriterionRun | null {
  if (!contract.freeze || contract.changed) return null
  return contract.runs
    .filter((run) => run.criterionId === criterionId && run.freezeHash === contract.freeze!.hash)
    .reduce<CriterionRun | null>((latest, run) => !latest || run.id > latest.id ? run : latest, null)
}

export function criterionState(contract: ContractView, criterion: ContractCriterion): CriterionState {
  if (contract.changed) return 'stale'
  if (!contract.freeze || !contract.document || !['frozen', 'in_progress', 'fulfilled'].includes(contract.document.status)) return 'open'
  if (criterion.type === 'manual') {
    const approvals = contract.manualApprovals.filter((approval) => approval.criterionId === criterion.id && approval.freezeHash === contract.freeze!.hash)
    if (contract.sourceFingerprint && approvals.some((approval) => approval.sourceFingerprint === contract.sourceFingerprint)) return 'met'
    return approvals.length ? 'stale' : 'open'
  }
  const run = currentRun(contract, criterion.id)
  if (!run) return 'open'
  if (!run.finishedAt) return 'running'
  if (!contract.sourceFingerprint || run.sourceFingerprint !== contract.sourceFingerprint) return 'stale'
  return run.passed ? 'met' : 'failed'
}

export function milestoneProgress(contract: ContractView, milestone: ContractMilestone): { met: number; total: number } {
  return { met: milestone.criteria.filter((criterion) => criterionState(contract, criterion) === 'met').length, total: milestone.criteria.length }
}

export function elapsedTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  const whole = Math.floor(seconds)
  return [Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60].map((part) => String(part).padStart(2, '0')).join(':')
}
