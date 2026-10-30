import type { ContractDocument } from '../../shared/cockpit'

/** Independent parser input, kept with the tests rather than the owner's untracked project drafts. */
export function contractFixture(): ContractDocument {
  return {
    schema_version: 'cockpit-contract/1', contract_id: 'C-FIXTURE', project: 'fixture-project',
    title: 'Verified delivery', objective: 'Deliver observable behavior with current evidence', status: 'draft',
    non_goals: ['Approve manual criteria automatically'],
    budget: { max_sessions: 2, max_hours: 1, stop_when_exceeded: true },
    milestones: [
      { id: 'M1', title: 'Automated proof', criteria: [
        { id: 'AC1', type: 'automated', description: 'The check actually exits successfully', check: { command: 'echo fixture', expect: 'exit_code_0' }, status: 'open', evidence: null }
      ] },
      { id: 'M2', title: 'Owner review', criteria: [
        { id: 'AC2', type: 'manual', description: 'The owner accepts the visible result', status: 'open', approved_by: null }
      ] }
    ],
    approved_by: null, frozen_at: null, amendments: [], links: { sessions: [], code_guardian_task: null }
  }
}
