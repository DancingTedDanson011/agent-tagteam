import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ContractCriterion, ContractDocument, ContractView } from '../../shared/cockpit'
import { redact } from '../agents/mcp'
import { atomicWrite, isWithinDirectory as inside } from '../fsutil'
import type { CockpitStore, ProjectRecord } from './store'

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const nullableText = (value: unknown) => value === null || typeof value === 'string'
const strings = (value: unknown, nonempty = false): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string' && (!nonempty || item.length > 0))
const contractId = (value: unknown): value is string => typeof value === 'string' && /^C-[A-Z0-9]+(-[A-Z0-9]+)*$/.test(value)
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) => required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))

/** Mirrors the shipped JSON schema, with uniqueness checks that JSON Schema does not express. */
export function parseContract(value: unknown): { document: ContractDocument | null; errors: string[] } {
  const errors: string[] = []
  const fail = (path: string) => { errors.push(`Invalid ${path}`) }
  if (!record(value)) return { document: null, errors: ['Contract must be an object'] }
  if (!keys(value, ['contract_id', 'project', 'title', 'status', 'objective', 'non_goals', 'budget', 'milestones', 'approved_by', 'frozen_at', 'amendments', 'links'], ['schema_version', 'depends_on'])) fail('contract properties')
  if (value.schema_version !== undefined && value.schema_version !== 'cockpit-contract/1') fail('schema_version')
  if (!contractId(value.contract_id)) fail('contract_id')
  if (typeof value.project !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(value.project)) fail('project')
  if (!text(value.title) || !text(value.objective)) fail('title/objective')
  if (!['draft', 'frozen', 'in_progress', 'fulfilled', 'amended', 'cancelled'].includes(String(value.status))) fail('status')
  if (!strings(value.non_goals, true)) fail('non_goals')
  if (value.depends_on !== undefined && (!Array.isArray(value.depends_on) || !value.depends_on.every(contractId))) fail('depends_on')
  if (!nullableText(value.approved_by) || !nullableText(value.frozen_at)) fail('approval metadata')
  const budget = value.budget
  if (!record(budget) || !keys(budget, ['max_sessions', 'max_hours', 'stop_when_exceeded'], ['note']) || !Number.isSafeInteger(budget.max_sessions) || Number(budget.max_sessions) < 1 || typeof budget.max_hours !== 'number' || !Number.isFinite(budget.max_hours) || budget.max_hours <= 0 || typeof budget.stop_when_exceeded !== 'boolean' || (budget.note !== undefined && typeof budget.note !== 'string')) fail('budget')
  const milestoneIds = new Set<string>()
  const criterionIds = new Set<string>()
  if (!Array.isArray(value.milestones) || value.milestones.length === 0) fail('milestones')
  else for (const milestone of value.milestones) {
    if (!record(milestone) || !keys(milestone, ['id', 'title', 'criteria']) || typeof milestone.id !== 'string' || !/^M[0-9]+$/.test(milestone.id) || !text(milestone.title) || !Array.isArray(milestone.criteria) || milestone.criteria.length === 0) { fail('milestone'); continue }
    if (milestoneIds.has(milestone.id)) fail(`duplicate milestone ${milestone.id}`)
    milestoneIds.add(milestone.id)
    for (const criterion of milestone.criteria) {
      if (!record(criterion) || !keys(criterion, ['id', 'type', 'description', 'status'], ['check', 'evidence', 'approved_by']) || typeof criterion.id !== 'string' || !/^AC[0-9]+$/.test(criterion.id) || !text(criterion.description) || !['automated', 'manual'].includes(String(criterion.type)) || !['open', 'met', 'failed'].includes(String(criterion.status))) { fail('criterion'); continue }
      if (criterionIds.has(criterion.id)) fail(`duplicate criterion ${criterion.id}`)
      criterionIds.add(criterion.id)
      if (criterion.type === 'automated') {
        if (!record(criterion.check) || !keys(criterion.check, ['command', 'expect']) || !text(criterion.check.command) || criterion.check.expect !== 'exit_code_0') fail(`${criterion.id}.check`)
      } else if (Object.hasOwn(criterion, 'check')) fail(`${criterion.id}.manual check`)
      if (criterion.approved_by !== undefined && !nullableText(criterion.approved_by)) fail(`${criterion.id}.approved_by`)
      if (criterion.evidence !== undefined && criterion.evidence !== null) {
        const evidence = criterion.evidence
        if (!record(evidence) || !keys(evidence, ['command', 'exit_code', 'at'], ['output_excerpt', 'git_head', 'source_fingerprint']) || typeof evidence.command !== 'string' || !Number.isSafeInteger(evidence.exit_code) || typeof evidence.at !== 'string' || (evidence.output_excerpt !== undefined && typeof evidence.output_excerpt !== 'string') || (evidence.git_head !== undefined && typeof evidence.git_head !== 'string') || (evidence.source_fingerprint !== undefined && (typeof evidence.source_fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(evidence.source_fingerprint)))) fail(`${criterion.id}.evidence`)
      }
    }
  }
  if (!Array.isArray(value.amendments)) fail('amendments')
  else for (const amendment of value.amendments) if (!record(amendment) || !keys(amendment, ['at', 'summary'], ['by', 'approved_by']) || typeof amendment.at !== 'string' || !text(amendment.summary) || (amendment.by !== undefined && typeof amendment.by !== 'string') || (amendment.approved_by !== undefined && !nullableText(amendment.approved_by))) fail('amendment')
  const links = value.links
  if (!record(links) || !keys(links, ['sessions', 'code_guardian_task']) || !strings(links.sessions) || !nullableText(links.code_guardian_task)) fail('links')
  return { document: errors.length ? null : structuredClone(value) as ContractDocument, errors }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export function definitionHash(document: ContractDocument): string {
  const definition = { contract_id: document.contract_id, project: document.project, title: document.title, objective: document.objective, non_goals: document.non_goals, depends_on: document.depends_on, budget: document.budget, milestones: document.milestones.map((milestone) => ({ id: milestone.id, title: milestone.title, criteria: milestone.criteria.map((criterion) => ({ id: criterion.id, type: criterion.type, description: criterion.description, check: criterion.check })) })) }
  return createHash('sha256').update(canonical(definition)).digest('hex')
}
export function generateGoal(document: ContractDocument, openIds: string[], runnerCommand: string): string {
  if (runnerCommand !== 'clio.run_contract_check') throw new Error('Unknown cockpit check tool')
  const goal = `/goal ${document.objective}\nVertrag: ${document.contract_id}\nNicht-Ziele: ${document.non_goals.join('; ')}\nOffene Kriterien: ${openIds.join(', ') || 'keine'}.\nPrüfe mit dem clio-Werkzeug run_contract_check den Vertrag ${document.contract_id}; nutze optional criterion_id für einzelne automatisierte Kriterien. Das Cockpit entscheidet anhand aktueller Nachweise und manueller Eigentümerabnahmen über erfüllt. Ändere eingefrorene Kriterien nur über ein freigegebenes Amendment.`
  if (goal.length > 4000) throw new Error('Goal exceeds the supported length; shorten the objective or non-goals')
  return goal
}

export type SourceStamp = { fingerprint: string | null; gitHead: string | null; error: string | null }
export type LightContractInput = { title: string; objective: string; maxSessions: number; maxHours: number; command?: string; criteria?: { description: string; command?: string }[] }
type ContractFile = { id: string; path: string; document: ContractDocument | null; errors: string[] }
const criterionIds = (document: ContractDocument | null): string[] => document?.milestones.flatMap((milestone) => milestone.criteria.map((criterion) => criterion.id)) ?? []
const MAX_CONTRACT_BYTES = 1024 * 1024
const errorText = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000)

