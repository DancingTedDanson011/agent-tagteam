/** Plain, structured-clone-safe data exchanged by the cockpit and its local main process. */
export type CockpitState = 'error' | 'waiting' | 'running' | 'idle' | 'ended' | 'unknown'
export type CockpitLevel = 'overview' | 'board' | 'details'
export type CockpitSource = 'registry' | 'hook' | 'code_guardian' | 'codeguard' | 'transcript' | 'manual' | 'runner'
export type TaskState = 'todo' | 'doing' | 'review' | 'done' | 'blocked'
export type WaitingKind = 'question' | 'plan_approval' | 'permission' | 'dialog' | 'cg_decision' | 'cg_gate_ask' | 'other'

export type CockpitSettings = { level: CockpitLevel; retentionDays: number }
export type SourceHealth = { source: CockpitSource; status: 'ok' | 'missing' | 'unsupported' | 'error'; detail: string }

export type CockpitSession = {
  id: string
  projectId: number
  pid: number | null
  tileId: string | null
  name: string
  state: CockpitState
  rawState: string | null
  waitingFor: string | null
  version: string
  supported: boolean
  startedAt: string
  updatedAt: string
  observedSeconds: number
  contractId: string | null
}

export type WaitingItem = {
  id: string
  projectId: number
  sessionId: string | null
  kind: WaitingKind
  source: CockpitSource
  ref: string
  summary: string
  openedAt: string
  tileId: string | null
}

export type CockpitTask = {
  id: number
  projectId: number
  title: string
  state: TaskState
  source: 'manual' | 'hook' | 'code_guardian'
  ref: string | null
  contractId: string | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
  rawState?: string
  metadata?: Record<string, string>
}

export type CockpitEvent = {
  id: number
  projectId: number | null
  sessionId: string | null
  at: string
  source: CockpitSource
  kind: string
  summary: string
  detail: string
}

export type ContractStatus = 'draft' | 'frozen' | 'in_progress' | 'fulfilled' | 'amended' | 'cancelled'
export type ContractBudget = { max_sessions: number; max_hours: number; stop_when_exceeded: boolean; note?: string }
export type ContractEvidence = { command: string; exit_code: number; output_excerpt?: string; at: string; git_head?: string; source_fingerprint?: string }
export type ContractCriterion = {
  id: string
  type: 'automated' | 'manual'
  description: string
  check?: { command: string; expect: 'exit_code_0' }
  status: 'open' | 'met' | 'failed'
  evidence?: ContractEvidence | null
  approved_by?: string | null
}
export type ContractMilestone = { id: string; title: string; criteria: ContractCriterion[] }
export type ContractDocument = {
  schema_version?: 'cockpit-contract/1'
  contract_id: string
  project: string
  title: string
  status: ContractStatus
  objective: string
  non_goals: string[]
  depends_on?: string[]
  budget: ContractBudget
  milestones: ContractMilestone[]
  approved_by: string | null
  frozen_at: string | null
  amendments: { at: string; by?: string; summary: string; approved_by?: string | null }[]
  links: { sessions: string[]; code_guardian_task: string | null }
}

export type CriterionRun = {
  id: number
  projectId: number
  contractId: string
  criterionId: string
  startedAt: string
  finishedAt: string | null
  command: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  error: string | null
  gitHead: string | null
  freezeHash: string
  sourceFingerprint: string | null
  passed: boolean
}
export type ManualApproval = { criterionId: string; approvedBy: string; at: string; freezeHash: string; sourceFingerprint?: string | null }
export type ContractView = {
  id: string
  path: string
  document: ContractDocument | null
  errors: string[]
  definitionHash: string | null
  sourceFingerprint: string | null
  freeze: { hash: string; approvedBy: string; at: string } | null
  changed: boolean
  runs: CriterionRun[]
  manualApprovals: ManualApproval[]
  progress: { met: number; total: number }
  usage: { sessions: number; observedSeconds: number; exceeded: boolean }
  fulfilled: boolean
  running: boolean
  goalText: string | null
}

export type ProjectView = {
  id: number
  root: string
  name: string
  branch: string | null
  state: CockpitState
  sessions: CockpitSession[]
  waiting: WaitingItem[]
  tasks: CockpitTask[]
  contracts: ContractView[]
  events: CockpitEvent[]
  observedSeconds: number
}
export type CockpitSnapshot = {
  at: string
  writable: boolean
  error: string | null
  projects: ProjectView[]
  adapters: SourceHealth[]
  settings: CockpitSettings
  pluginPath: string | null
}

export type CockpitCommand =
  | { type: 'add-project'; root: string }
  | { type: 'create-task'; projectId: number; title: string; contractId?: string | null; sessionId?: string | null }
  | { type: 'move-task'; projectId: number; taskId: number; state: TaskState }
  | { type: 'assign-task'; projectId: number; taskId: number; contractId: string | null }
  | { type: 'save-settings'; level: CockpitLevel; retentionDays: number }
  | { type: 'create-contract'; projectId: number; title: string; objective: string; maxSessions: number; maxHours: number; command: string }
  | { type: 'save-contract'; projectId: number; contractId: string; json: string; expectedDefinitionHash: string }
  | { type: 'freeze-contract'; projectId: number; contractId: string; approvedBy: string; expectedDefinitionHash: string }
  | { type: 'amend-contract'; projectId: number; contractId: string; summary: string; expectedDefinitionHash: string }
  | { type: 'approve-criterion'; projectId: number; contractId: string; criterionId: string; approvedBy: string; expectedFreezeHash: string; expectedSourceFingerprint: string }
  | { type: 'run-criterion'; projectId: number; contractId: string; criterionId: string }
  | { type: 'run-contract'; projectId: number; contractId: string }
  | { type: 'cancel-check'; projectId: number; contractId: string }
  | { type: 'assign-session'; projectId: number; sessionId: string; contractId: string | null }
  | { type: 'refresh' }

