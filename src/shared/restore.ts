// Names, colours and restore recipes of sessions. Everything here may come from workspaces.json on
// disk or from the page, and part of it ends up on a command line: it is checked, never trusted.
import type { AgentProvider, ColorId, SlotLaunch, WindowRun } from './types'
import { normalizeFolder } from './folder'

/** The session colours; readable as a stripe or dot on the app's dark surfaces. */
export const COLORS: Record<ColorId, string> = {
  red: '#f47067',
  orange: '#f0883e',
  yellow: '#e3b341',
  green: '#57ab5a',
  teal: '#39c5cf',
  blue: '#539bf5',
  violet: '#b083f0',
  pink: '#e275ad'
}

/** Claude Code's status glyphs at the start of a window title (✳ idle, ◐◓◑◒ and braille while working). */
const STATUS_GLYPH = /^[\s✳◐◓◑◒⠁-⣿]+/u

export function cleanTitle(title: string): string {
  return title.replace(STATUS_GLYPH, '').trim()
}

/** The title carries Claude Code's status glyph: Claude runs in that window. */
export function hasAgentStatus(title: string): boolean {
  return /^\s*[✳◐◓◑◒⠁-⣿]/u.test(title)
}

const MAX_LABEL = 60

/**
 * A display name. It also becomes a Windows Terminal title argument, so what a command line could
 * read as syntax goes: control characters, `;` (Windows Terminal's command separator), `"`, `\`, and
 * leading dashes (a flag). '' clears the name; null means "not text at all".
 */
export function parseLabel(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const clean = v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f;"\\]/g, '')
    .trim()
    .replace(/^[\s-]+/, '')
  return clean.slice(0, MAX_LABEL).trim()
}

export function parseColorId(v: unknown): ColorId | null {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(COLORS, v) ? (v as ColorId) : null
}

const PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'opencode', 'cmd', 'pwsh']
const RUNS: readonly WindowRun[] = ['claude', 'codex', 'opencode']
const SHELLS = ['cmd', 'powershell', 'pwsh'] as const

/** An absolute folder exactly as normalizeFolder would write it (no quotes, `..`, device paths or variables). */
function isCleanFolder(v: unknown): v is string {
  return typeof v === 'string' && normalizeFolder(v, '') === v
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseSlotLaunch(v: unknown): SlotLaunch | null {
  if (!isObj(v)) return null
  if (v.kind === 'agent') {
    const provider = PROVIDERS.find((p) => p === v.provider)
    const role = v.role === 'plain' || v.role === 'orchestrator' ? v.role : null
    if (!provider || !role || !isCleanFolder(v.cwd)) return null
    return { kind: 'agent', provider, role, cwd: v.cwd }
  }
  if (v.kind !== 'window') return null
  if (v.cwd !== null && !isCleanFolder(v.cwd)) return null
  const cwd = v.cwd as string | null
  let run: WindowRun | undefined
  if (v.run !== undefined) {
    run = RUNS.find((r) => r === v.run)
    if (!run) return null
  }
  const withRun = <T extends object>(o: T) => (run ? { ...o, run } : o)
  if (v.host === 'conhost') {
    const shell = SHELLS.find((s) => s === v.shell)
    if (!shell) return null
    return withRun({ kind: 'window' as const, host: 'conhost' as const, shell, cwd })
  }
  if (v.host === 'wt') {
    // Windows Terminal reads ";" as the start of a new command, even inside a folder argument.
    if (cwd !== null && cwd.includes(';')) return null
    return withRun({ kind: 'window' as const, host: 'wt' as const, cwd })
  }
  return null
}