export function createLightContract(project: string, input: LightContractInput): ContractDocument {
  const criteria = input.criteria ?? [{ description: `Verify: ${input.objective}`, ...(input.command?.trim() ? { command: input.command } : {}) }, { description: `Owner accepts the delivered result: ${input.objective}` }]
  if (criteria.length < 2 || criteria.length > 3) throw new Error('Light mode requires two or three criteria')
  const value: ContractDocument = {
    schema_version: 'cockpit-contract/1', contract_id: `C-${randomUUID().toUpperCase()}`, project,
    title: input.title, status: 'draft', objective: input.objective, non_goals: [],
    budget: { max_sessions: input.maxSessions, max_hours: input.maxHours, stop_when_exceeded: true },
    milestones: [{ id: 'M1', title: input.title, criteria: criteria.map((criterion, index) => ({ id: `AC${index + 1}`, type: criterion.command ? 'automated' : 'manual', description: criterion.description, ...(criterion.command ? { check: { command: criterion.command, expect: 'exit_code_0' as const } } : {}), status: 'open', evidence: null, approved_by: null })) }],
    approved_by: null, frozen_at: null, amendments: [], links: { sessions: [], code_guardian_task: null }
  }
  const parsed = parseContract(value)
  if (!parsed.document) throw new Error(parsed.errors.join('; '))
  return parsed.document
}

