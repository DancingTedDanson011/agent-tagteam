import { describe, expect, it } from 'vitest'
import { definitionHash, parseContract } from './contracts'
import { contractFixture as fixture } from './contract.fixture'
describe('strict contract validation', () => {
  it('accepts an independent contract with automated and manual milestone criteria', () => {
    const value = fixture()
    expect(parseContract(value)).toEqual({ document: value, errors: [] })
  })
  it('rejects unknown properties, semantic duplicate IDs, wrong budgets and wrong check variants', () => {
    const invalid = [
      (value: any) => { value.extra = true },
      (value: any) => { value.milestones[1].id = value.milestones[0].id },
      (value: any) => { value.milestones[1].criteria[0].id = value.milestones[0].criteria[0].id },
      (value: any) => { value.budget.max_sessions = 0 },
      (value: any) => { delete value.milestones[0].criteria[0].check },
      (value: any) => { value.milestones[0].criteria[0].type = 'manual' },
      (value: any) => { value.milestones[0].criteria[0].check.command = '' }
    ]
    for (const change of invalid) {
      const value = fixture()
      change(value)
      expect(parseContract(value).document).toBeNull()
      expect(parseContract(value).errors.length).toBeGreaterThan(0)
    }
  })
  it('binds definitions while allowing mutable result fields to change', () => {
    const value = fixture()
    const original = definitionHash(value)
    value.milestones[0].criteria[0].status = 'met'
    value.milestones[0].criteria[0].approved_by = 'forged'
    value.milestones[0].criteria[0].evidence = { command: 'x', exit_code: 0, at: 'now' }
    expect(definitionHash(value)).toBe(original)
    value.milestones[0].criteria[0].check!.command = 'different command'
    expect(definitionHash(value)).not.toBe(original)
  })
  it('accepts a structured source fingerprint in evidence and rejects malformed fingerprints', () => {
    const value = fixture()
    value.milestones[0].criteria[0].evidence = { command: 'verify', exit_code: 0, at: 'now', source_fingerprint: 'a'.repeat(64) }
    expect(parseContract(value).document).not.toBeNull()
    value.milestones[0].criteria[0].evidence.source_fingerprint = 'invalid'
    expect(parseContract(value).document).toBeNull()
  })
})
