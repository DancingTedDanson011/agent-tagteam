// How a session is written into a workspace, and the command lines that bring it back. Pure.
import { normalizeFolder } from '../../shared/folder'
import { COLORS, hasAgentStatus } from '../../shared/restore'
import type { AgentProvider, AgentRole, SessionStyle, SlotLaunch, WindowRun } from '../../shared/types'
import { quoteArg } from '../win32/launch'

type WtLaunch = Extract<SlotLaunch, { host: 'wt' }>
type ConhostLaunch = Extract<SlotLaunch, { host: 'conhost' }>

/** The resume words of each agent CLI (read from their --help on 2026-09-25). */
function resumeWords(run: WindowRun, resume: boolean): string[] {
  if (!resume) return []
  return run === 'codex' ? ['resume', '--last'] : ['--continue']
}

/** Characters cmd and PowerShell read as plain text in an unquoted word (`~` for 8.3 short names). */
const PLAIN_PATH = /^[A-Za-z]:\\[A-Za-z0-9_.~\\-]+$/

/**
 * An agent CLI's absolute path as one unquoted word for `cmd /k` or `-Command`, or null. A path
 * with spaces or shell syntax goes through its 8.3 short name (`short`); failing that it is refused.
 * Never a bare name: `cmd /k claude` searches the working folder before PATH (cold review, reproduced).
 */
export function commandPath(p: string | null, short: (p: string) => string | null): string | null {
  if (!p || !/^[A-Za-z]:\\/.test(p)) return null
  if (PLAIN_PATH.test(p)) return p
  const s = short(p)
  return s && PLAIN_PATH.test(s) ? s : null
}

/** Absolute paths of the programs a restored window runs. run: from commandPath, null = shell only. */
export type WtPaths = { cmd: string; run: string | null }
export type ConhostPaths = { shell: string; run: string | null }

/**
 * Arguments for wt.exe. `-w new` makes a window of its own (without it the tab can land in one of the
 * user's windows). Windows Terminal splits at ";" anywhere in its arguments, so a folder or name with
 * one is refused (null) — the parsers already remove it, this is the last line.
 */
export function wtArgs(launch: WtLaunch, cwd: string, style: SessionStyle, resume: boolean, paths: WtPaths): string[] | null {
  if (cwd.includes(';') || style.label?.includes(';')) return null
  const args = ['-w', 'new', '-d', cwd]
  if (style.label) args.push('--title', style.label)
  if (style.color) args.push('--tabColor', COLORS[style.color])
  if (launch.run && paths.run) args.push(paths.cmd, '/k', paths.run, ...resumeWords(launch.run, resume))
  return args
}

/** The CreateProcess command line for a classic console window. The folder is a separate parameter. */
export function conhostCommandLine(launch: ConhostLaunch, resume: boolean, paths: ConhostPaths): string {
  const shell = quoteArg(paths.shell)
  const run = launch.run && paths.run ? [paths.run, ...resumeWords(launch.run, resume)] : []
  if (launch.shell === 'cmd') return ['conhost.exe', shell, ...(run.length ? ['/k', ...run] : [])].join(' ')
  return ['conhost.exe', shell, '-NoLogo', ...(run.length ? ['-NoExit', '-Command', ...run] : [])].join(' ')
}

export type Describable = {
  processName: string
  className: string
  title: string
  agent?: { provider: AgentProvider; role: AgentRole; cwd: string }
}

const SHELLS: Record<string, ConhostLaunch['shell']> = { 'cmd.exe': 'cmd', 'powershell.exe': 'powershell', 'pwsh.exe': 'pwsh' }

/**
 * The recipe that brings a session back, or null when there is none. `readCwd` reads the working
 * folder of the window's own process (classic consoles only: Windows Terminal serves every window
 * from one process, so its folder cannot be told per window — measured in the plan's cold review).
 */
export function describeSession(s: Describable, readCwd: () => string | null): SlotLaunch | null {
  if (s.agent) {
    if (s.agent.role === 'worker') return null // its orchestrator starts workers
    // stored as the parser will read it back (a start request may carry a trailing \ or ..)
    const cwd = normalizeFolder(s.agent.cwd, '')
    return cwd ? { kind: 'agent', provider: s.agent.provider, role: s.agent.role, cwd } : null
  }
  const run: { run?: WindowRun } = hasAgentStatus(s.title) ? { run: 'claude' } : {}
  if (s.className === 'CASCADIA_HOSTING_WINDOW_CLASS') return { kind: 'window', host: 'wt', cwd: null, ...run }
  const shell = SHELLS[s.processName.toLowerCase()]
  if (s.className !== 'ConsoleWindowClass' || !shell) return null
  const raw = readCwd()
  const cwd = raw === null ? null : normalizeFolder(raw, '')
  return { kind: 'window', host: 'conhost', shell, cwd, ...run }
}
