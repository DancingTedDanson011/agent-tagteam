import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { date, digest, invalidEvent, isRecord, listFiles, rawExcerpt, readBounded, text } from './common'
import type { SourceAdapter, SourceEvent, SourceTask, SourceWaiting } from './common'

export const KNOWN_GUARDIAN_VERSIONS = ['17.14', '16.167'] as const
export type CellContract = { name: string; sections: { name: string; total: number; open: number }[]; raw: string }
export type GuardianArtifacts = { tasks: SourceTask[]; waiting: SourceWaiting[]; events: SourceEvent[]; adapter: SourceAdapter }
const projectSession = (cwd: string): string => `guardian:${digest(cwd)}`
const taskState = (state: string, checked: boolean): SourceTask['state'] =>
  /^(verworfen|vertagt|fremd)\b/.test(state) ? 'dropped' : /^(erledigt|done)\b/.test(state) || checked ? 'done' : /^laeuft\b/.test(state) ? 'in_progress' : 'open'

export function parseGuardianTodo(content: string, cwd: string, now = new Date().toISOString()): { tasks: SourceTask[]; waiting: SourceWaiting[]; raw: string } {
  const tasks: SourceTask[] = []; const waiting: SourceWaiting[] = []; const occurrences = new Map<string, number>()
  let current: SourceTask | undefined
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*- \[([ xX])\]\s+(?:(T-\d+)\s*·\s*([^·]+)\s*·\s*)?(.+)$/.exec(line)
    if (!match) {
      const metadata = /^\s+(Wirkung|Beleg|Angelegt|Geschlossen|Fertig-wenn):\s*(.*)$/.exec(line)
      if (current && metadata) (current.metadata ??= {})[metadata[1]] = text(metadata[2], 4000)
      else if (/^\S/.test(line)) current = undefined
      continue
    }
    const [, checked, id, state, title] = match
    const safeTitle = text(title, 500)
    if (!safeTitle.trim()) { current = undefined; continue }
    const sourceState = text(state?.trim() || (checked === ' ' ? 'offen' : 'erledigt'), 500)
    const fingerprint = digest(safeTitle); const occurrence = occurrences.get(fingerprint) ?? 0; occurrences.set(fingerprint, occurrence + 1)
    const sourceRef = id || `legacy:${fingerprint}:${occurrence}`
    current = { source: 'code_guardian', sourceRef, cwd, sessionId: null, title: safeTitle, state: taskState(sourceState, checked !== ' '), sourceState }
    tasks.push(current)
    if (/^entscheidung\b/.test(sourceState) && checked === ' ') waiting.push({ sessionId: projectSession(cwd), cwd, kind: 'cg_decision', ref: sourceRef,
      summary: text(sourceState.replace(/^entscheidung\s*/, '') || safeTitle), openedAt: now, source: 'code_guardian' })
  }
  return { tasks, waiting, raw: rawExcerpt(content) }
}

export function parseGuardianTask(content: string, cwd: string, ref: string): SourceTask {
  const field = (name: string) => text(new RegExp(`^${name}:\\s*(.+)$`, 'm').exec(content)?.[1]?.trim(), 500)
  const plan = /(?:^|\n)## Plan\s*\r?\n([\s\S]*?)(?=\r?\n## |$)/.exec(content)?.[1] ?? ''
  const checks = [...plan.matchAll(/^\s*- \[([ xX])\]/gm)]
  const session = field('Sitzung')
  return { source: 'code_guardian', sourceRef: `trace:${ref}`, cwd, sessionId: /^[A-Za-z0-9_.:-]+$/.test(session) ? session : null,
    title: field('Ziel') || ref, state: checks.length > 0 && checks.every(check => check[1] !== ' ') ? 'done' : checks.some(check => check[1] !== ' ') ? 'in_progress' : 'open' }
}

export function parseCellContract(content: string, name: string): CellContract {
  const sections: CellContract['sections'] = []
  let current: CellContract['sections'][number] | undefined
  for (const line of content.split(/\r?\n/)) {
    const heading = /^##\s+(.+)$/.exec(line)
    if (heading) { current = { name: text(heading[1]), total: 0, open: 0 }; sections.push(current); continue }
    const check = /^\s*- \[([ xX])\]/.exec(line)
    if (current && check) { current.total++; if (check[1] === ' ') current.open++ }
  }
  return { name: text(name, 200), sections: sections.filter(section => section.total > 0), raw: rawExcerpt(content) }
}

export function parseGateSignal(name: string): { sessionId: string; gate: string; stage: 'angehalten' | 'fragt' | 'geprueft' } | null {
  const match = /^([A-Za-z0-9_-]+)\.(DEPLOY|MIGRATION|LOESCHEN|SECRET)\.(angehalten|fragt|geprueft)$/.exec(name)
  return match ? { sessionId: match[1], gate: match[2], stage: match[3] as 'angehalten' | 'fragt' | 'geprueft' } : null
}

export function parseAllowLog(content: string, now = new Date().toISOString()): SourceEvent[] {
  return content.split(/\r?\n/).filter(Boolean).slice(-512).map(line => {
    const columns = line.split('\t')
    if (columns.length < 6) return invalidEvent('code_guardian', 'Malformed gate log row', line, now)
    const [at, gate, verdict, cwd, command, reason] = columns
    return { id: `guardian:allow:${digest(line)}`, source: 'code_guardian' as const, kind: `${text(gate, 100)}:${text(verdict, 40)}`, at: date(at, now),
      cwd, summary: text(`${gate}: ${verdict} — ${reason}`), raw: rawExcerpt({ command, reason, gate, verdict }) }
  })
}

