import { execFile, type ExecFileOptionsWithStringEncoding, type PromiseWithChild } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { promisify } from 'node:util'
import type { CriterionRun } from '../../shared/cockpit'
import { redact } from '../agents/mcp'
import { findOnPath } from '../agents/programs'
import { isWithinDirectory as within } from '../fsutil'
import { definitionHash, parseContract, type ContractRepository, type SourceStamp } from './contracts'
import { startNativeSourceWatch } from './source-watch'
import type { CockpitStore } from './store'
import { createCheckProcess } from './check-process'
export type RunnerOptions = { timeoutMs?: number; maxOutputBytes?: number; shellPath?: string; gitPath?: string | null }
const execFileAsync = promisify(execFile)
function exec(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding): PromiseWithChild<{ stdout: string; stderr: string }> {
  const pending = execFileAsync(file, args, options)
  const child = pending.child
  let pipeFailure: Error | null = null
  const closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()))
  const failPipe = (error: Error) => { if (!pipeFailure) { pipeFailure = error; child.kill() } }
  child.stdin?.on('error', failPipe)
  child.stdout?.on('error', failPipe)
  child.stderr?.on('error', failPipe)
  const result = pending.then(async (output) => { await closed; if (pipeFailure) throw pipeFailure; return output },
    async (error: unknown) => { await closed; throw pipeFailure ?? error })
  return Object.assign(result, { child })
}
const MAX_FILES = 4000
const MAX_BYTES = 32 * 1024 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
const excluded = (name: string) => name.replace(/\\/g, '/').split('/').some((part) => ['.git', 'node_modules', 'out', 'dist', 'coverage', '.cache'].includes(part) || part.startsWith('.code-guardian') || ['.audit-log.md', '.task-journal.md'].includes(part))
const relevant = (name: string) => !excluded(name)
const gitArgs = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '--no-pager']
const message = (error: unknown) => redact(error instanceof Error ? error.message : String(error)).slice(0, 4000)
const abortError = () => new Error('Check cancelled')
const checkAbort = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError() }
function trustedBinary(path: string, root: string): string {
  if (!isAbsolute(path)) throw new Error('Check tools require absolute executable paths')
  const canonical = realpathSync.native(path)
  if (within(root, canonical) || !statSync(canonical).isFile()) throw new Error('Check tools must be outside the project root')
  return canonical
}
function gitOnPath(): string | null {
  if (process.platform === 'win32') return findOnPath('git.exe', process.env.PATH ?? '')
  for (const directory of (process.env.PATH ?? '').split(delimiter)) if (isAbsolute(directory) && existsSync(join(directory, 'git'))) return join(directory, 'git')
  return null
}
type Fingerprint = SourceStamp & { paths: Set<string>; gitPath: string | null }
async function boundedSource(path: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Source fingerprint byte limit exceeded')
    const buffer = Buffer.alloc(Math.min(limit, info.size) + 1)
    let length = 0
    while (length < buffer.byteLength) {
      checkAbort(signal)
      const result = await file.read(buffer, length, buffer.byteLength - length, length)
      if (!result.bytesRead) break
      length += result.bytesRead
    }
    if (length > limit) throw new Error('Source fingerprint byte limit exceeded')
    if (length > info.size) throw new Error('Source changed while fingerprinting')
    return buffer.subarray(0, length)
  } finally { await file.close() }
}

