import { existsSync } from 'node:fs'
import { sameDirectory } from '../fsutil'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CockpitCommand, CockpitEvent, CockpitResult, CockpitSession, CockpitSettings, CockpitSnapshot, CockpitState, ContractView, CriterionRun, ProjectView, SourceHealth, TaskState, WaitingItem } from '../../shared/cockpit'
import { redact, type CockpitMcpBridge } from '../agents/mcp'
import { CockpitCollector, type CollectorOptions, type CollectorResult } from './collector'
import type { LifecycleSnapshot, Source, SourceSession, SourceTask, SourceWaiting } from './adapters/common'
import { completedToolOf } from './adapters/hooks'
import { ContractRepository } from './contracts'
import { acquireWriterLock } from './lock'
import { canonicalProjectRoot, findTileForPid, readProjectBranch, type TileProcess } from './mapping'
import { CheckRunner, type RunnerOptions } from './runner'
import { CockpitStore, type ProjectRecord, type SessionRecord } from './store'

type Options = {
  home?: string
  registryDir?: string
  spoolDir?: string
  pluginPath?: string
  getTiles?: () => TileProcess[]
  parentPid?: (pid: number) => number | null
  isProcessAlive?: CollectorOptions['isProcessAlive']
  onChange?: () => void
  runner?: RunnerOptions
}
const safeError = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000)
const sourceState = (state: CockpitState): SourceSession['state'] => state === 'running' ? 'busy' : state
const stateOf = (session: SourceSession): CockpitState => session.state === 'ended' || session.state === 'error' ? session.state : !session.versionSupported ? 'unknown' : session.state === 'busy' ? 'running' : session.state === 'shell' ? 'idle' : session.state
const asSettings = (raw: Record<string, unknown>): CockpitSettings => ({
  level: raw.level === 'board' || raw.level === 'details' ? raw.level : 'overview',
  retentionDays: typeof raw.retentionDays === 'number' && Number.isInteger(raw.retentionDays) && raw.retentionDays >= 1 && raw.retentionDays <= 3650 ? raw.retentionDays : 30
})
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const readHealth = (value: unknown): SourceHealth[] => !Array.isArray(value) ? [] : value.slice(0, 32).flatMap(item =>
  record(item) && ['registry', 'hook', 'code_guardian', 'codeguard', 'transcript'].includes(String(item.source)) &&
  ['ok', 'missing', 'unsupported', 'error'].includes(String(item.status)) && typeof item.detail === 'string'
    ? [{ source: item.source as SourceHealth['source'], status: item.status as SourceHealth['status'], detail: redact(item.detail).slice(0, 4000) }] : [])
const readGuardianWaiting = (value: unknown): WaitingItem[] => !Array.isArray(value) ? [] : value.slice(0, 2048).flatMap(item => {
  if (!record(item) || !Number.isSafeInteger(item.projectId) || Number(item.projectId) <= 0 ||
    (item.source !== 'code_guardian' && item.source !== 'codeguard') || typeof item.id !== 'string' ||
    typeof item.ref !== 'string' || typeof item.summary !== 'string' || typeof item.openedAt !== 'string' ||
    !Number.isFinite(Date.parse(item.openedAt)) || !['question', 'plan_approval', 'permission', 'dialog', 'cg_decision', 'cg_gate_ask', 'other'].includes(String(item.kind))) return []
  return [{ id: item.id.slice(0, 1000), projectId: item.projectId as number, sessionId: null, source: item.source,
    kind: item.kind as WaitingItem['kind'], ref: redact(item.ref).slice(0, 1000), summary: redact(item.summary).slice(0, 4000),
    openedAt: item.openedAt, tileId: null }]
})

/** One local observer/writer per data directory; other app instances remain useful as readers. */
export class CockpitController {
  private store: CockpitStore | null = null
  private repository: ContractRepository | null = null
  private runner: CheckRunner | null = null
  private writer: { close(): void } | null = null
  private collector: CockpitCollector | null = null
  private readonly roots: string[] = []
  private readonly jobs = new Map<string, Promise<CriterionRun[]>>()
  private readonly observedAt = new Map<string, number>()
  private busy: Promise<void> | null = null
  private closed = false
  private lastError: string | null = null
  private pruneAt = 0
  private value: CockpitSnapshot

