import { existsSync, lstatSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { digest, fileIdentity, invalidEvent, KNOWN_CLAUDE_VERSIONS, listFiles, readBounded, sameFileIdentity } from './adapters/common'
import type { FileIdentity, LifecycleSnapshot, SourceAdapter, SourceEvent, SourceSession, SourceTask, SourceWaiting } from './adapters/common'
import { readRegistry } from './adapters/registry'
import { HookLifecycle, parseHookEvent } from './adapters/hooks'
import { readGuardianArtifacts } from './adapters/codeGuardian'
import { CodeguardReader } from './adapters/codeguard'
import { ByteTail, parseTranscriptRecord } from './adapters/transcript'

export type CollectorOptions = {
  registryDir?: string; spoolDir?: string; claudeDir?: string; guardDir?: string; projectRoots?: readonly string[]
  knownVersions?: readonly string[]; knownGuardianVersions?: readonly string[]; clock?: () => string | Date; initialLifecycle?: Partial<LifecycleSnapshot>
  isProcessAlive?: (pid: number, procStart?: string | null) => boolean | null
  isToolCompleted?: (sessionId: string, toolUseId: string) => boolean
}
export type CollectorResult = { sessions: SourceSession[]; waiting: SourceWaiting[]; tasks: SourceTask[]; events: SourceEvent[]; adapters: SourceAdapter[]; spoolToAck: string[] }
const spoolName = (name: string): boolean => /^cockpit-[A-Za-z0-9-]+\.json$/.test(name)

/** Sources are observations only. The owner commits them to its store, then acknowledges spool paths. */
export class CockpitCollector {
  private readonly options: CollectorOptions
  private readonly registryDir: string
  private readonly spoolDir: string
  private readonly claudeDir: string
  private readonly lifecycle: HookLifecycle
  private readonly codeguard: CodeguardReader
  private readonly transcript = new ByteTail()
  private readonly transcriptPaths = new Map<string, string>()
  private readonly pending = new Map<string, { digest: string; fileIdentity: FileIdentity }>()
  private readonly deadIdentities = new Map<string, { pid: number; procStart?: string | null; endedAt: string }>()
  private readonly registry = new Map<string, SourceSession>()
  private lastRegistryIds = new Set<string>()
  private readonly ackErrors: SourceEvent[] = []
  constructor(options: CollectorOptions = {}) {
    this.options = options
    this.claudeDir = options.claudeDir ?? join(homedir(), '.claude')
    this.registryDir = options.registryDir ?? join(this.claudeDir, 'sessions')
    this.spoolDir = resolve(options.spoolDir ?? join(homedir(), '.cli-organizer', 'cockpit-spool'))
    this.lifecycle = new HookLifecycle(options.initialLifecycle, { isToolCompleted: options.isToolCompleted })
    this.lastRegistryIds = new Set((options.initialLifecycle?.sessions ?? []).filter(session => session.pid !== null && session.state !== 'ended').map(session => session.sessionId))
    this.codeguard = new CodeguardReader(options.guardDir ?? join(homedir(), '.guard'))
  }
  poll(): CollectorResult {
    const clock = this.options.clock?.() ?? new Date(); const now = clock instanceof Date ? clock.toISOString() : clock
    const events: SourceEvent[] = this.ackErrors.splice(0)
    const registry = readRegistry(this.registryDir, this.options.knownVersions ?? KNOWN_CLAUDE_VERSIONS, now)
    events.push(...registry.events)
    const currentIds = new Set(registry.sessions.map(session => session.sessionId))
    const identities = new Map<string, boolean | null>()
    for (const session of registry.sessions) {
      if (session.pid !== null && this.options.isProcessAlive) {
        try {
          const alive = this.options.isProcessAlive(session.pid, session.procStart)
          identities.set(session.sessionId, alive)
          if (alive === false) {
            const dead = this.deadIdentities.get(session.sessionId)
            const endedAt = dead && dead.pid === session.pid && dead.procStart === session.procStart ? dead.endedAt : now
            this.deadIdentities.set(session.sessionId, { pid: session.pid, procStart: session.procStart, endedAt })
            session.state = 'ended'; session.endedAt = endedAt; this.lifecycle.endMissing(session.sessionId, now)
          }
          else if (alive === true) {
            const dead = this.deadIdentities.get(session.sessionId)
            if (dead && (dead.pid !== session.pid || dead.procStart !== session.procStart)) this.deadIdentities.delete(session.sessionId)
          }
          else if (alive === null) session.state = 'unknown'
        } catch (error) { session.state = 'unknown'; identities.set(session.sessionId, null); events.push(invalidEvent('registry', error instanceof Error ? error.message : 'Process identity check failed', '', now, session.sessionId)) }
      }
      this.registry.set(session.sessionId, session)
    }
    if (registry.complete) for (const id of this.lastRegistryIds) if (!currentIds.has(id)) {
      const session = this.registry.get(id)
      if (session) this.registry.set(id, { ...session, state: 'ended', updatedAt: now, endedAt: now })
      this.lifecycle.endMissing(id, now)
    }
    if (registry.complete) this.lastRegistryIds = currentIds
    const spoolToAck: string[] = []
    const spool = listFiles(this.spoolDir, 2048)
    if (spool.error) events.push(invalidEvent('hook', spool.error, '', now, this.spoolDir))
    for (const name of spool.names.filter(spoolName).slice(0, 128)) {
      const file = join(this.spoolDir, name); const loaded = readBounded(file)
      if ('error' in loaded) { events.push(invalidEvent('hook', loaded.error, '', now, file)); continue }
      const parsed = parseHookEvent(loaded.text, now, file)
      events.push(parsed.event)
      if (parsed.ok) {
        this.lifecycle.apply(parsed.event)
        const path = parsed.event.data.transcript_path
        if (typeof path === 'string' && this.validTranscriptPath(path)) this.transcriptPaths.set(path, parsed.event.sessionId)
      }
      this.pending.set(file, { digest: digest(loaded.text), fileIdentity: loaded.fileIdentity }); spoolToAck.push(file)
    }
    const lifecycle = this.lifecycle.snapshot()
    const sessions = new Map(this.registry)
    for (const session of lifecycle.sessions) {
      const native = sessions.get(session.sessionId)
      if (!native) sessions.set(session.sessionId, session)
      else if (session.updatedAt >= native.updatedAt || (session.state === 'error' && native.state !== 'ended')) sessions.set(session.sessionId, { ...native, state: session.state, updatedAt: session.updatedAt >= native.updatedAt ? session.updatedAt : native.updatedAt,
        ...(session.currentTool ? { currentTool: session.currentTool } : {}), ...(session.endedAt ? { endedAt: session.endedAt } : {}) })
    }
    for (const [id, alive] of identities) {
      const session = sessions.get(id)
      if (session && alive !== true) { session.state = alive === false ? 'ended' : 'unknown'; if (alive === false) session.endedAt = now }
    }
    for (const [id, dead] of this.deadIdentities) {
      const session = sessions.get(id)
      if (session) { session.state = 'ended'; session.endedAt = dead.endedAt }
    }
    const roots = [...new Set([...(this.options.projectRoots ?? []), ...[...sessions.values()].map(session => session.cwd)])]
    const guardian = readGuardianArtifacts(this.claudeDir, roots, now, this.options.knownGuardianVersions)
    const codeguard = this.codeguard.poll(now)
    events.push(...guardian.events, ...codeguard.events)
    const waiting = [...lifecycle.waiting, ...guardian.waiting].filter(item => sessions.get(item.sessionId)?.state !== 'ended')
    for (const item of waiting) {
      const session = sessions.get(item.sessionId)
      if (session && session.state !== 'ended') { if (identities.get(item.sessionId) !== null) session.state = 'waiting'; if (!item.cwd) item.cwd = session.cwd }
    }
    for (const session of registry.sessions) if (session.state === 'waiting' && sessions.get(session.sessionId)?.state === 'waiting' && !waiting.some(item => item.sessionId === session.sessionId)) waiting.push({ sessionId: session.sessionId,
      cwd: session.cwd, kind: 'other', ref: 'registry', summary: session.currentTool || 'Waiting for input', openedAt: session.updatedAt, source: 'registry' })
    for (const [path] of this.transcriptPaths) {
      const result = this.transcript.read(path)
      if (result.error) events.push(invalidEvent('transcript', result.error, '', now, path))
      if (result.oversized) events.push(invalidEvent('transcript', 'Oversized transcript records skipped', '', now, path))
      for (const line of result.lines.filter(Boolean)) { const event = parseTranscriptRecord(line, now); if (event) events.push(event) }
    }
    return { sessions: [...sessions.values()], waiting, tasks: [...lifecycle.tasks, ...guardian.tasks], events, spoolToAck,
      adapters: [registry.adapter, { source: 'hook', available: existsSync(this.spoolDir), supported: true, message: 'Optional local observation plugin', invalid: events.filter(event => event.source === 'hook' && event.kind === 'invalid').length },
        guardian.adapter, codeguard.adapter, { source: 'transcript', available: this.transcriptPaths.size > 0, supported: true, message: 'Tool metadata from appended bytes only', invalid: events.filter(event => event.source === 'transcript' && event.kind === 'invalid').length }] }
  }

  private validTranscriptPath(file: string): boolean {
    const root = resolve(this.claudeDir, 'projects'); const path = resolve(file)
    return path.startsWith(root + (process.platform === 'win32' ? '\\' : '/')) && path.endsWith('.jsonl')
  }

  ackSpool(paths: readonly string[]): void {
    for (const file of paths) {
      const path = resolve(file)
      if (dirname(path) !== this.spoolDir || !spoolName(basename(path)) || !this.pending.has(path)) continue
      try {
        const expected = this.pending.get(path)!
        const stat = lstatSync(path, { bigint: true })
        if (!stat.isFile() || stat.isSymbolicLink() || !sameFileIdentity(expected.fileIdentity, fileIdentity(stat))) continue
        const loaded = readBounded(path)
        if ('error' in loaded || !sameFileIdentity(expected.fileIdentity, loaded.fileIdentity) || digest(loaded.text) !== expected.digest) continue
        if (!sameFileIdentity(expected.fileIdentity, fileIdentity(lstatSync(path, { bigint: true })))) continue
        unlinkSync(path); this.pending.delete(path)
      } catch (error) { this.ackErrors.push(invalidEvent('hook', error instanceof Error ? error.message : 'Spool acknowledgement failed', '', new Date().toISOString(), path)) }
    }
  }
}
