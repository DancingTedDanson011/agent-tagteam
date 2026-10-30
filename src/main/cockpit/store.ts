import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { CockpitSource, CockpitState, CriterionRun, ManualApproval, TaskState, WaitingKind } from '../../shared/cockpit'
import { redact } from '../agents/mcp'
import { sameDirectory } from '../fsutil'

export type ProjectRecord = { id: number; rootPath: string; name: string; viewLevel: number; createdAt: string }
export type SessionRecord = {
  sessionId: string; projectId: number; cwd: string; pid: number | null; procStart: string | null; tileId: string | null; name: string
  version: string; versionSupported: boolean; statusRaw: string | null; state: CockpitState; waitingFor: string | null
  startedAt: string; lastEventAt: string; endedAt: string | null; observedSeconds: number; contractId: string | null
}
export type SessionInput = Pick<SessionRecord, 'sessionId' | 'projectId' | 'cwd'> & Partial<Omit<SessionRecord, 'sessionId' | 'projectId' | 'cwd' | 'state'>> & { state: CockpitState | 'busy' | 'shell' }
export type WaitingInput = { kind: WaitingKind; source: CockpitSource; ref?: string; summary: string; openedAt?: string }
export type WaitingRecord = Required<WaitingInput> & { id: number; sessionId: string; projectId: number; tileId: string | null; resolvedAt: string | null }
export type TaskRecord = { id: number; projectId: number; contractId: string | null; sessionId: string | null; title: string; state: TaskState; source: 'manual' | 'hook' | 'code_guardian'; sourceRef: string | null; rawState: string | null; metadata: Record<string, string>; createdAt: string; updatedAt: string }
export type TaskOptions = Partial<Pick<TaskRecord, 'contractId' | 'sessionId' | 'source' | 'sourceRef' | 'state' | 'rawState' | 'metadata'>>
export type EventInput = { projectId?: number | null; sessionId?: string | null; at?: string; source: CockpitSource; kind: string; adapterVersion?: string; payload?: unknown; summary?: string; detail?: string; sourceRef?: string | null; dedupeKey?: string | null }
export type EventRecord = { id: number; projectId: number | null; sessionId: string | null; at: string; source: CockpitSource; kind: string; adapterVersion: string; payload: unknown; summary: string; detail: string; sourceRef: string | null }
export type FreezeRecord = { projectId: number; contractId: string; hash: string; approvedBy: string; at: string }
export type RunInput = Omit<CriterionRun, 'id'>
export type ManualApprovalRecord = ManualApproval & { projectId: number; contractId: string; note: string; sourceFingerprint: string | null }
type Row = Record<string, any>
const now = () => new Date().toISOString()
const clip = (value: string, max = 32768) => redact(value).slice(0, max)
const states = (value: CockpitState | 'busy' | 'shell'): CockpitState => value === 'busy' ? 'running' : value === 'shell' ? 'idle' : value
// Completion evidence can arrive before its session/project is resolvable, so it has no entity foreign key.
const COMPLETED_TOOL_SCHEMA = `CREATE TABLE IF NOT EXISTS completed_tool(
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 200),
  tool_use_id TEXT NOT NULL CHECK(length(tool_use_id) BETWEEN 1 AND 200),
  PRIMARY KEY(session_id,tool_use_id)
) WITHOUT ROWID;`
const QUERY_INDEX_SCHEMA = `
  CREATE INDEX IF NOT EXISTS criterion_run_latest ON criterion_run(project_id,contract_id,criterion_id,id);
  CREATE INDEX IF NOT EXISTS event_project_id ON event(project_id,id);
  CREATE INDEX IF NOT EXISTS event_at ON event(at);
`

export function latestRunsSql(criterionCount: number): string {
  if (!Number.isSafeInteger(criterionCount) || criterionCount < 1) throw new Error('Latest-run selection needs current criteria')
  const parameters = Array.from({ length: criterionCount }, () => '?').join(',')
  return `SELECT r.* FROM criterion_run r JOIN (
    SELECT max(id) AS id FROM criterion_run
    WHERE project_id=? AND contract_id=? AND criterion_id IN (${parameters})
    GROUP BY criterion_id
  ) latest ON latest.id=r.id ORDER BY r.id DESC`
}

