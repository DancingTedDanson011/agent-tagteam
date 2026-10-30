import { expect, it } from 'vitest'
import { generateGoal } from './contracts'
import { contractFixture } from './contract.fixture'

it('names the real MCP check tool and every open criterion within the goal limit', () => {
  const document = contractFixture()
  const text = generateGoal(document, ['AC1', 'AC2'], 'clio.run_contract_check')
  expect(text).toContain('run_contract_check')
  expect(text).toContain(document.contract_id)
  expect(text).toContain('AC1')
  expect(text).toContain('AC2')
  expect(text.length).toBeLessThanOrEqual(4000)
})