export type CockpitResult = { ok: true; message?: string; path?: string } | { ok: false; error: string }

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' && value.length <= max && !value.includes('\0') && (empty || value.trim().length > 0)
const contractId = (value: unknown): value is string => text(value, 200) && /^C-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(value)
const sessionId = (value: unknown): value is string => text(value, 200) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const taskStates: readonly TaskState[] = ['todo', 'doing', 'review', 'done', 'blocked']

/** Clean copy at the renderer boundary. Files, approvals and frozen hashes are checked again in main. */
export function parseCockpitCommand(value: unknown): CockpitCommand | null {
  if (!object(value) || typeof value.type !== 'string') return null
  const v = value
  if (v.type === 'refresh') return { type: 'refresh' }
  if (v.type === 'add-project') {
    return text(v.root, 32767) && /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+|\/)/.test(v.root)
      ? { type: 'add-project', root: v.root } : null
  }
  if (v.type === 'save-settings') {
    return (v.level === 'overview' || v.level === 'board' || v.level === 'details') &&
      Number.isInteger(v.retentionDays) && (v.retentionDays as number) >= 1 && (v.retentionDays as number) <= 3650
      ? { type: 'save-settings', level: v.level, retentionDays: v.retentionDays as number } : null
  }
  if (!id(v.projectId)) return null
  const projectId = v.projectId
  if (v.type === 'create-task') {
    if (!text(v.title, 500) || (v.contractId !== undefined && v.contractId !== null && !contractId(v.contractId)) ||
      (v.sessionId !== undefined && v.sessionId !== null && !sessionId(v.sessionId))) return null
    return { type: 'create-task', projectId, title: v.title.trim(),
      ...(v.contractId !== undefined ? { contractId: v.contractId as string | null } : {}),
      ...(v.sessionId !== undefined ? { sessionId: v.sessionId as string | null } : {}) }
  }
  if (v.type === 'move-task') {
    return id(v.taskId) && taskStates.includes(v.state as TaskState)
      ? { type: 'move-task', projectId, taskId: v.taskId, state: v.state as TaskState } : null
  }
  if (v.type === 'assign-task') {
    return id(v.taskId) && (v.contractId === null || contractId(v.contractId))
      ? { type: 'assign-task', projectId, taskId: v.taskId, contractId: v.contractId as string | null } : null
  }
  if (v.type === 'create-contract') {
    return text(v.title, 200) && text(v.objective, 8000) && text(v.command, 8000, true) &&
      id(v.maxSessions) && v.maxSessions <= 100000 && typeof v.maxHours === 'number' &&
      Number.isFinite(v.maxHours) && v.maxHours > 0 && v.maxHours <= 100000
      ? { type: 'create-contract', projectId, title: v.title.trim(), objective: v.objective.trim(),
          maxSessions: v.maxSessions, maxHours: v.maxHours, command: v.command } : null
  }
  if (v.type === 'assign-session') {
    return sessionId(v.sessionId) && (v.contractId === null || contractId(v.contractId))
      ? { type: 'assign-session', projectId, sessionId: v.sessionId, contractId: v.contractId as string | null } : null
  }
  if (!contractId(v.contractId)) return null
  const contract = v.contractId
  switch (v.type) {
    case 'save-contract': return text(v.json, 1048576) && hash(v.expectedDefinitionHash) ? { type: v.type, projectId, contractId: contract, json: v.json, expectedDefinitionHash: v.expectedDefinitionHash } : null
    case 'freeze-contract': return text(v.approvedBy, 100) && hash(v.expectedDefinitionHash) ? { type: v.type, projectId, contractId: contract, approvedBy: v.approvedBy.trim(), expectedDefinitionHash: v.expectedDefinitionHash } : null
    case 'amend-contract': return text(v.summary, 4000) && hash(v.expectedDefinitionHash) ? { type: v.type, projectId, contractId: contract, summary: v.summary.trim(), expectedDefinitionHash: v.expectedDefinitionHash } : null
    case 'run-contract':
    case 'cancel-check': return { type: v.type, projectId, contractId: contract }
    case 'run-criterion':
      return text(v.criterionId, 100) && /^AC[0-9]+$/.test(v.criterionId)
        ? { type: v.type, projectId, contractId: contract, criterionId: v.criterionId } : null
    case 'approve-criterion':
      return text(v.criterionId, 100) && /^AC[0-9]+$/.test(v.criterionId) && text(v.approvedBy, 100) && hash(v.expectedFreezeHash) && hash(v.expectedSourceFingerprint)
        ? { type: v.type, projectId, contractId: contract, criterionId: v.criterionId, approvedBy: v.approvedBy.trim(), expectedFreezeHash: v.expectedFreezeHash, expectedSourceFingerprint: v.expectedSourceFingerprint } : null
    default: return null
  }
}
