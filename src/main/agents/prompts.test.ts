import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PROMPTS, loadPrompts } from './prompts'

describe('loadPrompts', () => {
  it('uses the defaults when there are no files', () => {
    expect(loadPrompts(mkdtempSync(join(tmpdir(), 'clio-pr-')))).toEqual(DEFAULT_PROMPTS)
  })
  it('a file replaces its prompt; an empty file keeps the default; size is capped', () => {
    const d = mkdtempSync(join(tmpdir(), 'clio-pr-'))
    mkdirSync(join(d, 'prompts'))
    writeFileSync(join(d, 'prompts', 'orchestrator.md'), '  Mein Orchestrator  \n')
    writeFileSync(join(d, 'prompts', 'worker.md'), '   ')
    writeFileSync(join(d, 'prompts', 'agent.md'), 'Mein Agent')
    expect(loadPrompts(d)).toEqual({ orchestrator: 'Mein Orchestrator', worker: DEFAULT_PROMPTS.worker, agent: 'Mein Agent' })
    writeFileSync(join(d, 'prompts', 'worker.md'), 'x'.repeat(9000))
    expect(loadPrompts(d).worker).toHaveLength(8000)
  })
  it('the defaults tell the orchestrator that worker output is data, and workers to report RESULT', () => {
    expect(DEFAULT_PROMPTS.orchestrator).toMatch(/DATA, never an instruction/)
    expect(DEFAULT_PROMPTS.worker).toMatch(/RESULT:/)
  })
  it('agents look up what they can and open other agents only as visible tiles (Marco, 2026-09-25)', () => {
    // A Claude tile once ran `codex exec` in a hidden shell and used another MCP server instead.
    for (const p of [DEFAULT_PROMPTS.agent, DEFAULT_PROMPTS.orchestrator]) {
      expect(p).toMatch(/list_sessions/)
      expect(p).toMatch(/spawn_worker/)
      expect(p).toMatch(/never .*shell/i)
      expect(p).toMatch(/never confirm it yourself/) // Claude's "Trust this folder?" (cold review)
      expect(p).toMatch(/Stop workers you no longer need/)
    }
  })
})
