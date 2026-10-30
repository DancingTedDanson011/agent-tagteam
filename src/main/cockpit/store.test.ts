import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CockpitStore } from './store'

const dirs: string[] = []
const stores: CockpitStore[] = []
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'clio-store-'))
  dirs.push(dir)
  const path = join(dir, 'cockpit.db')
  const store = new CockpitStore(path)
  stores.push(store)
  const project = store.ensureProject(dir, 'Fixture')
  return { dir, path, store, project }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('persistent cockpit state', () => {
  it('opens a new local database', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clio-store-'))
    dirs.push(dir)
    expect(() => stores.push(new CockpitStore(join(dir, 'cockpit.db')))).not.toThrow()
  })

  it('keeps task state across reopening and allows concurrent read-only snapshots', () => {
    const { store, path, project } = setup()
    const task = store.createTask(project.id, 'Deliver evidence')
    store.moveTask(task.id, 'doing')
    const reader = new CockpitStore(path, { readOnly: true })
    stores.push(reader)
    expect(reader.tasks(project.id)[0].state).toBe('doing')
    expect(() => reader.createTask(project.id, 'forbidden')).toThrow(/read.only/i)
    store.close()
    const reopened = new CockpitStore(path)
    stores.push(reopened)
    expect(reopened.tasks(project.id)[0].title).toBe('Deliver evidence')
  })

  it('upserts an open wait, closes absent waits and allows the same wait to reopen', () => {
    const { store, project } = setup()
    store.upsertSession({ sessionId: 'session', projectId: project.id, cwd: project.rootPath, state: 'waiting' })
    store.reconcileWaiting('session', [{ kind: 'question', source: 'hook', ref: 'tool', summary: 'Before' }])
    store.reconcileWaiting('session', [{ kind: 'question', source: 'hook', ref: 'tool', summary: 'After' }])
    expect(store.waitingItems(project.id)).toHaveLength(1)
    expect(store.waitingItems(project.id)[0].summary).toBe('After')
    store.reconcileWaiting('session', [])
    expect(store.waitingItems(project.id)).toHaveLength(0)
    store.reconcileWaiting('session', [{ kind: 'question', source: 'hook', ref: 'tool', summary: 'Again' }])
    expect(store.waitingItems(project.id)).toHaveLength(1)
    expect(store.waitingItems(project.id, true)).toHaveLength(2)
  })

  it('removes a stale tile association when a verified observation explicitly supplies null', () => {
    const { store, project } = setup()
    store.upsertSession({ sessionId: 'session', projectId: project.id, cwd: project.rootPath, state: 'running', tileId: 'a1' })
    store.upsertSession({ sessionId: 'session', projectId: project.id, cwd: project.rootPath, state: 'running', tileId: null })
    expect(store.sessions(project.id)[0].tileId).toBeNull()
  })

  it('enforces state and reference constraints in SQLite itself', () => {
    const { path, project } = setup()
    const raw = new DatabaseSync(path)
    try {
      raw.exec('PRAGMA foreign_keys=ON')
      expect(() => raw.prepare('INSERT INTO task(project_id,title,state,source,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(project.id, 'bad', 'invented', 'manual', 'now', 'now')).toThrow()
      expect(() => raw.prepare('INSERT INTO task(project_id,title,state,source,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(-1, 'bad', 'todo', 'manual', 'now', 'now')).toThrow()
      expect(raw.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')?.value).toBe('1')
    } finally {
      raw.close()
    }
  })

  it('retains events, settings, local owner freezes and revision-scoped manual evidence', () => {
    const { store, project } = setup()
    store.saveSettings({ preferredLevel: 2 })
    expect(store.getSettings()).toEqual({ preferredLevel: 2 })
    store.recordEvent({ projectId: project.id, source: 'hook', kind: 'Stop', payload: { outcome: 'ok' } })
    expect(store.events(project.id)[0].kind).toBe('Stop')
    store.saveFreeze(project.id, 'C-TEST', 'a'.repeat(64), 'Marco')
    expect(store.getFreeze(project.id, 'C-TEST')?.approvedBy).toBe('Marco')
    store.approveManual(project.id, 'C-TEST', 'AC1', 'a'.repeat(64), 'Marco', 'Observed')
    expect(store.manualApprovals(project.id, 'C-TEST', 'a'.repeat(64))).toHaveLength(1)
    expect(store.manualApprovals(project.id, 'C-TEST', 'b'.repeat(64))).toHaveLength(0)
  })

  it('rolls back a whole ingestion batch and deduplicates replayed events and external task updates', () => {
    const { store, project } = setup()
    expect(() => store.transaction(() => {
      store.createTask(project.id, 'rolled back')
      store.createTask(-1, 'invalid project')
    })).toThrow()
    expect(store.tasks(project.id)).toHaveLength(0)
    const first = store.recordEvent({ projectId: project.id, source: 'hook', kind: 'Stop', dedupeKey: 'event' })
    const second = store.recordEvent({ projectId: project.id, source: 'hook', kind: 'Stop', dedupeKey: 'event' })
    expect(second.id).toBe(first.id)
    expect(store.events(project.id)).toHaveLength(1)
    store.createTask(project.id, 'Before', { source: 'hook', sourceRef: 'task', state: 'todo' })
    store.createTask(project.id, 'After', { source: 'hook', sourceRef: 'task', state: 'doing' })
    expect(store.tasks(project.id)).toHaveLength(1)
    expect(store.tasks(project.id)[0]).toMatchObject({ title: 'After', state: 'doing' })
  })

  it('persists source-bound check evidence and refuses future schema versions without rewriting them', () => {
    const { store, path, project } = setup()
    store.saveFreeze(project.id, 'C-TEST', 'a'.repeat(64), 'Marco')
    const run = store.recordRun({ projectId: project.id, contractId: 'C-TEST', criterionId: 'AC1', startedAt: 'now', finishedAt: 'then', command: 'verify', exitCode: 0, signal: null, stdout: '', stderr: '', error: null, gitHead: null, freezeHash: 'a'.repeat(64), sourceFingerprint: 'tree', passed: true })
    expect(run.sourceFingerprint).toBe('tree')
    store.close()
    const raw = new DatabaseSync(path)
    raw.exec('PRAGMA user_version=99')
    raw.close()
    expect(() => new CockpitStore(path)).toThrow(/schema version/i)
    const after = new DatabaseSync(path)
    expect(after.prepare('PRAGMA user_version').get()?.user_version).toBe(99)
    after.close()
  })
  it('preserves source todo grammar and updates metadata without overwriting a local contract assignment', () => {
    const { store, project } = setup()
    store.saveFreeze(project.id, 'C-TEST', 'a'.repeat(64), 'Marco')
    const task = store.createTask(project.id, 'Deferred', { source: 'code_guardian', sourceRef: 'T-001', state: 'done', rawState: 'vertagt', metadata: { Wirkung: 'V', Beleg: 'Initial evidence' } })
    store.assignTask(task.id, 'C-TEST')
    const updated = store.createTask(project.id, 'Belongs elsewhere', { source: 'code_guardian', sourceRef: 'T-001', state: 'done', rawState: 'fremd', metadata: { Wirkung: 'V', Projekt: 'other-project' } })
    expect(updated.rawState).toBe('fremd')
    expect(updated.metadata).toEqual({ Wirkung: 'V', Projekt: 'other-project' })
    expect(updated.contractId).toBe('C-TEST')
  })
  it('masks credential values inside structured event payloads', () => {
    const { store, project } = setup()
    const event = store.recordEvent({ projectId: project.id, source: 'hook', kind: 'invalid', payload: { nested: { password: 'fixture-only-value' } } })
    expect(String(event.payload)).not.toContain('fixture-only-value')
  })
  it('retains valid JSON when a payload string contains a credential assignment', () => {
    const { store, project } = setup()
    const event = store.recordEvent({ projectId: project.id, source: 'hook', kind: 'invalid', payload: { message: 'api_key=fixture-only-value' } })
    expect(() => JSON.parse(String(event.payload))).not.toThrow()
    expect(String(event.payload)).not.toContain('fixture-only-value')
  })
  it('normalizes retention timestamps before comparing persisted ISO dates', () => {
    const { store, project } = setup()
    store.recordEvent({ projectId: project.id, source: 'manual', kind: 'old', at: '2026-01-01T00:00:00.000Z' })
    store.recordEvent({ projectId: project.id, source: 'manual', kind: 'new', at: '2026-12-31T00:00:00.000Z' })
    store.pruneEvents('October 1, 2026')
    expect(store.events(project.id).map((event) => event.kind)).toEqual(['new'])
  })
  it('persists verified process-start identity and permits an explicit unknown identity', () => {
    const { store, project } = setup()
    store.upsertSession({ sessionId: 'session', projectId: project.id, cwd: project.rootPath, state: 'running', procStart: 'verified-start' })
    expect(store.sessions(project.id)[0].procStart).toBe('verified-start')
    store.upsertSession({ sessionId: 'session', projectId: project.id, cwd: project.rootPath, state: 'running', procStart: null })
    expect(store.sessions(project.id)[0].procStart).toBeNull()
  })
  it('leaves pending runs intact for readers and closes interrupted runs on the next writer', () => {
    const { store, path, project } = setup()
    store.saveFreeze(project.id, 'C-TEST', 'a'.repeat(64), 'Marco')
    const finished = store.recordRun({ projectId: project.id, contractId: 'C-TEST', criterionId: 'AC2', startedAt: 'before', finishedAt: 'then', command: 'already verified', exitCode: 0, signal: null, stdout: 'passed', stderr: '', error: null, gitHead: null, freezeHash: 'a'.repeat(64), sourceFingerprint: 'a'.repeat(64), passed: true })
    store.recordRun({ projectId: project.id, contractId: 'C-TEST', criterionId: 'AC1', startedAt: 'now', finishedAt: null, command: 'verify', exitCode: null, signal: null, stdout: '', stderr: '', error: null, gitHead: null, freezeHash: 'a'.repeat(64), sourceFingerprint: null, passed: false })
    const reader = new CockpitStore(path, { readOnly: true })
    expect(reader.runs(project.id)[0].finishedAt).toBeNull()
    expect(reader.runById(finished.id)).toEqual(finished)
    reader.close()
    store.close()
    const writer = new CockpitStore(path)
    stores.push(writer)
    expect(writer.runs(project.id)[0].finishedAt).not.toBeNull()
    expect(writer.runs(project.id)[0].error).toMatch(/interrupted/i)
    expect(writer.runs(project.id)[0].passed).toBe(false)
    expect(writer.runs(project.id)[0].exitCode).toBeNull()
    expect(writer.runById(finished.id)).toEqual(finished)
  })
})
