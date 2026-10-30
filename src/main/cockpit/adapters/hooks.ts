import { absolutePath, date, digest, identity, invalidEvent, isRecord, KNOWN_CLAUDE_VERSIONS, MAX_SOURCE_BYTES, rawExcerpt, sanitize, text } from './common'
import type { LifecycleSnapshot, SourceEvent, SourceSession, SourceTask, SourceWaiting } from './common'

export type HookEvent = SourceEvent & { source: 'hook'; sessionId: string; cwd: string; name: string; toolName: string; toolUseId: string; data: Record<string, unknown> }
export type CompletedToolRef = { sessionId: string; toolUseId: string }
export type HookLifecycleOptions = { isToolCompleted?: (sessionId: string, toolUseId: string) => boolean; maxCompletedTools?: number }
/** Fresh parsed events retain this identity independently of the bounded display excerpt. */
export function completedToolOf(event: SourceEvent): CompletedToolRef | null {
  if (event.source !== 'hook' || !['PostToolUse', 'PostToolUseFailure'].includes(event.kind)) return null
  const sessionId = identity(event.sessionId)
  const toolUseId = identity((event as Partial<HookEvent>).toolUseId)
  return sessionId && toolUseId ? { sessionId, toolUseId } : null
}
export function parseHookEvent(value: unknown, now = new Date().toISOString(), ref = ''): { ok: true; event: HookEvent } | { ok: false; event: SourceEvent } {
  let data = value
  if (typeof data === 'string') {
    if (Buffer.byteLength(data) > MAX_SOURCE_BYTES) return { ok: false, event: invalidEvent('hook', 'Hook payload exceeds byte limit', '[oversized]', now, ref) }
    try { data = JSON.parse(data) } catch { return { ok: false, event: invalidEvent('hook', 'Invalid hook JSON', data, now, ref) } }
  }
  if (!isRecord(data) || !identity(data.session_id) || !absolutePath(data.cwd) || !identity(data.hook_event_name)) {
    return { ok: false, event: invalidEvent('hook', 'Hook identity or event is invalid', data, now, ref) }
  }
  // Sanitize before any field becomes a state value or persistent evidence.
  const clean = sanitize(data) as Record<string, unknown>
  const raw = rawExcerpt(clean)
  const name = identity(data.hook_event_name)
  const sessionId = identity(data.session_id)
  const at = date(data.cockpit_recorded_at ?? data.timestamp, now)
  const toolName = text(clean.tool_name, 200)
  return { ok: true, event: { id: `hook:${digest(ref || raw + at)}`, source: 'hook', kind: name, at, sessionId, cwd: data.cwd as string, name,
    toolName, toolUseId: identity(data.tool_use_id), data: clean, raw, summary: text(toolName ? `${name}: ${toolName}` : name) } }
}

const waitingKey = (item: Pick<SourceWaiting, 'sessionId' | 'kind' | 'ref'>): string => `${item.sessionId}\u0000${item.kind}\u0000${item.ref}`
export class HookLifecycle {
  private readonly sessions = new Map<string, SourceSession>()
  private readonly waiting = new Map<string, SourceWaiting>()
  private readonly tasks = new Map<string, SourceTask>()
  private readonly processed = new Set<string>()
  private readonly completed = new Map<string, true>()
  private readonly maxCompletedTools: number
  constructor(initial?: Partial<LifecycleSnapshot>, private readonly options: HookLifecycleOptions = {}) {
    this.maxCompletedTools = options.maxCompletedTools ?? 4096
    if (!Number.isInteger(this.maxCompletedTools) || this.maxCompletedTools < 1 || this.maxCompletedTools > 4096) throw new Error('Invalid completion cache capacity')
    for (const session of initial?.sessions ?? []) this.sessions.set(session.sessionId, { ...session })
    for (const item of initial?.waiting ?? []) if (item.source === 'hook') this.waiting.set(waitingKey(item), { ...item })
    for (const task of initial?.tasks ?? []) if (task.source === 'claude_task') this.tasks.set(task.sourceRef, { ...task })
    for (const item of [...this.waiting.values()]) if (item.ref && this.wasToolCompleted(item.sessionId, item.ref)) this.resolveTool(item.sessionId, item.ref)
  }

  private rememberCompletion(sessionId: string, toolUseId: string): void {
    const key = `${sessionId}\0${toolUseId}`
    if (this.completed.has(key)) return
    if (this.completed.size >= this.maxCompletedTools) {
      if (!this.options.isToolCompleted) throw new Error('A persistent completion lookup is required when the causal cache is full')
      this.completed.delete(this.completed.keys().next().value!)
    }
    this.completed.set(key, true)
  }

