import { describe, expect, it } from 'vitest'
import { parseWorkspaces } from './validate'
import { parseCockpitCommand as parse } from './cockpit'

describe('cockpit workspace mode', () => {
  it('restores the cockpit even when no terminal is captured', () => {
    expect(parseWorkspaces([{ id: 'projects', name: 'Projects', view: 'cockpit', slots: [] }]))
      .toEqual([{ id: 'projects', name: 'Projects', view: 'cockpit', slots: [] }])
  })
})

describe('cockpit command boundary', () => {
  it('accepts a clean task request and drops unrelated fields', () => {
    expect(parse({ type: 'create-task', projectId: 1, title: 'Review result', injected: 'ignored' }))
      .toEqual({ type: 'create-task', projectId: 1, title: 'Review result' })
  })

  it('rejects malformed ids and never accepts a direct shell execution request', () => {
    for (const value of [null, [], { type: 'create-task', projectId: -1, title: 'Task' },
      { type: 'move-task', projectId: 1, taskId: 1, state: 'invented' },
      { type: 'run-criterion', projectId: 1, contractId: '../../escape', criterionId: 'AC1' },
      { type: 'execute', command: 'arbitrary' }, { type: 'save-settings', level: 'overview', retentionDays: Infinity }]) {
      expect(parse(value)).toBeNull()
    }
  })

  it('requires the exact reviewed hashes before a contract can be changed or accepted', () => {
    const hash = 'a'.repeat(64)
    expect(parse({ type: 'freeze-contract', projectId: 1, contractId: 'C-TEST', approvedBy: 'Owner' })).toBeNull()
    expect(parse({ type: 'freeze-contract', projectId: 1, contractId: 'C-TEST', approvedBy: 'Owner', expectedDefinitionHash: hash }))
      .toEqual({ type: 'freeze-contract', projectId: 1, contractId: 'C-TEST', approvedBy: 'Owner', expectedDefinitionHash: hash })
    expect(parse({ type: 'approve-criterion', projectId: 1, contractId: 'C-TEST', criterionId: 'AC1', approvedBy: 'Owner', expectedFreezeHash: hash })).toBeNull()
  })
})
