// Agent tiles: terminals this app runs itself through ConPTY (node-pty), unlike captured windows.
// Everything a tile shows or an orchestrator reads goes through here.
import { EventEmitter } from 'node:events'
import type { AgentProvider, AgentRole, AgentStart } from '../../shared/types'
import { quoteArg } from '../win32/launch'
import type { Launch, Program } from './providers'
import { Screen } from './screen'

export type PtyLike = {
  pid: number
  onData(cb: (data: string) => void): { dispose(): void }
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void }
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/** `commandLine`: the arguments as one Windows command line, quoted by this app (see commandTail). */
export type SpawnPty = (file: string, commandLine: string, opts: { cwd: string; env: Record<string, string>; cols: number; rows: number }) => PtyLike

export type AgentSession = {
  id: string
  provider: AgentProvider
  role: AgentRole
  parentId: string | null
  cwd: string
  pty: PtyLike
  screen: Screen
  lastOutputAt: number
  lastUserInputAt: number
  exited: boolean
  /** The user allowed an orchestrator to control this tile (it did not start it). */
  unlocked: boolean
  /** Files written for this start (an MCP config with a token): removed when the program ends. */
  files: string[]
}

export type AgentDeps = {
  spawn: SpawnPty
  program: (p: AgentProvider) => Program | null
  launch: (start: AgentStart, id: string) => Launch
  isDir: (path: string) => boolean
  baseEnv: Record<string, string>
  writeFile: (path: string, content: string) => void
  removeFile: (path: string) => void
  now?: () => number
}

export type StartResult =
  | { ok: true; id: string }
  | { ok: false; error: 'bad-cwd' | 'not-installed' }
  | { ok: false; error: 'spawn-failed'; detail: string }

/**
 * The arguments as one command line, quoted with this app's MSVCRT rules (win32/launch.ts). node-pty's
 * own quoting leaves an argument alone that starts and ends with a quote, so a task text could split
 * into extra flags (cold review, reproduced); handing it a finished string bypasses that.
 */
export function commandTail(args: string[]): string {
  return args.map(quoteArg).join(' ')
}

const COLS = 120
const ROWS = 32

export class AgentManager extends EventEmitter<{ data: [id: string, data: string]; exit: [id: string]; changed: [] }> {
  private readonly agents = new Map<string, AgentSession>()
  private next = 1

  constructor(private readonly deps: AgentDeps) {
    super()
  }

  list(): AgentSession[] {
    return [...this.agents.values()]
  }

  get(id: string): AgentSession | undefined {
    return this.agents.get(id)
  }

  start(start: AgentStart, parentId: string | null): StartResult {
    if (!this.deps.isDir(start.cwd)) return { ok: false, error: 'bad-cwd' }
    const program = this.deps.program(start.provider)
    if (!program) return { ok: false, error: 'not-installed' }
    const id = `a${this.next++}`
    const launch = this.deps.launch(start, id)
    let pty: PtyLike
    try {
      for (const f of launch.files) this.deps.writeFile(f.path, f.content)
      pty = this.deps.spawn(program.file, commandTail([...program.prefix, ...launch.args]), {
        cwd: start.cwd,
        env: { ...this.deps.baseEnv, ...launch.env },
        cols: COLS,
        rows: ROWS
      })
    } catch (err) {
      for (const f of launch.files) this.deps.removeFile(f.path)
      // Say which program and why: a bare "spawn-failed" left the orchestrator guessing (2026-09-24).
      return { ok: false, error: 'spawn-failed', detail: `${program.file}: ${err instanceof Error ? err.message : String(err)}` }
    }
    const a: AgentSession = {
      id,
      provider: start.provider,
      role: start.role,
      parentId,
      cwd: start.cwd,
      pty,
      screen: new Screen(COLS, ROWS),
      lastOutputAt: 0,
      lastUserInputAt: 0,
      exited: false,
      unlocked: false,
      files: launch.files.map((f) => f.path)
    }
    this.agents.set(id, a)
    pty.onData((data) => {
      a.lastOutputAt = this.now()
      void a.screen.write(data)
      this.emit('data', id, data)
    })
    pty.onExit(() => this.ended(a))
    this.emit('changed')
    return { ok: true, id }
  }

  write(id: string, data: string, from: 'user' | 'orchestrator'): boolean {
    const a = this.agents.get(id)
    if (!a || a.exited) return false
    if (from === 'user') a.lastUserInputAt = this.now()
    a.pty.write(data)
    return true
  }

  resize(id: string, cols: number, rows: number): void {
    const a = this.agents.get(id)
    if (!a || a.exited) return
    a.pty.resize(cols, rows)
    a.screen.resize(cols, rows)
  }

  setUnlocked(id: string, unlocked: boolean): void {
    const a = this.agents.get(id)
    if (!a) return
    a.unlocked = unlocked
    this.emit('changed')
  }

  /** Ends the program; the tile stays (showing its last output) until it is removed. */
  stop(id: string): void {
    const a = this.agents.get(id)
    if (!a || a.exited) return
    try {
      a.pty.kill()
    } catch (err) {
      console.error(`could not end agent ${id}`, err) // stopAll must go on with the others
    } finally {
      this.ended(a)
    }
  }

  private ended(a: AgentSession): void {
    if (a.exited) return
    a.exited = true
    for (const f of a.files.splice(0)) this.deps.removeFile(f)
    this.emit('exit', a.id)
    this.emit('changed')
  }

  remove(id: string): void {
    const a = this.agents.get(id)
    if (!a) return
    this.stop(id)
    a.screen.dispose()
    this.agents.delete(id)
    this.emit('changed')
  }

  stopAll(): void {
    for (const id of [...this.agents.keys()]) this.stop(id)
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }
}
