import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { ContractRepository } from './contracts'
import { CockpitStore, type RunInput } from './store'
import * as storage from './store'

const fixtures: { dir: string; store: CockpitStore }[] = []
const SOURCE = 'a'.repeat(64)
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-latest-'))
  const path = join(dir, 'cockpit.db')
  const store = new CockpitStore(path)
  fixtures.push({ dir, store })
  const project = store.ensureProject(dir)
  store.saveFreeze(project.id, 'C-TEST', SOURCE, 'Marco')
  const evidence: RunInput = { projectId: project.id, contractId: 'C-TEST', criterionId: 'AC1', startedAt: 'now', finishedAt: 'then', command: 'verify', exitCode: 0, signal: null, stdout: '', stderr: '', error: null, gitHead: null, freezeHash: SOURCE, sourceFingerprint: SOURCE, passed: true }
  return { dir, path, store, project, evidence }
}
afterEach(() => { vi.restoreAllMocks(); for (const { store, dir } of fixtures.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }) } })

it('bounds the normal snapshot by criteria and lets a newer failure or pending check invalidate older proof', async () => {
  const { store, project, evidence } = setup()
  const contracts = new ContractRepository(store)
  contracts.setFingerprintProvider(async () => ({ fingerprint: SOURCE, gitHead: null, error: null }))
  const draft = await contracts.create(project.id, { title: 'Bounded evidence', objective: 'Keep current proof', maxSessions: 2, maxHours: 1, criteria: [{ description: 'First result', command: 'first-check' }, { description: 'Second result', command: 'second-check' }] })
  const frozen = await contracts.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  const current = { ...evidence, contractId: draft.id, freezeHash: frozen.definitionHash! }
  store.recordRun({ ...current, stdout: 'old-output-' + 'x'.repeat(30000) })
  store.recordRun({ ...current, criterionId: 'AC2', stdout: 'old-output-' + 'x'.repeat(30000) })
  expect((await contracts.list(project.id))[0].fulfilled).toBe(true)
  const failed = store.recordRun({ ...current, passed: false, exitCode: 1, error: 'failed' })
  const pending = store.recordRun({ ...current, criterionId: 'AC2', finishedAt: null, passed: false, exitCode: null })
  store.recordRun({ ...current, criterionId: 'AC99', stdout: 'retired-criterion-output', freezeHash: 'b'.repeat(64) })
  const view = (await contracts.list(project.id))[0]
  expect(view.runs.map((run) => run.id)).toEqual([pending.id, failed.id])
  expect(view.runs.some((run) => run.stdout.includes('old-output-'))).toBe(false)
  expect(view.fulfilled).toBe(false)
  expect(view.running).toBe(true)
  expect(view.progress.met).toBe(0)
  expect(view.document?.milestones[0].criteria.map((criterion) => criterion.status)).toEqual(['failed', 'open'])
  expect(store.runs(project.id, draft.id)).toHaveLength(5)
  vi.spyOn(store, 'runs').mockImplementation(() => { throw new Error('Full output history must not be loaded by a normal snapshot') })
  expect((await contracts.list(project.id))[0].runs).toHaveLength(2)
})

it('returns inserted and finished runs directly without reading output history', () => {
  const { store, evidence } = setup()
  vi.spyOn(store, 'runs').mockImplementation(() => { throw new Error('Full output history must not be loaded by a write') })
  const pending = store.recordRun({ ...evidence, passed: false, finishedAt: null, exitCode: null })
  const finished = store.finishRun(pending.id, evidence)
  expect(finished).toMatchObject({ id: pending.id, passed: true, finishedAt: 'then' })
  expect(store.runById(pending.id)).toEqual(finished)
  expect(store.runById(-1)).toBeNull()
})

it('uses covering latest-run grouping and event indexes for the actual query shapes', () => {
  const { path, project } = setup()
  const database = new DatabaseSync(path)
  try {
    const plan = (sql: string, ...args: (number | string)[]) => database.prepare('EXPLAIN QUERY PLAN ' + sql).all(...args).map((row) => String(row.detail)).join('\n')
    const latest = plan(storage.latestRunsSql(2), project.id, 'C-TEST', 'AC1', 'AC2')
    const events = plan('SELECT * FROM event WHERE project_id=? ORDER BY id DESC LIMIT ?', project.id, 10)
    const retention = plan('DELETE FROM event WHERE at<?', '2026-01-01T00:00:00.000Z')
    expect(latest).toContain('USING COVERING INDEX criterion_run_latest')
    expect(latest).not.toContain('TEMP B-TREE FOR GROUP BY')
    expect(latest).toMatch(/SEARCH r USING INTEGER PRIMARY KEY/)
    expect(events).toContain('USING INDEX event_project_id')
    expect(events).not.toContain('TEMP B-TREE')
    expect(retention).toMatch(/USING (?:COVERING )?INDEX event_at/)
  } finally { database.close() }
})

it('reads the latest proof after asynchronous fingerprinting so a newly started check cannot revive an old green result', async () => {
  const { store, project, evidence } = setup()
  const contracts = new ContractRepository(store)
  contracts.setFingerprintProvider(async () => ({ fingerprint: SOURCE, gitHead: null, error: null }))
  const draft = await contracts.create(project.id, { title: 'Concurrent snapshot', objective: 'Read current run state', maxSessions: 2, maxHours: 1, criteria: [{ description: 'First', command: 'first' }, { description: 'Second', command: 'second' }] })
  const frozen = await contracts.freeze(project.id, draft.id, 'Marco', draft.definitionHash!)
  const current = { ...evidence, contractId: draft.id, freezeHash: frozen.definitionHash! }
  store.recordRun(current)
  store.recordRun({ ...current, criterionId: 'AC2' })
  let inserted = false
  contracts.setFingerprintProvider(async () => {
    if (!inserted) { inserted = true; store.recordRun({ ...current, finishedAt: null, passed: false, exitCode: null, sourceFingerprint: null }) }
    return { fingerprint: SOURCE, gitHead: null, error: null }
  })
  const view = (await contracts.list(project.id))[0]
  expect(view.running).toBe(true)
  expect(view.fulfilled).toBe(false)
  expect(view.runs.find((run) => run.criterionId === 'AC1')?.finishedAt).toBeNull()
})

it('adds missing optimization indexes on a writable reopen and leaves readonly schema and causal proof unchanged', () => {
  const { path, store } = setup()
  store.markToolCompleted('session', 'completed')
  store.close()
  const old = new DatabaseSync(path)
  old.exec('DROP INDEX IF EXISTS criterion_run_latest; DROP INDEX IF EXISTS event_project_id; DROP INDEX IF EXISTS event_at; CREATE INDEX IF NOT EXISTS event_project_at ON event(project_id,at)')
  const schema = () => old.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' ORDER BY name").all()
  const before = schema()
  const reader = new CockpitStore(path, { readOnly: true })
  try { expect(reader.isToolCompleted('session', 'completed')).toBe(true); expect(schema()).toEqual(before) } finally { reader.close(); old.close() }
  const writer = new CockpitStore(path)
  try {
    expect(writer.isToolCompleted('session', 'completed')).toBe(true)
    const check = new DatabaseSync(path, { readOnly: true })
    try {
      const names = check.prepare("SELECT name FROM sqlite_schema WHERE type='index'").all().map((row) => row.name)
      expect(names).toEqual(expect.arrayContaining(['criterion_run_latest', 'event_project_id', 'event_at', 'event_project_at']))
    } finally { check.close() }
  } finally { writer.close() }
})