function subdirectories(dir: string, onError: (message: string) => void): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).sort().slice(-128) }
  catch (error) {
    if (!(isRecord(error) && error.code === 'ENOENT')) onError(text(error instanceof Error ? error.message : 'Artifact directory read failed'))
    return []
  }
}

export function readGuardianArtifacts(claudeDir: string, projectRoots: readonly string[], now = new Date().toISOString(), knownVersions: readonly string[] = KNOWN_GUARDIAN_VERSIONS): GuardianArtifacts {
  const tasks: SourceTask[] = []; const waiting: SourceWaiting[] = []; const events: SourceEvent[] = []
  const skill = join(claudeDir, 'skills', 'code-guardian', 'SKILL.md')
  const present = existsSync(skill)
  const loaded = present ? readBounded(skill) : null
  const version = loaded && 'text' in loaded ? /# Code Guardian\s*\(v([\d.]+)\)/.exec(loaded.text)?.[1] ?? '' : ''
  const supported = present && knownVersions.includes(version)
  const adapter: SourceAdapter = { source: 'code_guardian', available: present, supported, version, invalid: 0,
    message: supported ? 'Read-only local artifacts' : 'Code Guardian: not supported' }
  if (!supported) {
    if (loaded && 'error' in loaded) { events.push(invalidEvent('code_guardian', loaded.error, '', now, skill)); adapter.invalid++ }
    return { tasks, waiting, events, adapter }
  }
  const load = (file: string, consume: (content: string) => void) => {
    if (!existsSync(file)) return
    const result = readBounded(file)
    if ('text' in result) consume(result.text)
    else events.push(invalidEvent('code_guardian', result.error, '', now, file))
  }
  for (const cwd of projectRoots.slice(0, 128)) {
    load(join(cwd, '.code-guardian-todo.md'), content => {
      const result = parseGuardianTodo(content, cwd, now); tasks.push(...result.tasks); waiting.push(...result.waiting)
      events.push({ id: `guardian:todo:${digest(cwd + result.raw)}`, source: 'code_guardian', kind: 'todo_snapshot', at: now, cwd, summary: 'Code Guardian tasks', raw: result.raw })
    })
    const traceDir = join(cwd, '.code-guardian-evidence')
    const directoryError = (message: string) => events.push(invalidEvent('code_guardian', message, '', now, cwd))
    for (const trace of subdirectories(traceDir, directoryError)) load(join(traceDir, trace, 'aufgabe.md'), content => tasks.push(parseGuardianTask(content, cwd, trace)))
    const cellDir = join(cwd, '.code-guardian-zelle')
    for (const cell of subdirectories(cellDir, directoryError)) load(join(cellDir, cell, 'vertrag.md'), content => {
      const result = parseCellContract(content, cell)
      events.push({ id: `guardian:cell:${digest(cwd + cell + result.raw)}`, source: 'code_guardian', kind: 'cell_contract', at: now, cwd, summary: result.name, raw: rawExcerpt(result) })
    })
    load(join(cwd, '.code-guardian-autopilot.md'), content => {
      for (const line of content.split(/\r?\n/).filter(line => /wartet auf Freigabe/i.test(line))) waiting.push({ sessionId: projectSession(cwd), cwd, kind: 'cg_decision', ref: `autopilot:${digest(line)}`,
        summary: text(line), openedAt: now, source: 'code_guardian' })
    })
  }
  const signalDir = join(claudeDir, 'code-guardian-status')
  const signals = new Map<string, { signal: NonNullable<ReturnType<typeof parseGateSignal>>; at: string; mtime: number; name: string }>()
  const signalFiles = listFiles(signalDir)
  if (signalFiles.error) events.push(invalidEvent('code_guardian', signalFiles.error, '', now, signalDir))
  for (const name of signalFiles.names) {
    const signal = parseGateSignal(name)
    if (!signal) { events.push(invalidEvent('code_guardian', 'Unknown guard signal', name, now)); continue }
    try {
      const mtime = lstatSync(join(signalDir, name)).mtimeMs; const key = `${signal.sessionId}:${signal.gate}`
      const prior = signals.get(key)
      if (!prior || mtime > prior.mtime || (mtime === prior.mtime && signal.stage === 'geprueft')) signals.set(key, { signal, at: new Date(mtime).toISOString(), mtime, name })
    } catch (error) { events.push(invalidEvent('code_guardian', text(error instanceof Error ? error.message : 'Guard signal read failed'), name, now)) }
  }
  for (const { signal, at, name } of signals.values()) {
    events.push({ id: `guardian:signal:${digest(name + at)}`, source: 'code_guardian', kind: `${signal.gate}:${signal.stage}`, at, sessionId: signal.sessionId, summary: `${signal.gate}: ${signal.stage}`, raw: rawExcerpt(signal) })
    if (signal.stage === 'fragt') waiting.push({ sessionId: signal.sessionId, cwd: '', kind: 'cg_gate_ask', ref: signal.gate, summary: `${signal.gate}: approval requested`, openedAt: at, source: 'code_guardian' })
  }
  const allowDir = join(claudeDir, 'code-guardian-incidents', 'allow-log')
  const allowFiles = listFiles(allowDir)
  if (allowFiles.error) events.push(invalidEvent('code_guardian', allowFiles.error, '', now, allowDir))
  for (const name of allowFiles.names.filter(name => /^\d{4}-\d{2}-\d{2}\.tsv$/.test(name)).slice(-2)) load(join(allowDir, name), content => events.push(...parseAllowLog(content, now)))
  adapter.invalid = events.filter(event => event.kind === 'invalid').length
  return { tasks, waiting, events, adapter }
}