export class ContractRepository {
  private fingerprint: (root: string, fresh?: boolean) => Promise<SourceStamp> = async () => ({ fingerprint: null, gitHead: null, error: 'Source freshness has not been verified' })
  private running: (projectId: number, contractId: string) => boolean = () => false
  constructor(readonly store: CockpitStore) {}
  setFingerprintProvider(provider: (root: string, fresh?: boolean) => Promise<SourceStamp>): void { this.fingerprint = provider }
  setRunningProvider(provider: (projectId: number, contractId: string) => boolean): void { this.running = provider }
  private project(projectId: number): ProjectRecord {
    const project = this.store.project(projectId)
    if (!project) throw new Error('Unknown project')
    if (realpathSync.native(project.rootPath) !== project.rootPath) throw new Error('Project root identity changed')
    return project
  }
  private directory(project: ProjectRecord): string {
    const directory = join(project.rootPath, '.contracts')
    if (existsSync(directory) && !inside(project.rootPath, realpathSync.native(directory))) throw new Error('Contract directory escapes the project root')
    return directory
  }
  private read(path: string, root: string): ContractFile {
    const fallback = basename(path, '.json')
    try {
      if (!inside(root, realpathSync.native(path))) throw new Error('Contract file escapes the project root')
      const fd = openSync(path, 'r')
      let source: string
      try {
        if (fstatSync(fd).size > MAX_CONTRACT_BYTES) throw new Error('Contract file is too large')
        const buffer = Buffer.alloc(MAX_CONTRACT_BYTES + 1)
        const length = readSync(fd, buffer, 0, buffer.length, 0)
        if (length > MAX_CONTRACT_BYTES) throw new Error('Contract file is too large')
        source = buffer.subarray(0, length).toString('utf8')
      } finally { closeSync(fd) }
      const parsed = parseContract(JSON.parse(source))
      return { id: parsed.document?.contract_id ?? fallback, path, ...parsed }
    } catch (error) { return { id: fallback, path, document: null, errors: [errorText(error)] } }
  }
  private scan(project: ProjectRecord): ContractFile[] {
    const directory = this.directory(project)
    if (!existsSync(directory)) return []
    const files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.name.endsWith('.json') && (entry.isFile() || entry.isSymbolicLink())).map((entry) => this.read(join(directory, entry.name), project.rootPath))
    const counts = new Map<string, number>()
    for (const file of files) if (file.document) counts.set(file.id, (counts.get(file.id) ?? 0) + 1)
    for (const file of files) {
      if ((counts.get(file.id) ?? 0) > 1) file.errors.push(`Duplicate contract ID ${file.id}`)
      if (file.document && !file.errors.length && this.store.canWrite()) this.store.upsertContract(project.id, file.id, file.path, file.document.status)
    }
    return files.sort((a, b) => a.id.localeCompare(b.id))
  }
  private raw(projectId: number, id: string): { project: ProjectRecord; file: ContractFile; document: ContractDocument } {
    const project = this.project(projectId)
    const file = this.scan(project).find((item) => item.id === id)
    if (!file?.document || file.errors.length) throw new Error(file?.errors.join('; ') || 'Unknown contract')
    return { project, file, document: file.document }
  }
  private frozen(projectId: number, id: string) {
    const loaded = this.raw(projectId, id)
    const freeze = this.store.getFreeze(projectId, id)
    if (!freeze) throw new Error('Contract needs a local owner-approved freeze')
    if (definitionHash(loaded.document) !== freeze.hash) throw new Error('Frozen definition changed; an owner-approved amendment is required')
    if (!['frozen', 'in_progress', 'fulfilled'].includes(loaded.document.status)) throw new Error('Contract is not frozen for execution')
    return { ...loaded, freeze }
  }
  assertFrozen(projectId: number, id: string) { return this.frozen(projectId, id) }
  private reviewed(document: ContractDocument, expected: string): void {
    if (!expected || definitionHash(document) !== expected) throw new Error('Contract changed since review; reopen it and review again')
  }
  assertRunnable(projectId: number, id: string, criterionId: string): { project: ProjectRecord; document: ContractDocument; criterion: ContractCriterion; freezeHash: string } {
    const loaded = this.frozen(projectId, id)
    const criterion = loaded.document.milestones.flatMap((milestone) => milestone.criteria).find((item) => item.id === criterionId)
    if (!criterion || criterion.type !== 'automated' || !criterion.check) throw new Error('Criterion has no automated check')
    const usage = this.store.contractUsage(projectId, id)
    if (loaded.document.budget.stop_when_exceeded && (usage.sessions > loaded.document.budget.max_sessions || usage.observedSeconds > loaded.document.budget.max_hours * 3600)) throw new Error('Contract budget exceeded; owner amendment required')
    return { project: loaded.project, document: loaded.document, criterion, freezeHash: loaded.freeze.hash }
  }
  async list(projectId: number, fresh = false): Promise<ContractView[]> {
    const project = this.project(projectId)
    const files = this.scan(project)
    const needsStamp = files.some((file) => file.document && this.store.getFreeze(projectId, file.id) && (file.document.milestones.some((milestone) => milestone.criteria.some((criterion) => criterion.type === 'manual')) || this.store.hasRuns(projectId, file.id, criterionIds(file.document)) || this.store.manualApprovals(projectId, file.id).length > 0))
    let stamp: SourceStamp = { fingerprint: null, gitHead: null, error: null }
    if (needsStamp) try { stamp = await this.fingerprint(project.rootPath, fresh) } catch (error) { stamp = { fingerprint: null, gitHead: null, error: errorText(error) } }
    return files.map((file) => this.view(project, file, stamp))
  }
  private view(project: ProjectRecord, file: ContractFile, stamp: SourceStamp): ContractView {
    const document = file.document ? structuredClone(file.document) : null
    const hash = document ? definitionHash(document) : null
    const freeze = this.store.getFreeze(project.id, file.id)
    const changed = !!(freeze && hash !== freeze.hash)
    const errors = [...file.errors]
    if (changed) errors.push('Frozen definition changed; amendment required')
    const active = !!(freeze && !changed && document && ['frozen', 'in_progress', 'fulfilled'].includes(document.status) && !file.errors.length)
    // Read payloads after the awaited fingerprint: a check may have started while it was computed.
    const runs = this.store.latestRuns(project.id, file.id, criterionIds(document))
    const approvals = this.store.manualApprovals(project.id, file.id, hash ?? undefined)
    const latest = new Map<string, (typeof runs)[number]>()
    for (const run of runs) if (!latest.has(run.criterionId)) latest.set(run.criterionId, run)
    const validStamp = !!stamp.fingerprint && !stamp.error
    let met = 0
    const criteria = document?.milestones.flatMap((milestone) => milestone.criteria) ?? []
    for (const criterion of criteria) {
      const run = latest.get(criterion.id)
      const approval = approvals.find((item) => item.criterionId === criterion.id && item.sourceFingerprint === stamp.fingerprint)
      const currentRun = active && validStamp && run?.freezeHash === hash && run.sourceFingerprint === stamp.fingerprint && run.gitHead === stamp.gitHead
      const accepted = criterion.type === 'automated' ? currentRun && run.passed : active && validStamp && !!approval
      criterion.status = accepted ? 'met' : criterion.type === 'automated' && currentRun && run.finishedAt !== null && !run.passed ? 'failed' : 'open'
      criterion.approved_by = criterion.type === 'manual' && accepted ? approval!.approvedBy : null
      criterion.evidence = criterion.type === 'automated' && currentRun && run.exitCode !== null ? { command: run.command, exit_code: run.exitCode, output_excerpt: run.stdout + run.stderr, at: run.finishedAt ?? run.startedAt, ...(run.gitHead ? { git_head: run.gitHead } : {}), ...(run.sourceFingerprint ? { source_fingerprint: run.sourceFingerprint } : {}) } : null
      if (accepted) met++
    }
    const running = this.running(project.id, file.id) || runs.some((run) => run.finishedAt === null && run.freezeHash === hash)
    const fulfilled = active && !running && criteria.length > 0 && met === criteria.length
    if (document) {
      document.approved_by = freeze?.approvedBy ?? null
      document.frozen_at = freeze?.at ?? null
      document.status = document.status === 'cancelled' ? 'cancelled' : fulfilled ? 'fulfilled' : changed ? 'amended' : active ? runs.length ? 'in_progress' : 'frozen' : 'draft'
    }
    let goalText: string | null = null
    if (document) try { goalText = generateGoal(document, criteria.filter((item) => item.status !== 'met').map((item) => item.id), 'clio.run_contract_check') } catch (error) { errors.push(errorText(error)) }
    if (active && (runs.length || approvals.length) && !validStamp) errors.push(stamp.error ?? 'Source freshness is pending')
    const usage = this.store.contractUsage(project.id, file.id)
    return { id: file.id, path: file.path, document, errors, definitionHash: hash, sourceFingerprint: validStamp ? stamp.fingerprint : null, freeze: freeze ? { hash: freeze.hash, approvedBy: freeze.approvedBy, at: freeze.at } : null, changed, runs, manualApprovals: approvals, progress: { met, total: criteria.length }, usage: { ...usage, exceeded: !!document && (usage.sessions > document.budget.max_sessions || usage.observedSeconds > document.budget.max_hours * 3600) }, fulfilled, running, goalText }
  }
  private async current(projectId: number, id: string): Promise<ContractView> { const view = (await this.list(projectId, true)).find((item) => item.id === id); if (!view) throw new Error('Unknown contract'); return view }
  async create(projectId: number, input: LightContractInput): Promise<ContractView> {
    if (!this.store.canWrite()) throw new Error('Cockpit store is read-only')
    const project = this.project(projectId)
    const slug = basename(project.rootPath).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'project'
    const document = createLightContract(slug, input)
    const directory = this.directory(project)
    mkdirSync(directory, { recursive: true })
    this.directory(project)
    const path = join(directory, `${document.contract_id}.json`)
    if (existsSync(path)) throw new Error('Contract already exists')
    atomicWrite(path, JSON.stringify(document, null, 2) + '\n')
    this.store.upsertContract(projectId, document.contract_id, path, 'draft')
    return this.current(projectId, document.contract_id)
  }
  async save(projectId: number, id: string, json: string, expectedDefinitionHash: string): Promise<ContractView> {
    if (!this.store.canWrite()) throw new Error('Cockpit store is read-only')
    if (Buffer.byteLength(json) > MAX_CONTRACT_BYTES) throw new Error('Contract file is too large')
    const parsed = parseContract(JSON.parse(json))
    if (!parsed.document) throw new Error(parsed.errors.join('; '))
    if (parsed.document.contract_id !== id) throw new Error('Contract ID cannot be changed')
    const loaded = this.raw(projectId, id)
    this.reviewed(loaded.document, expectedDefinitionHash)
    const freeze = this.store.getFreeze(projectId, id)
    if (freeze && definitionHash(parsed.document) !== freeze.hash) throw new Error('Create an amendment before editing a frozen definition')
    parsed.document.amendments = loaded.document.amendments
    atomicWrite(loaded.file.path, JSON.stringify(parsed.document, null, 2) + '\n')
    return this.current(projectId, id)
  }
  async freeze(projectId: number, id: string, approvedBy: string, expectedDefinitionHash: string): Promise<ContractView> {
    if (!this.store.canWrite() || !approvedBy.trim()) throw new Error('Owner approval is required')
    const loaded = this.raw(projectId, id)
    this.reviewed(loaded.document, expectedDefinitionHash)
    const hash = definitionHash(loaded.document)
    const previous = this.store.getFreeze(projectId, id)
    if (previous && previous.hash !== hash) throw new Error('Create an amendment before approving the changed definition')
    const at = new Date().toISOString()
    loaded.document.status = 'frozen'
    loaded.document.approved_by = approvedBy.trim()
    loaded.document.frozen_at = at
    const amendment = loaded.document.amendments.at(-1)
    if (amendment && !amendment.approved_by) amendment.approved_by = approvedBy.trim()
    atomicWrite(loaded.file.path, JSON.stringify(loaded.document, null, 2) + '\n')
    this.store.saveFreeze(projectId, id, hash, approvedBy, at, loaded.file.path)
    this.store.recordEvent({ projectId, source: 'manual', kind: 'contract-frozen', summary: `Owner approved ${id}`, payload: { hash, approvedBy: approvedBy.trim() } })
    return this.current(projectId, id)
  }
  async amend(projectId: number, id: string, summary: string, expectedDefinitionHash: string): Promise<ContractView> {
    if (!this.store.canWrite() || !summary.trim()) throw new Error('Amendment summary is required')
    const loaded = this.raw(projectId, id)
    this.reviewed(loaded.document, expectedDefinitionHash)
    if (!this.store.getFreeze(projectId, id)) throw new Error('Only a locally frozen contract can be amended')
    this.store.revokeFreeze(projectId, id)
    loaded.document.status = 'draft'; loaded.document.approved_by = null; loaded.document.frozen_at = null
    loaded.document.amendments.push({ at: new Date().toISOString(), summary: summary.trim(), approved_by: null })
    for (const criterion of loaded.document.milestones.flatMap((milestone) => milestone.criteria)) { criterion.status = 'open'; criterion.evidence = null; criterion.approved_by = null }
    atomicWrite(loaded.file.path, JSON.stringify(loaded.document, null, 2) + '\n')
    this.store.recordEvent({ projectId, source: 'manual', kind: 'contract-amended', summary: summary.trim(), payload: { contractId: id } })
    return this.current(projectId, id)
  }
  async approveManual(projectId: number, id: string, criterionId: string, approvedBy: string, expectedFreezeHash: string, expectedSourceFingerprint: string, note = ''): Promise<ContractView> {
    const loaded = this.frozen(projectId, id)
    if (loaded.freeze.hash !== expectedFreezeHash) throw new Error('Freeze changed since review')
    if (!loaded.document.milestones.some((milestone) => milestone.criteria.some((criterion) => criterion.id === criterionId && criterion.type === 'manual'))) throw new Error('Criterion is not manual')
    const stamp = await this.fingerprint(loaded.project.rootPath, true)
    if (!stamp.fingerprint || stamp.error) throw new Error(stamp.error ?? 'Source freshness is unavailable')
    if (stamp.fingerprint !== expectedSourceFingerprint) throw new Error('Source changed since review; review the current result again')
    if (this.frozen(projectId, id).freeze.hash !== loaded.freeze.hash) throw new Error('Contract changed during approval')
    this.store.approveManual(projectId, id, criterionId, loaded.freeze.hash, approvedBy, note, new Date().toISOString(), stamp.fingerprint)
    return this.current(projectId, id)
  }
  async finalize(projectId: number, id: string, expectedFreezeHash: string, expectedSourceFingerprint: string): Promise<ContractView> {
    if (!this.store.canWrite()) throw new Error('Cockpit store is read-only')
    const loaded = this.frozen(projectId, id)
    if (loaded.freeze.hash !== expectedFreezeHash) throw new Error('Freeze changed since review')
    const stamp = await this.fingerprint(loaded.project.rootPath, true)
    if (!stamp.fingerprint || stamp.error || stamp.fingerprint !== expectedSourceFingerprint) throw new Error('Source changed since review; completion refused')
    const current = this.frozen(projectId, id)
    if (current.freeze.hash !== expectedFreezeHash) throw new Error('Freeze changed during completion')
    const view = this.view(current.project, current.file, stamp)
    if (!view.fulfilled || !view.document) throw new Error('Contract criteria are not fulfilled with current evidence')
    for (const criterion of view.document.milestones.flatMap((milestone) => milestone.criteria)) {
      if (criterion.evidence?.output_excerpt && criterion.evidence.output_excerpt.length > 1024) criterion.evidence.output_excerpt = criterion.evidence.output_excerpt.slice(0, 1024) + '\n[full captured excerpt remains in cockpit]'
    }
    const serialized = JSON.stringify(view.document, null, 2) + '\n'
    if (Buffer.byteLength(serialized) > MAX_CONTRACT_BYTES) throw new Error('Completion snapshot exceeds the contract file size limit')
    if (!parseContract(view.document).document || definitionHash(view.document) !== expectedFreezeHash) throw new Error('Invalid completion snapshot')
    atomicWrite(current.file.path, serialized)
    return this.current(projectId, id)
  }
}