/** Writable construction requires the app's separate writer lock; readers never migrate. */
export class CockpitStore {
  private readonly db: DatabaseSync
  private readonly readOnly: boolean
  private closed = false
  private transactionDepth = 0
  private savepoint = 0

  constructor(path: string, options: { readOnly?: boolean } = {}) {
    this.readOnly = options.readOnly === true
    if (!this.readOnly) mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path, { readOnly: this.readOnly })
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000')
      const version = Number((this.db.prepare('PRAGMA user_version').get() as Row).user_version)
      if (version > 1 || (this.readOnly && version !== 1)) throw new Error('Unsupported cockpit schema version')
      if (!this.readOnly) {
        this.db.exec('PRAGMA journal_mode=WAL')
        if (version === 0) this.migrate()
        else this.db.exec(COMPLETED_TOOL_SCHEMA)
      }
      if (this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')?.value !== '1') throw new Error('Invalid cockpit schema metadata')
      if (!this.readOnly && version !== 0) this.transaction(() => this.db.exec(QUERY_INDEX_SCHEMA))
      // A writable opener owns cockpit.lock; unfinished rows therefore belong to a departed writer.
      if (!this.readOnly) this.db.prepare('UPDATE criterion_run SET finished_at=?,passed=0,exit_code=NULL,signal=NULL,error=? WHERE finished_at IS NULL').run(now(), 'Check interrupted when its writer ended')
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  private writable(): void {
    if (this.closed) throw new Error('Cockpit store is closed')
    if (this.readOnly) throw new Error('Cockpit store is read-only')
  }

  transaction<T>(fn: () => T): T {
    this.writable()
    const nested = this.transactionDepth > 0
    const point = `cockpit_${++this.savepoint}`
    this.db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE')
    this.transactionDepth++
    try {
      const value = fn()
      if (value instanceof Promise) throw new Error('Cockpit transactions must be synchronous')
      this.db.exec(nested ? `RELEASE ${point}` : 'COMMIT')
      return value
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK')
      throw error
    } finally {
      this.transactionDepth--
    }
  }

  private migrate(): void {
    this.transaction(() => {
      this.db.exec(`
        CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE project(id INTEGER PRIMARY KEY,root_path TEXT NOT NULL,root_key TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,view_level INTEGER NOT NULL DEFAULT 1 CHECK(view_level IN(1,2,3)),created_at TEXT NOT NULL);
        CREATE TABLE contract_ref(project_id INTEGER NOT NULL REFERENCES project(id),contract_id TEXT NOT NULL,file_path TEXT NOT NULL DEFAULT '',freeze_hash TEXT,status TEXT NOT NULL CHECK(status IN('draft','frozen','in_progress','fulfilled','amended','cancelled')),PRIMARY KEY(project_id,contract_id));
        CREATE TABLE session(session_id TEXT PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES project(id),cwd TEXT NOT NULL,pid INTEGER,proc_start TEXT,tile_id TEXT,name TEXT NOT NULL,cc_version TEXT NOT NULL,version_supported INTEGER NOT NULL CHECK(version_supported IN(0,1)),status_raw TEXT,state TEXT NOT NULL CHECK(state IN('error','waiting','running','idle','ended','unknown')),waiting_for TEXT,started_at TEXT NOT NULL,last_event_at TEXT NOT NULL,ended_at TEXT,observed_seconds REAL NOT NULL DEFAULT 0 CHECK(observed_seconds>=0),contract_id TEXT,FOREIGN KEY(project_id,contract_id) REFERENCES contract_ref(project_id,contract_id));
        ${COMPLETED_TOOL_SCHEMA}
        CREATE TABLE waiting_item(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL REFERENCES session(session_id),kind TEXT NOT NULL CHECK(kind IN('question','plan_approval','permission','dialog','cg_decision','cg_gate_ask','other')),source TEXT NOT NULL CHECK(source IN('registry','hook','transcript','code_guardian','codeguard','manual','runner')),ref TEXT NOT NULL DEFAULT '',summary TEXT NOT NULL,opened_at TEXT NOT NULL,resolved_at TEXT);
        CREATE UNIQUE INDEX waiting_open_one ON waiting_item(session_id,kind,ref) WHERE resolved_at IS NULL;
        CREATE TABLE task(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL REFERENCES project(id),contract_id TEXT,title TEXT NOT NULL CHECK(length(title)>0 AND length(title)<=2000),state TEXT NOT NULL CHECK(state IN('todo','doing','review','done','blocked')),source TEXT NOT NULL CHECK(source IN('manual','hook','code_guardian')),source_ref TEXT,session_id TEXT REFERENCES session(session_id),source_state TEXT,metadata TEXT NOT NULL DEFAULT '{}',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,source,source_ref),FOREIGN KEY(project_id,contract_id) REFERENCES contract_ref(project_id,contract_id));
        CREATE TABLE owner_freeze(project_id INTEGER NOT NULL,contract_id TEXT NOT NULL,hash TEXT NOT NULL,approved_by TEXT NOT NULL CHECK(length(approved_by)>0),at TEXT NOT NULL,PRIMARY KEY(project_id,contract_id,hash),FOREIGN KEY(project_id,contract_id) REFERENCES contract_ref(project_id,contract_id));
        CREATE TABLE manual_approval(project_id INTEGER NOT NULL,contract_id TEXT NOT NULL,criterion_id TEXT NOT NULL,freeze_hash TEXT NOT NULL,approved_by TEXT NOT NULL,at TEXT NOT NULL,note TEXT NOT NULL,source_fingerprint TEXT,PRIMARY KEY(project_id,contract_id,criterion_id,freeze_hash),FOREIGN KEY(project_id,contract_id) REFERENCES contract_ref(project_id,contract_id));
        CREATE TABLE criterion_run(id INTEGER PRIMARY KEY,project_id INTEGER NOT NULL,contract_id TEXT NOT NULL,criterion_id TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,command TEXT NOT NULL,exit_code INTEGER,signal TEXT,stdout TEXT NOT NULL,stderr TEXT NOT NULL,error TEXT,git_head TEXT,freeze_hash TEXT NOT NULL,source_fingerprint TEXT,passed INTEGER NOT NULL CHECK(passed IN(0,1)),FOREIGN KEY(project_id,contract_id) REFERENCES contract_ref(project_id,contract_id));
        CREATE TABLE contract_session(project_id INTEGER NOT NULL,contract_id TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES session(session_id),linked_at TEXT NOT NULL,observed_seconds REAL NOT NULL DEFAULT 0 CHECK(observed_seconds>=0),PRIMARY KEY(project_id,contract_id,session_id),FOREIGN KEY(project_id,contract_id) REFERENCES contract_ref(project_id,contract_id));
        CREATE TABLE event(id INTEGER PRIMARY KEY,project_id INTEGER REFERENCES project(id),session_id TEXT,at TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('registry','hook','transcript','code_guardian','codeguard','manual','runner')),kind TEXT NOT NULL,adapter_version TEXT NOT NULL,payload TEXT NOT NULL,summary TEXT NOT NULL,detail TEXT NOT NULL,source_ref TEXT);
        CREATE UNIQUE INDEX event_source_ref ON event(source,source_ref) WHERE source_ref IS NOT NULL;
        ${QUERY_INDEX_SCHEMA}
        CREATE INDEX task_project_state ON task(project_id,state);
        INSERT INTO meta(key,value) VALUES('schema_version','1');
        PRAGMA user_version=1;
      `)
    })
  }

  private completionIdentity(sessionId: string, toolUseId: string): void {
    for (const value of [sessionId, toolUseId]) if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value) || redact(value) !== value) throw new Error('Invalid completed tool identity')
  }
  markToolCompleted(sessionId: string, toolUseId: string): void {
    this.writable(); this.completionIdentity(sessionId, toolUseId)
    this.db.prepare('INSERT INTO completed_tool(session_id,tool_use_id) VALUES(?,?) ON CONFLICT DO NOTHING').run(sessionId, toolUseId)
  }
  isToolCompleted(sessionId: string, toolUseId: string): boolean {
    if (this.closed) throw new Error('Cockpit store is closed')
    this.completionIdentity(sessionId, toolUseId)
    return this.db.prepare('SELECT 1 FROM completed_tool WHERE session_id=? AND tool_use_id=?').get(sessionId, toolUseId) !== undefined
  }

  ensureProject(root: string, name?: string): ProjectRecord {
    this.writable()
    const rootPath = realpathSync.native(root)
    if (!statSync(rootPath).isDirectory()) throw new Error('Project root is not a directory')
    const existing = this.projects().find(project => project.rootPath === rootPath || sameDirectory(project.rootPath, rootPath))
    if (existing) return existing
    const key = rootPath
    this.db.prepare('INSERT INTO project(root_path,root_key,display_name,created_at) VALUES(?,?,?,?)').run(rootPath, key, name?.trim() || basename(rootPath), now())
    return this.projectFrom(this.db.prepare('SELECT * FROM project WHERE root_key=?').get(key) as Row)
  }
  private projectFrom(row: Row): ProjectRecord { return { id: Number(row.id), rootPath: row.root_path, name: row.display_name, viewLevel: row.view_level, createdAt: row.created_at } }
  projects(): ProjectRecord[] { return (this.db.prepare('SELECT * FROM project ORDER BY display_name,id').all() as Row[]).map((row) => this.projectFrom(row)) }
  project(id: number): ProjectRecord | null { const row = this.db.prepare('SELECT * FROM project WHERE id=?').get(id); return row ? this.projectFrom(row as Row) : null }
  canWrite(): boolean { return !this.readOnly && !this.closed }

  private sessionFrom(row: Row): SessionRecord { return { sessionId: row.session_id, projectId: row.project_id, cwd: row.cwd, pid: row.pid, procStart: row.proc_start, tileId: row.tile_id, name: row.name, version: row.cc_version, versionSupported: row.version_supported === 1, statusRaw: row.status_raw, state: row.state, waitingFor: row.waiting_for, startedAt: row.started_at, lastEventAt: row.last_event_at, endedAt: row.ended_at, observedSeconds: row.observed_seconds, contractId: row.contract_id } }
  sessions(projectId?: number): SessionRecord[] { return (projectId === undefined ? this.db.prepare('SELECT * FROM session').all() : this.db.prepare('SELECT * FROM session WHERE project_id=?').all(projectId) as Row[]).map((row) => this.sessionFrom(row)) }
  upsertSession(input: SessionInput): void {
    this.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM session WHERE session_id=?').get(input.sessionId) as Row | undefined
      const state = states(input.state)
      const at = input.lastEventAt ?? now()
      const contractId = input.contractId === undefined ? previous?.contract_id ?? null : input.contractId
      const tileId = input.tileId === undefined ? previous?.tile_id ?? null : input.tileId
      const procStart = input.procStart === undefined ? previous?.proc_start ?? null : input.procStart
      const observed = input.observedSeconds ?? previous?.observed_seconds ?? 0
      this.db.prepare(`INSERT INTO session(session_id,project_id,cwd,pid,proc_start,tile_id,name,cc_version,version_supported,status_raw,state,waiting_for,started_at,last_event_at,ended_at,observed_seconds,contract_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,cwd=excluded.cwd,pid=excluded.pid,proc_start=excluded.proc_start,tile_id=excluded.tile_id,name=excluded.name,cc_version=excluded.cc_version,version_supported=excluded.version_supported,status_raw=excluded.status_raw,state=excluded.state,waiting_for=excluded.waiting_for,last_event_at=excluded.last_event_at,ended_at=excluded.ended_at,observed_seconds=excluded.observed_seconds,contract_id=excluded.contract_id`).run(input.sessionId, input.projectId, input.cwd, input.pid ?? null, procStart, tileId, input.name ?? input.sessionId, input.version ?? '', Number(input.versionSupported === true), input.statusRaw ?? null, state, input.waitingFor ?? null, input.startedAt ?? previous?.started_at ?? at, at, input.endedAt ?? (state === 'ended' ? at : null), observed, contractId)
      if (contractId) {
        this.db.prepare('INSERT INTO contract_session(project_id,contract_id,session_id,linked_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(input.projectId, contractId, input.sessionId, at)
        const delta = previous && previous.contract_id === contractId ? Math.max(0, observed - Number(previous.observed_seconds)) : 0
        this.db.prepare('UPDATE contract_session SET observed_seconds=observed_seconds+? WHERE project_id=? AND contract_id=? AND session_id=?').run(delta, input.projectId, contractId, input.sessionId)
      }
    })
  }
  assignSession(sessionId: string, contractId: string | null): void {
    const session = this.sessions().find((item) => item.sessionId === sessionId)
    if (!session) throw new Error('Unknown session')
    this.upsertSession({ ...session, contractId })
  }
  contractUsage(projectId: number, contractId: string): { sessions: number; observedSeconds: number } {
    const row = this.db.prepare('SELECT count(*) AS sessions,coalesce(sum(observed_seconds),0) AS observed FROM contract_session WHERE project_id=? AND contract_id=?').get(projectId, contractId) as Row
    return { sessions: row.sessions, observedSeconds: row.observed }
  }

  reconcileWaiting(sessionId: string, items: WaitingInput[], source?: CockpitSource): void {
    this.transaction(() => {
      const at = now()
      const existing = this.db.prepare('SELECT * FROM waiting_item WHERE session_id=? AND resolved_at IS NULL').all(sessionId) as Row[]
      const keys = new Set(items.map((item) => `${item.kind}\0${item.ref ?? ''}`))
      for (const row of existing) if ((!source || row.source === source) && !keys.has(`${row.kind}\0${row.ref}`)) this.db.prepare('UPDATE waiting_item SET resolved_at=? WHERE id=?').run(at, row.id)
      for (const item of items) {
        if (source && item.source !== source) throw new Error('Waiting source does not match reconciliation scope')
        this.db.prepare(`INSERT INTO waiting_item(session_id,kind,source,ref,summary,opened_at) VALUES(?,?,?,?,?,?) ON CONFLICT(session_id,kind,ref) WHERE resolved_at IS NULL DO UPDATE SET summary=excluded.summary,source=excluded.source`).run(sessionId, item.kind, item.source, item.ref ?? '', clip(item.summary, 4000), item.openedAt ?? at)
      }
    })
  }
  waitingItems(projectId?: number, includeResolved = false): WaitingRecord[] {
    const clauses = [includeResolved ? '1' : 'w.resolved_at IS NULL', ...(projectId === undefined ? [] : ['s.project_id=?'])]
    return (this.db.prepare(`SELECT w.*,s.project_id,s.tile_id FROM waiting_item w JOIN session s ON s.session_id=w.session_id WHERE ${clauses.join(' AND ')} ORDER BY w.opened_at,w.id`).all(...(projectId === undefined ? [] : [projectId])) as Row[]).map((row) => ({ id: row.id, sessionId: row.session_id, projectId: row.project_id, tileId: row.tile_id, kind: row.kind, source: row.source, ref: row.ref, summary: row.summary, openedAt: row.opened_at, resolvedAt: row.resolved_at }))
  }

  private taskFrom(row: Row): TaskRecord { return { id: row.id, projectId: row.project_id, contractId: row.contract_id, sessionId: row.session_id, title: row.title, state: row.state, source: row.source, sourceRef: row.source_ref, rawState: row.source_state, metadata: JSON.parse(row.metadata), createdAt: row.created_at, updatedAt: row.updated_at } }
  createTask(projectId: number, title: string, options: TaskOptions = {}): TaskRecord {
    this.writable()
    const at = now()
    const previous = options.sourceRef !== undefined && options.sourceRef !== null ? this.db.prepare('SELECT * FROM task WHERE project_id=? AND source=? AND source_ref=?').get(projectId, options.source ?? 'manual', options.sourceRef) as Row | undefined : undefined
    if (options.metadata && Object.entries(options.metadata).some(([key, value]) => key.length > 200 || typeof value !== 'string')) throw new Error('Invalid task metadata')
    const metadata = options.metadata === undefined ? previous?.metadata ?? '{}' : JSON.stringify(Object.fromEntries(Object.entries(options.metadata).map(([key, value]) => [key, clip(value, 4000)])))
    const rawState = options.rawState === undefined ? previous?.source_state ?? null : options.rawState
    const result = this.db.prepare(`INSERT INTO task(project_id,contract_id,title,state,source,source_ref,session_id,source_state,metadata,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,source,source_ref) DO UPDATE SET title=excluded.title,state=excluded.state,source_state=excluded.source_state,metadata=excluded.metadata,updated_at=excluded.updated_at`).run(projectId, options.contractId ?? null, clip(title.trim(), 2000), options.state ?? previous?.state ?? 'todo', options.source ?? 'manual', options.sourceRef ?? null, options.sessionId ?? null, rawState, metadata, at, at)
    const row = previous ? this.db.prepare('SELECT * FROM task WHERE id=?').get(previous.id) : this.db.prepare('SELECT * FROM task WHERE id=?').get(result.lastInsertRowid)
    return this.taskFrom(row as Row)
  }
  moveTask(id: number, state: TaskState): void { this.writable(); if (this.db.prepare('UPDATE task SET state=?,updated_at=? WHERE id=?').run(state, now(), id).changes === 0) throw new Error('Unknown task') }
  assignTask(id: number, contractId: string | null): void { this.writable(); if (this.db.prepare('UPDATE task SET contract_id=?,updated_at=? WHERE id=?').run(contractId, now(), id).changes === 0) throw new Error('Unknown task') }
  tasks(projectId?: number): TaskRecord[] { return (projectId === undefined ? this.db.prepare('SELECT * FROM task ORDER BY id').all() : this.db.prepare('SELECT * FROM task WHERE project_id=? ORDER BY id').all(projectId) as Row[]).map((row) => this.taskFrom(row)) }

  upsertContract(projectId: number, contractId: string, filePath: string, status: string): void {
    this.writable()
    this.db.prepare(`INSERT INTO contract_ref(project_id,contract_id,file_path,status) VALUES(?,?,?,?) ON CONFLICT(project_id,contract_id) DO UPDATE SET file_path=excluded.file_path,status=excluded.status`).run(projectId, contractId, filePath, status)
  }
  saveFreeze(projectId: number, contractId: string, hash: string, approvedBy: string, at = now(), filePath = ''): void {
    if (!/^[a-f0-9]{64}$/.test(hash) || !approvedBy.trim()) throw new Error('Invalid owner freeze')
    this.transaction(() => {
      this.upsertContract(projectId, contractId, filePath, 'frozen')
      this.db.prepare('INSERT INTO owner_freeze(project_id,contract_id,hash,approved_by,at) VALUES(?,?,?,?,?) ON CONFLICT(project_id,contract_id,hash) DO UPDATE SET approved_by=excluded.approved_by,at=excluded.at').run(projectId, contractId, hash, approvedBy.trim(), at)
      this.db.prepare('UPDATE contract_ref SET freeze_hash=? WHERE project_id=? AND contract_id=?').run(hash, projectId, contractId)
    })
  }
  getFreeze(projectId: number, contractId: string): FreezeRecord | null {
    const row = this.db.prepare('SELECT f.* FROM owner_freeze f JOIN contract_ref c ON c.project_id=f.project_id AND c.contract_id=f.contract_id AND c.freeze_hash=f.hash WHERE f.project_id=? AND f.contract_id=?').get(projectId, contractId) as Row | undefined
    return row ? { projectId, contractId, hash: row.hash, approvedBy: row.approved_by, at: row.at } : null
  }
  revokeFreeze(projectId: number, contractId: string): void { this.writable(); this.db.prepare('UPDATE contract_ref SET freeze_hash=NULL,status=? WHERE project_id=? AND contract_id=?').run('amended', projectId, contractId) }
  approveManual(projectId: number, contractId: string, criterionId: string, freezeHash: string, approvedBy: string, note = '', at = now(), sourceFingerprint: string | null = null): void {
    this.writable()
    if (this.getFreeze(projectId, contractId)?.hash !== freezeHash || !approvedBy.trim()) throw new Error('Manual approval needs the current owner-approved freeze')
    this.db.prepare('INSERT INTO manual_approval(project_id,contract_id,criterion_id,freeze_hash,approved_by,at,note,source_fingerprint) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(project_id,contract_id,criterion_id,freeze_hash) DO UPDATE SET approved_by=excluded.approved_by,at=excluded.at,note=excluded.note,source_fingerprint=excluded.source_fingerprint').run(projectId, contractId, criterionId, freezeHash, approvedBy.trim(), at, clip(note), sourceFingerprint)
  }
  manualApprovals(projectId: number, contractId: string, hash?: string): ManualApprovalRecord[] {
    return (this.db.prepare(`SELECT * FROM manual_approval WHERE project_id=? AND contract_id=?${hash === undefined ? '' : ' AND freeze_hash=?'}`).all(projectId, contractId, ...(hash === undefined ? [] : [hash])) as Row[]).map((row) => ({ projectId, contractId, criterionId: row.criterion_id, approvedBy: row.approved_by, at: row.at, freezeHash: row.freeze_hash, note: row.note, sourceFingerprint: row.source_fingerprint }))
  }

  private runValues(input: RunInput) { return [input.projectId, input.contractId, input.criterionId, input.startedAt, input.finishedAt, clip(input.command), input.exitCode, input.signal, clip(input.stdout), clip(input.stderr), input.error === null ? null : clip(input.error), input.gitHead, input.freezeHash, input.sourceFingerprint, Number(input.passed)] }
  recordRun(input: RunInput): CriterionRun {
    this.writable()
    const result = this.db.prepare('INSERT INTO criterion_run(project_id,contract_id,criterion_id,started_at,finished_at,command,exit_code,signal,stdout,stderr,error,git_head,freeze_hash,source_fingerprint,passed) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...this.runValues(input))
    const run = this.runById(Number(result.lastInsertRowid))
    if (!run) throw new Error('Inserted check run could not be read')
    return run
  }
  finishRun(id: number, input: RunInput): CriterionRun {
    this.writable()
    const changed = this.db.prepare('UPDATE criterion_run SET project_id=?,contract_id=?,criterion_id=?,started_at=?,finished_at=?,command=?,exit_code=?,signal=?,stdout=?,stderr=?,error=?,git_head=?,freeze_hash=?,source_fingerprint=?,passed=? WHERE id=? AND project_id=? AND contract_id=? AND criterion_id=?').run(...this.runValues(input), id, input.projectId, input.contractId, input.criterionId).changes
    if (!changed) throw new Error('Unknown check run')
    const run = this.runById(id)
    if (!run) throw new Error('Finished check run could not be read')
    return run
  }
  private runFrom(row: Row): CriterionRun { return { id: row.id, projectId: row.project_id, contractId: row.contract_id, criterionId: row.criterion_id, startedAt: row.started_at, finishedAt: row.finished_at, command: row.command, exitCode: row.exit_code, signal: row.signal, stdout: row.stdout, stderr: row.stderr, error: row.error, gitHead: row.git_head, freezeHash: row.freeze_hash, sourceFingerprint: row.source_fingerprint, passed: row.passed === 1 } }
  runById(id: number): CriterionRun | null { const row = this.db.prepare('SELECT * FROM criterion_run WHERE id=?').get(id) as Row | undefined; return row ? this.runFrom(row) : null }
  private currentCriteria(criterionIds: readonly string[]): string[] {
    const ids = [...new Set(criterionIds)]
    if (ids.some((id) => typeof id !== 'string' || !/^AC[0-9]+$/.test(id))) throw new Error('Invalid current criterion identity')
    return ids
  }
  hasRuns(projectId: number, contractId: string, criterionIds: readonly string[]): boolean {
    const ids = this.currentCriteria(criterionIds)
    return ids.length > 0 && this.db.prepare(`SELECT 1 FROM criterion_run WHERE project_id=? AND contract_id=? AND criterion_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`).get(projectId, contractId, ...ids) !== undefined
  }
  latestRuns(projectId: number, contractId: string, criterionIds: readonly string[]): CriterionRun[] {
    const ids = this.currentCriteria(criterionIds)
    if (!ids.length) return []
    return (this.db.prepare(latestRunsSql(ids.length)).all(projectId, contractId, ...ids) as Row[]).map((row) => this.runFrom(row))
  }
  runs(projectId?: number, contractId?: string): CriterionRun[] {
    const clauses = [...(projectId === undefined ? [] : ['project_id=?']), ...(contractId === undefined ? [] : ['contract_id=?'])]
    return (this.db.prepare(`SELECT * FROM criterion_run${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY id DESC`).all(...(projectId === undefined ? [] : [projectId]), ...(contractId === undefined ? [] : [contractId])) as Row[]).map((row) => this.runFrom(row))
  }
  recordEvent(input: EventInput): EventRecord {
    this.writable()
    const ref = input.dedupeKey ?? input.sourceRef ?? null
    let payload = JSON.stringify(input.payload ?? null, (key, value: unknown) => key && /password|passwd|secret|token|api[_-]?key|authorization|cookie|credential/i.test(key) ? '****' : typeof value === 'string' ? clip(value) : value)
    if (Buffer.byteLength(payload) > 32768) {
      let excerpt = payload.slice(0, 16384)
      do { payload = JSON.stringify({ truncated: true, excerpt }); if (Buffer.byteLength(payload) <= 32768) break; excerpt = excerpt.slice(0, Math.floor(excerpt.length / 2)) } while (excerpt.length)
    }
    const at = input.at === undefined ? now() : new Date(input.at).toISOString()
    const result = this.db.prepare('INSERT INTO event(project_id,session_id,at,source,kind,adapter_version,payload,summary,detail,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(source,source_ref) WHERE source_ref IS NOT NULL DO NOTHING').run(input.projectId ?? null, input.sessionId ?? null, at, input.source, input.kind, input.adapterVersion ?? '1', payload, clip(input.summary ?? input.kind, 4000), clip(input.detail ?? ''), ref)
    const row = ref === null ? this.db.prepare('SELECT * FROM event WHERE id=?').get(result.lastInsertRowid) : this.db.prepare('SELECT * FROM event WHERE source=? AND source_ref=?').get(input.source, ref)
    return this.eventFrom(row as Row)
  }
  private eventFrom(row: Row): EventRecord { return { id: row.id, projectId: row.project_id, sessionId: row.session_id, at: row.at, source: row.source, kind: row.kind, adapterVersion: row.adapter_version, payload: row.payload, summary: row.summary, detail: row.detail, sourceRef: row.source_ref } }
  events(projectId?: number, limit = 200): EventRecord[] {
    const bounded = Math.max(1, Math.min(1000, Math.floor(limit)))
    return (projectId === undefined ? this.db.prepare('SELECT * FROM event ORDER BY id DESC LIMIT ?').all(bounded) : this.db.prepare('SELECT * FROM event WHERE project_id=? ORDER BY id DESC LIMIT ?').all(projectId, bounded) as Row[]).map((row) => this.eventFrom(row))
  }
  pruneEvents(before: string): void { this.writable(); if (!Number.isFinite(Date.parse(before))) throw new Error('Invalid retention boundary'); this.db.prepare('DELETE FROM event WHERE at<?').run(new Date(before).toISOString()) }
  getSettings(): Record<string, unknown> { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get('settings'); return row ? JSON.parse(String(row.value)) : {} }
  saveSettings(settings: Record<string, unknown>): void { this.writable(); this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('settings', JSON.stringify(settings)) }
  close(): void { if (!this.closed) { this.closed = true; this.db.close() } }
}