/** Content, not mtime/HEAD alone; result metadata in valid contracts is excluded explicitly. */
export async function fingerprintProject(root: string, options: Pick<RunnerOptions, 'gitPath'> = {}, signal?: AbortSignal): Promise<Fingerprint> {
  checkAbort(signal)
  const canonicalRoot = realpathSync.native(root)
  let gitHead: string | null = null
  let selectedGit: string | null = null
  let files: { name: string; tracked: boolean }[] | null = null
  const candidate = options.gitPath === undefined ? gitOnPath() : options.gitPath
  if (candidate) {
    const git = trustedBinary(candidate, canonicalRoot)
    try {
      const listing = await exec(git, [...gitArgs, 'ls-files', '--cached', '--others', '--exclude-standard', '--stage', '-z'], { cwd: canonicalRoot, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, signal })
      files = listing.stdout.split('\0').filter(Boolean).map((entry) => { const match = /^[0-7]{6} [a-f0-9]{40,64} [0-3]\t([\s\S]*)$/.exec(entry); return { name: (match?.[1] ?? entry).replace(/\\/g, '/'), tracked: !!match } })
      selectedGit = git
      try {
        const head = (await exec(git, [...gitArgs, 'rev-parse', '--verify', 'HEAD'], { cwd: canonicalRoot, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, signal })).stdout.trim()
        if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head)) throw new Error('Invalid Git HEAD output')
        gitHead = head
      } catch (error) { checkAbort(signal); if (!((error as { code?: number }).code === 128)) throw error }
    } catch (error) {
      checkAbort(signal)
      if ((error as { code?: number }).code !== 128) throw error
      files = null
      selectedGit = null
    }
  }
  if (files === null) {
    files = []
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(join(canonicalRoot, directory), { withFileTypes: true })) {
        checkAbort(signal)
        const name = [directory, entry.name].filter(Boolean).join('/')
        if (excluded(name)) continue
        if (entry.isSymbolicLink()) throw new Error(`Source symlink requires an explicit boundary: ${name}`)
        if (entry.isDirectory()) await walk(name)
        else if (entry.isFile() && relevant(name)) files!.push({ name, tracked: false })
        if (files!.length > MAX_FILES) throw new Error('Source fingerprint file limit exceeded')
      }
    }
    await walk('')
  }
  const selected = [...new Map(files.filter((file) => !excluded(file.name) && (file.tracked || relevant(file.name))).map((file) => [file.name, file])).values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (selected.length > MAX_FILES) throw new Error('Source fingerprint file limit exceeded')
  const hash = createHash('sha256').update(gitHead ?? 'no-git-head')
  const paths = new Set<string>()
  let bytes = 0
  for (const file of selected) {
    checkAbort(signal)
    const path = resolve(canonicalRoot, file.name)
    if (!within(canonicalRoot, path)) throw new Error('Git path escapes the project root')
    hash.update('\0' + file.name + '\0')
    paths.add(file.name)
    let info
    try { info = await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { hash.update('deleted'); continue } throw error }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Source path requires an explicit boundary: ${file.name}`)
    if (info.size > MAX_FILE_BYTES || bytes + info.size > MAX_BYTES) throw new Error('Source fingerprint byte limit exceeded')
    const content = await boundedSource(path, Math.min(MAX_FILE_BYTES, MAX_BYTES - bytes), signal)
    bytes += content.byteLength
    if (content.byteLength > MAX_FILE_BYTES || bytes > MAX_BYTES) throw new Error('Source fingerprint byte limit exceeded')
    if (/^\.contracts\/[^/]+\.json$/i.test(file.name)) {
      try { const parsed = parseContract(JSON.parse(content.toString('utf8'))); if (parsed.document) { hash.update(definitionHash(parsed.document)); continue } } catch { /* invalid contract bytes still participate in the source fingerprint */ }
    }
    hash.update(content)
  }
  return { fingerprint: hash.digest('hex'), gitHead, error: null, paths, gitPath: selectedGit }
}

async function hasSourceEvents(root: string, observed: Set<string>, start: Fingerprint, end: Fingerprint, files: Set<string>, directories: Set<string>): Promise<boolean> {
  const selected = new Set([...start.paths, ...end.paths])
  for (const name of [...selected]) {
    for (let slash = name.lastIndexOf('/'); slash >= 0; slash = name.lastIndexOf('/', slash - 1)) selected.add(name.slice(0, slash))
  }
  const candidates: string[] = []
  for (const name of observed) {
    if (excluded(name)) continue
    if (selected.has(name)) return true
    // A complete typed stream distinguishes removed containers from files that reused the same name.
    if (!files.has(name) && directories.has(name)) continue
    candidates.push(name)
  }
  if (!candidates.length) return false
  if (!start.gitPath || end.gitPath !== start.gitPath) return true
  const query = exec(start.gitPath, [...gitArgs, 'check-ignore', '--stdin', '-z'], { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 })
  let inputError: Error | null = null
  const input = query.child.stdin
  input?.on('error', (error) => { inputError = error })
  input?.end(candidates.join('\0') + '\0')
  let ignored = new Set<string>()
  try { ignored = new Set((await query).stdout.split('\0').filter(Boolean)) }
  catch (error) { if ((error as { code?: number }).code !== 1) throw error }
  if (inputError) throw inputError
  if (!input) throw new Error('Could not classify source watcher events')
  return candidates.some((name) => !ignored.has(name))
}

export class CheckRunner {
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<unknown> | null }>()
  private readonly cache = new Map<string, { at: number; value: Promise<Fingerprint> }>()
  private closed = false
  constructor(private readonly store: CockpitStore, private readonly contracts: ContractRepository, private readonly options: RunnerOptions = {}) {
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error('Invalid check timeout')
    if (options.maxOutputBytes !== undefined && (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 64 || options.maxOutputBytes > 1024 * 1024)) throw new Error('Invalid check output cap')
    contracts.setFingerprintProvider((root, fresh) => this.fingerprint(root, fresh))
    contracts.setRunningProvider((projectId, contractId) => this.isRunning(projectId, contractId))
  }
  private fingerprint(root: string, fresh = false): Promise<Fingerprint> {
    const previous = this.cache.get(root)
    if (!fresh && previous && Date.now() - previous.at < 1000) return previous.value
    const value = fingerprintProject(root, this.options)
    this.cache.set(root, { at: Date.now(), value })
    void value.catch(() => { if (this.cache.get(root)?.value === value) this.cache.delete(root) })
    return value
  }
  private key(projectId: number, id: string): string { return `${projectId}:${id}` }
  isRunning(projectId: number, id: string): boolean { return this.active.has(this.key(projectId, id)) }
  private start<T>(projectId: number, id: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.closed || !this.store.canWrite()) return Promise.reject(new Error('Check runner is read-only or closed'))
    const key = this.key(projectId, id)
    if (this.active.has(key)) return Promise.reject(new Error('A check for this contract is already running'))
    const job = { controller: new AbortController(), promise: null as Promise<unknown> | null }
    this.active.set(key, job)
    const promise = action(job.controller.signal).finally(() => this.active.delete(key))
    job.promise = promise
    return promise
  }
  run(projectId: number, id: string, criterionId: string): Promise<CriterionRun> { return this.start(projectId, id, (signal) => this.execute(projectId, id, criterionId, signal)) }
  runAll(projectId: number, id: string): Promise<CriterionRun[]> {
    return this.start(projectId, id, async (signal) => {
      const document = this.contracts.assertFrozen(projectId, id).document
      const results: CriterionRun[] = []
      for (const criterion of document.milestones.flatMap((milestone) => milestone.criteria).filter((item) => item.type === 'automated')) {
        if (signal.aborted) break
        results.push(await this.execute(projectId, id, criterion.id, signal))
      }
      return results
    })
  }
  cancel(projectId: number, id: string): void { this.active.get(this.key(projectId, id))?.controller.abort() }
  async close(): Promise<void> { this.closed = true; for (const job of this.active.values()) job.controller.abort(); await Promise.allSettled([...this.active.values()].map((job) => job.promise)); this.cache.clear() }

  private async execute(projectId: number, id: string, criterionId: string, signal: AbortSignal): Promise<CriterionRun> {
    const loaded = this.contracts.assertRunnable(projectId, id, criterionId)
    const command = loaded.criterion.check!.command
    const startedAt = new Date().toISOString()
    const pending = this.store.recordRun({ projectId, contractId: id, criterionId, startedAt, finishedAt: null, command, exitCode: null, signal: null, stdout: '', stderr: '', error: null, gitHead: null, freezeHash: loaded.freezeHash, sourceFingerprint: null, passed: false })
    let start: Fingerprint | null = null
    let exitCode: number | null = null
    let exitSignal: string | null = null
    let stdout = ''
    let stderr = ''
    let failure: string | null = null
    let watcher: FSWatcher | null = null
    let nativeWatcher: ReturnType<typeof startNativeSourceWatch> | null = null
    let watchFailure: string | null = null
    let changed = false
    const observed = new Set<string>()
    const observedFiles = new Set<string>()
    const observedDirectories = new Set<string>()
    const closeNativeWatch = async () => { const closing = nativeWatcher; nativeWatcher = null; await closing?.close() }
    try {
      checkAbort(signal)
      watcher = watch(loaded.project.rootPath, { recursive: true }, (_event, file) => { if (file === null) changed = true; else observed.add(file.toString().replace(/\\/g, '/')) })
      watcher.on('error', () => { changed = true })
      if (process.platform === 'win32') nativeWatcher = startNativeSourceWatch(loaded.project.rootPath, (event) => {
        const name = event.path.replace(/\\/g, '/')
        if (excluded(name)) return
        observed.add(name)
        if (event.kind === 'file') observedFiles.add(name)
        else {
          observedDirectories.add(name)
          if (event.action === 'renamed_from' || event.action === 'renamed_to') changed = true
        }
      }, (error) => { watchFailure = `Could not verify source changes: ${message(error)}` })
      start = await fingerprintProject(loaded.project.rootPath, this.options, signal)
      checkAbort(signal)
      const shellCandidate = this.options.shellPath ?? (process.platform === 'win32' ? process.env.SystemRoot ? join(process.env.SystemRoot, 'System32', 'cmd.exe') : '' : '/bin/sh')
      const shell = trustedBinary(shellCandidate, loaded.project.rootPath)
      if (process.platform === 'win32' && basename(shell).toLowerCase() !== 'cmd.exe') throw new Error('Windows checks require the explicit system cmd.exe shell')
      this.contracts.assertRunnable(projectId, id, criterionId)
      const result = await this.command(command, loaded.project.rootPath, shell, signal)
      exitCode = result.exitCode; exitSignal = result.signal; stdout = result.stdout; stderr = result.stderr; failure = result.error
      const end = await fingerprintProject(loaded.project.rootPath, this.options)
      await closeNativeWatch()
      watcher.close()
      watcher = null
      const sourceEvents = await hasSourceEvents(loaded.project.rootPath, observed, start, end, observedFiles, observedDirectories)
      failure = failure ?? watchFailure
      if (changed || sourceEvents || end.fingerprint !== start.fingerprint || end.gitHead !== start.gitHead) failure = failure ?? 'Source changed during the check'
      if (this.contracts.assertRunnable(projectId, id, criterionId).freezeHash !== loaded.freezeHash) failure = failure ?? 'Contract changed during the check'
      this.cache.set(loaded.project.rootPath, { at: Date.now(), value: Promise.resolve(end) })
      if (signal.aborted) failure = failure ?? 'Check cancelled'
    } catch (error) { failure = signal.aborted ? 'Check cancelled' : message(error) }
    finally {
      watcher?.close()
      try { await closeNativeWatch() } catch (error) { failure = failure ?? `Could not close source observation: ${message(error)}` }
    }
    return this.store.finishRun(pending.id, { projectId, contractId: id, criterionId, startedAt, finishedAt: new Date().toISOString(), command, exitCode, signal: exitSignal, stdout, stderr, error: failure, gitHead: start?.gitHead ?? null, freezeHash: loaded.freezeHash, sourceFingerprint: start?.fingerprint ?? null, passed: failure === null && exitCode === 0 })
  }

  private async command(command: string, root: string, shell: string, signal: AbortSignal): Promise<{ exitCode: number | null; signal: string | null; stdout: string; stderr: string; error: string | null }> {
    checkAbort(signal)
    const tree = createCheckProcess(command, root, shell)
    const child = tree.child
    const cap = this.options.maxOutputBytes ?? 32768
    const output: Buffer[] = []
    const errors: Buffer[] = []
    let bytes = 0
    let truncated = false
    let failure: string | null = null
    let terminating: Promise<void> | null = null
    let closed = false
    let cleanupTimer: ReturnType<typeof setTimeout> | null = null
    let finish: ((result: { exitCode: number | null; signal: string | null }) => void) | null = null
    const capture = (parts: Buffer[], chunk: Buffer) => { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); const remaining = Math.max(0, cap - bytes); if (buffer.byteLength > remaining) truncated = true; if (remaining) { const value = buffer.subarray(0, remaining); parts.push(value); bytes += value.byteLength } }
    const terminate = (reason: string) => {
      failure = failure ?? reason
      if (closed || terminating) return
      terminating = Promise.resolve().then(() => tree.terminate()).catch((error) => { failure = `${failure}; ${message(error)}` }).finally(() => {
        if (!closed) cleanupTimer = setTimeout(() => {
          failure = `${failure}; Process pipes did not close after process-tree termination`
          child.stdout?.destroy(); child.stderr?.destroy()
          finish?.({ exitCode: child.exitCode, signal: child.signalCode })
        }, 1000)
      })
    }
    child.stdin?.on('error', (error) => terminate(`Check input pipe failed: ${message(error)}`))
    child.stdout?.on('error', (error) => terminate(`Check output pipe failed: ${message(error)}`))
    child.stderr?.on('error', (error) => terminate(`Check error pipe failed: ${message(error)}`))
    child.stdout?.on('data', (chunk) => capture(output, chunk))
    child.stderr?.on('data', (chunk) => capture(errors, chunk))
    const abort = () => terminate('Check cancelled')
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const timer = setTimeout(() => terminate('Check timeout exceeded'), this.options.timeoutMs ?? 120000)
    void tree.started.catch((error) => terminate(message(error)))
    try {
      const result = await new Promise<{ exitCode: number | null; signal: string | null }>((resolveResult) => {
        finish = resolveResult
        child.once('error', (error) => terminate(message(error)))
        child.once('close', (code, stoppedBy) => { closed = true; resolveResult({ exitCode: code, signal: stoppedBy }) })
      })
      if (terminating) await terminating
      // Drop an incomplete final token before redaction: a cut key may be too short for its matcher.
      const clean = (parts: Buffer[]) => { const text = Buffer.concat(parts).toString('utf8'); return redact(truncated ? text.replace(/\S*$/u, '') : text) }
      const marker = truncated ? '\n[output truncated]' : ''
      const bounded = (text: string, maximum: number) => new StringDecoder('utf8').write(Buffer.from(text).subarray(0, Math.max(0, maximum)))
      const safeError = bounded(clean(errors), cap - Buffer.byteLength(marker))
      const safeOutput = bounded(clean(output), cap - Buffer.byteLength(marker + safeError)) + marker
      return { ...result, stdout: safeOutput, stderr: safeError, error: failure }
    } finally { clearTimeout(timer); if (cleanupTimer) clearTimeout(cleanupTimer); signal.removeEventListener('abort', abort); tree.dispose() }
  }
}
