// Claude asks "Trust this folder?" in every folder it has not seen (default: "No, exit"). A Claude
// worker started by another tile in THAT tile's folder (or below) gets the answer from the organizer:
// the folder is already the starting tile's workspace (Marco, 2026-09-25). Anywhere else the user
// decides. The rule lives here, not in a prompt, so no agent can widen it.
import { detectTrustPrompt, normalizeFolder } from '../../shared/folder'
import type { AgentProvider, AgentRole } from '../../shared/types'

/**
 * Case folding for the comparison: ASCII letters only. JavaScript folds more than NTFS does (the
 * KELVIN SIGN lowercases to "k" but names another folder on disk — cold review), so anything else
 * must match exactly: a mismatch means "not inside", the safe direction.
 */
const fold = (p: string) => p.replace(/[a-z]/g, (ch) => ch.toUpperCase())

/** `child` is `parent` or a folder below it (normalized, ASCII case-insensitive, at a path boundary). */
export function isInsideFolder(child: string, parent: string): boolean {
  const c = normalizeFolder(child, '')
  const p = normalizeFolder(parent, '')
  if (!c || !p) return false
  const cf = fold(c)
  const pf = fold(p)
  return cf === pf || cf.startsWith(pf.endsWith('\\') ? pf : pf + '\\')
}

/**
 * The real start dialog for exactly `folder`: Claude's "Accessing workspace:" line followed by that
 * folder, the two options — and no numbered choice anywhere (a permission question must never get
 * these keys). Text that merely looks like the dialog (an answer, a file) lacks the folder line.
 */
export function isTrustDialogFor(lines: string[], folder: string): boolean {
  if (!detectTrustPrompt(lines)) return false
  if (lines.some((l) => /^\s*❯\s+\d+\./.test(l))) return false
  const at = lines.findIndex((l) => l.trim() === 'Accessing workspace:')
  const shown = lines.slice(at + 1).find((l) => l.trim() !== '')
  const want = normalizeFolder(folder, '')
  return at >= 0 && !!shown && !!want && fold(shown.trim()) === fold(want)
}

export type TrustWorker = { provider: AgentProvider; role: AgentRole; cwd: string; parentId: string | null }
export type TrustParent = { cwd: string; exited: boolean }

export function autoTrust(worker: TrustWorker, parent: TrustParent | undefined): boolean {
  if (worker.provider !== 'claude' || worker.role !== 'worker' || !worker.parentId) return false
  if (!parent || parent.exited) return false
  return isInsideFolder(worker.cwd, parent.cwd)
}

/**
 * The keys that select "Yes, I trust this folder" from where the ❯ cursor is, then Enter (one key per
 * entry: Claude's UI takes them one by one). Measured on Claude Code 2.1.282: "No, exit" is
 * preselected, one arrow down reaches "Yes". Null when the dialog is not recognizable.
 */
export function trustKeys(lines: string[]): string[] | null {
  const cursor = lines.findIndex((l) => /^\s*❯\s/.test(l))
  const yes = lines.findIndex((l) => /^\s*(❯\s+)?Yes, I trust this folder\s*$/.test(l))
  if (cursor < 0 || yes < 0) return null
  const step = yes > cursor ? '\x1b[B' : '\x1b[A'
  return [...Array<string>(Math.abs(yes - cursor)).fill(step), '\r']
}