  constructor(private readonly directory: string, private readonly options: Options = {}) {
    this.value = { at: new Date().toISOString(), writable: false, error: null, projects: [], adapters: [],
      settings: { level: 'overview', retentionDays: 30 }, pluginPath: options.pluginPath && existsSync(options.pluginPath) ? options.pluginPath : null }
  }

  snapshot(): CockpitSnapshot { return this.value }
  private emit(): void { this.options.onChange?.() }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.busy) return this.busy
    this.busy = this.update().catch(error => {
      this.lastError = safeError(error)
      this.value = { ...this.value, error: this.lastError }
      this.emit()
    }).finally(() => { this.busy = null })
    return this.busy
  }

  private restoredLifecycle(): Partial<LifecycleSnapshot> {
    const store = this.store!
    const sessions = store.sessions()
    const byId = new Map(sessions.map(session => [session.sessionId, session]))
    const projectRoots = new Map(store.projects().map(project => [project.id, project.rootPath]))
    return {
      sessions: sessions.map(session => ({ sessionId: session.sessionId, cwd: session.cwd, pid: session.pid, name: session.name,
        version: session.version, versionSupported: session.versionSupported, state: sourceState(session.state),
        statusRaw: session.statusRaw ?? 'unknown', startedAt: session.startedAt, updatedAt: session.lastEventAt, endedAt: session.endedAt ?? undefined, procStart: session.procStart })),
      tasks: store.tasks().flatMap((task): SourceTask[] => {
        if (task.source !== 'hook' || !task.sourceRef || !task.sessionId) return []
        const cwd = byId.get(task.sessionId)?.cwd ?? projectRoots.get(task.projectId)
        if (!cwd) return []
        return [{ source: 'claude_task', sourceRef: task.sourceRef, cwd, sessionId: task.sessionId, title: task.title,
          state: task.state === 'done' ? task.rawState === 'deleted' ? 'dropped' : 'done' : task.state === 'doing' ? 'in_progress' : 'open',
          sourceState: task.rawState ?? undefined, metadata: task.metadata }]
      }),
      waiting: store.waitingItems().filter(item => ['registry', 'hook', 'transcript', 'code_guardian', 'codeguard'].includes(item.source)).map(item => ({
        sessionId: item.sessionId, cwd: byId.get(item.sessionId)?.cwd ?? '', kind: item.kind, source: item.source as Source,
        ref: item.ref, summary: item.summary, openedAt: item.openedAt
      }))
    }
  }

  private async open(): Promise<void> {
    if (this.writer || this.closed) return
    const lock = acquireWriterLock(join(this.directory, 'cockpit.lock'))
    if (!lock && this.store) return
    if (!lock && !existsSync(join(this.directory, 'cockpit.db'))) return
    await this.runner?.close()
    this.store?.close()
    this.store = null
    try {
      this.store = new CockpitStore(join(this.directory, 'cockpit.db'), { readOnly: !lock })
      this.repository = new ContractRepository(this.store)
      this.runner = new CheckRunner(this.store, this.repository, this.options.runner)
      this.writer = lock
      if (lock) {
        const home = this.options.home ?? homedir()
        this.collector = new CockpitCollector({ registryDir: this.options.registryDir ?? join(home, '.claude', 'sessions'),
          spoolDir: this.options.spoolDir ?? join(home, '.cli-organizer', 'cockpit-spool'), claudeDir: join(home, '.claude'),
          guardDir: join(home, '.guard'), projectRoots: this.roots, initialLifecycle: this.restoredLifecycle(), isProcessAlive: this.options.isProcessAlive,
          isToolCompleted: (sessionId, toolUseId) => this.store!.isToolCompleted(sessionId, toolUseId) })
        this.observedAt.clear()
      }
    } catch (error) {
      this.store?.close(); this.store = null
      lock?.close()
      throw error
    }
  }

  private async update(): Promise<void> {
    await this.open()
    if (!this.store || !this.repository || this.closed) return
    if (this.writer && this.collector) {
      this.roots.splice(0, this.roots.length, ...this.store.projects().map(project => project.rootPath))
      const observations = this.collector.poll()
      await this.ingest(observations)
      this.collector.ackSpool(observations.spoolToAck)
      if (Date.now() - this.pruneAt > 60_000) {
        const settings = asSettings(this.store.getSettings())
        this.store.pruneEvents(new Date(Date.now() - settings.retentionDays * 86400000).toISOString())
        this.pruneAt = Date.now()
      }
    }
    await this.refreshSnapshot()
  }

  private async ingest(result: CollectorResult): Promise<void> {
    const store = this.store!
    const paths = new Set<string>([...result.sessions.map(session => session.cwd), ...result.waiting.map(item => item.cwd),
      ...result.tasks.map(task => task.cwd), ...result.events.map(event => event.cwd).filter((cwd): cwd is string => !!cwd)])
    const normalized = new Map<string, string>()
    for (const path of paths) { const root = await canonicalProjectRoot(path); if (root) normalized.set(path, root) }
    const projects = new Map(store.projects().map(project => [project.rootPath, project]))
    const previous = new Map(store.sessions().map(session => [session.sessionId, session]))
    const tiles = this.options.getTiles?.() ?? []
    const now = Date.now()
    const guardianWaiting: WaitingItem[] = []
    const observedUpdates: Array<[string, number]> = []
    store.transaction(() => {
      const projectFor = (cwd: string, create = true): ProjectRecord | undefined => {
        const root = normalized.get(cwd)
        if (!root) return undefined
        let project = projects.get(root)
        if (!project && create) { project = store.ensureProject(root); projects.set(root, project) }
        return project
      }
      for (const observation of result.sessions) {
        const before = previous.get(observation.sessionId)
        const project = projectFor(observation.cwd, observation.state !== 'ended' || !!before) ?? (before ? store.project(before.projectId) ?? undefined : undefined)
        if (!project) continue
        const state = stateOf(observation)
        const elapsed = now - (this.observedAt.get(observation.sessionId) ?? now)
        const sameProject = before?.projectId === project.id
        const delta = sameProject && before?.state === 'running' && state === 'running' && elapsed >= 0 && elapsed <= 5000 ? elapsed / 1000 : 0
        const verified = observation.pid !== null && (!this.options.isProcessAlive || this.options.isProcessAlive(observation.pid, observation.procStart) === true)
        const tileId = state === 'ended' || !verified || observation.pid === null ? null : findTileForPid(observation.pid, tiles, this.options.parentPid ?? (() => null))
        store.upsertSession({ sessionId: observation.sessionId, projectId: project.id, cwd: observation.cwd, pid: observation.pid,
          tileId, procStart: observation.procStart ?? null, name: observation.name, version: observation.version, versionSupported: observation.versionSupported,
          statusRaw: observation.statusRaw, state, waitingFor: observation.currentTool ?? null, startedAt: observation.startedAt,
          lastEventAt: observation.updatedAt, endedAt: state === 'ended' ? observation.endedAt ?? new Date(now).toISOString() : null,
          observedSeconds: (sameProject ? before?.observedSeconds ?? 0 : 0) + delta,
          ...(before && !sameProject ? { contractId: null } : {}) })
        observedUpdates.push([observation.sessionId, now])
      }
      const sessions = new Map(store.sessions().map(session => [session.sessionId, session]))
      const bySession = new Map<string, SourceWaiting[]>()
      for (const item of result.waiting) {
        const session = sessions.get(item.sessionId)
        if (session) {
          if (session.state !== 'ended') bySession.set(item.sessionId, [...(bySession.get(item.sessionId) ?? []), item])
        } else {
          const project = projectFor(item.cwd)
          if (project && (item.source === 'code_guardian' || item.source === 'codeguard')) guardianWaiting.push({
            id: `${item.source}:${project.id}:${item.ref}`, projectId: project.id, sessionId: null, kind: item.kind,
            source: item.source, ref: item.ref, summary: item.summary, openedAt: item.openedAt, tileId: null
          })
        }
      }
      for (const session of sessions.values()) store.reconcileWaiting(session.sessionId, bySession.get(session.sessionId) ?? [])
      for (const task of result.tasks) {
        const project = projectFor(task.cwd)
        if (!project) continue
        const state: TaskState = task.state === 'done' || task.state === 'dropped' ? 'done' : task.state === 'in_progress' ? 'doing' : 'todo'
        store.createTask(project.id, task.title, { source: task.source === 'claude_task' ? 'hook' : 'code_guardian', sourceRef: task.sourceRef,
          sessionId: task.sessionId && sessions.get(task.sessionId)?.projectId === project.id ? task.sessionId : null, state,
          rawState: task.sourceState ?? null, metadata: task.metadata ?? {} })
      }
      for (const event of result.events) {
        const completion = completedToolOf(event)
        if (completion) store.markToolCompleted(completion.sessionId, completion.toolUseId)
        store.recordEvent({ source: event.source, sourceRef: event.id, kind: event.kind, at: event.at,
          projectId: event.cwd ? projectFor(event.cwd, false)?.id ?? null : null,
          sessionId: event.sessionId ?? null, summary: event.summary, detail: event.raw, payload: event.raw })
      }
      const adapters: SourceHealth[] = result.adapters.map(adapter => ({ source: adapter.source,
        status: !adapter.available ? 'missing' : !adapter.supported ? 'unsupported' : adapter.invalid ? 'error' : 'ok', detail: adapter.message }))
      store.saveSettings({ ...store.getSettings(), observerAdapters: adapters, guardianWaiting })
    })
    for (const [sessionId, at] of observedUpdates) this.observedAt.set(sessionId, at)
  }

  private sessionView(session: SessionRecord, tiles: TileProcess[]): CockpitSession {
    const verified = session.pid !== null && (!this.options.isProcessAlive || this.options.isProcessAlive(session.pid, session.procStart) === true)
    const tileId = session.state === 'ended' || !verified || session.pid === null ? null :
      findTileForPid(session.pid, tiles, this.options.parentPid ?? (() => null))
    return { id: session.sessionId, projectId: session.projectId, pid: session.pid, tileId, name: session.name,
      state: session.state, rawState: session.statusRaw, waitingFor: session.waitingFor, version: session.version,
      supported: session.versionSupported, startedAt: session.startedAt, updatedAt: session.lastEventAt,
      observedSeconds: session.observedSeconds, contractId: session.contractId }
  }

  private async refreshSnapshot(): Promise<void> {
    if (!this.store || !this.repository || this.closed) return
    const rawSettings = this.store.getSettings()
    const adapters = readHealth(rawSettings.observerAdapters)
    const guardian = readGuardianWaiting(rawSettings.guardianWaiting)
    const tiles = this.options.getTiles?.() ?? []
    const projects: ProjectView[] = []
    for (const project of this.store.projects()) {
      const sessions = this.store.sessions(project.id).map(session => this.sessionView(session, tiles))
      const waiting: WaitingItem[] = [...this.store.waitingItems(project.id).map(item => ({ id: String(item.id), projectId: item.projectId,
        sessionId: item.sessionId, kind: item.kind, source: item.source, ref: item.ref, summary: item.summary, openedAt: item.openedAt, tileId: sessions.find(session => session.id === item.sessionId)?.tileId ?? null })),
        ...guardian.filter(item => item.projectId === project.id)]
      const tasks = this.store.tasks(project.id).map(task => ({ ...task, ref: task.sourceRef, rawState: task.rawState ?? undefined }))
      const events: CockpitEvent[] = this.store.events(project.id, 100).map(event => ({ id: event.id, projectId: event.projectId,
        sessionId: event.sessionId, at: event.at, source: event.source, kind: event.kind, summary: event.summary, detail: event.detail }))
      let state: CockpitState = adapters.some(adapter => adapter.status === 'error') || sessions.some(session => session.state === 'error') ? 'error' : waiting.length ? 'waiting' :
        sessions.some(session => session.state === 'running') ? 'running' : sessions.some(session => session.state === 'idle') ? 'idle' :
        sessions.length && sessions.every(session => session.state === 'ended') ? 'ended' : 'unknown'
      let contracts: ContractView[] = []
      try { contracts = await this.repository.list(project.id) } catch (error) { state = 'error'; this.lastError = safeError(error) }
      if (contracts.some(contract => contract.errors.length > 0)) state = 'error'
      for (const contract of contracts) contract.running ||= this.jobs.has(`${project.id}:${contract.id}`)
      projects.push({ id: project.id, root: project.rootPath, name: project.name, branch: await readProjectBranch(project.rootPath),
        state, sessions, waiting, tasks, contracts, events, observedSeconds: sessions.reduce((total, session) => total + session.observedSeconds, 0) })
    }
    const priority: Record<CockpitState, number> = { error: 0, waiting: 1, running: 2, unknown: 3, idle: 4, ended: 5 }
    projects.sort((a, b) => priority[a.state] - priority[b.state] || a.name.localeCompare(b.name))
    this.value = { ...this.value, at: new Date().toISOString(), writable: !!this.writer, error: this.lastError,
      projects, adapters, settings: asSettings(rawSettings) }
    this.emit()
  }

  async command(command: CockpitCommand): Promise<CockpitResult> {
    try {
      if (this.closed) throw new Error('Cockpit is closed')
      if (!this.store || !this.writer) await this.tick()
      if (command.type === 'refresh') { await this.tick(); return { ok: true } }
      const store = this.store
      if (!store || !this.writer || !this.repository || !this.runner) throw new Error('This instance is read-only; use the instance holding the cockpit writer')
      if ('projectId' in command && !store.project(command.projectId)) throw new Error('Unknown project')
      this.lastError = null
      switch (command.type) {
        case 'add-project': {
          const root = await canonicalProjectRoot(command.root)
          if (!root) throw new Error('Project folder is not available')
          store.ensureProject(root)
          break
        }
        case 'create-task':
          if (command.contractId) await this.requireContract(command.projectId, command.contractId)
          if (command.sessionId && !store.sessions(command.projectId).some(session => session.sessionId === command.sessionId)) throw new Error('Session does not belong to this project')
          store.createTask(command.projectId, command.title, { contractId: command.contractId, sessionId: command.sessionId })
          break
        case 'move-task': {
          const task = store.tasks(command.projectId).find(task => task.id === command.taskId)
          if (!task || task.source !== 'manual') throw new Error('Only a manual task in this project can change state here')
          store.moveTask(task.id, command.state)
          break
        }
        case 'assign-task':
          if (!store.tasks(command.projectId).some(task => task.id === command.taskId)) throw new Error('Task does not belong to this project')
          if (command.contractId) await this.requireContract(command.projectId, command.contractId)
          store.assignTask(command.taskId, command.contractId)
          break
        case 'save-settings': store.saveSettings({ ...store.getSettings(), level: command.level, retentionDays: command.retentionDays }); break
        case 'create-contract': await this.repository.create(command.projectId, command); break
        case 'save-contract': await this.repository.save(command.projectId, command.contractId, command.json, command.expectedDefinitionHash); break
        case 'freeze-contract': await this.repository.freeze(command.projectId, command.contractId, command.approvedBy, command.expectedDefinitionHash); break
        case 'amend-contract': await this.repository.amend(command.projectId, command.contractId, command.summary, command.expectedDefinitionHash); break
        case 'approve-criterion':
          await this.repository.approveManual(command.projectId, command.contractId, command.criterionId, command.approvedBy, command.expectedFreezeHash, command.expectedSourceFingerprint)
          await this.finalizeIfSatisfied(command.projectId, command.contractId)
          break
        case 'assign-session':
          if (!store.sessions(command.projectId).some(session => session.sessionId === command.sessionId)) throw new Error('Session does not belong to this project')
          if (command.contractId) await this.requireContract(command.projectId, command.contractId)
          store.assignSession(command.sessionId, command.contractId)
          break
        case 'run-contract':
        case 'run-criterion':
          this.startRun(command.projectId, command.contractId, command.type === 'run-criterion' ? command.criterionId : undefined)
          return { ok: true, message: 'Check requested' }
        case 'cancel-check': this.runner.cancel(command.projectId, command.contractId); break
      }
      await this.refreshSnapshot()
      return { ok: true }
    } catch (error) {
      this.lastError = safeError(error)
      this.value = { ...this.value, error: this.lastError }
      this.emit()
      return { ok: false, error: this.lastError }
    }
  }

  private async requireContract(projectId: number, id: string): Promise<void> {
    if (!(await this.repository!.list(projectId)).some(contract => contract.id === id && contract.document)) throw new Error('Unknown or invalid project contract')
  }

  private async finalizeIfSatisfied(projectId: number, contractId: string): Promise<void> {
    if (this.closed) return
    const contract = (await this.repository!.list(projectId, true)).find(item => item.id === contractId)
    if (this.closed) return
    if (contract?.fulfilled && contract.freeze && contract.sourceFingerprint) {
      await this.repository!.finalize(projectId, contractId, contract.freeze.hash, contract.sourceFingerprint)
    }
  }

  private startRun(projectId: number, contractId: string, criterionId?: string): Promise<CriterionRun[]> {
    if (this.closed || !this.writer || !this.runner) throw new Error('Cockpit writer is not available')
    const key = `${projectId}:${contractId}`
    if (this.jobs.has(key)) throw new Error('A check for this contract is already running')
    const runner = this.runner!
    const job = (async () => {
      const runs = criterionId ? [await runner.run(projectId, contractId, criterionId)] : await runner.runAll(projectId, contractId)
      if (runs.length && runs.every(run => run.passed)) await this.finalizeIfSatisfied(projectId, contractId)
      return runs
    })()
    this.jobs.set(key, job)
    this.value = { ...this.value, projects: this.value.projects.map(project => project.id !== projectId ? project : ({ ...project,
      contracts: project.contracts.map(contract => contract.id === contractId ? { ...contract, running: true } : contract) })) }
    this.emit()
    void job.then(runs => {
      if (this.closed) return
      const failed = runs.find(run => !run.passed)
      this.lastError = failed ? failed.error ?? `Check ${failed.criterionId} did not pass` : null
      this.store?.recordEvent({ projectId, source: 'runner', kind: failed ? 'check_failed' : 'check_finished', summary: this.lastError ?? 'Requested checks completed' })
    }, error => {
      if (!this.closed) {
        this.lastError = safeError(error)
        this.store?.recordEvent({ projectId, source: 'runner', kind: 'check_failed', summary: this.lastError })
      }
    }).finally(async () => {
      this.jobs.delete(key)
      if (!this.closed) await this.refreshSnapshot()
    }).catch(error => { if (!this.closed) { this.lastError = safeError(error); this.value = { ...this.value, error: this.lastError }; this.emit() } })
    return job
  }

  readonly mcp: CockpitMcpBridge = {
    listContracts: async cwd => {
      await this.tick()
      const root = await canonicalProjectRoot(cwd)
      const projects = this.store?.projects() ?? []
      const project = root && (projects.find(project => project.rootPath === root) ?? projects.find(project => sameDirectory(project.rootPath, root)))
      if (!project || !this.repository) throw new Error('No cockpit project matches the calling tile folder')
      return (await this.repository.list(project.id, true)).map(contract => ({ contractId: contract.id, title: redact(contract.document?.title ?? contract.id),
        frozen: !!contract.freeze && !contract.changed, fulfilled: contract.fulfilled, progress: contract.progress,
        errors: contract.errors, criteria: contract.document?.milestones.flatMap(milestone => milestone.criteria.map(criterion => ({ id: criterion.id, type: criterion.type, description: redact(criterion.description) }))) ?? [] }))
    },
    runCheck: async (cwd, contractId, criterionId) => {
      try {
        await this.tick()
        if (this.closed) throw new Error('Cockpit is closed')
        if (!this.writer || !this.store) throw new Error('Cockpit writer is held by another app instance')
        const root = await canonicalProjectRoot(cwd)
        const projects = this.store.projects()
        const project = root && (projects.find(project => project.rootPath === root) ?? projects.find(project => sameDirectory(project.rootPath, root)))
        if (!project) throw new Error('No cockpit project matches the calling tile folder')
        const runs = await this.startRun(project.id, contractId, criterionId)
        const failed = runs.find(run => !run.passed)
        return failed ? { ok: false, error: failed.error ?? `Check ${failed.criterionId} failed (exit ${String(failed.exitCode)})` }
          : { ok: true, message: JSON.stringify({ checks: runs.map(run => ({ criterionId: run.criterionId, passed: run.passed, exitCode: run.exitCode, gitHead: run.gitHead })), manualApproval: 'Only the user can approve manual criteria in the cockpit' }) }
      } catch (error) { return { ok: false, error: safeError(error) } }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.busy
    await this.runner?.close()
    await Promise.allSettled([...this.jobs.values()])
    this.store?.close(); this.store = null
    this.writer?.close(); this.writer = null
  }
}