  private wasToolCompleted(sessionId: string, toolUseId: string): boolean {
    if (this.completed.has(`${sessionId}\0${toolUseId}`)) return true
    if (!this.options.isToolCompleted?.(sessionId, toolUseId)) return false
    this.rememberCompletion(sessionId, toolUseId)
    return true
  }

  private resolveTool(sessionId: string, toolUseId: string): void {
    let removed = false
    for (const [key, item] of this.waiting) if (item.sessionId === sessionId && item.ref === toolUseId) { this.waiting.delete(key); removed = true }
    const session = this.sessions.get(sessionId)
    if (removed && session?.state === 'waiting' && ![...this.waiting.values()].some(item => item.sessionId === sessionId)) this.sessions.set(sessionId, { ...session, state: 'busy' })
  }

  apply(event: HookEvent): void {
    const { sessionId, cwd, name, toolName, toolUseId, data, at } = event
    const completion = completedToolOf(event)
    if (completion) { this.rememberCompletion(completion.sessionId, completion.toolUseId); this.resolveTool(completion.sessionId, completion.toolUseId) }
    const opensToolWait = name === 'PermissionRequest' || (name === 'PreToolUse' && ['AskUserQuestion', 'ExitPlanMode'].includes(toolName))
    if (opensToolWait && toolUseId && this.wasToolCompleted(sessionId, toolUseId)) { this.resolveTool(sessionId, toolUseId); return }
    if (this.processed.has(event.id)) return
    // Task facts have their own ordering and remain valid even after unrelated activity or SessionEnd.
    this.applyTask(event)
    const prior = this.sessions.get(sessionId)
    if ((prior && at < prior.updatedAt) || (prior?.state === 'ended' && name !== 'SessionStart')) return
    this.processed.add(event.id)
    if (this.processed.size > 4096) this.processed.delete(this.processed.values().next().value!)
    const version = text(data.version, 100) || prior?.version || ''
    const session: SourceSession = { sessionId, cwd, pid: prior?.pid ?? null, name: prior?.name ?? sessionId, version,
      versionSupported: KNOWN_CLAUDE_VERSIONS.includes(version as typeof KNOWN_CLAUDE_VERSIONS[number]), state: prior?.state === 'waiting' ? 'busy' : prior?.state ?? 'unknown', statusRaw: name,
      startedAt: prior?.startedAt ?? at, updatedAt: at, ...(prior?.currentTool ? { currentTool: prior.currentTool } : {}) }
    for (const [key, item] of this.waiting) if (item.sessionId === sessionId && item.kind === 'dialog') this.waiting.delete(key)
    const clear = (predicate: (item: SourceWaiting) => boolean) => {
      for (const [key, item] of this.waiting) if (item.sessionId === sessionId && predicate(item)) this.waiting.delete(key)
    }
    if (name === 'PostToolUse' || name === 'PostToolUseFailure') clear(item =>
      (!!toolUseId && item.ref === toolUseId) || (item.kind === 'permission' && (!toolUseId || !item.ref)))
    if (name === 'Stop' || name === 'StopFailure' || name === 'SessionEnd') { clear(() => true); session.state = name === 'SessionEnd' ? 'ended' : name === 'StopFailure' ? 'error' : 'idle'; delete session.currentTool }
    if (name === 'SessionEnd') session.endedAt = at
    if (name === 'UserPromptSubmit') { clear(item => item.kind === 'permission'); session.state = 'busy' }
    if (name === 'SessionStart') { session.state = 'idle'; delete session.endedAt }
    if (name === 'PreToolUse') {
      session.state = 'busy'
      const input = isRecord(data.tool_input) ? data.tool_input : {}
      const file = text(input.file_path ?? input.path, 1000)
      session.currentTool = file ? `${toolName} · ${file}` : toolName
    }
    const add = (kind: SourceWaiting['kind'], ref: string, summary: string) => {
      const item: SourceWaiting = { sessionId, cwd, kind, ref, summary: text(summary), openedAt: at, source: 'hook' }
      const old = this.waiting.get(waitingKey(item))
      this.waiting.set(waitingKey(item), { ...item, openedAt: old?.openedAt ?? at })
    }
    if (name === 'PreToolUse' && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode')) {
      const input = isRecord(data.tool_input) ? data.tool_input : {}
      const questions = Array.isArray(input.questions) ? input.questions.filter(isRecord).map(question => text(question.question)).filter(Boolean).join('\n') : ''
      add(toolName === 'AskUserQuestion' ? 'question' : 'plan_approval', toolUseId, questions || (toolName === 'ExitPlanMode' ? 'Plan approval requested' : 'Question requires your answer'))
    }
    if (name === 'PermissionRequest') {
      const existing = [...this.waiting.values()].find(item => item.sessionId === sessionId && (item.kind === 'question' || item.kind === 'plan_approval') &&
        (item.ref === toolUseId || (!toolUseId && (toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode'))))
      if (!existing) add('permission', toolUseId, toolName ? `Permission requested: ${toolName}` : 'Permission requested')
    }
    if (name === 'Notification' && ['elicitation_dialog', 'agent_needs_input', 'permission_prompt'].includes(text(data.notification_type))) add('dialog', '', text(data.message) || 'Input requested')
    if ([...this.waiting.values()].some(item => item.sessionId === sessionId)) session.state = 'waiting'
    this.sessions.set(sessionId, session)
  }

  private applyTask(event: HookEvent): void {
    const { name, data, toolName, sessionId, cwd } = event
    const input = isRecord(data.tool_input) ? data.tool_input : {}
    const response = isRecord(data.tool_response) ? data.tool_response : {}
    const responseTask = isRecord(response.task) ? response.task : response
    const create = name === 'TaskCreated' || (name === 'PostToolUse' && toolName === 'TaskCreate')
    const update = name === 'TaskCompleted' || (name === 'PostToolUse' && toolName === 'TaskUpdate')
    if (!create && !update) return
    const taskId = identity(data.task_id) || identity(responseTask.id) || identity(input.taskId)
    if (!taskId) return
    const sourceRef = `${sessionId}:${taskId}`
    let old = this.tasks.get(sourceRef)
    const suppliedTitle = text(data.task_subject ?? responseTask.subject ?? input.subject, 500)
    if (old && suppliedTitle && old.metadata?._hook_task_has_title === 'false') {
      old = { ...old, title: suppliedTitle, metadata: { ...old.metadata, _hook_task_has_title: 'true' } }
      this.tasks.set(sourceRef, old)
    }
    // A creation is a baseline, never a subsequent mutation, even when its asynchronous hook arrives late.
    if (create && old) return
    const kind = create ? 'create' : 'update'
    const operation = event.toolUseId || event.id
    const oldAt = old?.metadata?._hook_task_at
    const oldKind = old?.metadata?._hook_task_kind
    if (old?.metadata?._hook_task_operation === operation && oldKind === kind) return
    const title = suppliedTitle || old?.title || taskId
    const oldStatus = old?.sourceState || (old?.state === 'done' ? 'completed' : old?.state === 'in_progress' ? 'in_progress' : old?.state === 'dropped' ? 'deleted' : 'pending')
    const status = name === 'TaskCompleted' ? 'completed' : text(input.status ?? responseTask.status) || (update ? oldStatus : 'pending')
    const state: SourceTask['state'] = status === 'completed' ? 'done' : status === 'in_progress' ? 'in_progress' : status === 'deleted' ? 'dropped' : 'open'
    const rank = (value: SourceTask['state']) => value === 'dropped' ? 3 : value === 'done' ? 2 : value === 'in_progress' ? 1 : 0
    if (old && oldKind !== 'create' && oldAt && (event.at < oldAt || (event.at === oldAt && rank(state) <= rank(old.state)))) return
    this.tasks.set(sourceRef, { source: 'claude_task', sourceRef, cwd, sessionId, title, state, sourceState: status,
      metadata: { ...old?.metadata, _hook_task_at: event.at, _hook_task_kind: kind, _hook_task_operation: operation,
        _hook_task_has_title: String(!!suppliedTitle || (old ? old.metadata?._hook_task_has_title !== 'false' : false)) } })
  }

  endMissing(sessionId: string, at: string): void {
    const session = this.sessions.get(sessionId)
    if (session) this.sessions.set(sessionId, { ...session, state: 'ended', updatedAt: at, endedAt: at })
    for (const [key, item] of this.waiting) if (item.sessionId === sessionId) this.waiting.delete(key)
  }

  snapshot(): LifecycleSnapshot {
    return { sessions: [...this.sessions.values()].map(value => ({ ...value })), waiting: [...this.waiting.values()].map(value => ({ ...value })), tasks: [...this.tasks.values()].map(value => ({ ...value })) }
  }
}
